# 专用图形 MCP 写入协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for this isolated integration task. Parent continues independent snapshot/metadata verification. No implementer subagents may spawn further agents.

**Goal:** MCP 通过有界 opaque 传输完成新图形预留、源/PNG 准备及完整 Markdown 提交，沿用同一后台服务，不能用只适合小输入的内联 Base64 绕过消息预算。

**Architecture:** Domain adapter 只管理当前调用者和 opaque 上传；格式、资源、版本和发布校验由现有 diagramCreationService/primaryDiagramService 完成。分出专用 adapter 模块，避免在知识工具大文件继续堆实现。

**Tech Stack:** TypeScript、Zod、现有 MCP transfer store、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`。父计划 `docs/superpowers/plans/2026-10-31-markdown-diagram-documents.md` Task 4F。

## Global Constraints

- 所有开发只使用临时测试数据，不迁移真实知识库、不部署、不重启服务、不改原目录的用户 ToDoo 工作。
- 主文件始终 Markdown；源格式、主图角色、语义类型分开；新图完整 PNG 提交后才激活预留 UUID。
- MCP 每条完整结果帧不超过 `mcpMaximumFrameBytes`（64 KiB，包含 structured/text 双份 JSON）；使用现有 `mcpResultFrameSize` 验证。
- 主图源/PNG/主文档预算分别 8 MiB/10 MiB/20 MiB；脑图/流程图实际源规则由主服务继续验证；上传每块沿用既有 store 限制。
- 主体/客户端、目标、固定主文件与源基线、类型、上传角色必须绑定，句柄不能跨文档/角色复用。每块授权按当前 scope/target/lease；原始凭据不得进入 Markdown、导出或日志。
- 复用原幂等行为，合法已提交请求重试不因准备租约过期而冒充失败；不要使新提交永远接受过期准备。
- 普通嵌入图旧 `prepare_note_diagram` 和 `download_note_document` 快照原文契约继续保留。

## Review Focus

- 交换两个目标或 source/preview 角色的上传句柄必须拒绝。
- 预留阶段 notes/scan/index 不能发现活动文档；MCP 不借用 browser owner principal。
- 收据不明结果重试不得产生第二 UUID、重复资源或不同版本成功。
- 权限收紧、过期、payload 摘要变化及主/源基线冲突要以当前状态拒绝。
- 出现 preview-required 时后台操作和 MCP operation schema 保留结构化 pending docs。

## Task 1: 完整 MCP primary workflow

**Files (owned):** Create `apps/server/plugins/primary-diagram-tools.ts`、`shared/mcp-primary-diagram-contracts.ts`（若有必要）；Modify `apps/server/plugins/knowledge-tools.ts`、`shared/mcp-knowledge-tools.ts`；Create `tests/mcp-primary-diagram-write.test.ts`；可创建简短协议文档。允许只为 metadata recovery 添加 primary-diagrams.ts getter；否则不要改父执行者核心/reader/UI文件。

**Interfaces:**
- `diagramCreationService(config,db,p).reserve({path,type,requestId}) / get(intentId) / cancel(intentId)` 已实现，24h 租约，绑定原调用主体/客户端。
- `primaryDiagramService(...,p).validateTarget({type,target})`：target=`{kind:'creation',intentId}` 或 `{kind:'document',noteId,expectedDocumentHash,expectedSourceHash}`，复用当前权限与双基线验证，返回 noteId/path/creationIntentId/documentHash/baselineSourceHash/status/expiresAt。
- `.getPreparation(preparedId,{fresh?:boolean})`：验证准备主体/客户端和当前目标权限；fresh=true 才检查 lease（begin 新主文档上传用 true；幂等提交重试不能无条件 fresh）。
- `.prepare(input)` 的共享 schema 在 `shared/diagram-document-contracts.ts`，接收精确 source 文本、sourceHash、同快照 PNG Base64、title/renderer/config/target/requestId，返回 PreparedDiagramPrimary。
- `.commit({preparedId,markdown,requestId})`：完整提交同一预留 UUID，返回 NoteDocument（content 为 Markdown）。现已只将 metadata 存 operation.result；同 requestId replay 通过参数摘要验证并复用传入正文返回原始快照。
- `createMcpTransferStore` 现有 beginUpload/info/append/readUpload/complete/createDownload；opaque source/preview/main 都走该 store。知识端 `authorizeTransfer` 需委托新 subport 验证三种新上传 binding。

**Frozen tool names/input choices:**
1. `reserve_diagram_document`: `{path,type,requestId}` → creation intent（完整类型与状态，固定身份）。
2. `get_diagram_creation_intent`: `{intentId}` → 当前同一意图。
3. `cancel_diagram_creation_intent`: `{intentId}` → terminal/current intent（提交中不能假确认取消）。
4. `begin_primary_diagram_upload`: `{target,type,sourceBytes,previewBytes,sourceSha256?,previewSha256?,requestId}` → `{source:transferInfo,preview:transferInfo}`。服务器固定 MIME/文件名，创建 source 与 preview 各自绑定角色，参数/目标基线一致。creation target 没有 active note，授权经意图；不得强行先创建 note。
5. `prepare_primary_diagram`: `{target,type,title,renderer,config,sourceTransferId,previewTransferId,sourceHash,requestId}` → compact prepared receipt：`id,noteId,creationIntentId?,type,documentHash,baselineSourceHash,sourceHash,renderHash,previewHash,preview,source?,expiresAt`。不重复回传调用者已有 title/renderer/config，避免 result frame 膨胀；可合并调用参数重建完整 PreparedDiagramPrimary 给通用 Markdown serializer。
6. `begin_primary_diagram_document_upload`: `{preparedId,totalBytes,sha256?,requestId}` → main Markdown transferInfo。
7. `commit_primary_diagram`: `{preparedId,documentTransferId,requestId}` → bounded receipt：`id,relativePath,documentType,title,modifiedAt,updatedAt,contentHash,sizeBytes,indexState`。不能回传整篇 Markdown；原文由现有下载/分段读 API 取得。

新工具使用既有 writeScopes（read+write），intent/source 读取用 readScopes 且服务端仍验证所有者/目标。使用 snake_case 工具名，与现有定义统一。以上是最小完整工作流，不新增任务清单或协同表格。

- [ ] RED：至少白板完整流、脑图/流程图 inline authority 不创建多余源附件、主文件未激活、句柄 target/role 交换、payload hash不符、撤权、过期、重复 requestId/不明结果重试，以及每个完整响应 ≤64KiB。实际通过 `createKnowledgeToolPort` 与真实 store 测试，不只测 schema 或 mock。
- [ ] 实现 shared 定义与专用 subport，knowledge-tools 仅分派 call/authorizeTransfer，并更新 get_knowledge_operation 的新收据联合和 target binding 鉴权。
- [ ] 主体、目标、角色、source/preview上传固定；UTF-8 解码保留 BOM。只有主服务允许的 Source/Png/Main 才完成上传，不绕过源/PNG/schema/CAS策略。
- [ ] unknown-outcome replay：若 primary commit 或其 core write 已成功而 outer MCP 收据未 complete，能从已记录 metadata/core receipt 恢复 bounded 结果，不依赖已过期的上传字节。若实际未提交，过期材料明确失败。必要时添加一个 creator/target-bound core metadata getter，不能读任意 operation/private内容。
- [ ] 运行新测试及适用旧 `tests/mcp-knowledge-full.test.ts`、`tests/mcp-knowledge-review-r1.test.ts`、`tests/mcp-primary-diagram-resource.test.ts`，父执行者统一 typecheck/build。全量长套件留到阶段冻结后由父执行者统一运行，避免与并行 reader 修改混合版本。
- [ ] 显式暂存 owned 文件并提交，self-review；完整报告写到指定 report 文件，只返回 DONE/concerns、commit hashes、测试摘要。父执行者再安排独立 spec+quality review。
