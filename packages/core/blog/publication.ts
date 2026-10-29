import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { renderToString } from 'katex';
import { extname } from 'node:path';
import type { AppConfig, NoteDocument } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  BlogDiagramNeed,
  BlogDiagramPreview,
  BlogMetadata,
} from '../../../shared/blog-contracts.js';
import { frontmatterOpening, frontmatterRange } from '../../../shared/frontmatter-range.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../../shared/diagram-portability.js';
import { isDiagramKind } from '../../../shared/diagram-fences.js';
import { whiteboardId, whiteboardReference, isWhiteboard } from '../../../shared/whiteboard.js';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown.js';
import { markdownStyles } from '../../../shared/markdown-styles.js';
import { markdownTasks } from '../../../shared/markdown-tasks.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { assetService } from '../assets.js';
import { localReference } from '../render.js';
import { HttpError } from '../errors.js';
import { BlogError } from './errors.js';
import { validateDiagramSource } from '../knowledge/diagram-artifacts.js';
import { authorizeBlogPath, blogHash, publicationPng } from './resources.js';

export type CapturedResource = { hash: string; mime: string; bytes: Buffer };
export function capturePublication(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  n: NoteDocument,
  metadata: BlogMetadata,
  resourceUrl: (hash: string) => string,
  previews: BlogDiagramPreview[] = [],
  allowMissing = false,
) {
  if (
    Buffer.byteLength(n.content) > 1024 ** 2 ||
    n.content.split('\n').some((line) => Buffer.byteLength(line) > 32768)
  )
    throw new BlogError(413, '博客仅支持 1 MiB 内、单行 32 KiB 内的 Markdown');
  const front = frontmatterRange(n.content);
  if (frontmatterOpening.test(n.content) && !front)
    throw new BlogError(400, 'YAML 属性缺少结束标记');
  const assets = assetService(config, db, notes),
    resources = new Map<string, CapturedResource>();
  const observed = new Map<string, { kind: 'asset' | 'note'; hash: string }>();
  const add = (bytes: Buffer, mime: string) => {
    const hash = blogHash(bytes);
    if (bytes.length > 10 * 1024 ** 2) throw new BlogError(413, '博客单个资源不能超过 10 MiB');
    resources.set(hash, { hash, mime, bytes });
    if (
      resources.size > 64 ||
      [...resources.values()].reduce((sum, r) => sum + r.bytes.length, 0) > 20 * 1024 ** 2
    )
      throw new BlogError(413, '博客资源不能超过 64 件或 20 MiB');
    return resourceUrl(hash);
  };
  const readAsset = (path: string) => {
    authorizeBlogPath(p, path, true);
    const a = assets.file(path);
    observed.set(path, { kind: 'asset', hash: blogHash(a.sourceBytes ?? a.bytes) });
    return a;
  };
  const readBoard = (reference: string) => {
    const ref = whiteboardReference(reference);
    const path = ref && !whiteboardId(ref) ? localReference(n.relativePath, ref) : undefined;
    const row =
      ref &&
      (whiteboardId(ref)
        ? notes.row(ref)
        : path &&
          (db.prepare('SELECT id,path FROM notes WHERE active=1 AND path=?').get(path) as
            | { id: string; path: string }
            | undefined));
    if (!row || !isWhiteboard(row.path)) throw new BlogError(404, '白板不存在或已移入回收站');
    authorizeBlogPath(p, row.path);
    const board = notes.getNote(row.id);
    validateDiagramSource('excalidraw', Buffer.from(board.content));
    observed.set(board.relativePath, { kind: 'note', hash: blogHash(board.content) });
    return board;
  };
  const parser = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
  const tokens = parser.parse(n.content, {}),
    groups = boundDiagramSources(n.content);
  const starts = [0];
  for (let i = 0; i < n.content.length; i++) if (n.content[i] === '\n') starts.push(i + 1);
  const changes: { from: number; to: number; text: string }[] = [],
    needs: BlogDiagramNeed[] = [];
  const supplied = new Set<number>();
  if (!Array.isArray(previews) || previews.length > 64)
    throw new BlogError(400, '图形预览列表格式不正确');
  for (const preview of previews) {
    if (!preview || !Number.isInteger(preview.fenceFrom) || supplied.has(preview.fenceFrom))
      throw new BlogError(400, '图形预览位置重复或无效');
    supplied.add(preview.fenceFrom);
  }
  const consumed = new Set<number>();
  for (const token of tokens) {
    const kind = token.info.trim();
    if (token.type !== 'fence' || !isDiagramKind(kind) || !token.map) continue;
    const from = starts[token.map[0]],
      to = starts[token.map[1]] ?? n.content.length;
    const code = token.content,
      codeHash = blogHash(normalizeDiagramCode(code));
    const board = kind === 'excalidraw' ? readBoard(code) : undefined;
    const source = board?.content ?? code;
    validateDiagramSource(kind, Buffer.from(source));
    const sourceHash = blogHash(source);
    const need: BlogDiagramNeed = {
      fenceFrom: from,
      kind,
      code,
      codeHash,
      sourceHash,
      ...(board ? { whiteboardId: board.id } : {}),
    };
    const group = groups.find((g) => g.from === from);
    let previewBytes: Buffer | undefined;
    const submitted = previews.find((v) => v.fenceFrom === from);
    if (submitted) {
      consumed.add(from);
      if (
        submitted.kind !== kind ||
        submitted.codeHash !== codeHash ||
        submitted.sourceHash !== sourceHash
      )
        throw new BlogError(409, '图形源版本已变化', {
          code: 'BLOG_PREVIEW_REQUIRED',
          needs: [need],
        });
      previewBytes = publicationPng(submitted.pngBase64);
    } else if (
      group &&
      group.binding.codeHash === codeHash &&
      group.binding.sourceHash === sourceHash
    ) {
      const sourcePath = localReference(n.relativePath, group.sourcePath),
        previewPath = localReference(n.relativePath, group.previewPath);
      if (sourcePath && previewPath) {
        try {
          const capturedSource = readAsset(sourcePath),
            preview = readAsset(previewPath);
          if (
            blogHash(capturedSource.sourceBytes ?? capturedSource.bytes) === sourceHash &&
            preview.mime === 'image/png'
          )
            previewBytes = publicationPng(preview.bytes.toString('base64'));
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 403) throw error;
        }
      }
    }
    if (!previewBytes) needs.push(need);
    changes.push({
      from: group?.prefixFrom ?? from,
      to,
      text: previewBytes
        ? `![图形预览](${add(previewBytes, 'image/png')})\n\n`
        : '\n\n图形预览待生成\n\n',
    });
  }
  if (consumed.size !== previews.length) throw new BlogError(400, '预览不属于当前 Markdown 图块');
  if (needs.length && !allowMissing)
    throw new BlogError(409, '请在博客工作台生成固定图形预览后重试', {
      code: 'BLOG_PREVIEW_REQUIRED',
      needs,
    });
  let content = n.content;
  for (const change of changes.sort((a, b) => b.from - a.from))
    content = content.slice(0, change.from) + change.text + content.slice(change.to);
  content = content.slice(frontmatterRange(content)?.end ?? 0);
  const md = new MarkdownIt({ html: false, linkify: true })
    .use(markdownStyles)
    .use(markdownTasks)
    .use(knowledgeMarkdown, {
      renderMath(source: string, display: boolean): string {
        try {
          return renderToString(source, {
            displayMode: display,
            output: 'mathml',
            trust: false,
            throwOnError: true,
            maxExpand: 1000,
            maxSize: 20,
          });
        } catch {
          return md.utils.escapeHtml(source);
        }
      },
    });
  const finalTokens = md.parse(content, {}),
    headings: { id: string; text: string }[] = [];
  const headingInlines: ((typeof finalTokens)[number] | undefined)[] = [];
  const localAssetUrl = (url: string) => {
    const path = localReference(n.relativePath, url);
    if (!path) return;
    const ext = extname(path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'].includes(ext)) return;
    const a = readAsset(path);
    return add(a.bytes, a.mime);
  };
  const isPublicLink = (url: string) => {
    if (!/^https?:\/\//i.test(url)) return false;
    try {
      const parsed = new URL(url),
        own = new URL(config.origin);
      return (
        !(parsed.origin === own.origin && !/^\/blog(?:\/|$)/.test(parsed.pathname)) &&
        !/^\/(?:api|s)(?:\/|$)/i.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  };
  const visit = (list: typeof finalTokens) => {
    const links: boolean[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.type === 'heading_open') {
        const id = 'heading-' + headings.length;
        t.attrSet('id', id);
        headings.push({ id, text: '' });
        headingInlines.push(list[i + 1]);
      }
      if (t.type === 'image') {
        const url = String(t.attrGet('src') || '');
        const captured = [...resources.keys()].find((hash) => resourceUrl(hash) === url);
        const mapped = captured ? url : localAssetUrl(url);
        if (!mapped) throw new BlogError(400, '博客图片必须使用当前原文直接引用的本地附件');
        t.attrSet('src', mapped);
        t.attrSet('title', '');
      } else if (t.type === 'link_open') {
        const url = String(t.attrGet('href') || '');
        let target: string | undefined;
        if (url.startsWith('#')) target = url;
        else if (isPublicLink(url)) target = url;
        else {
          const path = localReference(n.relativePath, url);
          if (path?.toLowerCase().endsWith('.md')) {
            const linked = db
              .prepare(
                "SELECT p.id,p.current_version_id,v.metadata_json FROM blog_posts p JOIN notes n ON n.id=p.source_note_id JOIN blog_versions v ON v.id=p.current_version_id WHERE p.state='published' AND n.active=1 AND n.path=?",
              )
              .get(path) as { metadata_json: string } | undefined;
            if (linked) target = '/blog/' + JSON.parse(linked.metadata_json).slug;
          } else if (path && extname(path).toLowerCase() === '.pdf') target = localAssetUrl(url);
        }
        links.push(!!target);
        if (target) {
          t.attrSet('href', target);
          t.attrSet('rel', 'noopener noreferrer');
          t.attrSet('title', '');
        } else {
          t.tag = 'span';
          t.attrs = null;
        }
      } else if (t.type === 'link_close' && !links.pop()) {
        t.tag = 'span';
        t.attrs = null;
      }
      if (t.children) visit(t.children);
    }
  };
  visit(finalTokens);
  const visibleText = (tokens: typeof finalTokens): string =>
    tokens
      .map((token) => {
        if (token.type === 'text' || token.type === 'code_inline') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
        if (token.type === 'footnote_ref') return '[' + (Number(token.meta?.id) + 1) + ']';
        if (token.type === 'math_inline')
          return md.utils.unescapeAll(
            sanitizeHtml(md.renderer.renderInline([token], md.options, {}), {
              allowedTags: [],
              allowedAttributes: {},
              nonTextTags: ['script', 'style', 'textarea', 'option', 'annotation'],
            }),
          );
        if (token.children) return visibleText(token.children);
        return token.type === 'image' ? token.content : '';
      })
      .join('');
  for (let i = 0; i < headings.length; i++)
    headings[i].text = visibleText(headingInlines[i]?.children || []);
  let coverHash: string | null = null;
  if (metadata.cover) {
    const cover = localAssetUrl(metadata.cover);
    if (!cover) throw new BlogError(400, '封面必须为本地图片附件');
    coverHash = [...resources.keys()].find((hash) => resourceUrl(hash) === cover) || null;
    if (!coverHash || !resources.get(coverHash)!.mime.startsWith('image/'))
      throw new BlogError(400, '封面必须为图片');
  }
  const html = sanitizePublicationHtml(md.renderer.render(finalTokens, md.options, {}));
  return {
    html,
    headings,
    needs,
    resources: [...resources.values()],
    coverHash,
    revalidate(fresh: Principal) {
      for (const [path, observation] of observed) {
        authorizeBlogPath(fresh, path, observation.kind === 'asset');
        let current: string;
        if (observation.kind === 'asset') {
          const a = assets.file(path);
          current = blogHash(a.sourceBytes ?? a.bytes);
        } else {
          const row = db.prepare('SELECT id FROM notes WHERE active=1 AND path=?').get(path) as
            | { id: string }
            | undefined;
          if (!row) throw new BlogError(409, '引用白板已变化');
          current = blogHash(notes.getNote(row.id).content);
        }
        if (current !== observation.hash) throw new BlogError(409, '发布资源已变化，请重新预览');
      }
    },
  };
}

/** The same allowlist protects locally captured and synchronized publication HTML. */
export function sanitizePublicationHtml(
  input: string,
  options: { resourceUrls?: ReadonlySet<string>; origin?: string } = {},
) {
  return sanitizeHtml(input, {
    transformTags: options.resourceUrls
      ? {
          img: (tagName, attribs) =>
            options.resourceUrls!.has(attribs.src)
              ? { tagName, attribs }
              : { tagName: 'span', attribs: {} },
          a: (tagName, attribs) => {
            const href = attribs.href || '';
            let allowed = href.startsWith('#') || options.resourceUrls!.has(href);
            if (/^\/blog(?:\/|$)/.test(href)) {
              try {
                const parsed = new URL(href, options.origin || 'https://portable.invalid');
                allowed = /^\/blog(?:\/|$)/.test(parsed.pathname);
              } catch {
                allowed = false;
              }
            }
            if (/^https?:\/\//i.test(href)) {
              try {
                const parsed = new URL(href),
                  own = options.origin ? new URL(options.origin) : undefined;
                allowed =
                  !(
                    own &&
                    parsed.origin === own.origin &&
                    !/^\/blog(?:\/|$)/.test(parsed.pathname)
                  ) && !/^\/(?:api|s)(?:\/|$)/i.test(parsed.pathname);
              } catch {
                allowed = false;
              }
            }
            return allowed
              ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }
              : { tagName: 'span', attribs: {} };
          },
        }
      : undefined,
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'math',
      'semantics',
      'mrow',
      'mi',
      'mn',
      'mo',
      'mtext',
      'mspace',
      'msub',
      'msup',
      'msubsup',
      'mfrac',
      'msqrt',
      'mroot',
      'mover',
      'munder',
      'munderover',
      'mtable',
      'mtr',
      'mtd',
      'menclose',
      'mpadded',
      'mstyle',
    ],
    allowedAttributes: {
      a: ['href', 'rel'],
      img: ['src', 'alt'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      '*': ['class'],
      td: ['style'],
      th: ['style'],
      span: ['style'],
      div: ['style'],
      math: ['xmlns', 'display'],
      mo: ['stretchy', 'fence', 'separator'],
      mspace: ['width'],
      mstyle: ['displaystyle', 'scriptlevel'],
    },
    allowedStyles: {
      td: { 'text-align': [/^(left|center|right)$/] },
      th: { 'text-align': [/^(left|center|right)$/] },
      div: { 'text-align': [/^(left|center|right)$/] },
      span: { color: [/^#[0-9a-fA-F]{6}$/] },
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'annotation'],
  });
}
