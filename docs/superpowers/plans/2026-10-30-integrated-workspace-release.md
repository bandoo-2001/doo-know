# Integrated Workspace Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 发布补齐图谱统一导航和离开保护、整合 To Doo 与历史版本的新正式版本。
**Architecture:** 从正式 rc.55 干净源码建立候选，按冻结快照导入授权闭包。复用菜单宿主与离开协议；通过最终包、数据副本、加密恢复和原生升级验证发布。
**Tech Stack:** Vue 3, TypeScript, Ant Design Vue 4.2.6, Vitest, Playwright, Node 22.22.1, SQLite.
**Spec:** docs/superpowers/specs/2026-10-30-integrated-workspace-release-design.md

## Global Constraints

- 不覆盖、暂存、重置、切换或提交原共享目录中其他会话的工作。
- 博客公开开关、文章、知识库原文、插件安装/启用状态和运行配置保留。
- 使用现有依赖，不进行无必要的全局安装；真实资料与凭据仅留私有忽略目录。
- 发布以实际 rc.55 为基线，固定提交和包哈希；通过原生管理器更新，保留 rc.55 回退。

## Review Focus

- 图谱模型草稿通过浏览器后退取消后，URL、输入和组件仍保留。
- 重复离开、保存中离开、卸载不能留下悬挂确认或重复导航许可。
- 图谱、To Doo、博客的设置入口和返回路径指向各自正确目标。
- Git 旧版接口兼容统一历史，同版本不同内容不可覆盖已装包。
- 候选验证不能碰正式数据，升级后不能覆盖已接受的新写入。

### Task 1: Freeze and integrate authorized source

**Files:** frozen snapshot scope manifest; To Doo, history and shared navigation paths recorded in `.local/integration-rc56/scope.json`.
- [x] 冻结原共享目录的源码字节、模式、状态和 HEAD。
- [x] 在实际 rc.55 创建独立候选，按依赖闭包导入授权文件，排除 MCP 权限树/传输面板。
- [ ] 运行入口/历史/To Doo 基线回归；记录结果并提交候选快照。

### Task 2: Graph hosted menu and draft leave protection

**Files:** `GraphWorkspace.vue`, `graph/GraphOverlay.vue`, `AppsWorkspace.vue`, `Workspace.vue`; graph overlay/hosted navigation regression tests.
**Interfaces:** GraphWorkspace exposes `hasUnsavedChanges(): boolean`, `requestLeave(): Promise<boolean>`; GraphOverlay exposes a cancellable close request; AppsWorkspace forwards to current app.
- [ ] 先写并运行失败回归：图谱统一菜单、模型设置、取消/确认后退、刷新提醒、busy/重复请求与卸载结清。
- [ ] 复用共享菜单注入和弹层关闭确认，接入宿主导航与 beforeunload。
- [ ] 运行相关测试、类型检查；独立审查实现和测试，处理实际问题。
- [ ] 提交修复并更新应用导航说明。

### Task 3: Integrated verification and immutable release

**Files:** release/private verification scripts, deployment acceptance record; plugin manifest only if new plugin content is published.
- [ ] 检查全部导入源码与依赖清单，确认博客源码未回退、旧 Git 接口兼容、插件版本不可变。
- [ ] 运行全量 `npm test`、类型检查、构建；失败须定位并记录，修复本次发布阻断问题。
- [ ] 桌面/手机逐项目独立运行图谱、主菜单、To Doo、历史恢复和博客回归。
- [ ] 冻结提交，构建并校验最终发布包，验证安装后资源与构建字节一致。
- [ ] 在正式资料隔离副本验证，创建新加密备份并实际恢复验证。

### Task 4: Deploy and preserve concurrent work

**Files:** private deployment script/evidence, `docs/验收记录/2026-10-30-integrated-workspace-deployment.md`.
- [ ] 独立审查部署脚本，核对当前版本、来源提交、包哈希与恢复证据。
- [ ] 原生管理器更新；检查健康、就绪、静态资源和公开博客。
- [ ] 逐项核对原文、笔记身份、博客记录/设置、插件与运行配置，保留 rc.55 回退。
- [ ] 原共享目录对照初始快照检查并发变化；只同步经过原字节核对的本次修复，保持他人工作。
- [ ] 写入实际验证/部署记录，报告版本、入口与剩余限制。
