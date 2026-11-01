# Markdown 图形文档验收与稳定性收尾

验收日期：2026-10-31 至 2026-11-01（UTC）。依据：[总体方案](superpowers/specs/2026-10-31-markdown-diagram-documents-design.md)、[主实施计划](superpowers/plans/2026-10-31-markdown-diagram-documents.md)、[补齐计划](superpowers/plans/2026-10-31-markdown-diagram-completion.md)。本页替代首轮的阶段性结论；历史证据保留在 Git 记录及[进展记录](markdown-diagram-stability-progress-2026-10-31.md)。

**当前状态：最终桌面联合回归正在修复、复验，尚未放行。** 手机端、App、PWA、桌面小组件不在本轮范围。真实知识库迁移、生产部署、服务重启均未执行。

## 工作基线与用户工作保护

原项目 `/home/bandoo/workspace/projects/doo-know`，分支 `txj/release-rc58`，HEAD `393979a664142dcef981abbfe6422fa70715a4fa`。开发和验收在隔离工作树 `/home/bandoo/.codex/worktrees/markdown-diagram-documents/doo-know` 进行，测试使用临时知识库及合成资料。

原项目既有 ToDoo 未提交工作按 427 个文件摘要保护。原目录此前仅回集到 `fe24474`；最新回集尚待最终验证。424 个保护文件保持原字节；`Workspace.vue`、`package.json`、`package-lock.json` 为已知三处交叠，按兼容基线合并。原分支、HEAD、暂存区保持不变。仅新增 Mind Elixir 和 SnapDOM 两个项目依赖。任务差异从 `5cd82ce` 兼容快照计算，该快照包含用户工作，不能整体当成功能提交发布。

## 可追踪验收清单

“通过”以实际执行为依据；专项互有交集，不相加冒充全套总数。环境跳过和未验证项目不算通过。

| # | 验收项目 | 状态 | 证据及实际边界 |
| --- | --- | --- | --- |
| 1 | 白板、脑图、流程图创建/编辑/保存/刷新/视图切换 | 专项通过，最终联合复验中 | 真实 Excalidraw、Mind Elixir、Mermaid；首次固定 source/render/PNG 后激活 `.md`；源码与专用工作区互切、刷新重开、标题/说明及原生链接。 |
| 2 | 标记、受管区、说明正文、普通编辑兼容 | 专项通过，最终联合复验中 | BOM/frontmatter、未知字段、代码示例伪标记、CRLF、非受管正文；CodeMirror 实际 undo/redo；普通笔记导航、草稿、树菜单、设置往返。 |
| 3 | 草稿/并发/断网/重试/渲染失败/首次创建完整性 | 专项通过，最终联合复验中 | 未决定恢复前保留唯一草稿；一致读快照；同 UUID 创建续跑；未知结果、请求丢失、CAS、配额不足、下载原草稿、失败源码和过期 PNG。 |
| 4 | 旧白板迁移、稳定 UUID、引用、旧草稿、历史 | 专项通过，最终联合复验中 | 专用 preflight/prepare/commit/resume/rollback；旧路径别名、两扫描器防重复身份；旧 JSON 草稿核对后转换；历史保留原始格式/逻辑路径/资源，重新生成匹配 PNG，禁止 JSON 直接写入新 Markdown。 |
| 5 | 移动/复制/改名/整理/撤销/回收站/恢复 | 发现联合缺陷，修复中 | 通用原生预览计划；源内链接和附件相对路径；复制新身份、共享资源保留、跨目录历史、单篇及文件夹恢复、真实进程退出恢复。最终联合发现：不相关主图缺源阻塞全库操作，正在修复。 |
| 6 | 单篇 `.md`、依赖/批量归档、完整性与缺失报告 | 专项通过 | 无依赖含普通外链直接 `.md`；有依赖或批量返回清单归档；循环引用、本地/远程/data/blob/HTML 媒体、视频封面、MP4/WebM/MP3/WAV、缺失/越权/变化/超限明确失败。 |
| 7 | 外部普通 Markdown 阅读及完整包回导 | 专项通过，最终联合复验中 | 三类真实编辑器 PNG 离线换目录；普通 markdown-it/Chromium，无 DooKnow/API/插件请求；原生链接最终 PNG；真实 SDK 闭环；归档及解压目录整体回导、持久作业重试。 |
| 8 | 分享/公开/博客/HTML/打印权限 | 专项通过，最终联合复验中 | 默认只读投影，原件能力独立且不赋予编辑权；逐块当前授权；PNG 内嵌可恢复场景防泄露；博客缓存/设计头像同闸门；HTML 和打印正文共用已验证输出，未连接实机打印机。 |
| 9 | 检索/AI 引用/图谱/Git/MCP/备份/ToDoo | 专项与完整单元通过 | 语义投影使用真实原文 UTF-8 行字节，完整 raw 扫描及缺块证明独立；旧 JSON 标签解码；索引/图谱版本重建保留人工决策；源/PNG/Git 冲突失效；MCP 有界预览/传输、备份恢复及稳定 noteRefs。 |

