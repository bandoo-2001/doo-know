import { z } from 'zod';
import type { AppDatabase } from '../db.js';
import type { AppConfig } from '../../../shared/contracts.js';
import {
  createKnowledgeDataDomain,
  readKnowledgeDataFile,
  writeKnowledgeDataFile,
} from '../knowledge-data.js';
import { BlogError } from './errors.js';
import { blogHash } from './resources.js';
import { sanitizePublicationHtml } from './publication.js';
import { validateSvgSource } from '../svg.js';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z
  .string()
  .max(64)
  .refine((s) => Number.isFinite(Date.parse(s)));
const metadata = z
  .object({
    slug: z
      .string()
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .refine(
        (s) => !['about', 'archive', 'rss.xml', 'sitemap.xml', 'assets', 'api', 'feed'].includes(s),
      ),
    title: text(1024).refine((s) => !!s.trim() && [...s].length <= 256),
    summary: text(2000),
    category: text(80),
    tags: z.array(text(80).min(1)).max(30),
    pinned: z.boolean(),
    cover: text(8192).nullable(),
  })
  .strict();
const settings = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean(),
    title: text(256),
    description: text(2000),
    author: text(256),
    baseUrl: text(2048).refine((s) => {
      if (!s) return true;
      try {
        const u = new URL(s);
        return (
          ['http:', 'https:'].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          ['', '/'].includes(u.pathname)
        );
      } catch {
        return false;
      }
    }),
    about: text(50000),
    theme: z.enum(['light', 'system']),
  })
  .strict();
const post = z
  .object({
    id,
    source_note_id: id,
    slug: z.string(),
    metadata: metadata,
    version: z.number().int().positive(),
    state: z.enum(['draft', 'published', 'withdrawn']),
    current_version_id: id.nullable(),
    published_at: timestamp.nullable(),
    updated_at: timestamp,
  })
  .strict();
const version = z
  .object({
    id,
    post_id: id,
    source_modified_at: text(64),
    source_hash: hash,
    metadata,
    html: z.string().max(16 * 1024 ** 2),
    headings: z.array(z.object({ id: text(256), text: text(65536) }).strict()).max(50000),
    cover_hash: hash.nullable(),
    created_at: timestamp,
  })
  .strict();
const blob = z
  .object({
    hash,
    mime: z.enum([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'application/pdf',
    ]),
    size: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 ** 2),
  })
  .strict();
const resource = z.object({ version_id: id, hash }).strict();
const state = z
  .object({
    version: z.literal(1),
    settings,
    posts: z.array(post).max(100000),
    versions: z.array(version).max(100000),
    blobs: z.array(blob).max(100000),
    resources: z.array(resource).max(1000000),
  })
  .strict();
type PortableBlogState = z.infer<typeof state>;
const domains = new WeakMap<
  AppDatabase,
  { root: string; domain: ReturnType<typeof createKnowledgeDataDomain<PortableBlogState>> }
>();
const file = 'apps/blog/state.json';
const assetPath = (value: string) => 'apps/blog/assets/' + value;
function invalid(message = '博客便携数据无效，已保留原有记录'): never {
  throw new BlogError(409, message, { code: 'KNOWLEDGE_DATA_INVALID' });
}
function unique<T>(values: T[], key: (value: T) => string) {
  const keys = new Set(values.map(key));
  if (keys.size !== values.length) invalid();
  return keys;
}

