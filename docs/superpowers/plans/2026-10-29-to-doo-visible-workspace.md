# To Doo Visible Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让现有功能直接可发现，提高空间利用，并统一重要程度与优先级的颜色和交互。

**Architecture:** 保留 Vue 共享 workbench 与现有路由和服务接口。侧栏/手机功能抽屉共享导航组件；任务展示使用 AntDV 和独立的颜色样式，避免修改无关页面。

**Tech Stack:** Vue 3、Ant Design Vue 4.2.6、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-29-to-doo-visible-workspace-design.md`

## Global Constraints

- 使用当前隔离工作区，保留未提交工作；基线副本在本聊天 visualization 目录 `todoo-redesign-baseline/`。
- 不写真实用户任务，不重置账号，不发布或重启正式服务。
- 不增加依赖；保留日历/清单/草稿/导航与实体存储合同。
- 新样式限定 To Doo；支持深色及 320px 宽度。

## Review Focus

- 切换列表、看板、四象限时保留清单和筛选，不带入错误详情。
- 手机抽屉选择后的草稿确认，以及关闭后键盘焦点。
- 大量清单不挤掉功能入口，分批加载不丢失。
- 优先级、重要性和紧急性三者语义不同，不改变数据值。
- 空状态、长标题、深色及窄屏仍可读，无隐藏日期。

### Task 1: 导航与空间

**Files:** `ToDooWorkspace.vue`、新 `to-doo/ToDooNavigation.vue`、`to-doo.css`。
**Interfaces:** 继续调用 `navigate(section, selection)`、`chooseQuickView`、`chooseList`、`loadLists`；导航组件仅发出事件。

联动修正：`ToDooQuickAdd.vue` 的快捷键只检查当前可见模态层；Drawer 自有原生 dialog 承担可访问语义和焦点边界，禁用框架的另一套 autofocus，避免动画结束抢回用户已移动的焦点。

- [x] 先添加并运行浏览器场景，确认现有功能隐藏和矩阵无颜色的失败。
- [x] 分组展现所有入口；AntDV 按钮和手机 Drawer；保留移动选择器。
- [x] 收紧布局，在桌面和手机核对滚动、路由及草稿。

### Task 2: 任务呈现与颜色

**Files:** `ToDooTaskViews.vue`、`ToDooTaskRow.vue`、`ToDooTaskDetail.vue`、新 `to-doo-priority.css`；由独立实现者负责，与 Task 1 无共享写文件。
**Interfaces:** 不改 props/emits、路由、任务模型；颜色文件由 Workspace 在现有 CSS 后引入。

- [x] 四象限增加独立颜色、文字行动提示、有效空状态与日期信息。
- [x] 优先级色彩覆盖行、看板、详情；重要/紧急设置上移。
- [x] 用 AntDV Segmented/Select 等适配核心控件，操作菜单有明确文字。
- [x] 运行相关测试及类型检查，报告所有变更。

### Task 3: 联动验收与交付

**Files:** 新 `tests/e2e/to-doo-visible-workspace.spec.ts`、必要的现有 To Doo e2e、`docs/ToDoo使用与数据.md`、验收记录。

- [x] 运行相关单元与桌面/手机浏览器，修复本次回归。
- [x] 类型检查和构建；独立审查本次相对基线的变化。
- [x] 真实开发服务只读截图；隔离示例数据展示任务和优先级。
- [x] 更新使用说明和验证记录，不提交其他任务的修改。