实际桌面截图：[白板](diagrams/acceptance-desktop-whiteboard.png)、[脑图](diagrams/acceptance-desktop-mindmap.png)、[流程图](diagrams/acceptance-desktop-flowchart.png)。三类实际编辑器离线产物：[白板 PNG](diagrams/acceptance-offline-whiteboard.png)、[脑图 PNG](diagrams/acceptance-offline-mindmap.png)、[流程图 PNG](diagrams/acceptance-offline-flowchart.png)。均来自临时测试资料。

## 已修复问题及主要文件

| 问题及根因 | 修复与主要位置 |
| --- | --- |
| 新入口仍创建旧 JSON；缺少共用完整保存会话 | `apps/web/components/DiagramDocumentWorkspace.vue`、`Workspace.vue`、`apps/web/diagrams/`：三类原生工作区，复用 reserve/prepare/commit，图形主文档单一草稿协调者。 |
| 离开恢复提示删除草稿；混合读取覆盖他人说明；派生替换破坏撤销 | `document-read.ts`、`document-session.ts`、`document-draft.ts`、`apps/web/editor/external-markdown.ts`：一致版本读取、held recovery、CAS、精确无历史差异。 |
| 仅凭 PNG 摘要冒认 source/render 绑定 | `packages/core/knowledge/diagram-publications.ts`、便携/MCP 消费者：固定完整元组及实际物理路径的准备证明。 |
| 旧迁移缺少稳定身份、入站图形预览、崩溃续跑与编辑保护 | `packages/core/knowledge/whiteboard-migration*.ts`、`WhiteboardMigrations.vue`：迁移日志、受控原件、别名、固定最终源预览；原生入站引用、回执重建及回滚冲突保护。 |
| 旧草稿/历史被当作新 Markdown；跨路径恢复使用错误资源基准 | `apps/web/diagrams/legacy-draft.ts`、`packages/core/knowledge/revision-context.ts`、`history-restore*.ts`、`recovery/`：保留原始类型、逻辑路径、摘要和资源 ID；核对后转换并重新 prepare；小/大恢复共用策略。 |
| 移动/复制/撤销/恢复只能拒绝原生链接改写，或预览与最终源不匹配 | `native-link-plans.ts`、`diagram-operation-previews.ts`、`organization/`、`folders.ts`、`knowledge/move.ts`、`knowledge/note-trash-native-restore.ts`：持久操作计划、每组源和预览、提交前最终文件/权限/身份/模式检查。 |
| 文件夹移动删除共享资源或恢复占用新文件 | `diagram-relocation.ts`、`archived-*-context.ts`：保留证明固定的共享资源及原物理基准；只允许受控资源目录撤销，后加文件冲突；历史/备份/崩溃恢复保持身份。 |
| 图形机器字段进入搜索，排除后完整扫描和引用坐标不可靠 | `shared/diagram-text-projection.ts`、`indexing/`、`graph/`：真实原文范围、旧 JSON 转义标签解码、完整扫描/块清单证明、缓存升级；相关附件变化撤下旧语义结果。 |
| 交付遗漏媒体、远程资源、原生最终 PNG；自导出大包无法回导 | `packages/core/portable-delivery/`、`assets/`、`shared/portable-resource-limits.ts`：严格闭包、流式媒体、固定公共 DNS/重定向、最终原生预览、目标文件系统暂存和受跟踪 promotion；保留原配额。 |
| MCP 缺完整便携/原生预览接口，错误丢失需求或撤权后继续读取 | `packages/core/mcp-*`、`plugins/knowledge-tools.ts`、`shared/mcp-*.ts`：有界源/结果分页、用途隔离上传、同 requestId 续跑、每块当前授权、兼容旧需求结构。 |
| 有效 PNG 中可能携带可恢复原场景而随公开图片泄露 | `shared/png-policy.ts`、`shared/diagram-primary.ts`、公开资源/博客/`apps/web/reading-export.ts`：已知 Excalidraw PNG 文本键拒绝；所有者原件不改字节，不能重绑旧哈希。 |

对应细节及独立复审：[历史资源](diagrams/validation/history-resources-2026-10-31.md)、[原生生命周期](diagrams/validation/native-lifecycle-2026-10-31.md)、[单篇恢复](diagrams/validation/note-trash-restore-2026-10-31.md)、[便携包](diagrams/validation/portable-packages-2026-10-31.md)、[PNG 隐私](diagrams/validation/png-preview-privacy-2026-10-31.md)、[语义索引](diagrams/validation/semantic-index-2026-10-31.md)、[MCP 预览](diagrams/validation/mcp-previews-2026-10-31.md)。

## 实际验证记录

