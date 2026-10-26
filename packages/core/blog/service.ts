import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  BlogCreateInput,
  BlogDashboard,
  BlogMetadata,
  BlogNoteStatus,
  BlogPost,
  BlogPostDetail,
  BlogPublishInput,
  BlogSettings,
  BlogUnpublishInput,
  BlogUpdateInput,
} from '../../../shared/blog-contracts.js';
import { isWhiteboard } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { requireScope } from '../agent/auth.js';
import { HttpError } from '../errors.js';
import { BlogError, typedBlogError } from './errors.js';
import { isMissingSource } from '../files.js';
import { assertWritable, acquireNoteWrite, releaseNoteWrite } from '../knowledge/write-lease.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { beginOperation, completeOperation, findOperation } from '../knowledge/operations.js';
import { authorizeBlogPath, blogHash } from './resources.js';
import { capturePublication } from './publication.js';

type PostRow = {
  id: string;
  source_note_id: string;
  slug: string;
  metadata_json: string;
  version: number;
  state: BlogPost['state'];
  current_version_id: string | null;
  published_at: string | null;
  updated_at: string;
};
type VersionRow = {
  id: string;
  post_id: string;
  source_modified_at: string;
  source_hash: string;
  metadata_json: string;
  html: string;
  headings_json: string;
  cover_hash: string | null;
  created_at: string;
};
const metadataKeys = ['slug', 'title', 'summary', 'category', 'tags', 'pinned', 'cover'];
const reserved = new Set(['about', 'archive', 'rss.xml', 'sitemap.xml', 'assets', 'api', 'feed']);
const shortTitle = (value: string) => [...value].slice(0, 256).join('');
function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalInput(item)]),
    );
  return value;
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BlogError(400, '请求格式不正确');
}
function bounded(value: unknown, max: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new BlogError(400, label + '格式不正确');
  return value;
}
function metadata(input: unknown, previous: BlogMetadata): BlogMetadata {
  object(input);
  if (Object.keys(input).some((key) => !metadataKeys.includes(key)))
    throw new BlogError(400, '博客元数据包含不支持字段');
  const v = { ...previous, ...input };
  const slug = bounded(v.slug, 100, '文章地址');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || reserved.has(slug))
    throw new BlogError(400, '文章地址需要小写英文、数字或连字符');
  if (
    !Array.isArray(v.tags) ||
    v.tags.length > 30 ||
    v.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 80)
  )
    throw new BlogError(400, '标签格式不正确');
  if (typeof v.pinned !== 'boolean' || (v.cover !== null && typeof v.cover !== 'string'))
    throw new BlogError(400, '博客元数据格式不正确');
  if (
    typeof v.title !== 'string' ||
    [...v.title].length > 256 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.title)
  )
    throw new BlogError(400, '文章标题格式不正确');
  const title = v.title.trim();
  if (!title) throw new BlogError(400, '文章标题不能为空');
  return {
    slug,
    title,
    summary: bounded(v.summary, 2000, '摘要'),
    category: bounded(v.category, 80, '分类').trim(),
    tags: [...new Set(v.tags.map((t) => t.trim()))],
    pinned: v.pinned,
    cover: v.cover === null ? null : bounded(v.cover, 8192, '封面'),
  };
}
function validVersion(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new BlogError(400, '发布版本格式不正确');
}
function actor(p: Principal, publication = false) {
  requireScope(p, 'knowledge:read');
  requireScope(p, 'knowledge:write');
  if (publication) requireScope(p, 'blog:publish');
}
export function blogService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  const rowByNote = (id: string) =>
    db.prepare('SELECT * FROM blog_posts WHERE source_note_id=?').get(id) as PostRow | undefined;
  const row = (id: string) => {
    const r = db.prepare('SELECT * FROM blog_posts WHERE id=?').get(id) as PostRow | undefined;
    if (!r) throw new BlogError(404, '博客文章不存在');
    return r;
  };
  const version = (id: string | null) =>
    id
      ? (db.prepare('SELECT * FROM blog_versions WHERE id=?').get(id) as VersionRow | undefined)
      : undefined;
  const settings = (_p?: Principal): BlogSettings => {
    if (_p) requireScope(_p, 'knowledge:read');
    return JSON.parse(
      (
        db.prepare('SELECT settings_json FROM blog_settings WHERE id=1').get() as {
          settings_json: string;
        }
      ).settings_json,
    );
  };
  const defaultMetadata = (id: string, title: string): BlogMetadata => ({
    slug: 'post-' + id.slice(0, 12),
    title: shortTitle(title),
    summary: '',
    category: '',
    tags: [],
    pinned: false,
    cover: null,
  });
  function source(p: Principal, id: string) {
    try {
      const nr = notes.row(id);
      authorizeBlogPath(p, nr.path);
      if (isWhiteboard(nr.path)) throw new BlogError(400, '请选择 Markdown 笔记作为博客文章');
      const n = notes.getNote(id);
      return { n, hash: blogHash(n.content) };
    } catch (error) {
      return typedBlogError(error);
    }
  }
  function describe(
    r: PostRow,
    p: Principal,
    observedSource?: ReturnType<typeof source> | null,
  ): BlogPost {
    // Withdrawal and durable receipts must remain usable when a previously
    // published source has grown beyond the ordinary Markdown reader's limits.
    authorizeBlogPath(p, notes.row(r.source_note_id, true).path);
    const v = version(r.current_version_id),
      s = settings();
    const m = JSON.parse(r.metadata_json) as BlogMetadata;
    let n: { title: string; modifiedAt: string } = {
        title: m.title,
        modifiedAt: v?.source_modified_at || '0',
      },
      hash = v?.source_hash || blogHash(''),
      unavailable = observedSource === null;
    if (observedSource !== null) {
      try {
        const current = observedSource ?? source(p, r.source_note_id);
        n = current.n;
        hash = current.hash;
      } catch (error) {
        if (!(error instanceof HttpError) || ![404, 409, 413, 422, 503].includes(error.statusCode))
          throw error;
        r = row(r.id);
        unavailable = true;
      }
    }
    return {
      ...m,
      id: r.id,
      sourceNoteId: r.source_note_id,
      sourceTitle: shortTitle(n.title),
      sourceModifiedAt: n.modifiedAt,
      sourceHash: hash,
      version: r.version,
      state: r.state,
      publishedVersionId: r.current_version_id,
      publishedAt: r.published_at,
      updatedAt: r.updated_at,
      hasUnpublishedChanges:
        unavailable || !v || v.source_hash !== hash || v.metadata_json !== r.metadata_json,
      url:
        r.state === 'published' && s.enabled
          ? s.baseUrl
            ? new URL('/blog/' + JSON.parse(v!.metadata_json).slug, s.baseUrl).href
            : '/blog/' + JSON.parse(v!.metadata_json).slug
          : null,
    };
  }
  function noteStatus(p: Principal, noteId: string): BlogNoteStatus {
    requireScope(p, 'knowledge:read');
    const { n, hash } = source(p, noteId),
      r = rowByNote(noteId);
    return {
      siteEnabled: settings().enabled,
      post: r ? describe(r, p, { n, hash }) : null,
      publicationVersion: r?.version || 0,
      source: {
        noteId,
        title: shortTitle(n.title),
        relativePath: n.relativePath,
        modifiedAt: n.modifiedAt,
        contentHash: hash,
      },
    };
  }
  function receipt<T>(p: Principal, kind: string, input: unknown, work: () => T): T {
    object(input);
    const requestId = bounded(input.requestId, 128, '请求标识');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new BlogError(400, '请求标识格式不正确');
    const digest = blogHash(JSON.stringify(canonicalInput(input)));
    const previous = db
      .prepare('SELECT * FROM blog_receipts WHERE actor=? AND client_id=? AND request_id=?')
      .get(p.id, p.clientId, requestId) as
      | { kind: string; input_hash: string; result_json: string }
      | undefined;
    if (previous) {
      if (previous.kind !== kind || previous.input_hash !== digest)
        throw new BlogError(409, '同一请求标识的参数已变化', { code: 'IDEMPOTENCY_CONFLICT' });
      return JSON.parse(previous.result_json);
    }
    const publication = ['publish', 'unpublish'].includes(kind);
    const operation = publication
      ? beginOperation(db, p, 'blog.' + kind, requestId, input).operation
      : undefined;
    const result = work();
    if (operation) completeOperation(db, operation.id, result);
    db.prepare(
      'INSERT INTO blog_receipts(actor,client_id,request_id,kind,input_hash,result_json,operation_id,source_note_id) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      p.id,
      p.clientId,
      requestId,
      kind,
      digest,
      JSON.stringify(result),
      operation?.id || null,
      publication ? input.noteId : null,
    );
    return result;
  }
  const mutate = <T>(kind: string, work: () => T) => {
    try {
      return workspaceWriteSync(db, { kind: 'blog.' + kind }, () =>
        db.transaction(work).immediate(),
      );
    } catch (error) {
      return typedBlogError(error);
    }
  };
  function insertPost(p: Principal, input: BlogCreateInput): PostRow {
    const { n } = source(p, input.sourceNoteId);
    if (rowByNote(n.id)) throw new BlogError(409, '这篇笔记已加入博客');
    const id = randomUUID(),
      m = metadata(input.metadata || {}, defaultMetadata(id, n.title)),
      now = new Date().toISOString();
    if (db.prepare('SELECT 1 FROM blog_posts WHERE slug=?').get(m.slug))
      throw new BlogError(409, '文章地址已被使用');
    db.prepare(
      "INSERT INTO blog_posts(id,source_note_id,slug,metadata_json,state,updated_at) VALUES(?,?,?,?,'draft',?)",
    ).run(id, n.id, m.slug, JSON.stringify(m), now);
    return row(id);
  }
  function createPost(p: Principal, input: BlogCreateInput) {
    actor(p);
    return mutate('create', () =>
      receipt(p, 'create', input, () => describe(insertPost(p, input), p)),
    );
  }
  function updatePost(p: Principal, id: string, input: BlogUpdateInput) {
    actor(p);
    object(input);
    validVersion(input.expectedVersion);
    return mutate('update', () => {
      const old = row(id);
      authorizeBlogPath(p, notes.row(old.source_note_id, true).path);
      return receipt(p, 'update:' + id, input, () => {
        if (old.version !== input.expectedVersion)
          throw new BlogError(409, '博客记录已变化，请刷新后重试');
        const m = metadata(input.metadata, JSON.parse(old.metadata_json));
        if (
          old.current_version_id &&
          m.slug !==
            (JSON.parse(version(old.current_version_id)!.metadata_json) as BlogMetadata).slug
        )
          throw new BlogError(400, '文章首次发布后地址不能修改', { code: 'BLOG_SLUG_LOCKED' });
        if (db.prepare('SELECT 1 FROM blog_posts WHERE slug=? AND id<>?').get(m.slug, id))
          throw new BlogError(409, '文章地址已被使用');
        // Published URLs remain stable until an explicit publication replaces the snapshot.
        db.prepare(
          'UPDATE blog_posts SET slug=?,metadata_json=?,version=version+1,updated_at=? WHERE id=?',
        ).run(m.slug, JSON.stringify(m), new Date().toISOString(), id);
        return describe(row(id), p);
      });
    });
  }
  function publishNote(
    p: Principal,
    input: BlogPublishInput,
    revalidate?: () => Principal,
  ): BlogPost {
    actor(p, true);
    object(input);
    validVersion(input.expectedPublicationVersion);
    return mutate('publish', () => {
      authorizeBlogPath(p, notes.row(input.noteId, true).path);
      return receipt(p, 'publish', input, () => {
        const old = rowByNote(input.noteId);
        if ((old?.version || 0) !== input.expectedPublicationVersion)
          throw new BlogError(409, '博客记录已变化，请刷新后重试');
        const lock = randomUUID();
        acquireNoteWrite(db, input.noteId, lock);
        try {
          const { n, hash } = source(p, input.noteId);
          if (n.modifiedAt !== input.expectedModifiedAt || hash !== input.expectedContentHash)
            throw new BlogError(409, '原文已变化，请重新预览');
          const r =
            old ||
            insertPost(p, {
              sourceNoteId: input.noteId,
              metadata: input.metadata,
              requestId: input.requestId,
            });
          const m = metadata(input.metadata || {}, JSON.parse(r.metadata_json));
          if (
            r.current_version_id &&
            m.slug !==
              (JSON.parse(version(r.current_version_id)!.metadata_json) as BlogMetadata).slug
          )
            throw new BlogError(400, '文章首次发布后地址不能修改', { code: 'BLOG_SLUG_LOCKED' });
          if (db.prepare('SELECT 1 FROM blog_posts WHERE slug=? AND id<>?').get(m.slug, r.id))
            throw new BlogError(409, '文章地址已被使用');
          const versionId = randomUUID(),
            url = (hash: string) => `/blog/assets/${r.id}/${versionId}/${hash}`;
          const captured = capturePublication(config, db, notes, p, n, m, url, input.diagrams);
          const fresh = revalidate?.() || p;
          actor(fresh, true);
          if (fresh.id !== p.id || fresh.clientId !== p.clientId)
            throw new BlogError(403, '发布授权已变化');
          authorizeBlogPath(fresh, n.relativePath);
          captured.revalidate(fresh);
          const current = source(fresh, input.noteId);
          if (
            current.n.modifiedAt !== n.modifiedAt ||
            current.hash !== hash ||
            current.n.relativePath !== n.relativePath
          )
            throw new BlogError(409, '发布期间原文已变化');
          assertWritable(db, input.noteId, undefined, lock);
          const now = new Date().toISOString();
          db.prepare('INSERT INTO blog_versions VALUES(?,?,?,?,?,?,?,?,?)').run(
            versionId,
            r.id,
            n.modifiedAt,
            hash,
            JSON.stringify(m),
            captured.html,
            JSON.stringify(captured.headings),
            captured.coverHash,
            now,
          );
          for (const a of captured.resources) {
            db.prepare('INSERT OR IGNORE INTO blog_blobs VALUES(?,?,?)').run(
              a.hash,
              a.mime,
              a.bytes,
            );
            db.prepare('INSERT INTO blog_version_resources VALUES(?,?)').run(versionId, a.hash);
          }
          db.prepare(
            "UPDATE blog_posts SET slug=?,metadata_json=?,version=?,state='published',current_version_id=?,published_at=COALESCE(published_at,?),updated_at=? WHERE id=?",
          ).run(m.slug, JSON.stringify(m), old ? r.version + 1 : 1, versionId, now, now, r.id);
          return describe(row(r.id), fresh);
        } finally {
          releaseNoteWrite(db, input.noteId, lock);
        }
      });
    });
  }
  function unpublishNote(
    p: Principal,
    input: BlogUnpublishInput,
    revalidate?: () => Principal,
  ): BlogPost {
    actor(p, true);
    object(input);
    validVersion(input.expectedPublicationVersion);
    return mutate('unpublish', () => {
      authorizeBlogPath(p, notes.row(input.noteId, true).path);
      return receipt(p, 'unpublish', input, () => {
        const r = rowByNote(input.noteId);
        if (!r) throw new BlogError(404, '博客文章不存在');
        if (r.version !== input.expectedPublicationVersion)
          throw new BlogError(409, '博客记录已变化');
        const fresh = revalidate?.() || p;
        actor(fresh, true);
        if (fresh.id !== p.id || fresh.clientId !== p.clientId)
          throw new BlogError(403, '授权已变化');
        authorizeBlogPath(fresh, notes.row(input.noteId, true).path);
        db.prepare(
          "UPDATE blog_posts SET state='withdrawn',version=version+1,updated_at=? WHERE id=?",
        ).run(new Date().toISOString(), r.id);
        return describe(row(r.id), fresh);
      });
    });
  }
  function postDetail(p: Principal, id: string): BlogPostDetail {
    requireScope(p, 'knowledge:read');
    const r = row(id);
    authorizeBlogPath(p, notes.row(r.source_note_id, true).path);
    let sourceContent = '';
    let observedSource: ReturnType<typeof source> | null = null;
    try {
      observedSource = source(p, r.source_note_id);
      const { n } = observedSource;
      sourceContent = n.content;
      const captured = capturePublication(
        config,
        db,
        notes,
        p,
        n,
        JSON.parse(r.metadata_json),
        (hash) => '/api/blog/posts/' + r.id + '/assets/' + hash,
        [],
        true,
      );
      return {
        post: describe(r, p, observedSource),
        sourceContent,
        previewHtml: captured.html,
        headings: captured.headings,
        diagramNeeds: captured.needs,
      };
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        ![400, 404, 409, 413, 422, 503].includes(error.statusCode)
      )
        throw error;
      return {
        post: describe(row(id), p, observedSource),
        sourceContent,
        previewHtml: '<p>当前原文暂时无法生成发布预览，请打开原笔记检查后重试。</p>',
        headings: [],
        diagramNeeds: [],
      };
    }
  }
  function updateSettings(p: Principal, input: { settings: BlogSettings; requestId: string }) {
    actor(p);
    object(input);
    object(input.settings);
    return mutate('settings', () =>
      receipt(p, 'settings', input, () => {
        const old = settings(),
          v = input.settings;
        if (v.version !== old.version) throw new BlogError(409, '站点设置已变化');
        if (
          Object.keys(v).some(
            (k) =>
              ![
                'version',
                'enabled',
                'title',
                'description',
                'author',
                'baseUrl',
                'about',
                'theme',
              ].includes(k),
          ) ||
          typeof v.enabled !== 'boolean' ||
          !['light', 'system'].includes(v.theme)
        )
          throw new BlogError(400, '站点设置格式不正确');
        let baseUrl = bounded(v.baseUrl, 2048, '站点地址').replace(/\/+$/, '');
        if (baseUrl) {
          try {
            const parsed = new URL(baseUrl);
            if (
              !['http:', 'https:'].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password ||
              parsed.search ||
              parsed.hash ||
              !['', '/'].includes(parsed.pathname)
            )
              throw Error();
            baseUrl = parsed.origin;
          } catch {
            throw new BlogError(400, '站点地址需要 HTTP(S) 根地址');
          }
        }
        const next: BlogSettings = {
          version: old.version + 1,
          enabled: v.enabled,
          title: bounded(v.title, 256, '站点标题'),
          description: bounded(v.description, 2000, '站点描述'),
          author: bounded(v.author, 256, '作者'),
          baseUrl,
          about: bounded(v.about, 50000, '关于'),
          theme: v.theme,
        };
        db.prepare('UPDATE blog_settings SET settings_json=? WHERE id=1').run(JSON.stringify(next));
        return next;
      }),
    );
  }
  function dashboard(
    p: Principal,
    query: { limit?: unknown; query?: unknown; cursor?: unknown } = {},
  ): BlogDashboard {
    requireScope(p, 'knowledge:read');
    const limit = query.limit == null ? 30 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BlogError(400, '分页大小不正确');
    const search = query.query == null ? '' : bounded(query.query, 200, '查询').toLowerCase();
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString());
        if (decoded.query !== search || !Number.isInteger(decoded.offset) || decoded.offset < 0)
          throw Error();
        offset = decoded.offset;
      } catch {
        throw new BlogError(400, '分页游标不正确');
      }
    }
    const all = (
      db
        .prepare(
          'SELECT p.* FROM blog_posts p JOIN notes n ON n.id=p.source_note_id ORDER BY p.updated_at DESC,p.id',
        )
        .all() as PostRow[]
    ).flatMap((r) => {
      try {
        return [describe(r, p)];
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.statusCode)) return [];
        throw error;
      }
    });
    const filtered = all.filter(
      (r) =>
        !search ||
        [r.title, r.summary, r.category, ...r.tags].join(' ').toLowerCase().includes(search),
    );
    const counts = (values: string[]) =>
      [...new Set(values.filter(Boolean))]
        .sort()
        .map((name) => ({ name, count: values.filter((v) => v === name).length }));
    return {
      settings: settings(),
      posts: filtered.slice(offset, offset + limit),
      total: filtered.length,
      nextCursor:
        offset + limit < filtered.length
          ? Buffer.from(JSON.stringify({ offset: offset + limit, query: search })).toString(
              'base64url',
            )
          : null,
      taxonomy: {
        categories: counts(all.map((r) => r.category)),
        tags: counts(all.flatMap((r) => r.tags)),
      },
    };
  }
  function deletePost(
    p: Principal,
    id: string,
    input: { expectedVersion: number; requestId: string },
  ) {
    actor(p);
    object(input);
    validVersion(input.expectedVersion);
    return mutate('delete', () =>
      receipt(p, 'delete:' + id, input, () => {
        const r = row(id);
        authorizeBlogPath(p, notes.row(r.source_note_id, true).path);
        if (r.version !== input.expectedVersion) throw new BlogError(409, '博客记录已变化');
        db.prepare('DELETE FROM blog_posts WHERE id=?').run(id);
        db.prepare(
          'DELETE FROM blog_blobs WHERE hash NOT IN (SELECT hash FROM blog_version_resources)',
        ).run();
        return { deleted: true };
      }),
    );
  }
  function checkPublic(r: PostRow) {
    if (!settings().enabled || r.state !== 'published' || !r.current_version_id)
      throw new BlogError(404, '博客页面不存在');
    const unavailable = (): never => {
      throw new BlogError(503, '博客暂时不可用');
    };
    const markWithdraw = () => {
      db.prepare(
        "UPDATE blog_posts SET state='withdrawn',version=version+1 WHERE id=? AND state='published'",
      ).run(r.id);
    };
    const withdraw = (): never => {
      markWithdraw();
      throw new BlogError(404, '博客页面不存在');
    };
    let observed: ReturnType<NoteService['row']>;
    try {
      observed = notes.row(r.source_note_id, true);
    } catch (error) {
      // row() checks the root before querying identity; its own 404 is an
      // authoritative missing identity, not a wrapped filesystem failure.
      if (error instanceof HttpError && error.statusCode === 404) return withdraw();
      return unavailable();
    }
    if (!observed.active) return withdraw();
    try {
      notes.exists(r.source_note_id);
    } catch (error) {
      if (!isMissingSource(error)) return unavailable();
      const confirmMissing = () => {
        let current: ReturnType<NoteService['row']>;
        try {
          current = notes.row(r.source_note_id, true);
        } catch (confirmation) {
          return confirmation instanceof HttpError && confirmation.statusCode === 404;
        }
        if (!current.active) return true;
        if (current.path !== observed.path) return false;
        // A writer, move, recovery, or synchronization can temporarily remove
        // the old pathname before publishing its final metadata.
        try {
          assertWritable(db, r.source_note_id);
        } catch {
          return false;
        }
        if (
          db
            .prepare("SELECT 1 FROM folder_trash WHERE state IN ('archiving','restoring') LIMIT 1")
            .get()
        )
          return false;
        try {
          notes.exists(r.source_note_id);
          return false;
        } catch (confirmation) {
          return isMissingSource(confirmation);
        }
      };
      const confirmed = db
        .transaction(() => {
          const missing = confirmMissing();
          if (missing) markWithdraw();
          return missing;
        })
        .immediate();
      if (confirmed) throw new BlogError(404, '博客页面不存在');
      return unavailable();
    }
  }
  function publicPost(slug: string) {
    const r = db
      .prepare(
        "SELECT p.* FROM blog_posts p JOIN blog_versions v ON v.id=p.current_version_id WHERE json_extract(v.metadata_json,'$.slug')=? AND p.state='published'",
      )
      .get(slug) as PostRow | undefined;
    if (!r) throw new BlogError(404, '博客页面不存在');
    checkPublic(r);
    const v = version(r.current_version_id)!;
    return project(r, v);
  }
  function project(r: PostRow, v: VersionRow) {
    const m = JSON.parse(v.metadata_json) as BlogMetadata;
    return {
      slug: m.slug,
      title: m.title,
      summary: m.summary,
      category: m.category,
      tags: m.tags,
      pinned: m.pinned,
      cover: v.cover_hash ? `/blog/assets/${r.id}/${v.id}/${v.cover_hash}` : null,
      publishedAt: r.published_at!,
      updatedAt: v.created_at,
      html: v.html,
      headings: JSON.parse(v.headings_json) as { id: string; text: string }[],
      url: '/blog/' + m.slug,
    };
  }
  function publicPosts(query: { category?: string; tag?: string } = {}) {
    if (!settings().enabled) throw new BlogError(404, '博客页面不存在');
    return (
      db
        .prepare("SELECT * FROM blog_posts WHERE state='published' ORDER BY published_at DESC,id")
        .all() as PostRow[]
    )
      .flatMap((r) => {
        try {
          checkPublic(r);
          const post = project(r, version(r.current_version_id)!);
          return (!query.category || post.category === query.category) &&
            (!query.tag || post.tags.includes(query.tag))
            ? [post]
            : [];
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 404) return [];
          throw error;
        }
      })
      .sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.publishedAt.localeCompare(a.publishedAt),
      );
  }
  function publicResource(postId: string, versionId: string, hash: string) {
    const r = row(postId);
    checkPublic(r);
    if (r.current_version_id !== versionId || !/^[a-f0-9]{64}$/.test(hash))
      throw new BlogError(404, '资源不存在');
    const a = db
      .prepare(
        'SELECT b.mime,b.bytes FROM blog_blobs b JOIN blog_version_resources r ON r.hash=b.hash WHERE r.version_id=? AND r.hash=?',
      )
      .get(versionId, hash) as { mime: string; bytes: Buffer } | undefined;
    if (!a) throw new BlogError(404, '资源不存在');
    return a;
  }
  function previewResource(p: Principal, id: string, hash: string) {
    const r = row(id),
      { n } = source(p, r.source_note_id),
      capture = capturePublication(
        config,
        db,
        notes,
        p,
        n,
        JSON.parse(r.metadata_json),
        (h) => '/api/blog/posts/' + id + '/assets/' + h,
        [],
        true,
      );
    const resource = capture.resources.find((a) => a.hash === hash);
    if (!resource) throw new BlogError(404, '资源不存在');
    return resource;
  }
  function operationStatus(p: Principal, key: { operationId?: string; requestId?: string }) {
    requireScope(p, 'knowledge:read');
    if (!key || !!key.operationId === !!key.requestId)
      throw new BlogError(400, '只提供一种操作标识');
    const op = findOperation(db, p, { id: key.operationId, requestId: key.requestId });
    const receipt = db
      .prepare(
        'SELECT source_note_id FROM blog_receipts WHERE actor=? AND client_id=? AND operation_id=?',
      )
      .get(p.id, p.clientId, op.operationId) as { source_note_id: string } | undefined;
    if (!receipt || !op.kind.startsWith('blog.')) throw new BlogError(404, '博客操作不存在');
    authorizeBlogPath(p, notes.row(receipt.source_note_id, true).path);
    return op;
  }
  return {
    noteStatus,
    publishNote,
    unpublishNote,
    dashboard,
    settings,
    updateSettings,
    createPost,
    postDetail,
    updatePost,
    deletePost,
    publicPost,
    publicPosts,
    publicResource,
    previewResource,
    operationStatus,
  };
}
export type BlogService = ReturnType<typeof blogService>;
