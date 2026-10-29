import { z } from 'zod';
import { mcpTransferInfoSchema } from './mcp-transfer-tools.js';
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const history = z.array(z.object({ revision: version, publishedAt: z.string().max(40) }).strict()).max(10);
const summary = z.object({ version, publishedRevision: nonnegative, publishedAt: z.string().max(40).nullable(), hasUnpublishedChanges: z.boolean(), draftBytes: nonnegative, draftHash: hash, publishedBytes: nonnegative, publishedHash: hash, history }).strict();
const comparison = z.object({ byteLength: nonnegative, sha256: hash }).strict();
export const blogDesignToolDefinitions = [
  { name: 'get_blog_design', description: '站点范围读取装修草稿或线上配置的完整 JSON，按 UTF-8 字节分页并返回哈希、版本及历史；不会截断总配置。', scope: 'blog:read', readOnly: true,
    input: z.object({ kind: z.enum(['draft','published']).default('draft'), offset: nonnegative.default(0), maxBytes: z.number().int().min(4).max(8192).default(4096) }).strict(),
    output: summary.extend({ kind: z.enum(['draft','published']), json: z.string().max(8192), byteLength: nonnegative, sha256: hash, startByte: nonnegative, endByte: nonnegative, nextByte: nonnegative.nullable() }).strict() },
  { name: 'update_blog_design', description: '以 expectedVersion 保存装修草稿，不自动发布。designJson 接收最多24000 UTF-8字节 JSON，完整大配置用 begin_blog_design_upload(kind=design) 上传后提交 designTransferId；两者只选其一。', scope: 'blog:manage', readOnly: false,
    input: z.object({ expectedVersion: version, designJson: z.string().max(24000).optional(), designTransferId: id.optional(), requestId }).strict(), output: summary },
  { name: 'publish_blog_design', description: '显式发布当前装修草稿，需要独立站点发布权；返回有界回执，不包含全部配置。', scope: 'blog:publish', readOnly: false,
    input: z.object({ expectedVersion: version, requestId }).strict(), output: summary },
  { name: 'restore_blog_design', description: '将指定装修历史恢复到草稿，需要站点管理权；线上配置需另行发布才改变。', scope: 'blog:manage', readOnly: false,
    input: z.object({ expectedVersion: version, revision: version, requestId }).strict(), output: summary },
  { name: 'begin_blog_design_upload', description: '创建绑定当前装修版本和站点管理权的不透明上传。design 为最多16MiB的JSON，media 为最多5MiB的PNG/JPEG/WebP。使用 append_mcp_upload 分块后提交，不接受文件路径或内联图片。', scope: 'blog:manage', readOnly: false,
    input: z.object({ kind: z.enum(['design','media']), expectedVersion: version, byteLength: z.number().int().min(1).max(16 * 1024 ** 2), sha256: hash, mime: z.enum(['application/json','image/png','image/jpeg','image/webp']), name: z.string().min(1).max(256), requestId }).strict(), output: mcpTransferInfoSchema },
  { name: 'commit_blog_design_media', description: '提交当前装修版本绑定的图片上传，校验真实格式与长度后返回稳定媒体引用；上传不会自动写入装修或公开图片。', scope: 'blog:manage', readOnly: false,
    input: z.object({ transferId: id, expectedVersion: version, requestId }).strict(), output: z.object({ hash, mime: z.string().max(128), url: z.string().max(128), previewUrl: z.string().max(128), size: nonnegative }).strict() },
  { name: 'get_blog_publication_review', description: '分页读取获准文章的发布诊断和受影响引用，返回待发/线上HTML的字节及哈希比较，不包含大块HTML。完整正文使用现有下载工具；truncated 标记过长引用摘要。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, warningOffset: nonnegative.default(0), affectedOffset: nonnegative.default(0), limit: z.number().int().min(1).max(8).default(5) }).strict(),
    output: z.object({ warnings: z.array(z.object({ code: z.enum(['unpublished-link','missing-link','missing-image','unsupported-image']), target: z.string().max(256), message: z.string().max(256), truncated: z.boolean() }).strict()).max(8), warningTotal: nonnegative, nextWarningOffset: nonnegative.nullable(), affectedPosts: z.array(z.object({ id, title: z.string().max(128), url: z.string().max(256), truncated: z.boolean() }).strict()).max(8), affectedTotal: nonnegative, nextAffectedOffset: nonnegative.nullable(), comparison: z.object({ draft: comparison, published: comparison.nullable(), changed: z.boolean() }).strict() }).strict() },
] as const;
