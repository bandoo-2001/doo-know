import { z } from 'zod';
import { diagramPreparationSchema } from './diagram-document-contracts.js';
import { mcpTransferInfoSchema } from './mcp-transfer-tools.js';
const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const type = diagramPreparationSchema.shape.type;
const target = diagramPreparationSchema.shape.target;
const asset = object({
  id,
  relativePath: z.string().max(4096),
  markdownPath: z.string().max(4096),
  mime: z.string().max(128),
});
export const primaryCreationIntent = object({
  id,
  noteId: id,
  relativePath: z.string().max(2048),
  documentType: type,
  status: z.enum(['reserved', 'prepared', 'committing', 'published', 'cancelled', 'expired']),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  commitOperationId: id.optional(),
});
export const primaryPreparedReceipt = object({
  id,
  noteId: id,
  creationIntentId: id.optional(),
  type,
  documentHash: hash.nullable(),
  baselineSourceHash: hash.nullable(),
  sourceHash: hash,
  renderHash: hash,
  previewHash: hash,
  preview: asset,
  source: asset.optional(),
  expiresAt: z.number().int(),
});
export const primaryCommitReceipt = object({
  id,
  relativePath: z.string().max(2048),
  documentType: type,
  title: z.string().max(2000),
  modifiedAt: z.string().regex(/^\d{1,30}$/),
  updatedAt: z.string().max(64),
  contentHash: hash,
  sizeBytes: z.number().int().nonnegative(),
  indexState: z.string().max(40),
});
export const primaryDiagramProtocols = [
  {
    name: 'reserve_diagram_document',
    description: '为新的 Markdown 主图预留稳定 UUID；源与 PNG 完整提交前不会创建活动笔记。',
    readOnly: false,
    input: object({ path: z.string().min(1).max(2048), type, requestId }),
    output: primaryCreationIntent,
  },
  {
    name: 'get_diagram_creation_intent',
    description: '查询当前主体与客户端拥有的主图创建意图及状态。',
    readOnly: true,
    input: object({ intentId: id }),
    output: primaryCreationIntent,
  },
  {
    name: 'cancel_diagram_creation_intent',
    description: '取消尚未发布的主图创建意图；提交中必须先核对结果。',
    readOnly: false,
    input: object({ intentId: id }),
    output: primaryCreationIntent,
  },
  {
    name: 'begin_primary_diagram_upload',
    description:
      '创建绑定同一主图目标、类型及源/PNG角色的有界上传；随后用 append_mcp_upload 分块追加。',
    readOnly: false,
    input: object({
      target,
      type,
      sourceBytes: z
        .number()
        .int()
        .min(0)
        .max(8 * 1024 * 1024),
      previewBytes: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
      sourceSha256: hash.optional(),
      previewSha256: hash.optional(),
      requestId,
    }),
    output: object({ source: mcpTransferInfoSchema, preview: mcpTransferInfoSchema }),
  },
  {
    name: 'prepare_primary_diagram',
    description:
      '从完整上传的同快照源与PNG准备主图；返回精简收据。合并调用参数 title/renderer/config 后用 Markdown serializer 生成完整主文件。',
    readOnly: false,
    input: object({
      target,
      type,
      title: diagramPreparationSchema.shape.title,
      renderer: diagramPreparationSchema.shape.renderer,
      config: diagramPreparationSchema.shape.config,
      sourceTransferId: id,
      previewTransferId: id,
      sourceHash: hash,
      requestId,
    }),
    output: primaryPreparedReceipt,
  },
  {
    name: 'begin_primary_diagram_document_upload',
    description: '为已准备主图创建最多20MiB完整 Markdown 上传；绑定准备身份和固定目标版本。',
    readOnly: false,
    input: object({
      preparedId: id,
      totalBytes: z
        .number()
        .int()
        .positive()
        .max(20 * 1024 * 1024),
      sha256: hash.optional(),
      requestId,
    }),
    output: mcpTransferInfoSchema,
  },
  {
    name: 'commit_primary_diagram',
    description:
      '提交完整 Markdown 并激活同一预留 UUID；返回有界元数据。结果未知时使用原 requestId 与句柄重试。',
    readOnly: false,
    input: object({ preparedId: id, documentTransferId: id, requestId }),
    output: primaryCommitReceipt,
  },
];
export const primaryDiagramToolNames = new Set(primaryDiagramProtocols.map((tool) => tool.name));
