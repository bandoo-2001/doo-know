# App Shortcuts Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the approved change in this session.

**Goal:** 将常用应用加入左侧菜单，并按账号保存在当前浏览器。

**Architecture:** 独立的本地偏好模块和共享应用目录负责有效 ID、顺序与账号隔离。应用卡片和菜单共享状态，由 Workspace 通过原有离开保护打开目标应用。

**Tech Stack:** Vue 3, TypeScript, localStorage, Vitest, Playwright。

**Spec:** `docs/superpowers/specs/2026-10-29-app-shortcuts-design.md`

## Global Constraints

不改后端；保留既有未提交的 HTTP UUID 修复；当前已隔离工作树内执行；仅使用临时测试资料。

## Review Focus

账号切换、异常存储、不重复加入、取消未保存离开、手机侧栏布局。

## Task 1: Local preferences and navigation

Files: `apps/web/app-shortcuts.ts`, `apps/web/App.vue`, `apps/web/components/{AppsWorkspace,WorkspaceFooter,Workspace}.vue`, `apps/web/{blog,workbench}.css`, `tests/app-shortcuts.test.ts`, `tests/e2e/app-shortcuts.spec.ts`.

- [x] 编写并观察浏览器回归失败：加入两个应用、直接打开、高亮、刷新、移除；笔记草稿与未保存 To Doo 切换保护。
- [x] 实现 `initializeAppShortcuts(accountId, storage?)`、`setAppPinned(id, pinned)` 和只读 `pinnedApps`；单元验证账号隔离、去重、损坏存储和写入失败。
- [x] 卡片独立按钮、菜单入口和 `openAppShortcut(id)` 接入既有离开保护；手机换行。
- [x] 运行定向单元、桌面/手机浏览器回归、类型检查及构建。
- [x] 独立审查最终差异并处理实质问题；记录验证结果。

按用户“继续实现”的明确指令在本会话直接执行，不再增加方案确认轮次。

## 验证结果

初始浏览器回归因缺少加入按钮失败；偏好单元回归发现重复加入改变顺序，修复后通过。最终相关单元测试 33 项通过；应用布局、HTTP 启动与首次快捷入口回归共 12 项通过，补充的快捷入口、笔记草稿及 To Doo 离开保护回归共 6 项通过。类型检查和生产构建通过。

真实 `http://100.93.35.65:5180` 使用现有开发会话验证了加入、刷新、博客与 To Doo 快捷打开；浏览器运行错误为 0。独立审查无实质问题，并检查了 320px、390px、横屏菜单换行及桌面滚动行为。未运行全项目测试，未发布或修改正式服务。
