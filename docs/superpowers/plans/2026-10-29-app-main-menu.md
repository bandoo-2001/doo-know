# App Main Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 共享可注入的应用主菜单和按页面需要展示的二级目录。

**Architecture:** 共享 rail 组件渲染声明式定义；Vue 宿主按组件作用域管理注入；应用处理导航和离开确认，原 Workspace 保持笔记与路由。To Doo 在独立模式保留导航后备。

**Tech Stack:** Vue 3、现有 Ant Design Vue、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-29-app-main-menu-design.md`

## Global Constraints

- 在当前既有隔离 worktree 增量修改；基线为聊天 artifact `app-navigation-baseline/`。
- 不引入依赖，不修改真实任务、凭据或正式服务，不提交其他工作。
- 根级菜单只展示并转交操作，业务导航由应用及宿主处理。
- 浏览器夹具与全项目生命周期测试共享固定端口，禁止并发运行两者；只运行任务所需检查。

## Review Focus

- 取消离开应用时 retained-note 快路径不能绕过 guard，URL 不应提前变更。
- 上下层菜单定义覆盖/释放与异步路由不能留下旧菜单或覆盖新导航。
- matrix/focus 等没有二级目录时桌面内容与详情正确铺满。
- app settings、默认 settings 和头像/返回入口的语义始终匹配当前应用。
- 手机抽屉、Logo/名称、深链、键盘、草稿与应用位置恢复。

### Task 1: 共享菜单与应用宿主

**Files:** 新 `workspace-main-menu.ts`、`WorkspaceMainMenu.vue`、`workspace-main-menu.css`；修改 `WorkspaceFooter.vue`、`AppsWorkspace.vue`、`Workspace.vue`、`Icon.vue`。
**Interfaces:** 菜单定义 `id/label/activeId/items/utilities/onSelect`；`provideWorkspaceMainMenu()`、`useWorkspaceMainMenu(definition)`、`useInjectedWorkspaceMainMenu()`；应用内容通过 `hostedNavigation` 接收是否由宿主管理菜单。

- [x] 先添加并运行菜单覆盖/释放、位置恢复的失败单元与两级导航浏览器检查。
- [x] 实现可配置菜单、默认适配、To Doo 与博客定义；返回箭头和应用设置。
- [x] 安全返回、intent 和按应用位置记忆；补充 Workspace 模块测试依赖映射。

### Task 2: To Doo 按需二级目录与品牌

**Files:** `ToDooWorkspace.vue`、`to-doo/ToDooNavigation.vue`、`to-doo.css`；实现者独立负责。
**Interfaces:** 可选 `hostedNavigation:boolean=false`；expose `requestSectionLeave(section):Promise<boolean>` 保护离开当前未保存设置；父组件仍处理原 navigate/back 事件。

- [x] 用独立定向测试固定不同 section 的 sidebar 规则与未保存设置保护。
- [x] hosted 时只保留任务/日历二级导航；matrix/focus 等铺满且每页 Logo/名称可见。
- [x] 保持日期/清单/筛选导航、窄屏目录与独立模式后备。

### Task 3: 关联验收

**Files:** 新菜单单元/e2e、相关旧 e2e、使用与组件扩展说明及验收记录。

- [x] 顺序运行相关单元与桌面/手机 e2e，修复本次回归。
- [x] 类型检查、构建、独立审查与真实开发预览只读截图。
- [x] 更新测试边界、菜单注入使用方式和修改位置。
