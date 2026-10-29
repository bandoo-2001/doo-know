import { z } from 'zod';
import { mcpTransferInfoSchema } from './mcp-transfer-tools.js';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().nonnegative();
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const cursor = z.string().max(8192).optional();
const date = z.string().max(40);
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);
const metadataShape = {
  slug: z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: text(512).min(1), summary: text(2000), category: text(80),
  tags: z.array(text(80).min(1)).max(30), pinned: z.boolean(), cover: text(8192).nullable(),
};
export const blogToolMetadata = z.object(metadataShape).strict();
export const blogToolMetadataPatch = blogToolMetadata.partial();
const summaryShape = {
  id, sourceNoteId: id, slug: metadataShape.slug, title: metadataShape.title,
  category: metadataShape.category, tags: metadataShape.tags,
  state: z.enum(['draft', 'published', 'withdrawn']), version,
  publishedVersionId: id.nullable(), publishedAt: date.nullable(), updatedAt: date,
  hasUnpublishedChanges: z.boolean(),
};
export const blogToolPost = z.object({ ...metadataShape, ...summaryShape,
  sourceTitle: text(512), sourceModifiedAt: z.string().max(30), sourceHash: hash,
  url: z.string().max(4096).nullable(), truncatedMetadata: z.array(z.enum(['summary','category','tags','cover'])).max(4),
}).strict();
export const blogToolSummary = z.object(summaryShape).strict();
const page = { limit: z.number().int().min(1).max(20).default(10), cursor };
const settingsShape = {
  version, enabled: z.boolean(), title: text(256), description: text(2000),
  author: text(256), baseUrl: text(2048), theme: z.enum(['light', 'system']),
};
export const blogToolSettings = z.object({ ...settingsShape,
  about: text(8192), aboutBytes: z.number().int().nonnegative(), aboutHash: hash,
  aboutRange: z.object({ startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(), nextByte: z.number().int().nonnegative().nullable() }).strict(),
}).strict();
export const blogToolVersion = z.object({ id, postId: id, sourceModifiedAt: z.string().max(30), sourceHash: hash, createdAt: date, current: z.boolean() }).strict();
const diagram = z.object({ fenceFrom: z.number().int().nonnegative(), kind: z.enum(['svg','mermaid','excalidraw']), codeHash: hash, sourceHash: hash, whiteboardId: id.optional() }).strict();
const resource = z.object({ hash, mime: z.string().max(128), sizeBytes: z.number().int().nonnegative().max(10 * 1024 ** 2) }).strict();
export const blogToolCapturedResource = resource.extend({ postId: id, versionId: id }).strict();
export const blogToolVersionMetadata = blogToolMetadata.extend({ coverResource: blogToolCapturedResource.nullable() }).strict();
// Transfer metadata is intentionally independent of host paths and filesystem names.
export const blogToolTransfer = mcpTransferInfoSchema;
export const blogToolDefinitions = [
  { name: 'list_blog_taxonomy', description: '分页列出当前获准文章使用的分类或标签及计数；不会暴露其他文章的分类。', scope: 'blog:read', readOnly: true,
    input: z.object({ kind: z.enum(['categories','tags']), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(100000).default(0) }).strict(), output: z.object({ entries: z.array(z.object({ name: text(80), count: z.number().int().positive() }).strict()).max(50), total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable() }).strict() },
  { name: 'list_blog_posts', description: '分页查询获准文章，可按标题摘要、发布状态、分类或标签筛选；返回管理摘要，原文通过知识读取工具获取。', scope: 'blog:read', readOnly: true,
    input: z.object({ ...page, query: text(200).optional(), state: summaryShape.state.optional(), category: text(80).optional(), tag: text(80).optional() }).strict(),
    output: z.object({ posts: z.array(blogToolSummary).max(20), total: z.number().int().nonnegative(), nextCursor: z.string().nullable() }).strict() },
  { name: 'get_blog_post', description: '读取文章管理元数据和原文版本状态。truncatedMetadata 标记截短字段，完整元数据用 download_blog_content(kind=metadata)；不会发布文章。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id }).strict(), output: blogToolPost },
  { name: 'create_blog_draft', description: '从获准笔记创建博客草稿，需要站点范围的独立草稿编辑授权。相同 requestId 重试返回原回执；不会公开文章。', scope: 'blog:write', readOnly: false,
    input: z.object({ sourceNoteId: id, metadata: blogToolMetadataPatch.optional(), requestId }).strict(), output: blogToolPost },
  { name: 'update_blog_draft', description: '使用 expectedVersion 编辑文章元数据，包括已发布文章的未发布修改。不会替换公开快照，发布仍需单独授权。', scope: 'blog:write', readOnly: false,
    input: z.object({ postId: id, metadata: blogToolMetadataPatch, expectedVersion: version, requestId }).strict(), output: blogToolPost },
  { name: 'delete_blog_post', description: '按文章版本删除文章及其公开版本，需要单独管理权限；原笔记仍保留。', scope: 'blog:manage', readOnly: false, destructive: true,
    input: z.object({ postId: id, expectedVersion: version, requestId }).strict(), output: z.object({ deleted: z.literal(true) }).strict() },
  { name: 'get_blog_settings', description: '读取站点设置，必须具有站点范围的读取授权。关于文本按 UTF-8 字节分页。', scope: 'blog:read', readOnly: true,
    input: z.object({ aboutOffset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(4).max(8192).default(4096) }).strict(), output: blogToolSettings },
  { name: 'update_blog_settings', description: '按 expectedVersion 修改站点设置，需要站点管理权。启用中的站点修改还需要单独发布权；aboutTransferId 可提交完整关于文本。', scope: 'blog:manage', readOnly: false,
    input: z.object({ expectedVersion: version, settings: z.object({ enabled: z.boolean().optional(), title: text(256).optional(), description: text(2000).optional(), author: text(256).optional(), baseUrl: text(2048).optional(), theme: z.enum(['light','system']).optional(), about: text(8192).optional() }).strict(), aboutTransferId: id.optional(), requestId }).strict(), output: blogToolSettings },
  { name: 'list_blog_versions', description: '分页列出获准文章的不可变发布版本及对应原文摘要，不包含 HTML 或知识库历史文件位置。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, ...page }).strict(), output: z.object({ versions: z.array(blogToolVersion).max(20), nextCursor: z.string().nullable() }).strict() },
  { name: 'get_blog_version', description: '读取指定发布版本的元数据和不可变 coverResource 封面关联；原始 metadata.cover 保留私有附件引用。下载 HTML 请使用 download_blog_content。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, versionId: id }).strict(), output: z.object({ version: blogToolVersion, metadata: blogToolMetadata, coverResource: blogToolCapturedResource.nullable(), truncatedMetadata: z.array(z.enum(['summary','category','tags','cover'])).max(4), htmlBytes: z.number().int().nonnegative(), htmlHash: hash, headingCount: z.number().int().nonnegative() }).strict() },
  { name: 'list_blog_resources', description: '列出原文预览或指定发布版本实际使用的资源摘要；仅返回关联资源，不公开文件系统位置。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, versionId: id.optional(), limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().min(0).max(64).default(0) }).strict(), output: z.object({ resources: z.array(resource).max(20), total: z.number().int().min(0).max(64), nextOffset: z.number().int().nullable() }).strict() },
  { name: 'download_blog_resource', description: '为获准文章关联资源创建短期下载传输；使用 read_mcp_transfer 分块读取，传输期间复核授权和文章版本。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, versionId: id.optional(), hash }).strict(), output: blogToolTransfer },
  { name: 'download_blog_content', description: '下载完整文章/版本元数据 JSON、预览/发布 HTML、关于文本或单个图块代码。使用不透明分块传输；原文全文仍使用知识读取工具。', scope: 'blog:read', readOnly: true,
    input: z.object({ kind: z.enum(['preview_html','version_html','about','diagram_source','metadata','version_metadata']), postId: id.optional(), versionId: id.optional(), fenceFrom: z.number().int().nonnegative().optional() }).strict(), output: blogToolTransfer },
  { name: 'list_blog_diagrams', description: '分页列出全部缺少预览的图块，每页最多20个。发现数量不受发布限制；单次发布最多提交64个 PNG 预览且资源总量仍受限制。', scope: 'blog:read', readOnly: true,
    input: z.object({ postId: id, limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().nonnegative().default(0) }).strict(), output: z.object({ diagrams: z.array(diagram).max(20), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(), sourceHash: hash }).strict() },
  { name: 'begin_blog_upload', description: '为关于文本或图块 PNG 创建上传传输，分别要求站点管理权或发布权。声明长度及 SHA-256 后使用分块工具上传；不接收文件路径。', scope: 'blog:read', readOnly: false,
    input: z.object({ kind: z.enum(['about','diagram_png']), postId: id.optional(), expectedVersion: version, byteLength: z.number().int().min(1).max(10 * 1024 ** 2), sha256: hash, mime: z.enum(['text/plain','image/png']), requestId }).strict(), output: blogToolTransfer },
  { name: 'publish_blog_post_with_diagrams', description: '显式发布文章并使用已上传、绑定当前文章的图块 PNG，每次最多64个、预览合计20 MiB。必须匹配 fenceFrom、codeHash、sourceHash，且单独要求 blog:publish。', scope: 'blog:publish', readOnly: false,
    input: z.object({ postId: id, noteId: id, expectedModifiedAt: z.string().max(30), expectedContentHash: hash, expectedPublicationVersion: version, metadata: blogToolMetadataPatch.optional(), diagrams: z.array(diagram.omit({ whiteboardId: true }).extend({ transferId: id }).strict()).max(64), requestId }).strict(), output: blogToolPost },
] as const;
export type BlogToolName = typeof blogToolDefinitions[number]['name'];
export const blogToolDefinition = (name: string) => blogToolDefinitions.find(item => item.name === name);
