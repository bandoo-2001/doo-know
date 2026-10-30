import { z } from 'zod';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import {
  type BlogDesign,
  type BlogDesignState,
  type BlogSaveDesignInput,
  type BlogPublishDesignInput,
  type BlogRestoreDesignInput,
  type BlogDesignMedia,
} from '../../../shared/blog-design.js';
import type { AppDatabase } from '../db.js';
import { requireScope } from '../agent/auth.js';
import { authorizeDomainResource } from '../auth/permissions.js';
import { BlogError } from './errors.js';
import { blogHash } from './resources.js';
import { assertWritable } from '../knowledge/write-lease.js';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
const id = text(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const hash = /^[a-f0-9]{64}$/;
export function safeBlogLink(value: string): boolean {
  if (!value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return false;
  } catch {
    return false;
  }
  if (value.startsWith('/blog')) {
    if (!/^\/blog(?:\/|[?#]|$)/.test(value)) return false;
    try {
      const path = value.split(/[?#]/)[0];
      if (path.includes('//') || /%(?:25|2f|5c)/i.test(path)) return false;
      const decoded = decodeURIComponent(value);
      if (
        /[\\\u0000-\u001f\u007f]/.test(decoded) ||
        decoded.split(/[/?#]/).some((v) => v === '.' || v === '..')
      )
        return false;
      const url = new URL(value, 'https://blog.invalid');
      return url.pathname === '/blog' || url.pathname.startsWith('/blog/');
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:', 'mailto:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.protocol !== 'mailto:' || !url.search)
    );
  } catch {
    return false;
  }
}
const link = z.object({ id, label: text(100), href: text(2048).refine(safeBlogLink) }).strict();
const image = text(100).refine((v) => !v || /^\/blog\/media\/[a-f0-9]{64}$/.test(v));
const unique = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((v) => v.id)).size === items.length;
const links = z.array(link).max(30).refine(unique);
export const blogDesignSchema = z
  .object({
    template: z.enum(['journal', 'magazine', 'profile']),
    accent: text(7).regex(/^#[a-fA-F0-9]{6}$/),
    font: z.enum(['sans', 'serif']),
    width: z.enum(['comfortable', 'wide']),
    cardStyle: z.enum(['plain', 'bordered']),
    profile: z
      .object({
        name: text(256),
        tagline: text(1000),
        bio: z
          .string()
          .max(50000)
          .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)),
        avatar: image,
        cover: image,
      })
      .strict(),
    navigation: links,
    socialLinks: links,
    modules: z
      .array(
        z
          .object({
            id,
            kind: z.enum(['intro', 'featured', 'latest', 'collections', 'projects', 'links']),
            title: text(256),
            enabled: z.boolean(),
            limit: z.number().int().min(1).max(50),
          })
          .strict(),
      )
      .max(30)
      .refine(unique),
    collections: z
      .array(
        z
          .object({
            id,
            slug: text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            title: text(256),
            description: text(2000),
            postIds: z
              .array(text(100).min(1))
              .max(500)
              .refine((v) => new Set(v).size === v.length),
          })
          .strict(),
      )
      .max(100)
      .refine(unique)
      .refine((v) => new Set(v.map((x) => x.slug)).size === v.length),
    projects: z
      .array(
        z
          .object({
            id,
            title: text(256),
            description: text(2000),
            href: text(2048).refine(safeBlogLink),
          })
          .strict(),
      )
      .max(100)
      .refine(unique),
    friendLinks: links,
  })
  .strict();
export function validateBlogDesign(input: unknown): BlogDesign {
  const parsed = blogDesignSchema.safeParse(input);
  if (!parsed.success) throw new BlogError(400, '博客装修配置格式不正确');
  return parsed.data;
}
export function authorizeStudio(p: Principal, action: 'read' | 'manage' | 'publish') {
  requireScope(p, 'knowledge:read');
  if (p.policyVersion === 2 || p.permissionCeiling || p.pluginId === 'mcp')
    requireScope(p, 'blog:' + action);
  else if (action !== 'read') {
    requireScope(p, 'knowledge:write');
    if (action === 'publish') requireScope(p, 'blog:publish');
  }
  authorizeDomainResource(p, 'blog', action);
}
const request = text(128).regex(/^[A-Za-z0-9_-]{8,128}$/);
const expectedVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const publishSchema = z.object({ expectedVersion, requestId: request }).strict();
const saveSchema = publishSchema.extend({ design: blogDesignSchema });
const restoreSchema = publishSchema.extend({ revision: expectedVersion });
const uploadSchema = z
  .object({
    name: text(256).min(1),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    base64: z.string().max(7 * 1024 ** 2),
    requestId: request,
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BlogError(400, '博客装修请求格式不正确');
  return result.data;
}
export function assertStudioImage(bytes: Buffer, mime: string): void {
  if (bytes.length > 5 * 1024 ** 2) throw new BlogError(413, '图片不能超过 5 MiB');
  const signatures: Record<string, boolean> = {
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,

    'image/webp':
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
  };
  if (!signatures[mime]) throw new BlogError(400, '图片内容与格式不匹配');
}
export function studioService(
  db: AppDatabase,
  helpers: {
    enabled: () => boolean;
    mutate: <T>(kind: string, work: () => T) => T;
    receipt: <T>(p: Principal, kind: string, input: unknown, work: () => T) => T;
  },
) {
  const raw = () =>
    db.prepare('SELECT * FROM blog_design_state WHERE id=1').get() as {
      version: number;
      draft_json: string;
      published_json: string;
      published_revision: number;
      published_at: string | null;
    };
  function state(): BlogDesignState {
    const r = raw();
    return {
      version: r.version,
      draft: JSON.parse(r.draft_json),
      published: JSON.parse(r.published_json),
      publishedRevision: r.published_revision,
      publishedAt: r.published_at,
      hasUnpublishedChanges: r.draft_json !== r.published_json,
      history: db
        .prepare(
          'SELECT revision,published_at AS publishedAt FROM blog_design_history ORDER BY revision DESC',
        )
        .all() as BlogDesignState['history'],
    };
  }
  function checkVersion(expected: number) {
    if (raw().version !== expected) throw new BlogError(409, '博客装修已变化，请重新读取');
  }
  function mediaReferences(design: BlogDesign) {
    return [design.profile.avatar, design.profile.cover]
      .filter(Boolean)
      .map((v) => v.slice('/blog/media/'.length));
  }
  function requireMedia(design: BlogDesign) {
    let total = 0;
    for (const h of new Set(mediaReferences(design))) {
      const media = db
        .prepare('SELECT length(bytes) AS size FROM blog_design_media WHERE hash=?')
        .get(h) as { size: number } | undefined;
      if (!media) throw new BlogError(400, '装修图片不存在，请重新上传');
      total += media.size;
    }
    if (total > 20 * 1024 ** 2) throw new BlogError(413, '装修图片总大小不能超过 20 MiB');
  }
  function designState(p: Principal) {
    authorizeStudio(p, 'read');
    return state();
  }
  function saveDesign(p: Principal, input: BlogSaveDesignInput, replayInput?: Record<string, unknown>) {
    authorizeStudio(p, 'manage');
    const data = parse(saveSchema, input);
    return helpers.mutate('design.save', () =>
      helpers.receipt(p, 'design.save', replayInput ?? data, () => {
        assertWritable(db);
        checkVersion(data.expectedVersion);
        requireMedia(data.design);
        db.prepare('UPDATE blog_design_state SET draft_json=?,version=version+1 WHERE id=1').run(
          JSON.stringify(data.design),
        );
        return state();
      }),
    );
  }
  function publishDesign(p: Principal, input: BlogPublishDesignInput) {
    authorizeStudio(p, 'publish');
    const data = parse(publishSchema, input);
    return helpers.mutate('design.publish', () =>
      helpers.receipt(p, 'design.publish', data, () => {
        assertWritable(db);
        checkVersion(data.expectedVersion);
        const r = raw(),
          design = validateBlogDesign(JSON.parse(r.draft_json));
        requireMedia(design);
        const revision = r.published_revision + 1,
          at = new Date().toISOString();
        db.prepare(
          'UPDATE blog_design_state SET published_json=draft_json,published_revision=?,published_at=?,version=version+1 WHERE id=1',
        ).run(revision, at);
        db.prepare('INSERT INTO blog_design_history VALUES(?,?,?)').run(revision, r.draft_json, at);
        db.prepare(
          'DELETE FROM blog_design_history WHERE revision NOT IN (SELECT revision FROM blog_design_history ORDER BY revision DESC LIMIT 10)',
        ).run();
        return state();
      }),
    );
  }
  function restoreDesign(p: Principal, input: BlogRestoreDesignInput) {
    authorizeStudio(p, 'manage');
    const data = parse(restoreSchema, input);
    return helpers.mutate('design.restore', () =>
      helpers.receipt(p, 'design.restore', data, () => {
        assertWritable(db);
        checkVersion(data.expectedVersion);
        const revision = db
          .prepare('SELECT design_json FROM blog_design_history WHERE revision=?')
          .get(data.revision) as { design_json: string } | undefined;
        if (!revision) throw new BlogError(404, '装修历史不存在');
        db.prepare('UPDATE blog_design_state SET draft_json=?,version=version+1 WHERE id=1').run(
          revision.design_json,
        );
        return state();
      }),
    );
  }
  function publicDesign() {
    if (!helpers.enabled()) throw new BlogError(404, '博客页面不存在');
    return JSON.parse(raw().published_json) as BlogDesign;
  }
  function previewDesign(p: Principal, design?: BlogDesign) {
    authorizeStudio(p, 'read');
    return design === undefined ? state().draft : validateBlogDesign(design);
  }
  function uploadDesignMedia(
    p: Principal,
    input: { name: string; mime: string; base64: string; requestId: string },
    replayInput?: Record<string, unknown>,
    boundVersion?: number,
  ): BlogDesignMedia {
    authorizeStudio(p, 'manage');
    const data = parse(uploadSchema, input);
    if (!data.base64 || data.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data.base64))
      throw new BlogError(400, '图片编码格式不正确');
    const bytes = Buffer.from(data.base64, 'base64');
    if (bytes.toString('base64') !== data.base64) throw new BlogError(400, '图片编码格式不正确');
    assertStudioImage(bytes, data.mime);
    const h = blogHash(bytes);
    return helpers.mutate('design.media', () =>
      helpers.receipt(p, 'design.media', replayInput ?? { ...data, base64: h }, () => {
        assertWritable(db);
        if (boundVersion !== undefined) checkVersion(boundVersion);
        db.prepare('INSERT OR IGNORE INTO blog_design_media VALUES(?,?,?)').run(
          h,
          data.mime,
          bytes,
        );
        return {
          hash: h,
          mime: data.mime,
          url: '/blog/media/' + h,
          previewUrl: '/api/blog/design/media/' + h,
          size: bytes.length,
        };
      }),
    );
  }
  function readMedia(h: string) {
    if (!hash.test(h)) throw new BlogError(404, '装修图片不存在');
    const media = db.prepare('SELECT mime,bytes FROM blog_design_media WHERE hash=?').get(h) as
      | { mime: string; bytes: Buffer }
      | undefined;
    if (!media) throw new BlogError(404, '装修图片不存在');
    return media;
  }
  function designMedia(p: Principal, h: string) {
    authorizeStudio(p, 'read');
    return readMedia(h);
  }
  function publicDesignMedia(h: string) {
    if (!mediaReferences(publicDesign()).includes(h)) throw new BlogError(404, '装修图片不存在');
    return readMedia(h);
  }
  return {
    designState,
    saveDesign,
    publishDesign,
    restoreDesign,
    publicDesign,
    previewDesign,
    uploadDesignMedia,
    designMedia,
    publicDesignMedia,
  };
}
