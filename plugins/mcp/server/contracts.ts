import { z } from "zod";
export type Principal = import('../../../shared/knowledge-contracts.js').Principal;
export type BackendConfig = {
  baseUrl: string;
  serviceToken: string;
  assertionSecret: string;
  issuer: string;
  audience: string;
};
export const noteId = z.string().min(1).max(256);
export const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\x00-\x1f]+$/);
export const version = z.string().regex(/^\d{1,30}$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const inlineText = z
  .string()
  .refine((s) => Buffer.byteLength(s, "utf8") <= 32768, "正文超过 32 KiB");
export const noteInfo = z.object({
  id: noteId,
  title: z.string(),
  relativePath: z.string(),
  url: z.string().url().optional(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: version,
  contentHash: hash.nullable(),
  editorMode: z.enum(["full", "large", "metadata"]),
  longestLineBytes: z.number().int().nonnegative().nullable(),
  readState: z.enum(["unknown", "preparing", "ready"]),
  sourceRevision: z.number().int().positive().nullable().default(null),
  shared: z.boolean().optional(),
});
export const readInput = z
  .object({
    snapshotId: z.string().optional().describe("已有快照ID；新读取可省略，不能与cursor同用。"),
    cursor: z.string().max(8192).optional().describe("原样续用nextCursor；不能与snapshotId或range同用。"),
    maxBytes: z.number().int().min(4).max(16384).default(8192).describe("本页UTF8字节上限，默认8192，最多16384。"),
    range: z
      .object({
        startLine: z.number().int().positive().describe("从1计数，含此行。"),
        endLine: z.number().int().positive().describe("含此行，范围最多200行。"),
        lineByteOffset: z.number().int().nonnegative().optional().describe("起始行内的UTF8字节偏移，须在字符边界。"),
      })
      .strict()
      .refine(
        (r) => r.endLine >= r.startLine && r.endLine - r.startLine + 1 <= 200,
        "读取范围最多 200 行",
      )
      .optional(),
  })
  .strict()
  .refine(
    (b) => !b.cursor || (!b.range && !b.snapshotId),
    "cursor 不能与范围同时使用",
  );
export const readPage = z
  .object({
    snapshotId: z.string(),
    sourceHash: hash,
    modifiedAt: version,
    content: z.string().refine((s) => Buffer.byteLength(s) <= 16384),
    startLine: z.number().int().positive(),
    endLine: z.number().int().nonnegative(),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
    lineByteOffset: z.number().int().nonnegative().optional(),
    bytesReturned: z.number().int().nonnegative().max(16384),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
    budgetRemainingBytes: z.number().int(),
    rangeHash: hash,
  })
  .strict()
  .refine(
    (p) =>
      Buffer.byteLength(p.content) === p.bytesReturned &&
      p.endByte - p.startByte === p.bytesReturned &&
      p.endLine - p.startLine + 1 <= 200 &&
      p.content.split("\n").length - (p.content.endsWith("\n") ? 1 : 0) <=
        200 &&
      (!p.hasMore || !!p.nextCursor),
    "读取页字节、范围或行数不一致",
  );
export const patchEdit = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("replace_text"),
      before: z.string().min(1).describe("快照中的精确旧文本，须唯一匹配。"),
      after: z.string().describe("替换文本。"),
    })
    .strict(),
  z
    .object({
      type: z.literal("replace_range"),
      startByte: z.number().int().nonnegative().describe("快照中从0计数的UTF8字节位置，含此字节。"),
      endByte: z.number().int().nonnegative().describe("UTF8字节范围的排他终点；两端须在字符边界。"),
      expectedRangeHash: hash.describe("原字节范围的SHA256；使用读取页rangeHash或精确计算。"),
      insert: z.string().describe("在该字节范围插入的文本。"),
    })
    .strict()
    .refine((e) => e.endByte >= e.startByte, "字节范围顺序错误"),
]);
export const patchInput = z
  .object({
    snapshotId: z.string().describe("read_note或get_note_outline返回的版本快照。"),
    expectedModifiedAt: version.describe("快照的精确版本；冲突先读取最新正文并合并草稿。"),
    expectedContentHash: hash.describe("快照原文的SHA256。"),
    requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
    edits: z.array(patchEdit).min(1).max(20).describe("最多20项，旧文本与插入合计最多32KiB UTF8。"),
  })
  .strict()
  .refine(
    (b) =>
      b.edits.reduce(
        (n, e) =>
          n +
          (e.type === "replace_text"
            ? Buffer.byteLength(e.before) + Buffer.byteLength(e.after)
            : Buffer.byteLength(e.insert)),
        0,
      ) <= 32768,
    "修改文本合计超过 32 KiB",
  );
