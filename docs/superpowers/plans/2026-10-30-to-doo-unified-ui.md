# To Doo Unified UI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task. Preserve current uncommitted work; record progress in the linked implementation entry. The user explicitly requested direct continuous execution.

**Goal:** 实现统一 To Doo UI、长期专注记录及相联的 HTTP/core/MCP 能力，并完成真实功能和跨页视觉验收。

**Architecture:** 以现有 ToDooWorkspace 为唯一 AppShell，宿主菜单提供一级导航。共享布局 tokens/组件消除页面漂移，领域查询与授权聚合统一在核心，适配层只校验和裁剪结果。专注主题独立持久化，活动会话和历史分页分别获取。

**Tech Stack:** Vue 3、TypeScript、Ant Design Vue 4.2.6、Fastify、SQLite、Zod、MCP SDK、Vitest、Playwright。

**Spec:** [唯一规范、覆盖与证据入口](../../design/to-doo/unified-ui-v2/IMPLEMENTATION.md)，由用户完整目标文件约束。

## Global Constraints

- 64px 一级导航、56px 顶栏、180px 目录、420px 详情、24px 桌面内边距；8px 间距体系，全局单点调整。
- 当前工作树/分支原地实施；不覆盖已有修改、不部署、不写真实数据。暂不提交混有原有工作的变更。
- AntDV 复用优先，新增依赖须官方版本/许可证/包体验证；保留笔记博客依赖和样式。
- 显式保存/草稿、requestId、expectedRevision、权限、响应预算、导出恢复保持兼容。

## Review Focus

- 顶栏跨有/无目录页面坐标一致，详情跟随顶栏而不遮盖；768px/portrait 等宿主断点一致。
- 历史分页期间插入新专注不会重项/漏项；活动会话不受分页和筛选影响。
- 无清单专注、归档/删除关联任务、跨日及修正时长仍正确显示且不泄露受限名称。
- KeepAlive 隐藏页的时钟/请求、并发页面与过期响应不覆盖当前会话/草稿。
- 大区间统计/图表、恢复旧 schema、MCP 授权撤销都不能只通过普通小数据用例。

### Task 1: AppShell 与共享布局

**Files:** `apps/web/components/ToDooWorkspace.vue`, `components/to-doo/ToDooPageHeader.vue`, `ToDooPageToolbar.vue`, `ToDooSectionHeader.vue`, `apps/web/to-doo-tokens.css`, `to-doo.css`, `to-doo-task-detail.css`；测试 `tests/e2e/to-doo-unified-shell.spec.ts`。

**Interfaces:** 保持 Workspace 的 navigate/selection/leave/externalDirty；共享 Header 接收 title/description、actions slot，Toolbar/SectionHeader 提供语义插槽。

- [x] 建立真实浏览器跨页坐标测试：1440px/1873px 顶栏高 56±1、目录宽 180±1、宿主 64±1、详情 420±1，同组标题/内容起点±1；先运行确认失败。
- [x] 提取 PageHeader，顶栏跨目录与正文统一；以 tokens 替代冲突尺寸，复用宿主菜单，保留小屏目录和详情焦点规则。
- [x] 运行 shell/hosted-navigation/详情回归及类型检查，记录实际截图。

### Task 2: 授权统计与完整区间

**Files:** `packages/core/to-doo/queries.ts`, `apps/server/to-doo/agent-port.ts`, `shared/to-doo-contracts.ts`, `ToDooReview.vue`；测试领域与 MCP parity。

**Interfaces:** 共用 `statistics(store, query, scope?)` 或授权实体聚合，明确 now/from/to/list/domain；适配层不复制时长计算。

- [x] 先加跨日/运行/暂停/取消/休息/修正/无清单与受限资源的同口径失败用例。
- [x] 收敛统计，新增完整日期趋势聚合；UI 趋势按所选区间读取，不依赖工作集或截断到31天。
- [x] 验证同范围 UI/HTTP/MCP 一致，拒绝/撤销授权不泄露名称和计数。

### Task 3: 专注主题、历史查询与兼容

**Files:** `shared/to-doo-contracts.ts`, `shared/to-doo-mcp-contracts.ts`, `shared/mcp-to-doo-tools.ts`, `packages/core/to-doo/{service,store,queries}.ts`, `apps/server/to-doo/{routes,agent-port,mcp-tools}.ts`, `plugins/mcp/server/{to-doo-tools,to-doo-operations}.ts`；新增领域/route/MCP tests。

