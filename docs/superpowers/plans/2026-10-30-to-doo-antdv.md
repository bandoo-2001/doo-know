# To Doo AntDV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用真实 AntDV 控件统一 To Doo 操作、表单、弹层和反馈。

**Architecture:** 域值适配器复用实际 Select/DatePicker；页面按需导入其他控件；确认服务由 ToDooWorkspace 提供。保留原有共享 workbench 与 API。

**Tech Stack:** Vue 3、Ant Design Vue 4.2.6、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-30-to-doo-antdv-design.md`

## Global Constraints

- 保留未提交工作；精确基线为本聊天 artifact/todoo-antdv/baseline。
- 禁止修改真实任务、账号、正式服务及服务端合同，不新增依赖。
- 日期字符串、nullable/boolean/number、多选及表单提交语义保持一致。
- 页面控件按需导入；仅 To Doo 样式适配。
- 所有 e2e 由主代理串行执行。

## Review Focus

- 下拉的 null/false/0 和多选不能被字符串化写回。
- 日期/时间清空、确认与跨时区保留原字符串语义。
- Modal 的取消、Esc、关闭/返回和未保存确认不能丢稿或提前写入。
- 按钮 submit、输入法 Enter、Q 和禁用/loading 不改变重复提交保护。
- 弹层在手机和深色主题正确显示；自定义 CSS 不破坏 Ant 内部输入。

### Task 1: 共享控件与核心任务界面

**Files:** 新 `ToDooSelect.vue`、`ToDooDateField.vue`、`to-doo-controls.ts`、`to-doo-ant.css`；修改 `ToDooWorkspace.vue`、TaskViews/TaskDetail/TaskRow/QuickAdd。
- [x] 先固定选择值和日期适配合同的失败测试，再实现实际 AntDV 适配。
- [x] 迁移任务表单、筛选、操作与确认，统一作用域样式。

### Task 2: 设置、日历与目录

**Files:** ToDooSettings.vue、ToDooCalendar.vue、ToDooNavigation.vue。
- [x] 迁移表单、视图控件和按钮，保留导入/日历保存语义。
- [x] 运行相关测试与类型检查，不启动 e2e。

### Task 3: 节奏、统计与提醒

**Files:** ToDooRhythm.vue、ToDooReview.vue、ToDooReminders.vue、ToDooDateExceptions.vue。
- [x] 使用输入、选择、统计、进度、空态和异步确认组件。
- [x] 保留专注/习惯/纪念日/复盘与提醒回执，运行相关测试。

### Task 4: 实体与批量表单

**Files:** ToDooEntityEditor.vue、ToDooBatchEditor.vue、ToDooOutcomeNote.vue、ToDooFilterGroup.vue、ToDooNotes.vue。
- [x] 迁移 Modal 和表单，保留未保存保护及组合筛选。
- [x] 运行相关测试与类型检查，不启动 e2e。

### Task 5: 联动验证

**Files:** 控件与业务测试、必要的原 e2e 适配、使用与验收记录。
- [x] 在隔离数据中验证实际 Ant 选择/日期/多选/弹层、保存与取消。
- [x] 相关单元、桌面/手机 e2e、类型检查、构建、独立审查。
- [x] 更新开发预览并保留实拍截图，记录范围及例外。