### 完整单元、类型与构建

- `npm run typecheck`、`npm run build`：冻结运行时代码 `02ede20` 均退出 0（类型与构建输出无错误）。
- `npm test -- --shard=1/2`：226 文件，225 通过、1 跳过；1672 测试通过、15 跳过；退出 0，1019.56 秒。
- `npm test -- --shard=2/2` 最终复验：225 文件，224 通过、1 跳过；1774 测试通过、1 跳过；退出 0，586.78 秒。
- 两个确定分片无重复、并集覆盖 **451 文件，449 通过、2 环境跳过；3446 测试通过、16 跳过、0 失败**。第一片之后只修改第二片的四个测试夹具，未修改运行时代码或第一片测试；文件集合和哈希保存在本地验收材料中。
- 首轮全套发现 1 个实际兼容问题：MCP 错误过滤丢失旧预览需求，已修复。其余为夹具未提供历史资源路径/完整扫描证明、新模块 VM 映射缺失、旧 revision 列数及新备份策略；分别核对根因并保留原行为断言修正。WAL 仍验证自身租约立即释放及后台任务最终归零。原 pending-folder 历史快照恢复覆盖保留，不把不安全备份改成成功。

### 浏览器与边界专项

- 首轮最终桌面核心 22/22，审阅后追加 6/6；Mind Elixir 独立真实适配 4/4。
- 后续新增：迁移 2/2、图形历史故障恢复 1/1、复制/批量整理/旧树菜单 11/11、目录整体上传 1/1、实际原生链接离线交付及目录回导 1/1。以上为不同阶段专项，有重叠，不替代最终联合运行。
- PNG 隐私独立浏览器 1/1，真实 Excalidraw 输出不含原场景，输入不变；公开/博客/HTML/打印相关服务回归及独立复审通过。原渲染器此前已过滤 `exportEmbedScene`，不把这一防御补强描述成“原编辑器曾泄露”。
- 1000 文档/分页，20 MiB 普通文档，128 MiB 随机媒体，约 252 MiB 两媒体包实际自导出回导均通过。252 MiB 真实 owner HTTP 流式回导在 dataRoot/knowledgeRoot 不同文件系统验证，保留原导出回执，暂存峰值不超过 512 MiB，结束前清空账目。未执行真实嵌套挂载。
- 只读真实 MCP SDK：40 KiB 原生源分块→准备最终 PNG→同 requestId 重试导出→换目录普通阅读→不同写授权整包回导，1/1 通过。
- 最终首轮 67 项桌面联合运行：47 通过、20 失败。未启用 `VITE_DOCUMENT_EDITOR_ENABLED=1` 导致普通富文档相关入口失败；另发现缺源主图阻塞其他操作的实际缺陷；设置标题为原基线已过时期望。正在分别修复/以正确配置复验，不能将该轮记为通过。

### 环境跳过与未验证

- `tests/native-rollback-entrypoint.test.ts` 15 项：缺少既有 rc48/rc49 原生发行物。
- `tests/search-runtime-install.test.ts` 1 项：未提供 `DOOKNOW_SEARCH_ARTIFACT`。
- 本轮源码构建不等于正式平台发行包验证；上述门禁需在发行构建环境补证。实际本地向量/分词模型测试已运行，不属于这些跳过项。
- 实机打印机、独立设备、真实嵌套挂载未验证。离线换目录及两个实际文件系统之间的完整回导已验证。

## 操作限制与发布准备

1. 真实知识库迁移、生产部署、服务重启另行处理。原目录既有 Vite 预览进程未重启，不能将源码回集当作旧后端已经升级；本轮不重建其在用 `dist`。
2. 缺少可信原始路径/身份/摘要/日志的旧历史明确拒绝推断。源缺失或已变化、未知格式、超限原子引用单元等场景保留原件并明确失败，不能通过改哈希冒充恢复。
3. 整包导入先校验完整包，再逐篇激活完整文档；中断可能保留已成功导入的文档，通过同 requestId 续跑，不能承诺失败后目标库零变化。
4. 当前单媒体 128 MiB、便携包 256 MiB、最多 10000 文件、便携核心暂存 512 MiB；MCP 传输存储为独立额度。官方大归档上传在文件流前提供目标目录/requestId；旧式无提前上下文的小包兼容不等于满预算大包协议。
5. 仍被历史、回收站、共享副本引用的资产可能保留在原目录；没有历史附件自动清理功能，不应删除这些资源目录。
6. 仅拦截已知 Excalidraw PNG 文本场景元数据，不承诺清除所有图片元数据。公开原件必须显式授权；授权原件不赋予编辑权。

当前放行结论：**待最终联合缺陷修复、复验及安全回集后更新。** 发布准备步骤见[迁移与发布准备说明](diagrams/migration-release-preparation.md)；上述环境门禁、用户已有工作发布范围和生产操作边界仍须保留。
