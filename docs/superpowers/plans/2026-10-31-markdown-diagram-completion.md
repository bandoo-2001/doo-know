# Markdown 图形文档剩余实现 Implementation Plan

> **For agentic workers:** Parent executes persistent migration/history work inline; independent semantic/media/MCP domains use superpowers:dispatching-parallel-agents. Existing design is approved; no repeated design approval or mobile work.

**Goal:** 完成验收报告中仍未实现的明确设计要求，而不是把拒绝操作、兼容原文或专项通过当成最终目标。
**Architecture:** 沿用现有主文档 parser、固定 source/render/PNG 和完整写入闸门；新增专用迁移日志与原始类型历史，索引完整扫描证据独立于可检索范围，媒体/传输共用便携核心。
**Tech Stack:** 既有 TypeScript/Vue/SQLite/markdown-it/Zod/Excalidraw/Mind Elixir/Mermaid/Vitest/Playwright desktop。
**Spec:** `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`；最新验收 `docs/markdown-diagram-acceptance-2026-10-31.md`。

## Global Constraints

- 原项目用户工作保留；继续在 managed tree 开发，验证后以 task-only 差异安全回集，保留原项目暂存区。
- 仅临时知识库/脱敏资料，不迁移真实库、不部署/重启现有服务；不开展 mobile/App/PWA/widgets。
- 不重复已完成桌面编辑器/prepare/commit/公开投影；复用已验证 helper。
- 原文、源、派生 PNG 的摘要和权限分别校验；源或渲染输入变更不能改绑旧 PNG。
- 每个失败场景先根因取证、回归 RED，再实现 GREEN；全套只在代码冻结后适用分片跑，不并行改源码时跑。

## Review Focus

1. 同 UUID 跨 JSON/Markdown 切换后，旧会话、历史恢复和 scanner 不能把 JSON 写回或创建第二身份。
2. 任意源码范围排除不能绕过完整 raw 扫描和缺块检测，引用必须对应真实原文。
3. 远程下载不转发凭据、DNS 重绑定/重定向都重新核验，慢网络不能占工作区锁。
4. MCP 完整重复JSON帧≤64KiB，大包/媒体不全量Buffer；后续每块/每次发布实时复核权限。
5. 私有读取可显示待核对外部快照，完整导出必须有固定 render tuple 的服务器准备证据。

## Task 1: 固定主图准备证据（父执行者）

**Files:** `knowledge/diagram-publications.ts`、`tests/diagram-binding-proof.test.ts`；消费者为 portable service 与 MCP bundle。
**Interface:** `hasDiagramBindingProof(db,noteId,{sourceHash,renderHash,previewHash,previewPath,sourcePath?})`，匹配保留版本或有效准备的完整tuple+实际路径。调用者仍负责主体/当前文件哈希检查。

- [x] 实际 SQLite 版本/租约 RED→GREEN；不能仅凭 PNG path/hash 证明新标题/config；publication 回归21/21。
- [x] 导出两个入口接入、外部伪造完整元数据回归；审阅验证。

## Task 2: 语义投影与引用（semantic_projection）

**Files:** shared diagram-text-projection、indexing chunks/text/schema/worker、graph analysis 和引用消费者/测试。
**Interface:** `diagramTextSpans(markdown)` 原始 char/UTF8byte/line；`diagramAnalysisText(markdown)` 保持字符/行位置的遮罩。既有 chunk/stage/publish 方法签名不变，完整迭代写 raw hash/size/chunk inventory proof。

- [x] 三类正文/摘要/大纲/标签真实位置，元数据与重复预览排除；普通20MiB流式和内存预算不退化。
- [x] publish 对全chunker要求完整扫描、缺语义块仍拒绝；图谱本地和模型同投影，人工决策保留。
- [x] 旧索引/旧checkpoint升级失效及重排，旧JSON原始范围不假装Markdown；定向回归与审阅。

## Task 3: 媒体和完整资源交付（portable_media）

**Files:** assets/media/remote/portable core、shared资源解析与预算、owner/public流式HTTP、必要上传UI。
**Interfaces:** asset inspect/inspectById 返回元数据descriptor，open(descriptor,{start,end,check})返回已核验流；portable validate(p,id)实时复核fixed closure；import第三参数check回调用于批次权限更新。与MCP agent协调。

