import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "./contracts.js";
import * as c from "./contracts.js";
import type { KnowledgeClient, CallOptions } from "./service.js";
import { requireScope, authorizePath } from "./auth.js";
import {
  assertRequest,
  assertWriteBudgets,
  assertResponse,
  mcpResult,
  ReadingBudgets,
  budgets,
} from "./budgets.js";
import { BridgeError, errorBody, invalidInput, annotateError, bridgeErrorSchema } from "./errors.js";
import { createToDooOperations } from './to-doo-operations.js';
import { createKnowledgeToolOperations } from './knowledge-tools.js';
import { createBlogToolOperations } from './blog-tools.js';
import { createToDooFullToolOperations } from './to-doo-tools.js';
import { createTransferToolOperations } from './transfer-tools.js';
export type Operation = {
  name: string;
  description: string;
  scope?: string;
  additionalScopes?: string[];
  readOnly: boolean;
  destructive?: boolean;
  input: z.ZodObject;
  output: z.ZodObject;
  research?: boolean;
  run: (p: Principal, args: any, options: CallOptions) => Promise<any>;
};
const dataSchema = (v: z.ZodType) => z.object({ data: v }).strict();
const inputNoteId = c.noteId.describe("稳定noteId。");
const publicationReceipt = (post: z.infer<typeof c.blogPost>) => {
  const { id, sourceNoteId, sourceTitle, sourceModifiedAt, sourceHash, version, state, publishedVersionId, publishedAt, updatedAt, hasUnpublishedChanges, url, slug, title } = post;
  return { id, sourceNoteId, sourceTitle, sourceModifiedAt, sourceHash, version, state, publishedVersionId, publishedAt, updatedAt, hasUnpublishedChanges, url, slug, title, omittedMetadata: [...c.blogOmittedMetadata] };
};
const relative = (s: string) => {
  if (
    s.startsWith("/") ||
    s.includes("\\") ||
    /[\x00-\x1f]/.test(s) ||
    s.split("/").some((x) => x === ".." || x === ".")
  )
    throw new BridgeError("INVALID_INPUT");
  return s.replace(/\/+$/, "");
};
const policyKey = (p: Principal) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        p.id,
        p.clientId,
        [...p.scopes].sort(),
        [...p.allowedPrefixes].sort(),
        p.grantId || null, p.grantVersion || null, p.permissionPolicy || null, p.policyVersion || null, p.knowledgeAll || false,
      ]),
    )
    .digest("hex");
const referenceSchema = z
  .object({
    kind: z.enum(["note", "chunk"]),
    noteId: c.noteId,
    chunkId: z.string().max(256).optional(),
    sourceHash: c.hash,
    sourceRevision: z.number().int().positive(),
    owner: z.string().length(64),
    expires: z.number().int().positive(),
  })
  .strict();
