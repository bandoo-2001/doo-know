import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { BridgeError, errorBody } from "./errors.js";
export type Operation = {
  name: string;
  description: string;
  scope: string;
  readOnly: boolean;
  destructive?: boolean;
  input: z.ZodObject;
  output: z.ZodObject;
  research?: boolean;
  run: (p: Principal, args: any, options: CallOptions) => Promise<any>;
};
const dataSchema = (v: z.ZodType) => z.object({ data: v }).strict();
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
        p.grantId || null, p.grantVersion || null,
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
    {
      name: "search",
      description:
        "默认混合搜索，返回最多十个可 fetch 的完整对象。小笔记对象为全文，大笔记对象为带版本的片段；不自动翻页。",
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
        "返回 search 指定对象的完整 text。旧版本或授权变化拒绝访问；不会截断全文、自动遍历 cursor 或下载大文件。",
      scope: "knowledge:read",
      readOnly: true,
      research: true,
      input: z.object({ id: z.string().min(1).max(4096) }).strict(),
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
      input: z.object({ noteId: c.noteId }).strict(),
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
        .object({ noteId: c.noteId, cursor: z.string().max(8192).optional() })
        .strict(),
      output: dataSchema(c.outlineReply),
      run: (p, a, o) => client.outline(p, a, o),
    },
    {
      name: "read_note",
      description:
        "显式读取一个版本页面；默认8KiB/100行，最多16KiB/200行。单会话32页/256KiB/15分钟，调用方2并发/2MiB每分钟；不自动续读。",
      scope: "knowledge:read",
      readOnly: true,
      input: c.readInput.safeExtend({ noteId: c.noteId }),
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
        for (let attempt = 0; attempt < 6; attempt++) {
          const v = await client.list(p, input, o);
          for (const n of v.items) authorizePath(p, n.relativePath);
          try {
            assertResponse({ data: v });
            return v;
          } catch (e) {
            if (
              !(e instanceof BridgeError) ||
              e.code !== "RESPONSE_TOO_LARGE" ||
              input.limit <= 1
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
        authorizePath(p, relative(a.directory) + "/" + relative(a.fileName));
        return client.create(p, a, o);
      },
    },
    {
      name: "update_note",
      description:
        "仅普通模式整篇替换<=32KiB，必须提供精确expectedModifiedAt与原requestId。大文件必须使用patch_note。",
      scope: "knowledge:write",
      readOnly: false,
      input: c.updateInput.extend({ noteId: c.noteId }),
      output: dataSchema(c.writeSummary),
      run: async (p, a, o) => {
        const info = await client.info(p, { noteId: a.noteId }, o);
        authorizePath(p, info.relativePath);
        if (
          info.editorMode !== "full" ||
          info.sizeBytes > 1024 * 1024 ||
          info.longestLineBytes == null ||
          info.longestLineBytes > 32768
        )
          throw new BridgeError("LARGE_FILE_MODE_REQUIRED", 409);
        return client.update(p, a, o);
      },
    },
    {
      name: "patch_note",
      description:
        "版本快照绑定局部修改；最多20项、旧文本与插入合计32KiB。大文件返回operationId，仅返回摘要。",
      scope: "knowledge:write",
      readOnly: false,
      input: c.patchInput.safeExtend({ noteId: c.noteId }),
      output: dataSchema(c.fileReply(c.patchResult)),
      run: (p, a, o) => client.patch(p, a, o),
    },
    {
      name: "archive_note",
      description:
        "按版本归档到可恢复回收流程并停用分享，不永久删除。保留原requestId。",
      scope: "knowledge:write",
      readOnly: false,
      destructive: true,
      input: z
        .object({
          noteId: c.noteId,
          expectedModifiedAt: c.version,
          requestId: c.requestId,
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
      name: "operation_status",
      description:
        "按operationId或原requestId核对归属、状态和摘要；不返回正文。建议轮询间隔至少1秒。",
      scope: "knowledge:read",
      readOnly: true,
      input: z
        .object({
          operationId: z.string().min(1).max(256).optional(),
          requestId: c.requestId.optional(),
        })
        .strict()
        .refine((a) => !!a.operationId !== !!a.requestId, "只提供一种操作标识"),
      output: dataSchema(c.fileOperation),
      run: (p, a, o) => client.operation(p, a, o),
    },
    {
      name: "cancel_operation",
      description:
        "请求在提交前取消自己的文件任务。已进入committing须查询终态，不宣称已经回滚。",
      scope: "knowledge:write",
      readOnly: false,
      input: z.object({ operationId: z.string().min(1).max(256) }).strict(),
      output: dataSchema(c.fileOperation),
      run: (p, a, o) => client.cancel(p, a, o),
    },
  ];
  const execute = async (
    name: string,
    p: Principal,
    args: unknown,
    options: CallOptions = {},
  ) => {
    const op = operations.find((v) => v.name === name);
    if (!op) throw new BridgeError("UNKNOWN_TOOL", 404);
    requireScope(p, op.scope);
    assertRequest(args);
    if (!op.readOnly) assertWriteBudgets(args);
    const parsed = op.input.safeParse(args);
    if (!parsed.success) throw new BridgeError("INVALID_INPUT", 400);
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
  };
  return { operations, execute };
}
export function registerOperations(
  server: McpServer,
  registry: ReturnType<typeof createOperations>,
  p: Principal,
  options: CallOptions,
) {
  for (const op of registry.operations)
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: op.input,
        outputSchema: op.output,
        annotations: {
          readOnlyHint: op.readOnly,
          destructiveHint: !!op.destructive,
          idempotentHint: op.name !== "cancel_operation",
          openWorldHint: false,
        },
      },
      async (args, extra) => {
        try {
          return mcpResult(
            await registry.execute(op.name, p, args, {
              ...options,
              signal: AbortSignal.any([
                extra.signal,
                ...(options.signal ? [options.signal] : []),
              ]),
            }),
          );
        } catch (e) {
          return { ...mcpResult(errorBody(e)), isError: true };
        }
      },
    );
}
