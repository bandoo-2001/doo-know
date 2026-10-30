import { z } from 'zod';
import { mcpTransferInfoSchema } from './mcp-transfer-tools.js';

const id = z.string().min(1).max(256),
  path = z.string().max(4096),
  cursor = z.string().max(8192);
const version = z.string().regex(/^\d{1,30}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const page = { limit: z.number().int().min(1).max(30).default(10), cursor: cursor.optional() };
const note = { noteId: id },
  mutation = { ...note, expectedModifiedAt: version, requestId };
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const error = object({ code: z.string().max(64), retryable: z.boolean() });
const fileResult = object({
  id: id.optional(),
  relativePath: path.optional(),
  modifiedAt: version.optional(),
  contentHash: hash.optional(),
  sourceHash: hash.optional(),
  snapshotId: id.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  editCount: z.number().int().nonnegative().optional(),
  indexState: z.string().max(40).optional(),
  archived: z.boolean().optional(),
});
const operation = object({
  operationId: id,
  requestId: z.string().min(1).max(256),
  kind: z.string().max(128),
  status: z.enum([
    'prepared',
    'queued',
    'running',
    'committing',
    'succeeded',
    'failed',
    'cancelled',
    'needs_reconciliation',
  ]),
  snapshotId: id.optional(),
  result: fileResult.optional(),
  error: error.optional(),
});
const write = object({
  id,
  relativePath: path,
  modifiedAt: version,
  contentHash: hash,
  sizeBytes: z.number().int().nonnegative(),
  indexState: z.string().max(40),
});
const restored = write.extend({ restored: z.literal(true) }).strict();
const readInput = {
  snapshotId: id.optional(),
  cursor: cursor.optional(),
  maxBytes: z.number().int().min(4).max(16384).default(8192),
  range: object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    lineByteOffset: z.number().int().nonnegative().optional(),
  })
    .refine((r) => r.endLine >= r.startLine && r.endLine - r.startLine < 200)
    .optional(),
};
const read = object({
  snapshotId: id,
  sourceHash: hash,
  modifiedAt: version,
  content: z.string().max(16384),
  startLine: z.number().int().positive(),
  endLine: z.number().int().nonnegative(),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  bytesReturned: z.number().int().min(0).max(16384),
  hasMore: z.boolean(),
  nextCursor: cursor.optional(),
  budgetRemainingBytes: z.number().int(),
  rangeHash: hash,
  lineByteOffset: z.number().int().nonnegative(),
});
const readReply = z.discriminatedUnion('kind', [
  object({ kind: z.literal('ready'), data: read }),
  object({ kind: z.literal('accepted'), operation }),
]);
const share = object({
  enabled: z.boolean(),
  state: z.enum(['private', 'active', 'expired', 'revoked']),
  permission: z.enum(['view', 'edit']),
  expiresAt: z.string().max(64).nullable(),
  token: z.string().max(64).optional(),
  url: z.string().max(2048).optional(),
  editSupported: z.boolean(),
  editUnavailableReason: z.string().max(1024).optional(),
});
const shareOptions = {
  permission: z.enum(['view', 'edit']).optional(),
  expiresAt: z.string().max(64).nullable().optional(),
};
const asset = object({
  id,
  relativePath: path,
  mime: z.string().max(128),
  markdownPath: path.optional(),
});
const collectionNote = object({
  id,
  path,
  name: z.string().max(256),
  title: z.string().max(1024),
  summary: z.string().max(2048),
  summaryState: z.enum(['ready', 'pending', 'unavailable']),
  updatedAt: z.string().max(64).nullable(),
  favorite: z.boolean(),
});
const folderReceipt = object({ id, relativePath: path, deleted: z.boolean() });
const conflictResolution = object({
  id,
  operationId: id,
  resolved: z.literal(true),
  strategy: z.literal('keep_disk'),
  relativePath: path,
  modifiedAt: version,
  contentHash: hash,
  sizeBytes: z.number().int().nonnegative(),
  evidencePreserved: z.literal(true),
});
const fileConflict = object({
  id,
  noteId: id,
  kind: z.string().max(128),
  status: z.string().max(64),
  relativePath: path,
  resolvable: z.boolean(),
  reason: z.string().max(128).optional(),
  disk: object({
    modifiedAt: version,
    contentHash: hash,
    sizeBytes: z.number().int().nonnegative(),
  }).nullable(),
});
const syncConflict = object({
  id,
  status: z.string().max(64),
  resolvable: z.literal(false),
  reason: z.string().max(128),
});
const organizationConflict = object({
  operationId: id,
  status: z.enum(['committing', 'needs_reconciliation']),
  code: z.string().max(64),
});
// Transfer sessions never contain file bytes or host filesystem paths in their DTOs.
export const knowledgeTransfer = mcpTransferInfoSchema;
const bundleItem = object({
  path,
  targetPath: path,
  kind: z.enum(['note', 'asset']),
  state: z.enum(['pending', 'succeeded', 'skipped', 'failed']),
  noteId: id.optional(),
  error: z.string().max(128).optional(),
});
export const knowledgeBundleJob = object({
  jobId: id,
  requestId,
  kind: z.enum(['import', 'export']),
  state: z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']),
  revision: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  download: knowledgeTransfer.optional(),
  error: z.string().max(128).optional(),
});
const begin = {
  requestId,
  name: z.string().min(1).max(180),
  mime: z.string().max(128),
  totalBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  sha256: hash.optional(),
};
const transferComplete = { transferId: id, requestId };
export type KnowledgeToolDefinition = {
  name: string;
  description: string;
  scopes: string[];
  readOnly: boolean;
  destructive?: boolean;
  input: z.ZodObject;
  output: z.ZodType;
};
const tool = (
  name: string,
  description: string,
  scopes: string[],
  readOnly: boolean,
  input: z.ZodObject,
  output: z.ZodType,
  destructive = false,
): KnowledgeToolDefinition => ({
  name,
  description,
  scopes,
  readOnly,
  input,
  output,
  ...(destructive ? { destructive: true } : {}),
});
const readScopes = ['knowledge:read'],
  archiveScopes = ['knowledge:read', 'knowledge:archive'],
  writeScopes = ['knowledge:read', 'knowledge:write'];