export const patchResult = z.object({
  id: z.string().optional(),
  relativePath: z.string().optional(),
  modifiedAt: version,
  contentHash: hash,
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(20 * 1024 * 1024),
  editCount: z.number().int().nonnegative(),
  indexState: z.string(),
});
const fileResult = z
    .object({
      id: noteId.optional(),
      relativePath: z.string().max(1200).optional(),
      modifiedAt: version.optional(),
      contentHash: hash.optional(),
      sourceHash: hash.optional(),
      snapshotId: z.string().max(256).optional(),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(20 * 1024 * 1024)
        .optional(),
      editCount: z.number().int().nonnegative().optional(),
      indexState: z.string().max(40).optional(),
      archived: z.boolean().optional(),
      jobId: z.string().max(256).optional(),
      added: z.number().int().nonnegative().optional(),
      changed: z.number().int().nonnegative().optional(),
      removed: z.number().int().nonnegative().optional(),
      conflicted: z.number().int().nonnegative().optional(),
      complete: z.boolean().optional(),
    })
    .strict();
export const fileOperation = z.object({
  operationId: z.string(),
  requestId: z.string(),
  kind: z.string(),
  status: z.enum([
    "prepared",
    "queued",
    "running",
    "committing",
    "succeeded",
    "failed",
    "cancelled",
    "needs_reconciliation",
  ]),
  snapshotId: z.string().optional(),
  result: fileResult.optional(),
  error: z
    .object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      retryable: z.boolean(),
    })
    .optional(),
});
export const fileReply = <T extends z.ZodType>(data: T, includeResult = true) =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready"), data }),
    z.object({ kind: z.literal("accepted"), operation: includeResult ? fileOperation : fileOperation.omit({result:true}) }),
  ]);
export const readReply = fileReply(readPage, false);
export const outlineReply = fileReply(
  z.object({
    snapshotId: z.string(),
    sourceHash: hash,
    modifiedAt: version,
    items: z.array(
      z.object({
        title: z.string(),
        level: z.number().int(),
        line: z.number().int().positive(),
        startByte: z.number().int().nonnegative(),
      }),
    ),
    nextCursor: z.string().optional(),
  }), false,
);
export const createInput = z
  .object({
    directory: z.string().min(1).max(1000).optional().describe("兼容路径；与directoryId同传时须匹配当前路径。"),
    directoryId: z.string().min(1).max(256).nullable().optional().describe("稳定目录ID；null为业务根目录。优先使用此字段。"),
    fileName: z.string().min(1).max(180).describe("新笔记文件名；同名冲突不会覆盖。"),
    content: inlineText.describe("完整正文，最多32768个UTF8字节。"),
    requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
  })
  .strict().refine(v => v.directoryId !== undefined || v.directory !== undefined, "需要directoryId或directory");
export const updateInput = z
  .object({
    content: inlineText.describe("普通编辑模式的完整替换正文，最多32KiB UTF8；大文件用patch_note。"),
    expectedModifiedAt: version.describe("读取获得的精确版本；冲突先读取最新正文并合并草稿。"),
    requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
  })
  .strict();