- [x] MP4/WebM/MP3/WAV 结构校验和流式上传/读取/range，128MiB单媒体与共享总/暂存配额。
- [x] HTML媒体/封面/srcset/source真实源码范围、data安全持久化、blob浏览器先持久化；包内标准链接降级可用。
- [x] DNS固定公共IP、30s/3跳、不转发凭据、取消/错误清理；短锁快照与锁外网络/压缩，实际慢流不阻塞保存。
- [x] 自己生成的完整媒体包归档和目录回导，权限收紧停止流或未执行发布，审阅验证。

## Task 4: MCP 严格便携入口（portable_mcp）

**Files:** focused portable MCP port、mcp-transfers、knowledge-tools/bundles、shared/SDK与测试。
**Interfaces:** `export_portable_documents`、`begin_portable_import_upload`、`import_portable_archive`、`get_portable_import_result`；共用 portable core，不改变raw下载和旧bundle归档形式。

- [x] 有界流式transfer，大包无全Buffer，所有完整重复JSON帧≤64KiB；1000映射分页、精确未知结果恢复。
- [x] 各块重新鉴权/版本/工作区、媒体descriptor流、导入每份发布fresh principal；角色/目标不能交换。
- [x] 旧bundle对新primary同固定预览闸门；SDK未知导入结果查新receipt，不误用知识operation。

## Task 5: 稳定身份迁移、历史与通用文件操作（父执行者）

**Files:** 新 whiteboard-migrations / migration-journal / revision-context / native-link plan 与routes/UI/tests；窄修改core intents/recovery、notes scanner、recovery/snapshots/history consumers。
**Interfaces:** 迁移preflight/plan/prepare/commit/resume/rollback；固定旧身份、原文/最终source hash、新MD、受控备份及入站改写；历史记录 documentType/payloadFormat/logicalPath/contentHash/resources。浏览器渲染最终源码。

- [x] 迁移前保留旧文档活动，固定新source+PNG之后短切换；专用日志恢复所有FS/DB中断，旧路径别名与UUID、收藏/ToDoo/历史归属不丢。
- [x] 冲突目标不覆盖、未知/无效场景跳过保留、重复幂等；新编辑后回滚不覆盖，旧会话VERSION_CONFLICT；旧copy不被扫描成第二note。
- [x] 历史原始类型与逻辑路径/资源清单，旧JSON按场景重新prepare，跨目录恢复先重定位并匹配最终PG；小/大恢复同规则。
- [x] 将当前原生链接拒绝分支提升成有固定基线/最终source/PG的操作计划，跨目录move/copy/rename/undo/restore/导出导入共规则；共享资源保留及备份重建完整。
- [x] 旧inline v1完整回导重建durable准备/路径证明，消除无修改再导出仍需重画；已消费旧receipt跟随当前实际身份。

## Task 6: 最后集成与完成审计

- [x] 浏览器目录整体上传、作业跨重开管理/取消/恢复，与MCP/owner传输统一核心。
- [x] 桌面全部功能和故障回归，迁移/旧草稿/历史/ToDoo/备份临时库，全类型媒体包换目录普通渲染及回导。
- [x] 独立审阅修复，冻结完整分片及最终受影响回归、type/build退出0；16项发行物环境门禁记入发布准备未验证项，不冒充通过。
- [x] 按完整规格逐项审计、更新原项目报告并安全回集任务差异；用户工作和暂存区保留，未进行真实迁移/部署。

进展记录：已勾选项目的实际提交及验证见 `docs/markdown-diagram-stability-progress-2026-10-31.md`；最后的完整冻结验证尚未执行。252 MiB 两媒体包回导的额外复制暂存，以及跨目录历史和回收站上下文仍需完成，不能用当前专项通过代替总体完成。


2026-11-01 补记：上述历史、通用操作和最大完整包回导均已实际实现并独立审阅；旧“仍需完成”段落是当时记录。当前剩余Task6最终集成：单元完整分片已退出0，但最后桌面联合仍发现并正在修复缺源文档隔离问题；随后继续冻结验证和安全回集，不将文档勾选当作产品通过证据。


## 最终验收（2026-11-01）

此前段落的剩余实现均已补齐；最后集成又修复缺源全库阻塞与历史/leave自动保存竞态并补五条真实浏览器回归。完整451文件分片3457测试通过/16环境跳过，最后两组件相关14文件166项复验通过、桌面72项通过、独立脑图8项及PNG隐私1项通过，最终type/build与原目录typecheck退出0。源码与报告已安全回集。16项发行物门禁和实机打印/真实嵌套挂载等未验证边界保留到准备阶段；真实知识库迁移、部署和服务重启仍未执行。最终结论及限制见统一验收报告。