**Interfaces:** focusTopic 持久实体（name/color/archivedAt）；session 带 nullable topicId 和显示快照；独立 history 查询返回 items/stableCursor/statistics/active，不依赖 snapshot 第一页。

- [x] 先测试 1201 条历史、近优先过滤、稳定游标插入、独立活动、分页无关统计、归档不改任务/历史与重启/导出恢复。
- [x] 实现实体、查询、命令校验/关联快照、共享时间口径；同步集合/存储/契约/授权和 schema 发现。
- [x] 扩展现有 MCP 查询和实体工具保持旧调用兼容，验证 SDK/预算/权限/幂等/跨端。

### Task 4: 专注页面与持续计时

**Files:** `ToDooRhythm.vue` 拆出 `ToDooFocus.vue`、主题编辑与历史区域；`to-doo-workbench.ts` 专注查询控制；统一专注样式及浏览器测试。

**Interfaces:** 使用 Task 3 的主题/历史/活动；计时按 segments 和真实 now；归档不完成任务。

- [x] 先写新主题→专注→暂停/恢复→结束→刷新→历史/筛选→归档仍可回看流程及失败草稿用例。
- [x] 实现图08的主题列表、概览/历史、底部计时条；活动获取独立于历史，切页/后台/多窗口保持规则。
- [x] 验证320/390手机及桌面深浅色，弹层/导航/计时条和安全区不遮挡。

### Task 5: 各业务页与六类编辑面板统一

**Files:** `ToDooTaskViews.vue`, `ToDooCalendar.vue`, `ToDooRhythm.vue`, `ToDooReview.vue`, `ToDooSettings.vue`, `ToDooEntityEditor.vue`, `ToDooOutcomeNote.vue`, `ToDooReminders.vue` 和对应样式/测试。

**Interfaces:** 复用 Task 1 Header/Toolbar/SectionHeader；所有业务命令保持已有契约。

- [x] 核对13桌面视图、六编辑面板及手机布局，统一分区与主要操作，不删除未画出的功能。
- [x] 按覆盖表完成看板/目标/日历/矩阵/习惯/纪念日/复盘/通知/设置；必要业务差异先写失败测试。
- [x] 表单首层只保留常用项、次要项分组；隐藏错误自动定位；IME/键盘/null/false/0/日期/多选/失败保留通过。

### Task 6: 依赖与复杂度评估

**Files:** 规范入口依赖章节；按实际选择修改 package/lock 与相关视图。

- [x] 查候选官方文档/仓库/锁定版本并验证；记录许可/维护/兼容/体积/减少代码，只有实际收益才安装。
- [x] 比较基线与最终 build manifest/压缩大小；复用按需组件和懒加载，清理重复样式，不删除其他应用依赖。

### Task 7: 全范围验收与交付

**Files:** `tests/e2e/to-doo-unified-*.spec.ts`、截图目录、MCP覆盖矩阵及唯一证据入口。

- [x] 固定时间/种子/字体/缩放，对全部桌面视图制作同尺寸截图索引，320/390/768/1024/1440/1873与深浅色覆盖；少量关键几何断言按预设±1px。
- [x] 运行领域/MCP/HTTP/SDK全套、类型检查、构建、桌面/手机浏览器、保存刷新/重启、旧数据导出恢复与其他应用回归；失败要修复或如实列明。
- [x] 完成独立整体审阅并修复重大问题，补文档的兼容/恢复/运行方式/人工推送步骤和真实结果；逐项核实目标，尚未验证项不可标完成。


2026-10-31状态：任务1—7实现及自动验收已完成。独立整体审阅的重要问题均修复复核；最终完整证据、分组复测边界、设备条件跳过和人工推送状态以IMPLEMENTATION.md为准。


最终验收关闭：全仓385文件2770项、最后增量51文件450项、逐项汇总232个桌面/手机用例（2设备条件跳过）、169视觉测试通过；类型/构建通过，独立审阅重大问题均关闭。图册46张、几何156组、当前源码指纹校验通过。全仓和最后UI增量的版本界限、可选离线搜索安装验证跳过（旧归因已更正）、长批次开发环境超时及人工推送状态均在唯一入口如实记录，不宣称某个长批次退出状态全绿。本轮不部署/提交混有原有工作的大批修改。