export const searchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .refine((s) => [...s].length <= 512).describe("搜索文本，最多512个Unicode码点。"),
    mode: z.enum(["text", "semantic", "hybrid"]).default("hybrid").describe("默认hybrid；semantic依赖可用向量索引。"),
    freshness: z.enum(["indexed", "strict"]).default("indexed").describe("indexed允许索引版本；strict要求严格新鲜度。"),
    filters: z
      .object({
        directory: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        updatedAfter: z.string().optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(50).default(10).describe("每页1至50条，默认10。"),
    cursor: z.string().max(8192).optional().describe("原样续用nextCursor，保留查询、过滤和分页参数。"),
  })
  .strict();
export const searchOutput = z.object({
  results: z
    .array(
      z.object({
        noteId: z.string(),
        title: z.string(),
        relativePath: z.string(),
        url: z.string().url().optional(),
        matches: z
          .array(
            z.object({
              noteId: z.string(),
              chunkId: z.string(),
              title: z.string(),
              relativePath: z.string(),
              url: z.string().url().optional(),
              headingPath: z.array(z.string()),
              startLine: z.number().int(),
              endLine: z.number().int(),
              matchLine: z.number().int().positive().optional(),
              snippet: z.string().refine((s) => Buffer.byteLength(s) <= 512),
              sourceHash: hash,
              sourceRevision: z.number().int().positive(),
              matchedBy: z.array(z.enum(["text", "semantic"])),
            }),
          )
          .max(3),
      }),
    )
    .max(50),
  nextCursor: z.string().optional(),
  degraded: z.boolean(),
  reasons: z.array(z.string()),
  index: z.object({
    checkedAt: z.string().nullable(),
    pending: z.number().int(),
    generation: z.string().nullable(),
  }),
});

export const writeSummary = z
  .object({
    id: noteId,
    relativePath: z.string().max(1200),
    modifiedAt: version,
    contentHash: hash,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    indexState: z.string().max(40),
  })
  .strict();
export const archiveSummary = z
  .object({
    id: noteId,
    relativePath: z.string().max(1200),
    archived: z.literal(true),
    indexState: z.string().max(40),
  })
  .strict();
export const listInput = z
  .object({
    limit: z.number().int().min(1).max(50).default(10).describe("每页1至50条，默认10；续页保持原limit。"),
    cursor: z.string().max(8192).optional().describe("原样续用nextCursor；保持原directory与limit。"),
    directory: z.string().max(1000).optional().describe("授权范围内相对目录；续页保持不变。"),
  })
  .strict();
export const listOutput = z
  .object({
    items: z.array(noteInfo).max(50),
    nextCursor: z.string().max(8192).optional(),
  })
  .strict();
export const refreshInput = z
  .object({
    scope: z.string().max(1000).optional().describe("授权范围内相对目录；省略使用当前授权范围。"),
    requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
  })
  .strict();
export const refreshOutput = z
  .object({
    jobId: z.string().max(256),
    added: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    complete: z.boolean(),
    indexState: z.string().max(40),
  })
  .strict();
export const indexStatusInput = z
  .object({
    scope: z.string().max(1000).optional().describe("授权范围内相对目录。"),
    jobId: z.string().max(256).optional().describe("refresh_index返回的任务ID；接受任务不表示索引完成。"),
  })
  .strict();