export const knowledgeToolDefinitions: KnowledgeToolDefinition[] = [
  tool(
    'list_note_revisions',
    '分页列出授权笔记的历史版本摘要；不返回本机历史文件路径。',
    readScopes,
    true,
    object({ ...note, ...page }),
    object({
      items: z
        .array(
          object({
            id,
            createdAt: z.string().max(64),
            modifiedAt: version,
            sizeBytes: z.number().int().nonnegative(),
          }),
        )
        .max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'read_note_revision',
    '按笔记和版本读取有界历史快照；异步准备后查询 operation_status，保留原续页游标。',
    readScopes,
    true,
    object({ ...note, revisionId: id, ...readInput }),
    readReply,
  ),
  tool(
    'restore_note_revision',
    '核对当前笔记版本后通过文件任务恢复历史版本；使用原 requestId 重试并查询 operation_status。',
    writeScopes,
    false,
    object({ ...mutation, revisionId: id }),
    object({ kind: z.literal('accepted'), operation }),
  ),
  tool(
    'list_archived_notes',
    '分页列出当前有权管理的单篇回收站身份；目录回收站另行查询。',
    archiveScopes,
    true,
    object(page),
    object({
      items: z.array(object({ id, relativePath: path })).max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'restore_archived_note',
    '恢复指定回收站笔记身份，可指定同目录安全文件名；同名冲突保留原件。',
    [...archiveScopes, 'knowledge:write'],
    false,
    object({ ...note, fileName: z.string().min(1).max(180).optional(), requestId }),
    restored,
  ),
  tool(
    'archive_note_folder',
    '按目录当前子树版本整体归档目录及附件；需要整个目录的整理、写入和归档权限。',
    [...archiveScopes, 'knowledge:write', 'knowledge:organize'],
    false,
    object({ directoryId: id, expectedSubtreeRevision: hash, requestId }),
    folderReceipt,
    true,
  ),
  tool(
    'list_archived_folders',
    '分页列出当前授权范围内的目录回收站记录。',
    archiveScopes,
    true,
    object(page),
    object({
      items: z
        .array(
          object({
            id,
            relativePath: path,
            deletedAt: z.number().int().nonnegative(),
            noteCount: z.number().int().nonnegative(),
          }),
        )
        .max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'restore_archived_folder',
    '恢复指定目录回收站身份和全部子项；可更换同级目录名。',
    [...archiveScopes, 'knowledge:write', 'knowledge:organize'],
    false,
    object({ folderId: id, name: z.string().min(1).max(180).optional(), requestId }),
    folderReceipt,
  ),
  tool(
    'get_note_backlinks',
    '分页检查授权笔记中指向目标的链接，返回已检查及跳过数量。',
    readScopes,
    true,
    object({ ...note, cursor: cursor.optional() }),
    object({
      matches: z.array(object({ id, title: z.string().max(1024), relativePath: path })).max(50),
      checked: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      incomplete: z.boolean(),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'list_note_collection',
    '分页读取当前授权范围的最近笔记或个人收藏摘要；列表变化后重新查询。',
    readScopes,
    true,
    object({ kind: z.enum(['recent', 'favorites']), ...page }),
    object({
      items: z.array(collectionNote).max(30),
      nextCursor: cursor.nullable(),
      total: z.number().int().nonnegative(),
      version: z.string().max(256),
    }),
  ),
  tool(
    'get_note_collection_status',
    '返回授权范围内最近或收藏列表版本与总数。',
    readScopes,
    true,
    object({ kind: z.enum(['recent', 'favorites']) }),
    object({ total: z.number().int().nonnegative(), version: z.string().max(256) }),
  ),
  tool(
    'set_note_favorite',
    '为当前用户设置指定授权笔记的收藏状态；稳定 requestId 保证重试。',
    writeScopes,
    false,
    object({ ...note, favorite: z.boolean(), requestId }),
    object({ favorite: z.boolean() }),
  ),
  tool(
    'list_note_assets',
    '分页列出授权笔记可管理的附件摘要；下载需附属笔记授权。',
    readScopes,
    true,
    object({ ...note, ...page }),
    object({ items: z.array(asset).max(30), nextCursor: cursor.optional() }),
  ),
  tool(
    'begin_note_asset_upload',
    '为指定笔记版本准备有界附件上传；用 append_mcp_upload 分块上传，再完成。',
    writeScopes,
    false,
    object({ ...mutation, ...begin }),
    knowledgeTransfer,
  ),
  tool(
    'complete_note_asset_upload',
    '校验上传归属和当前笔记版本后保存附件；重复调用返回原收据。',
    writeScopes,
    false,
    object(transferComplete),
    asset,
  ),
  tool(
    'download_note_asset',
    '创建笔记附件下载会话；用 read_mcp_transfer 分块读取。',
    readScopes,
    true,
    object({ ...note, assetId: id, requestId, source: z.boolean().default(true) }),
    knowledgeTransfer,
  ),
  tool(
    'prepare_note_diagram',
    '从同一笔记版本的图形源和 PNG 上传生成可编辑图形组；只准备附件，插入正文用 patch_note。',
    writeScopes,
    false,
    object({
      ...mutation,
      kind: z.enum(['svg', 'mermaid', 'excalidraw']),
      sourceTransferId: id,
      previewTransferId: id,
      sourceHash: hash,
    }),
    object({ sourceHash: hash, preview: asset, source: asset }),
  ),
  tool(
    'resolve_note_whiteboard',
    '解析笔记中的白板引用并核对目标白板独立读取权限；正文用 read_note 或文档下载。',
    readScopes,
    true,
    object({ ...note, source: z.string().min(1).max(2048) }),
    object({
      id,
      relativePath: path,
      modifiedAt: version,
      contentHash: hash.nullable(),
      documentType: z.literal('whiteboard'),
    }),
  ),
  tool(
    'begin_note_document_upload',
    '准备 Markdown 或白板文档上传；新建提供目录，更新提供 noteId 和当前版本。',
    writeScopes,
    false,
    object({
      ...begin,
      directory: z
        .string()
        .max(2048)
        .optional()
        .describe('与name组合后的目标相对路径最多2048字符；开始上传前核对。'),
      noteId: id.optional(),
      expectedModifiedAt: version.optional(),
    }).refine((a) =>
      a.noteId
        ? !!a.expectedModifiedAt && a.directory === undefined
        : a.directory !== undefined && !a.expectedModifiedAt,
    ),
    knowledgeTransfer,
  ),
  tool(
    'complete_note_document_upload',
    '通过正常知识写入服务导入上传文档，保留类型校验、版本比较和稳定收据。',
    writeScopes,
    false,
    object(transferComplete),
    write,
  ),
  tool(
    'download_note_document',
    '从授权快照创建完整 Markdown/白板下载会话；快照准备中返回 operationId。',
    readScopes,
    true,
    object({ ...note, requestId, snapshotId: id.optional() }),
    z.union([knowledgeTransfer, object({ kind: z.literal('accepted'), operation })]),
  ),
  tool(
    'get_note_share',
    '查询指定笔记分享状态和链接；需要独立分享权限。',
    [...readScopes, 'knowledge:share'],
    true,
    object(note),
    share,
  ),
  tool(
    'create_note_share',
    '显式创建或更新公开分享；需独立分享权、当前笔记版本和稳定 requestId。修改已有有效分享必须提供当前 expectedToken。',
    [...readScopes, 'knowledge:share'],
    false,
    object({
      ...mutation,
      ...shareOptions,
      expectedToken: z.string().max(64).nullable().optional(),
    }),
    share,
  ),
  tool(
    'rotate_note_share',
    '显式轮换公开分享链接，使旧链接失效；核对当前 token 和笔记版本。',
    [...readScopes, 'knowledge:share'],
    false,
    object({ ...mutation, ...shareOptions, expectedToken: z.string().max(64) }),
    share,
    true,
  ),
  tool(
    'revoke_note_share',
    '撤销指定笔记公开分享；核对当前 token 和笔记版本，按原 requestId 重试。',
    [...readScopes, 'knowledge:share'],
    false,
    object({ ...mutation, expectedToken: z.string().max(64).nullable() }),
    share,
    true,
  ),
  tool(
    'get_knowledge_organization_settings',
    '读取全库整理记录保留期限；需要独立的全库资料维护权限。',
    ['knowledge:read', 'knowledge:manage'],
    true,
    object({}),
    object({ retentionDays: z.number().int().min(1).max(3650) }),
  ),
  tool(
    'update_knowledge_organization_settings',
    '核对旧期限后更新未来整理记录保留期限；需要独立的全库资料维护与写入权限。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    false,
    object({
      retentionDays: z.number().int().min(1).max(3650),
      expectedRetentionDays: z.number().int().min(1).max(3650),
      requestId,
    }),
    object({ retentionDays: z.number().int().min(1).max(3650) }),
  ),
  tool(
    'list_knowledge_conflicts',
    '分页列出文件、Git 或目录整理冲突；需要全库资料维护权限。Git/多文件冲突保留明确的人工核对原因。',
    ['knowledge:read', 'knowledge:manage'],
    true,
    object({ kind: z.enum(['files', 'sync', 'organization']), ...page }),
    object({
      items: z.array(z.union([fileConflict, syncConflict, organizationConflict])).max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'resolve_knowledge_conflict',
    '核对磁盘版本与摘要后保留磁盘内容并保存冲突证据；仅处理服务判定可解决的文件冲突。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    false,
    object({
      conflictId: id,
      strategy: z.literal('keep_disk'),
      expectedModifiedAt: version,
      expectedContentHash: hash,
      requestId,
    }),
    conflictResolution,
  ),
  tool(
    'get_knowledge_operation',
    '按自己的 operationId 或原 requestId 核对知识工具结果；重新核对当前权限、笔记/目录身份，分享收据仍需分享权。',
    readScopes,
    true,
    object({ operationId: id.optional(), requestId: requestId.optional() }).refine(
      (a) => !!a.operationId !== !!a.requestId,
    ),
    operation
      .extend({
        result: z
          .union([
            fileResult,
            write,
            restored,
            folderReceipt,
            share,
            asset.extend({ noteId: id }).strict(),
            object({ favorite: z.boolean() }),
            object({ sourceHash: hash, preview: asset, source: asset }),
            object({ retentionDays: z.number().int().min(1).max(3650) }),
            conflictResolution,
            knowledgeBundleJob,
          ])
          .optional(),
      })
      .strict(),
  ),
  tool(
    'begin_knowledge_bundle_upload',
    '为批量源文件 JSON 准备上传；entries 包含 path、encoding(utf8/base64)、content，另附 folderPath 和 collision(skip/rename)。最多200项/20MiB解码内容。需要全库资料维护及写入权。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    false,
    object({
      ...begin,
      mime: z.literal('application/json'),
      totalBytes: z
        .number()
        .int()
        .positive()
        .max(30 * 1024 * 1024),
    }),
    knowledgeTransfer,
  ),
  tool(
    'preview_knowledge_bundle_import',
    '分页预览上传批次的目标、冲突策略和警告；previewHash 绑定完整预览，应用前重新核对。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    true,
    object({ transferId: id, section: z.enum(['items', 'warnings']).default('items'), ...page }),
    object({
      previewHash: hash,
      totalBytes: z.number().int().nonnegative(),
      totalItems: z.number().int().nonnegative(),
      warningsTotal: z.number().int().nonnegative(),
      items: z
        .array(
          z.union([
            object({
              path,
              targetPath: path,
              kind: z.enum(['note', 'asset']),
              bytes: z.number().int().nonnegative(),
              decision: z.enum(['create', 'skip', 'rename']),
            }),
            object({ warning: z.string().max(4096) }),
          ]),
        )
        .max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'apply_knowledge_bundle_import',
    '按刚确认的预览批量导入笔记、白板和附件；保留稳定逐项回执、引用重写与冲突策略。结果未知查询 get_knowledge_bundle_job 原 requestId。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    false,
    object({ transferId: id, expectedPreviewHash: hash, requestId }),
    knowledgeBundleJob,
  ),
  tool(
    'list_knowledge_bundle_jobs',
    '分页查询当前身份和客户端的批量导入/导出作业摘要；不返回源内容。',
    ['knowledge:read', 'knowledge:manage'],
    true,
    object(page),
    object({ items: z.array(knowledgeBundleJob).max(30), nextCursor: cursor.optional() }),
  ),
  tool(
    'get_knowledge_bundle_job',
    '按本人的 jobId 或原 requestId 查询批量作业，并分页核对逐项回执。',
    ['knowledge:read', 'knowledge:manage'],
    true,
    object({ jobId: id.optional(), requestId: requestId.optional(), ...page }).refine(
      (a) => !!a.jobId !== !!a.requestId,
    ),
    object({
      job: knowledgeBundleJob,
      items: z.array(bundleItem).max(30),
      nextCursor: cursor.optional(),
    }),
  ),
  tool(
    'cancel_knowledge_bundle_job',
    '按当前作业版本取消后续批量步骤；已经完成的文件保留，逐项状态可核对。',
    ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
    false,
    object({ jobId: id, expectedRevision: z.number().int().positive(), requestId }),
    knowledgeBundleJob,
  ),
  tool(
    'continue_knowledge_bundle_job',
    '按当前作业版本继续等待快照、已取消或失败的作业；成功项目不重复写入。',
    ['knowledge:read', 'knowledge:manage'],
    false,
    object({ jobId: id, expectedRevision: z.number().int().positive(), requestId }),
    knowledgeBundleJob,
  ),
  tool(
    'export_knowledge_bundle',
    '按全库结构版本导出选定目录的 Markdown、白板和引用附件 TAR.GZ；快照准备中返回 waiting，继续用 continue_knowledge_bundle_job。不含账户、密钥和历史。',
    ['knowledge:read', 'knowledge:manage'],
    true,
    object({
      folderPath: path.optional(),
      expectedStructureRevision: z.string().min(1).max(256),
      requestId,
    }),
    knowledgeBundleJob,
  ),
];
export const knowledgeToolByName = new Map(
  knowledgeToolDefinitions.map((definition) => [definition.name, definition]),
);