export function createOperations(
  config: { objectIdSecret: string },
  client: KnowledgeClient,
) {
  const reader = new ReadingBudgets();
  const listReference = z.object({ cursor: z.string().max(8192), limit: z.number().int().min(1).max(50), requested: z.number().int().min(1).max(50), directory: z.string().nullable(), owner: z.string(), expires: z.number().int() }).strict();
  const listCursor = (p: Principal, cursor: string, limit: number, requested: number, directory?: string) => {
    const data = Buffer.from(JSON.stringify({ cursor, limit, requested, directory: directory ?? null, owner: policyKey(p), expires: Date.now() + 15 * 60000 })).toString('base64url');
    const result = 'dklist1.' + data + '.' + createHmac('sha256', config.objectIdSecret).update('list:' + data).digest('base64url');
    if (result.length > 8192) throw new BridgeError('RESPONSE_TOO_LARGE', 413);
    return result;
  };
  const openListCursor = (p: Principal, cursor: string, requested: number, directory?: string) => {
    try {
      const [prefix, data, signature, ...tail] = cursor.split('.');
      if (prefix !== 'dklist1' || !data || !signature || tail.length) throw Error();
      const expected = createHmac('sha256', config.objectIdSecret).update('list:' + data).digest(), actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const value = listReference.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
      if (value.owner !== policyKey(p) || value.requested !== requested || value.directory !== (directory ?? null)) throw new BridgeError('FORBIDDEN', 403);
      if (value.expires <= Date.now()) throw new BridgeError('CURSOR_EXPIRED', 410);
      return value;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('INVALID_CURSOR', 400);
    }
  };
  const sign = (
    p: Principal,
    input: {
      kind: "note" | "chunk";
      noteId: string;
      chunkId?: string;
      sourceHash: string;
      sourceRevision: number;
    },
  ) => {
    const data = Buffer.from(
      JSON.stringify({
        ...input,
        owner: policyKey(p),
        expires: Date.now() + 15 * 60 * 1000,
      }),
    ).toString("base64url");
    return (
      "dk1." +
      data +
      "." +
      createHmac("sha256", config.objectIdSecret)
        .update("research:" + data)
        .digest("base64url")
    );
  };
  const decode = (p: Principal, id: string) => {
    try {
      const [prefix, data, signature, ...tail] = id.split(".");
      if (prefix !== "dk1" || !data || !signature || tail.length)
        throw Error("invalid reference");
      const expected = createHmac("sha256", config.objectIdSecret)
        .update("research:" + data)
        .digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      )
        throw Error("invalid signature");
      const value = referenceSchema.parse(
        JSON.parse(Buffer.from(data, "base64url").toString("utf8")),
      );
      if (
        value.owner !== policyKey(p) ||
        value.expires <= Date.now() ||
        (value.kind === "chunk" && !value.chunkId) ||
        (value.kind === "note" && value.chunkId)
      )
        throw Error("stale reference");
      return value;
    } catch {
      throw new BridgeError("RESULT_STALE", 409);
    }
  };
  const getResearch = async (
    p: Principal,
    input: {
      noteId: string;
      sourceHash: string;
      sourceRevision: number;
      chunkId?: string;
    },
    options: CallOptions,
  ) =>
    reader.run(p, async () => {
      const result = await client.research(p, input, options);
      authorizePath(p, result.metadata.relativePath);
      if (
        result.metadata.noteId !== input.noteId ||
        result.metadata.sourceHash !== input.sourceHash ||
        result.metadata.sourceRevision !== input.sourceRevision ||
        result.metadata.objectType !== (input.chunkId ? "chunk" : "note") ||
        (input.chunkId && result.metadata.chunkId !== input.chunkId)
      )
        throw new BridgeError("INVALID_BACKEND_RESPONSE", 502);
      return result;
    });
  const resultObject = async (
    p: Principal,
    input: {
      kind: "note" | "chunk";
      noteId: string;
      sourceHash: string;
      sourceRevision: number;
      chunkId?: string;
    },
    options: CallOptions,
    id = sign(p, input),
  ) => {
    const data = await getResearch(p, input, options),
      result = { ...data, id };
    assertResponse(result);
    return result;
  };
  const operations: Operation[] = [
    { name:'get_mcp_context',description:'返回本人有效分域权限、实例及结构版本。保存/整理前调用；每次实时授权。',readOnly:true,input:z.object({}).strict(),output:dataSchema(c.mcpContext),run:(p,a,o)=>client.context(p,a,o) },
    { name:'list_directories',description:'列直接子目录，含空目录；null为根。默认20、最多50；游标绑定授权和结构版本。',scope:'knowledge:read',readOnly:true,input:c.directoryListInput,output:dataSchema(c.directoryPage),run:(p,a,o)=>client.directories(p,a,o) },
    { name:'organize_library',description:'提交最多50项目录创建、移动/改名，无逐次审批。冲突刷新context和目录；accepted后用原requestId查询终态。',scope:'knowledge:organize',additionalScopes:['knowledge:read','knowledge:write'],readOnly:false,input:c.organizeInput,output:dataSchema(c.organizationReply),run:(p,a,o)=>client.organize(p,a,o) },
    { name:'list_organization_history',description:'分页查看本人整理任务及当前授权范围内的安全摘要；撤销材料过期后不可撤销。',scope:'knowledge:read',readOnly:true,input:c.historyInput,output:dataSchema(c.historyPage),run:(p,a,o)=>client.organizationHistory(p,a,o) },
    { name:'undo_organization',description:'以新requestId提交完整补偿；须当前整理权限，后续变更返回UNDO_CONFLICT。',scope:'knowledge:organize',additionalScopes:['knowledge:read','knowledge:write'],readOnly:false,input:c.undoOrganizationInput,output:dataSchema(c.organizationReply),run:(p,a,o)=>client.undoOrganization(p,a,o) },
    {
      name: "search",
      description:
        "混合搜索最多10个可fetch对象：小笔记全文或大笔记片段，不自动翻页。",
      scope: "knowledge:read",
      readOnly: true,
      research: true,
      input: z.object({ query: c.searchInput.shape.query }).strict(),
      output: c.researchSearchOutput,
      run: async (p, args, options) => {
        const searched = await client.search(
            p,
            {
              query: args.query,
              mode: "hybrid",
              freshness: "indexed",
              limit: 10,
            },
            options,
          ),
          results: { id: string; title: string; url?: string }[] = [];
        const reasons = new Set<string>(searched.reasons || []); let omitted = 0;
        if (!client.externalWebOriginConfigured()) reasons.add("EXTERNAL_WEB_ORIGIN_REQUIRED");
        for (let offset = 0; offset < searched.results.length; offset += 2) {
          const batch = await Promise.all(searched.results.slice(offset, offset+2).map(async (note: z.infer<typeof c.searchOutput>['results'][number]) => {
          try {
          authorizePath(p, note.relativePath);
          const first = note.matches[0];
          if (!first) return {};
          const info = await client.info(p, { noteId: note.noteId }, options);
          authorizePath(p, info.relativePath);
          const base = {
            noteId: note.noteId,
            sourceHash: first.sourceHash,
            sourceRevision: first.sourceRevision,
          };
          let object;
          if (info.sizeBytes <= 16384 && info.editorMode !== "metadata") {
            try {
              object = await resultObject(
                p,
                { kind: "note", ...base },
                options,
              );
            } catch (e) {
              if (
                !(e instanceof BridgeError) ||
                !["RESEARCH_OBJECT_TOO_LARGE", "RESPONSE_TOO_LARGE"].includes(
                  e.code,
                )
              )
                throw e;
            }
          }
          object ??= await resultObject(
            p,
            { kind: "chunk", ...base, chunkId: first.chunkId },
            options,
          );
          return { item: { id: object.id, title: object.title, ...(object.url ? { url: object.url } : {}) } };
          } catch (error) {
            if (error instanceof BridgeError && ['RESULT_STALE','SNAPSHOT_STALE','VERSION_CONFLICT','NOT_FOUND','NOTE_NOT_FOUND','SOURCE_CHANGED'].includes(error.code)) return { stale: true };
            return { error };
          }
          }));
          // Wait for the whole bounded batch before propagating failures, so a
          // failed request never leaves untracked reads running after deactivation.
          for (const result of batch) {
            if ('error' in result) throw result.error;
            if (result.stale) { omitted++; reasons.add('RESULT_STALE'); }
            if (result.item) { assertResponse({results:[...results,result.item]}); results.push(result.item); }
          }
        }
        return { results, degraded: !!searched.degraded || reasons.size > 0, reasons: [...reasons], omitted };
      },
    },
    {
      name: "fetch",
      description:
        "返回search对象的完整text；版本或授权变化拒绝访问，不自动续页。",
      scope: "knowledge:read",
      readOnly: true,
      research: true,
      input: z.object({ id: z.string().min(1).max(4096).describe("原样使用search返回的对象ID；不是noteId，有效期15分钟。") }).strict(),
      output: c.researchObject,
      run: async (p, args, options) => {
        const reference = decode(p, args.id);
        return resultObject(p, reference, options, args.id);
      },
    },
    {
      name: "search_notes",
      description:
        "按 text/semantic/hybrid、过滤与 cursor 检索，严格新鲜度不降级冒充最新。最多50篇，每篇最多三个片段。",
      scope: "knowledge:read",
      readOnly: true,
      input: c.searchInput,
      output: dataSchema(c.searchOutput),
      run: async (p, a, o) => {
        if (a.filters?.directory)
          authorizePath(p, relative(a.filters.directory));
        const v = await client.search(p, a, o);
        for (const n of v.results) authorizePath(p, n.relativePath);
        return v;
      },
    },
    {
      name: "get_note_info",
      description:
        "只取元数据、版本、大小、编辑模式及需要登录的引用链接，不附带正文。",
      scope: "knowledge:read",
      readOnly: true,
      input: z.object({ noteId: inputNoteId }).strict(),
      output: dataSchema(c.noteInfo),
      run: async (p, a, o) => {
        const v = await client.info(p, a, o);
        authorizePath(p, v.relativePath);
        return v;
      },
    },
    {
      name: "get_note_outline",
      description: "有界章节目录；快照准备返回 operationId，须显式查询后继续。",
      scope: "knowledge:read",
      readOnly: true,
      input: z
        .object({ noteId: inputNoteId, cursor: z.string().max(8192).optional().describe("续用上一页nextCursor；不自动遍历。") })
        .strict(),
      output: dataSchema(c.outlineReply),
      run: (p, a, o) => client.outline(p, a, o),
    },
    {
      name: "read_note",
      description:
        "显式读取版本页；默认8KiB/100行，最多16KiB/200行。会话/身份预算见instructions，不自动续读。",
      scope: "knowledge:read",
      readOnly: true,
      input: c.readInput.safeExtend({ noteId: inputNoteId }),
      output: dataSchema(c.readReply),
      run: (p, a, o) => reader.run(p, () => client.readPage(p, a, o)),
    },
    {
      name: "list_notes",
      description: "按允许目录分页列出笔记摘要，不批量读取正文。",
      scope: "knowledge:read",
      readOnly: true,
      input: c.listInput,
      output: dataSchema(c.listOutput),
      run: async (p, a, o) => {
        if (a.directory) authorizePath(p, relative(a.directory));
        let input = a;
        if (a.cursor?.startsWith('dklist1.')) {
          const reference = openListCursor(p, a.cursor, a.limit, a.directory);
          input = { ...a, cursor: reference.cursor, limit: reference.limit };
        }
        for (let attempt = 0; attempt < 6; attempt++) {
          const v = await client.list(p, input, o);
          for (const n of v.items) authorizePath(p, n.relativePath);
          try {
            const result = { ...v, ...(v.nextCursor ? { nextCursor: listCursor(p, v.nextCursor, input.limit, a.limit, a.directory) } : {}) };
            assertResponse({ data: result });
            return result;
          } catch (e) {
            if (
              !(e instanceof BridgeError) ||
              e.code !== "RESPONSE_TOO_LARGE" ||
              input.limit <= 1 || input.cursor
            )
              throw e;
            input = {
              ...input,
              limit: Math.max(1, Math.floor(input.limit / 2)),
            };
          }
        }
        throw new BridgeError("RESPONSE_TOO_LARGE", 413);
      },
    },
    {
      name: "create_note",
      description:
        "创建<=32KiB UTF8笔记；同名冲突。必须保留原requestId；结果未知先查询，不生成新ID。",
      scope: "knowledge:write",
      readOnly: false,
      input: c.createInput,
      output: dataSchema(c.writeSummary),
      run: (p, a, o) => {
        if (a.directory !== undefined) authorizePath(p, relative(a.directory) + "/" + relative(a.fileName));
        return client.create(p, a, o);
      },
    },
    {
      name: "update_note",
      description:
        "普通模式替换<=32KiB；须精确版本和requestId。大文件使用patch_note。",
      scope: "knowledge:write",
      readOnly: false,
      input: c.updateInput.extend({ noteId: inputNoteId }),
      output: dataSchema(c.writeSummary),
      // The backend checks current authorization, then replays an immutable
      // receipt before checking fresh-write editing limits.
      run: (p, a, o) => client.update(p, a, o),
    },
    {
      name: "patch_note",
      description:
        "按快照局部修改；最多20项/32KiB。异步返回operationId，仅返回摘要。",
      scope: "knowledge:write",
      readOnly: false,
      input: c.patchInput.safeExtend({ noteId: inputNoteId }),
      output: dataSchema(c.fileReply(c.patchResult)),
      run: (p, a, o) => client.patch(p, a, o),
    },
    {
      name: "archive_note",
      description:
        "按版本归档到可恢复回收流程并停用分享，不永久删除。保留原requestId。",
      scope: "knowledge:archive",
      readOnly: false,
      destructive: true,
      input: z
        .object({
          noteId: inputNoteId,
          expectedModifiedAt: c.version.describe("读取获得的精确版本；冲突先重新读取并核对。"),
          requestId: c.requestId.describe("稳定操作ID；未知结果查询原ID。"),
        })
        .strict(),
      output: dataSchema(c.archiveSummary),
      run: (p, a, o) => client.archive(p, a, o),
    },
    {
      name: "refresh_index",
      description:
        "触发授权范围核对，返回jobId；不能将接受任务解释为向量已经完成。",
      scope: "knowledge:index",
      readOnly: false,
      input: c.refreshInput,
      output: dataSchema(c.refreshOutput),
      run: (p, a, o) => {
        if (a.scope != null) authorizePath(p, relative(a.scope));
        return client.refresh(p, a, o);
      },
    },
    {
      name: "index_status",
      description: "只查看授权范围索引进度、版本和错误摘要。",
      scope: "knowledge:index",
      readOnly: true,
      input: c.indexStatusInput,
      output: dataSchema(c.indexStatusOutput),
      run: (p, a, o) => {
        if (a.scope != null) authorizePath(p, relative(a.scope));
        return client.status(p, a, o);
      },
    },
    {
      name: 'get_blog_status',
      description: '查看站点、原文及发布版本。收据省略摘要、分类、标签、置顶和封面；网页保留完整元数据。站点关闭时公开文章不可访问。',
      scope: 'blog:read', additionalScopes:['knowledge:read'], readOnly: true,
      input: z.object({ noteId: inputNoteId }).strict(), output: dataSchema(c.blogStatusReceipt),
      run: async (p, a, o) => {
        const status = await client.blogStatus(p, a, o); authorizePath(p, status.source.relativePath);
        return { ...status, post: status.post ? publicationReceipt(status.post) : null };
      },
    },
    {
      name: 'publish_blog_post',
      description: '显式公开已有Markdown快照；需博客发布及原文读取权。私有编辑不更新公开版本。提供原文版本/哈希、发布版本（首次0）和requestId；未知结果按原ID查询。收据省略完整元数据。',
      scope: 'blog:publish', additionalScopes: ['knowledge:read'], readOnly: false,
      input: c.blogPublishInput, output: dataSchema(c.blogPublicationReceipt),
      run: async (p, a, o) => publicationReceipt(await client.blogPublish(p, a, o)),
    },
    {
      name: 'unpublish_blog_post',
      description: '显式撤下公开文章；须独立发布权、当前发布版本及requestId。私有笔记不变，返回紧凑收据。',
      scope: 'blog:publish', additionalScopes: ['knowledge:read'], readOnly: false, destructive: true,
      input: c.blogUnpublishInput, output: dataSchema(c.blogPublicationReceipt),
      run: async (p, a, o) => publicationReceipt(await client.blogUnpublish(p, a, o)),
    },
    {
      name: "operation_status",
      description:
        "按operationId或原requestId查看自己的状态和摘要，无正文。博客返回紧凑收据。轮询至少间隔1秒。",
      scope: "knowledge:read",
      readOnly: true,
      input: z
        .object({
          operationId: z.string().min(1).max(256).optional().describe("后台操作ID；与requestId恰好提供一个。"),
          requestId: c.requestId.optional().describe("结果未知时使用原写入ID；与operationId恰好提供一个。"),
        })
        .strict()
        .refine((a) => !!a.operationId !== !!a.requestId, "只提供一种操作标识")
        .describe("operationId与requestId必须且只能提供一个。"),
      output: dataSchema(c.mcpFileOperation),
      run: async (p, a, o) => {
        const operation = await client.operation(p, a, o);
        return operation.kind.startsWith('blog.') && operation.result && typeof operation.result.sourceNoteId === 'string'
          ? { ...operation, result: publicationReceipt(operation.result) } : operation;
      },
    },
    {
      name: "cancel_operation",
      description:
        "请求在提交前取消自己的文件任务。已进入committing须查询终态，不宣称已经回滚。",
      scope: "knowledge:write",
      readOnly: false,
      input: z.object({ operationId: z.string().min(1).max(256).describe("自己的后台操作ID；提交开始后须查询终态。") }).strict(),
      output: dataSchema(c.cancelOperation),
      run: (p, a, o) => client.cancel(p, a, o),
    },
  ];
  operations.push(...createToDooOperations(client));
  operations.push(...createKnowledgeToolOperations(client), ...createBlogToolOperations(client), ...createToDooFullToolOperations(client));
  operations.push(...createTransferToolOperations(client));
  const execute = async (
    name: string,
    p: Principal,
    args: unknown,
    options: CallOptions = {},
  ) => {
    try {
      const op = operations.find((v) => v.name === name);
      if (!op) throw new BridgeError("UNKNOWN_TOOL", 404);
      if (op.scope) requireScope(p, op.scope);
      for (const scope of op.additionalScopes || []) requireScope(p, scope);
      assertRequest(args);
      if (!op.readOnly) assertWriteBudgets(args);
      const parsed = op.input.safeParse(args);
      if (!parsed.success) throw invalidInput(name, parsed.error.issues);
      if (options.signal?.aborted) throw new BridgeError("CALL_CANCELLED", 499);
      const deadline = Math.min(
        options.deadline ?? Date.now() + budgets.call,
        Date.now() + budgets.call,
      );
      const result = await op.run(p, parsed.data, { ...options, deadline });
      const output = op.research ? result : { data: result };
      const checked = op.output.safeParse(output);
      if (!checked.success)
        throw new BridgeError("INVALID_BACKEND_RESPONSE", 502);
      assertResponse(checked.data);
      return checked.data;
    } catch (error) {
      throw annotateError(error, name, args);
    }
  };
  return { operations, execute };
}

