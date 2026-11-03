import { z } from 'zod';
import { mcpTransferInfoSchema } from './mcp-transfer-tools.js';
import type { KnowledgeToolDefinition } from './mcp-knowledge-tools.js';
const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  cursor = z.string().max(8192);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const rendering = {
  role: z.enum(['primary', 'embedded']),
  type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
  sourceHash: hash,
  renderHash: hash,
  title: z.string(),
  renderer: z.string(),
  config: z.record(z.string(), z.unknown()),
  expiresAt: z.number().int().positive(),
};
export const operationPreviewMetadata = object({
  id,
  noteId: id,
  ...rendering,
  kind: z.enum(['svg', 'mermaid', 'excalidraw']).optional(),
  documentHash: hash,
  baselineSourceHash: hash,
  sourceSizeBytes: z.number().int().nonnegative(),
});
export const portablePreviewMetadata = object({
  previewId: id,
  document: z.string().max(4096),
  ...rendering,
  type: z.literal('whiteboard'),
  direction: z.enum(['export', 'import']),
  sourceBytes: z.number().int().nonnegative(),
});
export const operationPreviewNeed = object({
  noteId: id,
  role: z.enum(['primary', 'embedded']),
  documentHash: hash,
  sourceHash: hash,
  renderHash: hash,
  snapshotId: id,
});
export const previewSourceChunk = object({
  id,
  sourceHash: hash,
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  encoding: z.literal('base64'),
  content: z.string().max(21848),
  eof: z.boolean(),
});
const sourceInput = {
  previewId: id,
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(1).max(16384).default(8192),
};
const upload = {
  previewId: id,
  sourceHash: hash,
  totalBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  sha256: hash,
  requestId,
};
const prepare = { previewId: id, sourceHash: hash, transferId: id, requestId };
function tool(
  name: string,
  description: string,
  scopes: string[],
  readOnly: boolean,
  input: z.ZodObject,
  output: z.ZodType,
): KnowledgeToolDefinition {
  return { name, description, scopes, readOnly, input, output };
}
const write = ['knowledge:read', 'knowledge:write'],
  read = ['knowledge:read'];
export const operationPreviewToolDefinitions: KnowledgeToolDefinition[] = [
  tool(
    'cancel_portable_preview',
    '取消本人的私有便携预览并回收源码与 PNG 暂存；不撤回已提交文档，不需要仍持有原目标路径权限。',
    [],
    false,
    object({ previewId: id }),
    object({ cancelled: z.literal(true) }),
  ),
  tool(
    'resume_organization_operation',
    '匹配的全部固定预览准备后继续本人的整理操作；保留 operationId，不重复提交计划。',
    ['knowledge:read', 'knowledge:write', 'knowledge:organize'],
    false,
    object({ operationId: id }),
    object({
      kind: z.literal('accepted'),
      operation: object({
        operationId: id,
        requestId,
        kind: z.string().max(128),
        status: z.string().max(64),
      }),
    }),
  ),
  tool(
    'list_operation_diagram_previews',
    '分页列出本人原生导航操作的全部固定预览需求；保存 planId 和 snapshotId，准备后重试原操作。',
    write,
    true,
    object({
      operationId: id,
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(20).default(20),
    }),
    object({
      planId: id,
      operationId: id,
      documents: z.array(operationPreviewNeed).max(20),
      totalCount: z.number().int().nonnegative(),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'get_operation_diagram_preview',
    '读取本人固定操作预览的渲染元数据和最多16KiB精确原件字节；每次重查当前基线及权限，不返回完整大原件。',
    write,
    true,
    object(sourceInput),
    object({ preview: operationPreviewMetadata, source: previewSourceChunk }),
  ),
  tool(
    'begin_operation_diagram_preview_upload',
    '为当前固定操作原件创建专用 PNG 上传；只接受匹配 sourceHash，使用 append_mcp_upload 后提交同一用途句柄。',
    write,
    false,
    object(upload),
    mcpTransferInfoSchema,
  ),
  tool(
    'prepare_operation_diagram_preview',
    '提交本人专用 PNG 上传并持久保存原件/渲染版本绑定；之后重试原操作，不接受替换原件。',
    write,
    false,
    object(prepare),
    object({
      preview: operationPreviewMetadata,
      preparedId: id,
      sourceHash: hash,
      renderHash: hash,
      previewHash: hash,
      expiresAt: z.number().int().positive(),
    }),
  ),
  tool(
    'list_portable_previews',
    '按原导出或导入 requestId 分页读取全部私有预览需求；保留该 requestId，准备后重试原交付。',
    read,
    true,
    object({
      requestId,
      direction: z.enum(['export', 'import']),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    object({
      requestId,
      direction: z.enum(['export', 'import']),
      items: z.array(portablePreviewMetadata).max(20),
      totalCount: z.number().int().nonnegative(),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'get_portable_preview',
    '有界读取本人私有便携预览原件及渲染元数据；导出只需当前读取权，导入须当前目标写入权。',
    read,
    true,
    object(sourceInput),
    object({ preview: portablePreviewMetadata, source: previewSourceChunk }),
  ),
  tool(
    'begin_portable_preview_upload',
    '为私有便携预览创建用途隔离的 PNG 上传；导出不写知识库附件，保留原交付 requestId。',
    read,
    false,
    object(upload),
    mcpTransferInfoSchema,
  ),
  tool(
    'prepare_portable_preview',
    '将匹配当前私有原件的 PNG 写入受配额控制的私有暂存；之后以原参数和原 requestId 重试导出或导入。',
    read,
    false,
    object(prepare),
    object({ preview: portablePreviewMetadata, previewHash: hash, ready: z.literal(true) }),
  ),
];