export const indexStatusOutput = z
  .object({
    lastReconciledAt: z.string().nullable(),
    lastFullHashAt: z.string().nullable(),
    knownHead: z.string().nullable(),
    sync: z.object({ id: z.string().optional(), status: z.string() }).strict(),
    conflicts: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    activeSpaceId: z.string().nullable(),
    generation: z.string().nullable(),
    error: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .nullable(),
    documents: z
      .array(
        z
          .object({
            noteId,
            relativePath: z.string(),
            sourceHash: hash.nullable(),
            sourceRevision: z.number().int().nonnegative(),
            textIndexedHash: hash.nullable(),
            vectorIndexedHash: hash.nullable(),
            conflict: z.boolean(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export const researchMetadata = z
  .object({
    objectType: z.enum(["note", "chunk"]),
    noteId,
    sourceHash: hash,
    sourceRevision: z.number().int().positive(),
    modifiedAt: version,
    relativePath: z.string().max(1200),
    chunkId: z.string().max(256).optional(),
    headingPath: z.array(z.string().max(1024)).max(32).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().nonnegative().optional(),
    startByte: z.number().int().nonnegative().optional(),
    endByte: z.number().int().nonnegative().optional(),
  })
  .strict();
export const researchObject = z
  .object({
    id: z.string().min(1).max(4096),
    title: z.string().refine((s) => [...s].length <= 256),
    text: z.string().refine((s) => Buffer.byteLength(s) <= 16384),
    url: z.string().url().max(4096).optional(),
    metadata: researchMetadata,
  })
  .strict();
export const researchSearchOutput = z
  .object({
    degraded: z.boolean(),
    reasons: z.array(z.string()).max(32),
    omitted: z.number().int().nonnegative(),
    results: z
      .array(
        z
          .object({
            id: z.string().max(4096),
            title: z.string().refine((s) => [...s].length <= 256),
            url: z.string().url().max(4096).optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

const blogTitle = z.string().refine((value) => [...value].length <= 256, '标题最多256个Unicode码点');
export const blogMetadata = z.object({
  slug: z.string().min(1).max(100), title: blogTitle.min(1), summary: z.string().max(2000),
  category: z.string().max(80), tags: z.array(z.string().min(1).max(80)).max(30), pinned: z.boolean(), cover: z.string().max(8192).nullable(),
}).strict();
export const blogPost = blogMetadata.extend({
  id: z.string().min(1).max(256), sourceNoteId: noteId, sourceTitle: blogTitle, sourceModifiedAt: version, sourceHash: hash,
  version: z.number().int().positive(), state: z.enum(['draft', 'published', 'withdrawn']),
  publishedVersionId: z.string().max(256).nullable(), publishedAt: z.string().max(64).nullable(), updatedAt: z.string().max(64),
  hasUnpublishedChanges: z.boolean(), url: z.string().max(4096).nullable(),
}).strict();
export const blogNoteStatus = z.object({
  siteEnabled: z.boolean(), post: blogPost.nullable(), publicationVersion: z.number().int().nonnegative(),
  source: z.object({ noteId, title: blogTitle, relativePath: z.string().max(1200), modifiedAt: version, contentHash: hash }).strict(),
}).strict();
// Full Web/SDK metadata remains unchanged. MCP exposes a recoverable receipt
// whose aggregate wire size stays small even for legal large metadata values.
export const blogOmittedMetadata = ['summary', 'category', 'tags', 'pinned', 'cover'] as const;
export const blogPublicationReceipt = blogPost.pick({
  id: true, sourceNoteId: true, sourceTitle: true, sourceModifiedAt: true, sourceHash: true,
  version: true, state: true, publishedVersionId: true, publishedAt: true, updatedAt: true,
  hasUnpublishedChanges: true, url: true, slug: true, title: true,
}).extend({
  omittedMetadata: z.tuple([z.literal('summary'), z.literal('category'), z.literal('tags'), z.literal('pinned'), z.literal('cover')]),
}).strict();
export const blogStatusReceipt = blogNoteStatus.extend({ post: blogPublicationReceipt.nullable() }).strict();
export const mcpFileOperation = fileOperation.extend({ result: fileResult.or(blogPublicationReceipt).or(z.lazy(() => organizationResult)).optional() });
export const blogPublishInput = z.object({
  noteId: noteId.describe("已有Markdown笔记的稳定ID，不是fetch.id。"),
  expectedModifiedAt: version.describe("核对过的原文精确版本。"),
  expectedContentHash: hash.describe("核对过的原文SHA256。"),
  expectedPublicationVersion: z.number().int().nonnegative().describe("get_blog_status的发布版本，首次为0。"),
  requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
  metadata: blogMetadata.partial().optional().describe("显式公开元数据；省略字段保留已有设置。"),
}).strict();
export const blogUnpublishInput = z.object({
  noteId: noteId.describe("原文笔记稳定ID，不是fetch.id。"),
  expectedPublicationVersion: z.number().int().nonnegative().describe("get_blog_status返回的当前发布版本。"),
  requestId: requestId.describe("稳定操作ID；未知结果查询原ID。"),
}).strict();

// Organization receipts are separate from file patch results and never contain body/journal data.
const objectId = z.string().min(1).max(256);
const revision = z.string().min(1).max(256);
export const organizationContext = z.object({
  libraryId: objectId, bindingVersion: z.number().int().nonnegative(), structureRevision: revision,
  inboxDirectoryId: objectId.nullable(),
  limits: z.object({actions:z.number(),files:z.number(),directories:z.number(),bodyBytes:z.number(),assetBytes:z.number()}).strict(),
}).strict();
const resourceSet = z.discriminatedUnion('mode', [z.object({mode:z.literal('all')}).strict(), z.object({mode:z.literal('selected'),resources:z.array(z.object({kind:z.string().max(64),id:objectId}).strict()).max(256)}).strict()]);
export const permissionPolicy = z.object({version:z.literal(2),domains:z.record(z.string().max(64),z.object({enabled:z.boolean(),ownerId:objectId,instanceId:objectId,actions:z.array(z.string().max(64)).max(16),resources:resourceSet}).strict())}).strict();
export const mcpContext = z.object({policy:permissionPolicy,organization:organizationContext.optional()}).strict();
export const directoryListInput = z.object({parentId:objectId.nullable().optional(),cursor:z.string().max(8192).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const directoryPage = z.object({libraryId:objectId,structureRevision:revision,items:z.array(z.object({id:objectId,path:z.string().max(1200),parentId:objectId.nullable(),subtreeRevision:revision,name:z.string().max(180),writable:z.boolean(),organizable:z.boolean()}).strict()).max(50),nextCursor:z.string().max(8192).optional()}).strict();
export const organizationAction = z.discriminatedUnion('type',[
  z.object({type:z.literal('create_directory'),parentId:objectId.nullable(),name:z.string().min(1).max(180)}).strict(),
  z.object({type:z.literal('move_note'),noteId,toDirectoryId:objectId.nullable(),fileName:z.string().min(1).max(180),expectedModifiedAt:version,expectedContentHash:hash}).strict(),
  z.object({type:z.literal('move_directory'),directoryId:objectId,toDirectoryId:objectId.nullable(),name:z.string().min(1).max(180),expectedSubtreeRevision:revision}).strict(),
]);
export const organizeInput = z.object({requestId,libraryId:objectId,expectedStructureRevision:revision,actions:z.array(organizationAction).min(1).max(50)}).strict();
export const organizationResult = z.object({operationId:objectId,libraryId:objectId,structureRevision:revision,changes:z.array(z.object({type:z.string().max(64),id:objectId,from:z.string().max(1200).optional(),to:z.string().max(1200)}).strict()).max(50),indexState:z.enum(['pending','ready']),undoAvailable:z.boolean()}).strict();
export const organizationOperation = fileOperation.omit({snapshotId:true,result:true}).extend({result:organizationResult.optional()}).strict();
export const organizationReply = z.object({kind:z.literal('accepted'),operation:organizationOperation}).strict();
export const historyInput = z.object({cursor:z.string().max(8192).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const historyPage = z.object({items:z.array(organizationOperation).max(50),nextCursor:z.string().max(8192).optional()}).strict();
export const undoOrganizationInput = z.object({operationId:objectId,requestId}).strict();

export const hostOperation = fileOperation.extend({result:fileResult.or(blogPost).or(organizationResult).optional()});

export const cancelOperation = fileOperation.extend({result:fileResult.or(organizationResult).optional()});