export function registerOperations(
  server: McpServer,
  registry: ReturnType<typeof createOperations>,
  p: Principal,
  options: CallOptions = {},
) {
  const annotations = (op: Operation) => ({
    readOnlyHint: op.readOnly,
    destructiveHint: !!op.destructive,
    idempotentHint: op.name !== "cancel_operation",
    openWorldHint: false,
  });
  const call = async (name: string, args: unknown, extra: { signal: AbortSignal }) => {
    try {
      return mcpResult(await registry.execute(name, p, args, {
        ...options,
        signal: AbortSignal.any([extra.signal, ...(options.signal ? [options.signal] : [])]),
      }));
    } catch (error) {
      return { ...mcpResult(errorBody(error)), isError: true };
    }
  };
  for (const op of registry.operations)
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: op.input,
        outputSchema: op.output,
        annotations: annotations(op),
      },
      (args, extra) => call(op.name, args, extra),
    );
  // Keep the registered schemas for discovery. The public request handler
  // receives raw arguments so registry validation can return safe structured
  // errors instead of the SDK's text-only schema error. Envelope validation is
  // still performed by Server.setRequestHandler(CallToolRequestSchema, ...).
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    call(request.params.name, request.params.arguments ?? {}, extra),
  );
  // SDK clients validate structured errors against the advertised output schema
  // after discovery. Keep success validation exact and add the shared error
  // core. Optional error metadata remains bounded by errorBody; repeating its
  // detailed recovery schema for all tools would exceed the discovery budget.
  const core = bridgeErrorSchema.properties.error;
  const errorEnvelope = {
    type: bridgeErrorSchema.type,
    additionalProperties: bridgeErrorSchema.additionalProperties,
    required: bridgeErrorSchema.required,
    properties: { error: {
      type: core.type,
      required: core.required,
      properties: { code: core.properties.code, message: core.properties.message, retryable: core.properties.retryable },
      additionalProperties: true,
    } },
  };
  server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const cursor = request.params?.cursor;
    if (cursor && !/^tools-v1:(?:0|[1-9]\d{0,5})$/.test(cursor)) throw new BridgeError('INVALID_INPUT');
    const start = cursor ? Number(cursor.slice('tools-v1:'.length)) : 0;
    if (start > registry.operations.length) throw new BridgeError('INVALID_INPUT');
    const tools: any[] = [];
    // Keep the original first page stable; the expanded application tools use
    // standard MCP pagination instead of increasing the transport frame limit.
    const end = start === 0 ? Math.min(18, registry.operations.length) : registry.operations.length;
    for (let index = start; index < end; index++) {
      const op = registry.operations[index];
      const { $schema, ...success } = z.toJSONSchema(op.output, { target: "draft-07", io: "output" });
      const tool = {
        name: op.name,
        description: op.description,
        inputSchema: z.toJSONSchema(op.input, { target: "draft-07", io: "input" }) as { type: "object" },
        outputSchema: { $schema, type: "object" as const, anyOf: [success, errorEnvelope] },
        annotations: annotations(op),
      };
      const nextCursor = index + 1 < registry.operations.length ? `tools-v1:${index + 1}` : undefined;
      const frame = { jsonrpc: '2.0', id: '\0'.repeat(128), result: { tools: [...tools, tool], ...(nextCursor ? { nextCursor } : {}) } };
      if (Buffer.byteLength(JSON.stringify(frame)) > budgets.response) {
        if (!tools.length) throw new BridgeError('RESPONSE_TOO_LARGE', 413);
        break;
      }
      tools.push(tool);
    }
    const next = start + tools.length;
    return { tools, ...(next < registry.operations.length ? { nextCursor: `tools-v1:${next}` } : {}) };
  });
}