/** Publication records are portable; credentials and operation receipts stay local. */
export function portableBlog(config: Pick<AppConfig, 'knowledgeRoot' | 'origin'>, db: AppDatabase) {
  const previous = domains.get(db);
  if (previous) {
    if (previous.root !== config.knowledgeRoot) invalid('博客资料目录已变化，请重新打开知识库');
    return previous.domain;
  }
  const readBlob = (descriptor: PortableBlogState['blobs'][number]) => {
    const bytes = readKnowledgeDataFile(config.knowledgeRoot, assetPath(descriptor.hash));
    if (!bytes || bytes.length !== descriptor.size || blogHash(bytes) !== descriptor.hash)
      invalid('博客发布资源缺失或校验失败，已保留原有记录');
    if (descriptor.mime === 'image/svg+xml') {
      if (!validateSvgSource(bytes).ok) invalid('博客 SVG 发布资源不安全');
    } else {
      const signatures: Record<string, boolean> = {
        'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
        'image/gif': ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()),
        'image/webp':
          bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
        'application/pdf': bytes.subarray(0, 5).toString() === '%PDF-',
      };
      if (!signatures[descriptor.mime]) invalid('博客发布资源类型校验失败');
    }
    return bytes;
  };
  const validate = (input: unknown): PortableBlogState => {
    const parsed = state.safeParse(input);
    if (!parsed.success) invalid();
    const data = parsed.data;
    const posts = unique(data.posts, (p) => p.id);
    unique(data.posts, (p) => p.source_note_id);
    unique(data.posts, (p) => p.slug);
    const versions = new Map(data.versions.map((v) => [v.id, v]));
    if (versions.size !== data.versions.length) invalid();
    const blobs = unique(data.blobs, (b) => b.hash);
    const blobTypes = new Map(data.blobs.map((b) => [b.hash, b.mime]));
    const resources = unique(data.resources, (r) => r.version_id + '/' + r.hash);
    const versionUrls = new Map<string, Set<string>>();
    for (const p of data.posts) {
      if (
        p.slug !== p.metadata.slug ||
        !db.prepare('SELECT 1 FROM notes WHERE id=?').get(p.source_note_id)
      )
        invalid();
      const current = p.current_version_id ? versions.get(p.current_version_id) : undefined;
      if (
        p.current_version_id &&
        (!current || current.post_id !== p.id || current.metadata.slug !== p.slug)
      )
        invalid();
      if (p.state === 'published' && (!current || !p.published_at)) invalid();
    }
    for (const r of data.resources) {
      if (!versions.has(r.version_id) || !blobs.has(r.hash)) invalid();
      const urls = versionUrls.get(r.version_id) || new Set<string>();
      const owner = versions.get(r.version_id)!;
      urls.add(`/blog/assets/${owner.post_id}/${owner.id}/${r.hash}`);
      versionUrls.set(r.version_id, urls);
    }
    for (const v of data.versions) {
      if (
        !posts.has(v.post_id) ||
        (v.cover_hash &&
          (!resources.has(v.id + '/' + v.cover_hash) ||
            !blobTypes.get(v.cover_hash)?.startsWith('image/')))
      )
        invalid();
      // Synchronized files are untrusted, including previously generated HTML.
      v.html = sanitizePublicationHtml(v.html, {
        resourceUrls: versionUrls.get(v.id) || new Set(),
        origin: config.origin,
      });
    }
    for (const b of data.blobs) readBlob(b);
    return data;
  };
  const domain = createKnowledgeDataDomain(config, db, file, {
    tables: [
      'blog_settings',
      'blog_posts',
      'blog_versions',
      'blog_blobs',
      'blog_version_resources',
    ],
    read: () => {
      const blobs = (
        db.prepare('SELECT hash,mime,bytes FROM blog_blobs ORDER BY hash').all() as {
          hash: string;
          mime: PortableBlogState['blobs'][number]['mime'];
          bytes: Buffer;
        }[]
      ).map((b) => {
        if (blogHash(b.bytes) !== b.hash) invalid('博客本地资源校验失败');
        const existing = readKnowledgeDataFile(config.knowledgeRoot, assetPath(b.hash));
        if (existing && !existing.equals(b.bytes)) invalid('博客发布资源发生冲突，已保留两侧资料');
        if (!existing) writeKnowledgeDataFile(config.knowledgeRoot, assetPath(b.hash), b.bytes);
        return { hash: b.hash, mime: b.mime, size: b.bytes.length };
      });
      const posts = (
        db.prepare('SELECT * FROM blog_posts ORDER BY id').all() as Record<string, unknown>[]
      ).map(({ metadata_json, ...p }) => ({
        ...p,
        metadata: JSON.parse(String(metadata_json)),
      })) as PortableBlogState['posts'];
      const versions = (
        db.prepare('SELECT * FROM blog_versions ORDER BY id').all() as Record<string, unknown>[]
      ).map(({ metadata_json, headings_json, ...v }) => ({
        ...v,
        metadata: JSON.parse(String(metadata_json)),
        headings: JSON.parse(String(headings_json)),
      })) as PortableBlogState['versions'];
      return {
        version: 1,
        settings: JSON.parse(
          (
            db.prepare('SELECT settings_json FROM blog_settings WHERE id=1').get() as {
              settings_json: string;
            }
          ).settings_json,
        ),
        posts,
        versions,
        blobs,
        resources: db
          .prepare('SELECT version_id,hash FROM blog_version_resources ORDER BY version_id,hash')
          .all() as PortableBlogState['resources'],
      };
    },
    validate,
    write: (data) => {
      // Recheck all bytes before changing any projection, including a concurrent asset replacement.
      const bytes = data.blobs.map((b) => ({ ...b, bytes: readBlob(b) }));
      db.prepare('DELETE FROM blog_version_resources').run();
      db.prepare('DELETE FROM blog_versions').run();
      db.prepare('DELETE FROM blog_posts').run();
      db.prepare('DELETE FROM blog_blobs').run();
      db.prepare('UPDATE blog_settings SET settings_json=? WHERE id=1').run(
        JSON.stringify(data.settings),
      );
      for (const p of data.posts)
        db.prepare(
          'INSERT INTO blog_posts(id,source_note_id,slug,metadata_json,version,state,current_version_id,published_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          p.id,
          p.source_note_id,
          p.slug,
          JSON.stringify(p.metadata),
          p.version,
          p.state,
          p.current_version_id,
          p.published_at,
          p.updated_at,
        );
      for (const v of data.versions)
        db.prepare('INSERT INTO blog_versions VALUES(?,?,?,?,?,?,?,?,?)').run(
          v.id,
          v.post_id,
          v.source_modified_at,
          v.source_hash,
          JSON.stringify(v.metadata),
          v.html,
          JSON.stringify(v.headings),
          v.cover_hash,
          v.created_at,
        );
      for (const b of bytes)
        db.prepare('INSERT INTO blog_blobs VALUES(?,?,?)').run(b.hash, b.mime, b.bytes);
      for (const r of data.resources)
        db.prepare('INSERT INTO blog_version_resources VALUES(?,?)').run(r.version_id, r.hash);
    },
  });
  domains.set(db, { root: config.knowledgeRoot, domain });
  return domain;
}
