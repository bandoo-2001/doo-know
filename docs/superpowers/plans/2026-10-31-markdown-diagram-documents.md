# Markdown 图形文档统一改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 白板、脑图、流程图以 Markdown 为主文件，保留稳定身份、完整图形版本和可离线阅读、整体回导的资源包。

**Architecture:** 共享解析器负责语义类型、受管范围和源/预览绑定，服务端统一负责版本校验、资源解析和完整提交。浏览器负责 PNG 准备；文件生命周期、公开投影、索引与便携传输复用同一契约。旧白板双读，迁移通过专用日志保留原身份。

**Tech Stack:** TypeScript、Vue 3、markdown-it、Zod、SQLite、Excalidraw、Mermaid/CodeMirror、Mind Elixir、SnapDOM、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`（已获用户确认）。

## Global Constraints

- 三种图形以 `.md` 为入口；PNG 和相对路径附件承担外部阅读；首版每篇一个主图。
- 普通笔记内嵌图保留仅存源码能力；专用主图完整保存必须有匹配 PNG。
- 脑图只支持根节点、纯文本和父子/同级顺序；流程图使用 Mermaid 源码与预览。
- 保留原 UUID、历史、收藏、分享限制和 ToDoo 关联；数据库类型只是可重建缓存。
- 单篇无依赖返回 `.md`；有依赖、多篇或目录返回归档；完整包能整体回导。
- 独立鉴权关联文档，读取和下载复核授权；公开默认仅正文及 PNG，原件单独授权。
- 远程网络、渲染、压缩在排他锁外；不部署服务端浏览器。
- 开发仅用临时测试知识库；不迁移真实知识库，不部署或重启常驻服务。
- 原工作目录的用户改动不得覆盖、清空、暂存或混入功能变更提交。

## Review Focus

1. 未知/重复标记及代码示例中的伪标记：保持原文并安全退回普通 Markdown（Task 1）。
2. 提交结果不明及旧会话重试：只激活一个完整版本，旧 JSON 不覆盖新 Markdown（Tasks 4、7）。
3. 路径变化导致原生源变化：不得改绑旧 PNG，先准备最终源版本或整项拒绝（Task 6）。
4. 导出后撤销关联权限及慢媒体：终止下载并回收暂存，普通保存不长时间阻塞（Task 12）。
5. 仅源附件/PNG 外部改变：主文档状态和索引必须过期，真实引用范围仍正确（Tasks 8、14）。

## 基线与执行方式

- 原目录 `/home/bandoo/workspace/projects/doo-know`，分支 `txj/release-rc58`，HEAD `393979a664142dcef981abbfe6422fa70715a4fa`。
- 原目录已有 63 个受跟踪文件变更，另有 ToDoo 源码、测试、设计证据和本方案等未跟踪文件。
- 原生工具创建隔离目录 `/home/bandoo/.codex/worktrees/markdown-diagram-documents/doo-know`。
- 兼容基线 `5cd82ce` 单独记录用户工作副本；它不是本任务的功能提交，不应将此基线提交发布成图形改造。功能差异以 `5cd82ce..HEAD` 为准，最终回集仅取该范围。
- 用户已授权细化计划后连续开发，无需再次确认常规实现决定。执行者在本会话逐项实现，每阶段更新本文件；完成后安排独立代码审阅。
- 初始复用现有 node_modules，只读检查不重装全部依赖；新增依赖时改为隔离安装，避免改动原目录依赖。

## 冻结的协议和责任边界

1. 文档标记 v1：`<!-- dooknow:document {JSON} -->`，已知字段 `version,type,engine`；未知字段保留。仅在 BOM/frontmatter 后第一个顶层块有效；其他冲突文档标记导致恢复模式。
2. 一个主图受管区：独立顶层 `<!-- dooknow:primary:start -->` 与 `<!-- dooknow:primary:end -->`。区内标题之外的格式按类型校验；说明区保持原字节。未知格式拒绝写回。
3. 主图绑定另用 `dooknow:primary-binding` v1 JSON：源字节 SHA-256、render fingerprint、PNG 摘要；旧 `diagram-preview` v1 内嵌协议保持可读。主文件完整摘要用于 CAS；渲染指纹只含类型、源摘要、根标题、渲染器及配置，不含 PNG/路径/绑定自身。
4. `DiagramResource` 将 `role:primary|embedded`、`sourceFormat:excalidraw|markdown-outline|mermaid`、完整主文件版本和编辑能力分开。前端不得把新白板 note.content 当 JSON。
5. 新建预留、图形完整提交、迁移意图、版本资源保留分别由服务端模块负责；通用 mutation core 是 Web/MCP/patch/上传/恢复的最后写入闸门。
6. 源重定位计划在实际提交之前产生最终源摘要；待预览用结构化错误返回计划、基线及文档 ID。不能完成半项文件操作。
7. 共享初始传输预算：包总量 256 MiB、10000 文件、关联文档 1000；单媒体 128 MiB、单 PNG 10 MiB、白板 8 MiB；网络每资源 30 秒、3 次重定向、暂存每任务 512 MiB。服务端允许收紧，前端消费同一配置；后续实测若需调整记入进度。
8. 媒体/便携暂存模块支持流式写入，旧 JSON 导入的 20 MiB/200 文件限制保留。新接口单独提供流式归档及分批目录暂存。

## Task 1: 主文档格式、范围及摘要（阶段 1）

**Files:** 新建 `shared/diagram-document.ts`、`shared/diagram-document-binding.ts`、`tests/diagram-document.test.ts`、`tests/diagram-document-binding.test.ts`、`docs/diagrams/format-v1.md`、`tests/fixtures/diagram-documents/{whiteboard,mindmap,flowchart}.md`。
**Interfaces:** `parseDiagramDocument(markdown:string): DiagramDocumentParse` 返回 ordinary/invalid/diagram 的可辨识联合、原始元数据和字符范围；`replaceDiagramPrimary(markdown:string,body:string):string` 仅改受管区；`hashDiagramBytes(string|Uint8Array):Promise<string>` 精确字节摘要；`diagramRenderFingerprint(input:DiagramRenderInput):Promise<string>` 不依赖派生路径。

- [x] 编写标记识别、BOM/frontmatter、CRLF、未知字段/版本、重复/缺失区、嵌套/代码伪标记及说明保留测试；运行 `npm test -- tests/diagram-document.test.ts tests/diagram-document-binding.test.ts`，确认 RED。
- [x] 实现共享 schema/解析/替换/绑定与三份完整样例，未知输入不自动重写。
- [x] 同命令 GREEN；以标准 markdown-it 渲染样例确认正文与普通图片/链接可读。
- [x] 审阅范围定位和摘要不自引用；显式暂存本任务文件并提交。

## Task 2: 脑图受限大纲适配和 PNG 验证（阶段 1）

**Files:** 新建 `shared/mindmap-outline.ts`、`apps/web/diagrams/mindmap.ts`、`tests/mindmap-outline.test.ts`、`tests/e2e/mindmap-adapter.spec.ts`、适配测试页面；修改 `package.json`、`package-lock.json`。
**Interfaces:** `parseMindmapOutline(source:string):MindmapNode`、`serializeMindmapOutline(root:MindmapNode):string`；节点 `{id,topic,children}`，ID 会话生成，不成为正文权威。`renderMindmapPng(root:MindmapNode):Promise<Blob>` 用临时展开实例。

- [x] RED：同名节点、中文、Markdown 转义、重排、500 节点/深树、拒绝富文本/多行结构的往返测试。
- [x] 核对官方 API，锁定确切依赖和许可证；实现适配器和不改变用户折叠/视口的整图捕获。
- [x] GREEN：单元测试及隔离浏览器中文输入、快捷键、撤销、离屏节点、整图 PNG 和 500 节点耗时记录；禁止外链字体/图片请求。
- [x] 运行 typecheck/build，记录验证与限制；审阅并提交。

## Task 3: 共享资源契约与文档类型（阶段 1）

**Files:** 修改 `shared/{contracts,knowledge-contracts,whiteboard}.ts`、MCP schema/SDK；新建 `shared/diagram-resource.ts`、`shared/portable-resource-limits.ts`、对应测试。
**Interfaces:** `DocumentType=markdown|whiteboard|mindmap|flowchart`；`DiagramResource` 与 `DiagramPreviewRequired` 公共类型；类型识别接收完整正文，旧后缀识别保持独立。

- [x] RED：旧 JSON/普通 Markdown 类型兼容、角色不等于类型、结构化待预览及预算边界。
- [x] 实现共享类型、预算和协议版本，更新消费者以通过类型检查；不提前激活新编辑器。
- [x] 跑对应测试、`npm run typecheck`；审阅并提交。阶段 1 所有门槛通过才开始阶段 2。

## Task 4: 预留身份、统一资源读取和完整提交（阶段 2）

**Files:** 新建 `packages/core/knowledge/diagram-documents.ts` 及 schema；修改 `diagram-artifacts.ts`、`notes.ts`、`knowledge/core.ts`、`db.ts`、Web/agent routes；新增临时库集成测试。
**Interfaces:** `reserve(input:{requestId,path,type}):CreationIntent`；`resolve(noteId,role,principal):DiagramResource`；`commit(input:{intentId?,noteId,expectedDocumentHash,expectedSourceHash,markdown,requestId}):NoteDocument`；所有 mutation 调用同一个提交校验。

- [x] RED：首次 PNG 未完成不入扫描、提交失败旧版本可读、并发/不明结果幂等重试、过期源和源码绕过被拒绝、取消/续跑/过期意图。
- [x] 实现兼容数据库迁移、预留/激活状态、权限资源解析、源/PNG 摘要校验及写入恢复日志；长准备在锁外。
- [x] GREEN：Web/MCP/patch/上传同策略；恢复重启与授权隔离集成测试、typecheck；审阅并提交。

### Task 4A: 可恢复预留身份（Task 4 的首个可验证子项）

`diagramCreationService(config, db, principal)` 先提供 `reserve({path,type,requestId})`、`get(intentId)`、`cancel(intentId)`。预留 UUID 仅存 `diagram_creation_intents`，不提前写 notes 活动记录或主文件；24 小时准备租约，过期/取消释放路径，但同一请求仍返回明确终态，不复用旧回执新建身份。主键、调用主体/客户端、路径和请求参数均绑定；后台重开数据库保持身份。表迁移在 openDatabase 中幂等创建。图形附件准备接入与完整发布为 Task 4B，届时由同一意图传递可信 noteId 给 mutation core；不能开放一个可由客户端指定任意 UUID 的普通创建参数。

Files: `packages/core/knowledge/{diagram-creation,diagram-document-schema}.ts`、`packages/core/db.ts`、`tests/diagram-creation.test.ts`。测试涵盖无主文件/活动索引、重复请求/参数冲突/路径竞争、撤权和跨主体访问、已有文件冲突、取消/过期与重启恢复。该子项不单独开放 Web/MCP 创建入口。

## Task 5: 新白板 UI、草稿、隐藏标记与公开投影（阶段 2）

**Files:** 修改 `Workspace.vue`、`WhiteboardWorkspace.vue`、`DiagramPreview.vue`、`DocumentEditor.vue`、draft/session 模块、`knowledge-markdown.ts`、`shares.ts`、`share-resources.ts`、公开路由；新增测试。
**Interfaces:** 白板 UI 消费 Task 4 的 reserve/resolve/commit；草稿 v2 `{documentType,payloadFormat,documentHash,sourceHash,intentId?,payload}`；公开解析仅授予 preview 能力。

- [x] RED：新建/重开/只读分享/旧白板双读、旧 JSON 草稿保留、跨视图/多标签页冲突及所有公开原件入口拒绝。
- [x] 接入创建及自动保存协调者、源码恢复/预览切换、原文保护 token；所有公开读取和源下载遵循能力校验。
- [x] GREEN：单元/桌面白板 E2E（本轮按用户要求不开展移动端）、typecheck；审阅并提交。

## Task 6: 历史、资源保留和移动计划（阶段 2）

**Files:** 修改 `recovery.ts`、`snapshots.ts`、`file-jobs.ts`、`folders.ts`、`knowledge/move.ts`、`organization/{plan,references,journal,restore}.ts`、备份/恢复；新增资源登记与原生链接重定位模块。
**Interfaces:** `DiagramOperationPlan` 固定前后路径、最终源摘要及 pendingPreviews；版本资源清单记录 `{path,hash,role}`；源链接基于源附件目录。

- [x] RED：跨目录/目标改名/整理撤销、旧历史恢复、小/大文件同规则、复制后独立修改、目录外活动/历史/租约引用阻止删除。
- [x] 实现不可变新源、预提交预览闸门、历史类型/逻辑路径、保留根和备份清单；缺失原件明确拒绝恢复。
- [x] GREEN：所有恢复/移动/备份集成测试和外部 Markdown 阅读；审阅并提交阶段 2。

## Task 7: 旧白板迁移与引用（阶段 3）

**Files:** 新建 `packages/core/knowledge/whiteboard-migrations.ts`、迁移 Web UI/路由及测试；修改 portable identity、旧 UUID/路径解析、历史/草稿转换。
**Interfaces:** `preflight():MigrationReport`；`prepare/commit/resume/rollback` 绑定专用 journal、旧身份和版本；浏览器调用既有画布准备 PNG。

- [x] RED：同名冲突、无效场景、缺附件、旧会话写入、中断每个日志节点、重复执行、已编辑文档回滚不覆盖。
- [x] 实现预检、短切换锁、日志恢复、身份/历史归属和入站引用范围改写；原件受控保留且不被重复扫描。
- [x] GREEN：只用临时测试知识库验证上述场景及收藏/ToDoo/分享限制不变；审阅并提交。

## Task 8: 索引投影与真实引用（阶段 3）

**Files:** 修改 `indexing/{chunks,text,state,reconcile}.ts`、knowledge 引用读取、集合/向量/图谱；新增文档投影测试。
**Interfaces:** `projectDiagramText(markdown):{scanHash,ranges}`，完整扫描证明与可检索真实行/UTF-8 字节范围独立。

- [x] RED：中文真实行字节、排除元数据/JSON/重复预览、全文件扫描不连续 chunk 不触发 INDEX_INCOMPLETE、保留图谱人工决策。
- [x] 实现三类型投影及完整扫描校验；迁移不沿用旧 JSON 假范围。
- [x] GREEN：索引/全文/AI 引用/向量/集合/图谱测试；审阅并提交阶段 3。

## Task 9: 脑图编辑器（阶段 4）

**Files:** 新建 `MindmapWorkspace.vue`；修改创建菜单、Workspace 路由、草稿/撤销会话及渲染。
**Interfaces:** 复用 Tasks 1–5 的解析、适配、reserve/resolve/commit。

- [x] RED：同级/子级新增、删除、拖拽、折叠/缩放/撤销、中文输入、源码重解析、说明区字节及待预览策略。
- [x] 接入按需加载和临时整树 PNG；不引入权威 JSON，切换重置撤销边界。
- [x] GREEN：单元及 desktop E2E（本轮不开展 mobile）、typecheck/build；审阅并提交阶段 4。

## Task 10: 流程图编辑器（阶段 5）

**Files:** 新建 `FlowchartWorkspace.vue`；修改 Workspace、Mermaid 图形准备/保存策略及模板。
**Interfaces:** 主图使用受管 Mermaid 原文和完整提交；内嵌保留旧源码保存策略。

- [x] RED：模板、语法定位、实时预览、保存重开原文不变、源码与 PNG 同快照、普通笔记兼容。
- [x] 实现 CodeMirror/现有 Mermaid 预览与统一会话，根标题变化使预览过期。
- [x] GREEN：desktop E2E（本轮不开展 mobile） 及相关图形测试；审阅并提交阶段 5。

## Task 11: 共享依赖规划及便携交付协议（阶段 6）

**Files:** 新建 `packages/core/knowledge/portable-{dependencies,paths,manifest,export}.ts`、shared 传输协议；修改管理端、MCP、reading-export 和下载 UI。
**Interfaces:** `planPortableExport({selection,principal,budget}):PortableExportPlan` 固定版本闭包和边类型；`PortableDelivery` 返回 kind/name/mime/size/hash/manifestVersion；原文及旧 bundle 契约保留。

- [x] RED：单篇无依赖含表格/外链直接 md；缺附件失败；多篇/目录归档；引用式/HTML src/srcset/poster/source；跨目录、循环、代码示例、同名/大小写/中文转义。
- [x] 实现范围解析和改写、摘要去重及完整性校验；原生链接重定位按 Task 6 先准备匹配预览；两套任务共用核心。
- [x] GREEN：离开原目录用标准渲染器核对图片/路径且无 API/令牌/UUID 协议；审阅并提交。

## Task 12: 媒体、远程取回和短锁暂存（阶段 6）

**Files:** 修改 assets、上传/MCP/公开路由；新建 bounded staging/remote media；修改 export tasks 和 download 授权。
**Interfaces:** 受校验 MP4/WebM/MP3/WAV 流式资产；Task 3 预算共享；每次下载复核 Task 11 固定闭包。

- [x] RED：真实文件结构/MIME不符、配额/重定向/SSRF、blob/data 处理、远程失败诊断、撤权终止、慢网络不阻塞普通保存。
- [x] 实现有界流式暂存、地址与重定向校验、不给远程转发会话、短锁复核与所有失败路径回收；媒体标准文件链接和封面。
- [x] GREEN：慢流、取消和权限变更集成测试；审阅并提交。

## Task 13: 清单归档/目录整体回导（阶段 6）

**Files:** 修改 import/file jobs/transfer routes、Web 导入和 MCP 传输；新增 portable import 服务及测试。
**Interfaces:** `stagePortableImport` 识别版本清单、字节摘要及资源预算，`commitPortableImport` 分配新身份并重写内部路径/源/预览。

- [x] RED：真实便携包和解压目录整体回导、超过旧 20 MiB/200 文件、清单损坏/版本未知、绝对/越界/符号链接/重复文件拒绝。
- [x] 实现安全解包和批次暂存，清单不当普通资产；源变化需要匹配预览才提交。
- [x] GREEN：导出→移位→回导→重开三类型和媒体；旧小 JSON API 限制不变；审阅并提交阶段 6。

## Task 14: 外部资源变化、分享博客与备份贯通（阶段 7）

**Files:** 修改 indexing watcher/reconcile/Git state、博客捕获和发布、HTML/打印、MCP/Bridge SDK、backup/restore；新增全链路测试。
**Interfaces:** 源/PNG 反向依赖状态传播到主文档；博客冻结同一资源解析结果及版本，不包含未授权原件。

- [x] RED：只改/删除源、只改 PNG、Git 冲突、博客无 fence 新白板仍复核源、公开各入口投影一致、备份恢复新状态表。
- [x] 完成协议消费者、引用保留、图谱决策和 ToDoo 笔记关联；清查所有后缀分支及导出入口文案。
- [x] GREEN：适用全链路 E2E、完整单元分片、类型检查与构建通过；16项缺发行物的门禁单独记录为发布准备待验证，不记通过。
- [x] 分域独立审阅及最后集成复审、缺陷修复和回归完成；更新进度、剩余限制及真实迁移/部署另行处理的操作说明。

## 进度与验证记录

2026-10-31：完整读取设计；核对原目录及共享入口；原生工作树隔离完成，用户改动副本成为单独兼容基线 `5cd82ce`，原目录未修改。基线 typecheck 和全量 Vitest 已启动，结果待收集。Task 1 尚未开始。下一步：完成基线结果归档，先执行格式测试 RED→GREEN。


2026-10-31 阶段 1（Tasks 1–3）：格式解析/受管范围、精确字节摘要与无自引用指纹、受限大纲、Mind Elixir/SnapDOM 临时整图、公开能力资源契约和统一预算均已实现。纯文本适配器同时被格式解析使用，因而 Tasks 1–3 作为同一阶段提交，避免中间提交依赖缺失。完整样例为结构验证样例，不宣称已具备可发布附件。

验证：相关 Vitest 103/103；独立适配 Playwright 6/6；typecheck 通过；build 通过；新增两库许可证被现有发布 notices 脚本收录。独立阶段审阅发现 1 个 P1、2 个 P2，均以真实失败用例修复；额外补测 PNG 固定快照、根节点和公开资源能力。详见 `docs/diagrams/stage-1-validation.md`。

全量 `npm test` 仍在运行，已观察到的 chunks-large/tokenizer 和 search-cli/model-local 两项环境失败均定位并单测重跑通过；最终结果需继续收集，不能声称全量已通过。隔离依赖就绪后的源码 SHA-256 核对：原目录 427 份兼容文件均保持一致。下一步：收集全量结果并推进 Task 4 的预留身份、资源准备和统一完整提交；不得提前启用新编辑器或迁移真实知识库。

2026-10-31 Task 4A：新增幂等数据库表及 `diagramCreationService` 的 reserve/get/cancel 原语。预留不创建主文件、不插入 notes/document_state 活动记录；绑定主体、客户端、目标路径和幂等参数，支持 24 小时租约、取消、过期和重启恢复。7 个专项测试通过，连同格式/资源契约回归 50/50；typecheck 通过。尚未开放 Web/MCP 入口，也未接入附件准备和发布，Task 4 整项保持未完成。

接续 Task 4B 的责任边界：新增主图准备回执，固定调用主体、预留 ID/笔记 ID、主文件基线、原生源基线、源码摘要、标题/renderer/config 渲染指纹和 PNG 摘要。白板写不可变源附件+PNG；大纲/Mermaid 只需 inline 源+PNG。`assets.upload` 当前要求活动 notes，须增加在同一短锁内验证创建意图的专用准备入口，不能扩大普通 `notes.exists` 权限。最终创建需通过可信服务将预留 UUID 交给 mutation core，客户端不能任意指定 UUID。所有普通写入入口随后接入同一图形完整性闸门；准备失败或无 PNG 不激活主文件。

2026-10-31 全量结果：原长跑已结束，392 文件中 387 通过、3 失败、2 跳过；2862 项中 2838 通过、8 失败、16 跳过。六个格式失败是长跑开始后缓存的审阅前实现，另两项为环境问题；当前最终实现对应测试全部已单独回归通过。该次混合版本运行不冒充全量通过，后续冻结代码后重新运行全量。

2026-10-31 Task 4B（准备部分）：新增 `shared/diagram-primary.ts`（渲染器/适配器版本、准备回执和完整主文件序列化）、`knowledge/primary-diagrams.ts`（主图 prepare）、`primary-diagram-state.ts`（主文件与源的独立版本读取）。新增 `diagram_prepared_primaries`，绑定当前主体/客户端、预留身份或活动文档的完整摘要及源基线、源/渲染/PNG 摘要和租约。白板上传源+PNG；脑图/流程图只上传 PNG。普通上传仍拒绝未发布 UUID，专用上传在锁内复核创建意图；无主文件提前激活。幂等、重启、部分上传失败续跑、过期、篡改、并发源/主文档变化均有测试。相关回归 84/84、typecheck 通过。未开放新路由，完整提交闸门仍待实现。

协议细化：metadata 可显式记录 `render:{renderer,config}`；渲染器指纹包含 DooKnow 适配器版本 `+dooknow@1`，与库版本共同绑定。大纲源的字节范围截止最后节点行的换行，不把图片前分隔空行计入源摘要；内联权威源需结束换行。格式解析和新序列化实际往返测试固定该规则。

2026-10-31 Task 4B 准备复审：独立 reviewer 报告两个 P2，分别为脑图前导空行使 sourceHash 与最终范围不符、白板文字空行加缩进形成意外块。已用真实失败用例修复：准备阶段在写资产前执行实际主文件序列化/解析，要求 inline 源逐字节一致；白板派生文字摘要采用动态围栏的标准 `text` 代码块，保留空行、缩进、类似机器标记的文字。额外补测 28 万字符、14 万围栏片段避免参数展开栈溢出。准备模块 16 项测试；含回归 91 项通过，适配浏览器 6/6 通过，typecheck 通过。

2026-10-31 Task 4C（发布基础）：新增 `diagram-publication-policy.ts` 与 `diagram-publications.ts`，通过待发布日志和固定版本资源清单，联动 mutation core 的新建/普通更新及恢复 record。`createDiagram` 只接受已授权创建意图并从服务端取预留 UUID，普通 create 不能冒充完整主图；完整提交固定源码/PNG/标题/renderer/config，普通源写入不能移除主图或绕过预览，说明区变化可复用已发布资源。`primary.commit` 支持已知/不明结果重试、跨文件系统写入后数据库记录失败的恢复，回执返回 Markdown；类型缓存和文件树/原文类型响应同步更新。单篇授权用固定 noteId/role/path/hash 证明读取其源附件，不扩大目录权限。未知格式版本保留普通 Markdown 源码恢复能力；已知主图不能借此移除类型。

验证：9 个发布集成测试通过，连同准备/格式/旧白板/传输/恢复共 113/113 通过；typecheck 通过。Task 4 整项仍未完成，接续事项：patch/file-jobs、上传提交和小/大历史恢复接入同一策略；补齐预留创建到资源读取的 Web/MCP 接口。尚未开放新建 UI/路由，不宣称公开投影、大文件、移动、历史资源保留已完成；这些必须在阶段 2 验收前解决。

2026-10-31 Task 4C 发布复审：独立审阅复现 1 个 P1（record 恢复未验证附件）和 2 个 P2（提交结果未明时取消仍成功、显式 preparedId 与提交快照不符）。三项均已 RED→GREEN 修复。恢复记录前重新验证清单内每份源/PNG 的固定摘要，缺失/变化保持未激活与待恢复；创建意图增加 commit_operation_id，进入可恢复文件提交后显示 committing 并拒绝假确认取消，提交前失败则释放占用、保留预留 UUID 可重试。显式 commit 必须匹配指定回执的主体/客户端、源/渲染/PNG 摘要和资产路径。

普通已授权文档更新仍可复用同篇文档、同基线的固定准备产物，供浏览器准备后由 MCP 按原写入重试；这不开放其他笔记资源，也不开放显式 preparedId 的跨主体提交。发布集成测试现为 14 项，含三项审阅复现、跨客户端授权差异和真实提交前文件丢失后的新请求恢复；相关回归 118/118，typecheck 与 build 通过。原目录 427 份兼容文件 SHA-256 再核对保持一致。

下一执行单元：Task 4D，先为 patch/file-jobs、snapshot 上传、revision 恢复列出实际落盘入口；复用同一发布校验。大文件用有界声明扫描区分普通 Markdown 与图形，不为检查类型整篇读取/解析普通大笔记；对图形 main/source/PNG 则固定完整版本。完成这些写入闸门及 Web/MCP 资源接口后才进入 Task 5 的新 UI 和公开投影，不提前声称 Task 4 或阶段 2 完成。

2026-10-31 Task 4D：完成实际落盘入口核查与统一校验。新增 `diagram-declaration.ts` 的有界同步/异步声明扫描，`diagram-file-publication.ts` 对保留声明的候选主图按完整固定字节摘要校验。后台 patch 和大文件历史恢复从固定 snapshot 读取原版本，提交前复核现场主文件；回收站恢复在搬回前及重试时复核资源。MCP 上传和小历史恢复已通过 core 策略，实际集成测试验证；修复原文上传默认 UTF-8 解码丢 BOM 的问题。后台操作错误持久化完整待预览列表，operation 返回结构化 details。恢复证明首次文件未保留时释放创建占用并保持原 UUID 可新请求重试。

验证：声明/入口/旧 patch/中断恢复等 51 项通过；另组旧 MCP 全链路/恢复 30 项通过（两组重叠）；真实 20 MiB 分块及原有内存预算测试通过。typecheck/build 已通过，最终固定 snapshot 调用调整的补充回归亦通过。详见 `docs/diagrams/stage-2-write-entries.md`。

下一步 Task 4E 仍需完成：资源解析与 Web/MCP 接口、>1 MiB 图形主文档及发布中读取一致性；尤其更新 rename 后 record 失败不能向读者冒充完整版本。通用 operation 状态不能承载大型全文；主图幂等原文返回与有界状态结果需要区分。随后 Task 5 公共投影与 UI、Task 6 生命周期/历史/原生链接，以及所有后续阶段继续执行，Task 4/阶段 2 仍未完成。

2026-10-31 Task4E/4F 接续：私有 owner HTTP 与 MCP 图形资源/源码下载已接入，共用发布完成版本读取；有效图形主文件支持20MiB，普通大文件保留流式预算。完成真实源版本绑定的类型/标题缓存；乱码候选仅影响单文档，不阻断整个文件树。MCP 新增七个有界 opaque 写入工具，三类 source/PNG/main 上传固定角色和目标，原文下载仍是 Markdown，提交/状态收据不含大型正文，未知成功可在材料过期后用固定摘要证明恢复。

验证：30个图形/旧白板/快照相关测试文件301/301通过，MCP专用与兼容四文件51/51通过（重叠）；typecheck/build通过。读取审阅两项P2已复现并修复；写入独立审阅一项P2为发布后跨权限目录移动的当前路径鉴权，正在修复并将复审，Task4 GREEN/完成状态仍保留未勾选。原工作目录427份保护基线文件摘要均未变化。

Task5已细化为 `2026-10-31-markdown-diagram-public-projection.md` 与 `2026-10-31-markdown-diagram-editor-session.md`。公开投影/旧资源适配和前端会话分离实施，接口由两个子计划冻结；Task6历史/移动、后续迁移/检索/编辑器/便携交付仍持续推进，不代表完成。

Task4F 最终验收：发布后当前路径鉴权已在5b841f5修复，三种成功/不明成功情形均真实RED→GREEN；五文件62/62，修复后typecheck/build通过。独立复审Spec/质量均批准。核心私有主图与写入已完成，Task5继续旧格式/嵌入资源兼容与公开投影；这些兼容项及Task6通过前，阶段2不关闭。

Task5A 后端与旧资源适配已完成审阅：公开投影/分页、原件能力、旧源码与PNG、博客主图分支；三项审阅问题真实复现后修复，独立复审Spec/质量通过，覆盖8文件104项。草稿v2基础与失败恢复保留已通过51项（含真实IndexedDB CAS/隔离）。安全公开阅读及原件授权开关桌面/移动8项通过，当前typecheck/build通过。仍未完成实际保存协调者、新Markdown白板创建和会话视图、历史与移动，阶段2继续；完整长套件留阶段冻结后运行。


2026-10-31 稳定性收尾更新：以上分项勾选补录已实际实现并经专项测试/审阅的工作；验证明细及提交见 `docs/markdown-diagram-stability-progress-2026-10-31.md`。它们不等于最后统一验收。Task 6 跨目录历史资源身份、回收站改名恢复，Task 11/13 最大完整资源包回导的暂存配额修复仍在收口；Task 14 最终冻结 typecheck/build/Vitest 全分片、桌面集成及原项目安全回集尚未完成。常驻服务、真实知识库未迁移或部署。


2026-11-01 统一验收：Task 6/11/13 的实现与独立专项均已完成，历史资源/单篇及文件夹回收站/共享保留/真实252 MiB回导报告位于 `docs/diagrams/validation/`。冻结单元451文件、3446项通过及16项环境跳过，type/build退出0。最终桌面联合发现无关主图缺源阻塞全库操作，正在修复、补正反回归并复审；最终GREEN及原项目回集仍保持待完成，以统一验收报告为准。


2026-11-01 最终验收：所有本轮功能任务已完成；完整单元3457通过/16环境跳过、最终两组件相关166项及桌面72项通过，type/build与原目录typecheck退出0。最后缺源隔离和保存决策竞态均有真实RED、独立复审与GREEN。历史待办段落保留原时点，当前以 `docs/markdown-diagram-acceptance-2026-10-31.md` 为准；实际迁移、发行物门禁补证、部署及重启不在本轮执行范围。
