# ToDoo 全页审查修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复已获授权的 ToDoo 全页 UI 与功能问题，并提供行为回归及真实截图证据。

**Architecture:** 保留组件和数据契约；在现有工作台模型中共享上下文与时间规则，在独立业务组件中修复具体行为。独立文件的任务可并行实施，浏览器夹具、Git提交和任务审查统一串行；共享组件/CSS有明确所有者，后续任务等待释放。

**Tech Stack:** Vue 3、TypeScript、Ant Design Vue、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-03-to-doo-audit-fixes-design.md`

## Global Constraints

- 沿用 Vue 3、Ant Design Vue、现有主题变量；不新增依赖，不改持久数据格式，不做数据迁移。
- 保留现有深链接、任务范围、分页、草稿、导入版本核对、冲突处理、恢复和权限边界。
- 只用现有隔离测试夹具；浏览器服务串行运行，端口使用 4279/4280，真实服务及数据不变。
- 行为修复先有能失败的测试；可逆的纯样式调整用真实截图和现有交互测试验证，不添加镜像 CSS 常量的测试。
- 每一项清单须有修复、验证或明确的证据裁定；不把隐藏功能、固定日期、UTC、稀疏数据和首屏截取当缺陷。
- 新文案使用中文，说明真实状态和操作影响；不承诺不存在的自动保存或整体回滚。

## Review Focus

- 导入预览后改变任一参数：旧确认不可提交；响应丢失重试不重复导入（Task 1）。
- 同日过时、跨午夜、跨时区和窗口边界：所有视图位置/逾期一致（Tasks 2/3）。
- 多页数据与跨设备活动：保留旧页且新纪录可见，分页状态真实（Task 4）。
- 归档历史、终态、手动覆盖与通知撤销：整理不歪曲历史，状态影响明确（Tasks 2/6）。
- 手机软键盘、长标题和未保存编辑：操作可达，焦点正确，草稿不被静默丢弃（Tasks 2/5/7）。

### Task 1: 设置、导入与偏好边界

**Files:** `ToDooSettings.vue`、`ToDooWorkspace.vue`（仅设置按钮接口）、导入 interop/共享 helper（按需）、相关单元和浏览器测试。
**Interfaces:** 保留 import preview/apply API、submitPreferences；可 expose 当前偏好分栏/草稿状态给父组件。当前编辑器和任务布局由后续任务负责。
**Requirements:** 实现 spec 设置与导入 S1–S7；全部预览项可核对；重试复用请求身份；时区建议可手填；连接/订阅草稿保护完整。检查导入部分失败/恢复的现有边界，不引入伪回滚。
- [x] 写并运行失败回归：预览A后改变正文或目标清单，旧确认消失；23项均可查看；更改显示时区免打扰可辨认；非偏好分栏不出现保存偏好。
- [x] 最小实现，保留已有冲突/批次/续跑和安全限制。
- [x] 运行相关 Vitest 和 `DOOKNOW_E2E_WEB_PORT=4279 DOOKNOW_E2E_API_PORT=4280 npm run test:e2e -- tests/e2e/to-doo-management-cohesion.spec.ts <新增测试> --project=desktop`；报告 red/green 证据，更新覆盖表并提交。

### Task 2: 任务范围、创建上下文、导航与手机任务布局

**Files:** `ToDooWorkspace.vue`、`ToDooTaskViews.vue`、`ToDooTaskRow.vue`、`ToDooTaskDetail.vue`（仅创建上下文/字段）、`ToDooNavigation.vue`、`WorkspaceMainMenu.vue`、任务模型/展示 helper、任务 CSS、相关测试。
**Interfaces:** 为 create/newTaskDraft 增加可选 seed，兼容现有调用；清单、状态、标签、优先级和今日日期显式传递。统一日期匹配 helper 供总览及列表使用；时间比较 helper 供行和详情使用。后续 Task 7 接续编辑窗口。
**Requirements:** G1–G2、T1–T8、B1–B4、C13、W1–W2。范围选择不切列表且保留摘要；终态不计待办；目标口径摘要；列/今日新增继承上下文；象限直接编辑和手动状态提示；手机工具区压缩、日期清晰、列/区跳转；新建支持优先级/重复/提醒且不暗中生成09:00计划。
- [x] 写并运行失败回归：昨天计划今天截止在两处今天均出现；进行中列新建仍进行中；今天新增自动归今天；筛选不离开看板；取消/跳过不计待办；当天早时刻截止显示逾期。
- [x] 实现并回归已有深链接、父子任务、草稿、空值和真实控件值；父任务各完成入口行为核实并统一。
- [x] 运行任务单元及相关任务/详情/列表浏览器回归，保存手机布局截图；更新覆盖表并提交。

### Task 3: 日历与时间线可靠性及窄屏显示

**Files:** `ToDooCalendar.vue`、日历布局 helper（需要时创建）、任务时间 helper、日历/时间线 CSS、相关测试。
**Interfaces:** 复用 Task 2 的时间判断；保持 timeBlock/dateEndExclusive 数据契约及 edit/open 事件。手机网格选择只影响呈现。
**Requirements:** C1–C12；跨日分段、跨窗裁切、显示时区一致、局部冲突组、默认时长、区间外计划摘要、截止时刻；手机保留议程且可切网格，时间线最小日宽与固定任务列，短事件完整信息，跨月清楚。
- [x] 写并运行失败回归：23:30/90分钟次日出现；窗口前开始的多日全天块正确裁切；两条早间重叠不缩窄下午独立块；跨时区截止日历/时间线同日；默认时长45在新建入口有效。
- [x] 实现并核实跨午夜常驻刷新、高密度同日/长标题；必要时用纯 helper 行为测试避免依赖CSS常量。
- [x] 运行日历/规划/日期区间浏览器回归及相关单元，保存桌面/手机截图，更新覆盖表并提交。

### Task 4: 专注项目、趋势、历史与同步

**Files:** `ToDooFocus.vue`、`ToDooFocusTrend.vue`、`ToDooFocusTimerFields.vue`、专注 helper/CSS及对应测试。
**Interfaces:** 保留 focus history/start/stop API；计时项目与记录筛选状态显式区分，保留分页和已加载旧记录。
**Requirements:** F1–F7及轮询风险；未来桶不作为零值连线；项目提示与动作一致，允许自由专注；修正标记；三套范围清楚；活动轮询合并新行、更新删除和分页；手机记录与计时器可达。切项目保留关联行动须清晰提示并可清空。
- [x] 写并运行失败回归：未来日期不产生下降连线；清空项目后start提交null；跨设备新记录进入已打开历史且旧页保留；修正时长可辨；手机查看累计切入历史。
- [x] 实现，回归活动计时、归档、休息、暂停/恢复和记录修正。
- [x] 运行专注单元与历史/趋势/空间浏览器测试，保存手机截图，更新覆盖表并提交。

### Task 5: 习惯更正、历史数量和纪念日

**Files:** `ToDooRhythm.vue`、`ToDooHabitCard.vue`、`ToDooHabitFields.vue`、`ToDooEntityEditor.vue`（农历/习惯）、习惯/纪念日 helper及CSS、相关测试。
**Interfaces:** 保持 habitEntry 与农历日期格式；单条删除走已有版本检查与回收机制，保留整天撤销确认。
**Requirements:** H1–H3、A1–A3、W5；手机紧凑卡片；历史真实数量、补记累计和当日条目列表；单条纠正；习惯实际日期/时区清楚；纪念日当天、过去文案正确及卡宽适中；农历分年/月/日和闰月但后端契约不变。
- [x] 写并运行失败回归：45/20历史仍可读45；三条记录只撤销一条其余保留；当天包含今天模式仍写就是今天；过去一次性不写下次；农历控件保存原格式。
- [x] 实现并检查规则变更生效日期、补记、跳过/暂停与多时区跨日。
- [x] 运行习惯/纪念日单元与相关浏览器回归，保存手机与窗口截图，更新覆盖表并提交。

### Task 6: 通知纠正与历史统计口径

**Files:** `ToDooReview.vue`、`ToDooReminderCards.vue`（共用选项按需）、通知处理/契约、`packages/core/to-doo/statistics.ts`、相关测试。
**Interfaces:** 扩充通知动作兼容旧动作，不突破来源有效性/权限检查；归档历史完成统计与当前待办/目标分母分别处理。
**Requirements:** N1–N4、R1–R2；确认通知不冒充事项完成；各种来源直达；延后选项一致；恢复未读/撤销处理忽略；历史完成不因归档下降；零值及口径可读。
- [x] 写并运行失败回归：习惯/纪念日通知可导航；确认提醒不完成事项；忽略后可恢复；延后30分钟有效；归档后过去区间完成不下降且当前待办排除归档。
- [x] 实现并回归分页、全部已读、来源删除/归档、重复提醒和已保存复盘快照。
- [x] 运行通知/统计单元及通知历史/复盘浏览器测试，更新覆盖表并提交。

### Task 7: 编辑窗口一致性、完整回归与截图交付

**Files:** `ToDooTaskDetail.vue`、`ToDooEntityEditor.vue`、`ToDooOutcomeNote.vue`、窗口CSS、审查专用截图脚本/测试、覆盖记录。
**Interfaces:** 接续 Task 2 创建种子字段；复用平台安全 Markdown 渲染；不把临时草稿承诺为服务端保存。
**Requirements:** W3–W4、W6及全局收尾；明确即时操作/待保存、关闭保留范围；成果笔记预览；窗口错误定位、焦点与关闭入口正常；核实手机软键盘、底栏、真触屏、密集日程及跨午夜的待验证项。
- [x] 写并运行失败行为回归：成果笔记预览安全显示且保留正文；编辑关闭后有清楚的保留/放弃反馈；主要操作与焦点在窄屏可达。
- [x] 保存固定数据、固定时间的改前/改后真实截图及索引；按G/T/B/C/F/H/A/R/N/S/W逐项填写结果，不能以只改文案掩盖行为缺陷。
- [x] 运行相关浏览器回归、`npm test`、`npm run typecheck`、`npm run build`、`git diff --check`；独立最终审查并处理发现，提交代码和验证记录。

最终验收与检查边界见 `docs/验收记录/2026-11-03-to-doo-audit-fixes.md`：产品冻结09ed83c；整仓3681通过/1搜索基准失败/2跳过，唯一失败原样隔离复跑通过，保留原失败事实及未确认的间歇性原因；未部署。
