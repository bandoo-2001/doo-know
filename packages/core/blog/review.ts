import MarkdownIt from 'markdown-it';
import { extname } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { BlogPost } from '../../../shared/blog-contracts.js';
import type { BlogPublicationReview, BlogPublicationWarning } from '../../../shared/blog-design.js';
import { frontmatterRange } from '../../../shared/frontmatter-range.js';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { assetService } from '../assets.js';
import { HttpError } from '../errors.js';
import { localReference } from '../render.js';
import { authorizeBlogPath } from './resources.js';
import { sanitizePublicationHtml } from './publication.js';

const parser = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
const body = (content: string) => content.slice(frontmatterRange(content)?.end ?? 0);
function targets(content: string) {
  const values: { image: boolean; target: string }[] = [];
  const visit = (tokens: ReturnType<typeof parser.parse>) => {
    for (const token of tokens) {
      if (token.type === 'image' || token.type === 'link_open') {
        const image = token.type === 'image';
        const target = String(token.attrGet(image ? 'src' : 'href') || '');
        if (target) values.push({ image, target });
      }
      if (token.children) visit(token.children);
    }
  };
  visit(parser.parse(body(content), {}));
  return values;
}
const inaccessible = (error: unknown) =>
  error instanceof HttpError && [400, 403, 404].includes(error.statusCode);

/** Owner-only diagnostics never replace the publication-time source and resource checks. */
export function reviewBlogPublication(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  id: string,
  hooks: {
    postMetadata: (principal: Principal, postId: string) => BlogPost;
    previewSnapshot: (principal: Principal, postId: string) => { html: string };
  },
): BlogPublicationReview {
  const post = hooks.postMetadata(p, id);
  const source = notes.getNote(post.sourceNoteId);
  authorizeBlogPath(p, source.relativePath);
  const warnings: BlogPublicationWarning[] = [];
  let hideLinkedState = false;
  const seen = new Set<string>();
  const warn = (code: BlogPublicationWarning['code'], target: string, message: string) => {
    const key = code + '\0' + target;
    if (!seen.has(key) && warnings.length < 100) {
      seen.add(key);
      warnings.push({ code, target, message });
    }
  };
  const assets = assetService(config, db, notes);
  const refs = targets(source.content);
  if (post.cover) refs.push({ image: true, target: post.cover });
  for (const { image, target } of refs) {
    if (target.startsWith('#')) continue;
    const path = localReference(source.relativePath, target);
    if (image) {
      if (
        !path ||
        !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extname(path).toLowerCase())
      ) {
        warn('unsupported-image', target, '图片需要使用笔记中的本地图片附件。');
        continue;
      }
      try {
        authorizeBlogPath(p, path, true);
        assets.file(path);
      } catch (error) {
        if (!inaccessible(error)) throw error;
        warn('missing-image', target, '图片不存在或不在授权范围内，请重新选择附件。');
      }
    } else if (path?.toLowerCase().endsWith('.md')) {
      try {
        authorizeBlogPath(p, path);
      } catch (error) {
        if (!inaccessible(error)) throw error;
        hideLinkedState = true;
        warn('missing-link', target, '引用不存在或不在授权范围内，发布时将显示为文字。');
        continue;
      }
      const linked = db
        .prepare(
          'SELECT n.id,p.id AS postId,p.state FROM notes n LEFT JOIN blog_posts p ON p.source_note_id=n.id WHERE n.path=? AND n.active=1',
        )
        .get(path) as { id: string; postId: string | null; state: string | null } | undefined;
      if (linked?.postId) {
        try {
          hooks.postMetadata(p, linked.postId);
        } catch (error) {
          if (!inaccessible(error)) throw error;
          hideLinkedState = true;
          warn('missing-link', target, '引用不存在或不在授权范围内，发布时将显示为文字。');
          continue;
        }
      }
      let exists = !!linked;
      if (linked) {
        try {
          notes.exists(linked.id);
        } catch (error) {
          if (!inaccessible(error)) throw error;
          exists = false;
        }
      }
      if (!exists) warn('missing-link', target, '引用不存在或不在授权范围内，发布时将显示为文字。');
      else if (linked!.state !== 'published')
        warn('unpublished-link', target, '引用的笔记尚未发布，发布时将显示为文字。');
    }
  }
  let draftHtml: string;
  try {
    if (hideLinkedState) throw new HttpError(403, '引用不在授权范围内');
    draftHtml = hooks.previewSnapshot(p, id).html;
  } catch (error) {
    if (!warnings.length || !inaccessible(error)) throw error;
    // Broken attachments should not prevent diagnosis. This fallback removes
    // image requests entirely and still renders only the body, never YAML.
    const tokens = parser.parse(body(source.content), {});
    const clean = (list: typeof tokens) => {
      for (const token of list) {
        if (token.type === 'image') {
          token.type = 'text';
          token.tag = '';
          token.attrs = null;
          token.children = null;
          token.content = '[图片待修复：' + token.content + ']';
        }
        if (token.type === 'link_open') token.attrs = null;
        if (token.children) clean(token.children);
      }
    };
    clean(tokens);
    draftHtml = sanitizePublicationHtml(parser.renderer.render(tokens, parser.options, {}));
  }
  const previous = post.publishedVersionId
    ? (db
        .prepare('SELECT html FROM blog_versions WHERE id=? AND post_id=?')
        .get(post.publishedVersionId, id) as { html: string } | undefined)
    : undefined;
  const affectedPosts: BlogPublicationReview['affectedPosts'] = [];
  const candidates = db
    .prepare(
      "SELECT id FROM blog_posts WHERE state='published' AND id<>? ORDER BY updated_at DESC LIMIT 300",
    )
    .all(id) as { id: string }[];
  for (const candidate of candidates) {
    try {
      const accessible = hooks.postMetadata(p, candidate.id);
      const note = notes.getNote(accessible.sourceNoteId);
      authorizeBlogPath(p, note.relativePath);
      if (
        targets(note.content).some(
          (ref) =>
            !ref.image && localReference(note.relativePath, ref.target) === source.relativePath,
        )
      ) {
        affectedPosts.push({
          id: accessible.id,
          title: accessible.title,
          url: accessible.url || '/blog/' + accessible.slug,
        });
        if (affectedPosts.length === 50) break;
      }
    } catch (error) {
      if (!inaccessible(error)) throw error;
    }
  }
  const publishedHtml =
    previous?.html.replace(
      /(src|href)="\/blog\/assets\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([a-f0-9]{64})"/g,
      '$1="/api/blog/posts/$2/versions/$3/assets/$4"',
    ) ?? null;
  return { publishedHtml, draftHtml, warnings, affectedPosts };
}
