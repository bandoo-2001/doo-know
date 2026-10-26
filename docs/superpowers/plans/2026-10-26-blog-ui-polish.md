# Blog UI Polish Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the two disjoint UI tasks; root owns final integration.

**Goal:** 改善博客页面的反馈、手机使用和公开阅读细节。
**Architecture:** 保留 Vue 工作台与只读 SSR；界面改进不触及发布、授权、资源快照和恢复语义。
**Tech Stack:** Vue、现有 CSS、Fastify SSR、Vitest、Playwright。
**Spec:** docs/superpowers/specs/2026-10-26-blog-ui-polish-design.md

## Global Constraints

- 复用干净 linked checkout 的 txj/blog-ui-polish；根工作区 8 个无关改动不覆盖、不提交。
- 两个实现者各自只改所属文件，不提交、不动服务；根统一提交。
- 不引入依赖，不改 MCP 合约与业务；不自动发行、安装或部署。
- 公共网页只读安全边界保持；纯样式通过浏览器验证。

## Review Focus

- 首次失败与旧预览共存时，不能改变已核对正文的哈希或重新发布未经核对的内容。
- 手机长标题、摘要、标签、链接和表格不造成页面溢出。
- 确认操作切换文章后不能执行在另一篇文章上，键盘关闭后焦点可恢复。
- system 跟随浏览器深浅模式，light 在深色系统中仍为浅色。
- 原发布、下架、幂等、权限与私有内容不受界面修改影响。

### Task 1: Owner workbench

**Files:** apps/web/components/BlogWorkspace.vue、apps/web/blog.css、必要时 apps/web/blog-workbench.ts；tests/blog-workbench.test.ts、tests/e2e/blog-polish.spec.ts（owner cases）。
- [x] 先复现首次详情失败不可重试和筛选无结果缺少重置，增加有意义回归。
- [x] 最小补齐读取状态、错误重试、空态与确认键盘反馈；保持既有异步和预览身份保护。
- [x] 整理手机表单和主要操作，中文文案、字号与触控尺寸。
- [x] 聚焦测试通过，交根审查。

### Task 2: Public reader

**Files:** apps/server/blog/routes.ts、可提取 apps/server/blog/styles.ts；tests/blog.test.ts、tests/e2e/blog-public-polish.spec.ts。
- [x] 先复现 system 主题无效及筛选缺少重置，补 HTTP／浏览器行为验证。
- [x] 实现主题、长内容容纳、标题／正文层级、目录、选中筛选、空态与键盘入口。
- [x] 保持快照正文、资源路由和 CSP，不删除原文标题、不引入客户端脚本。
- [x] 聚焦测试通过，交根审查。

### Task 3: Integrated verification and delivery

- [x] 修复回归中确认的既有 collections/service.ts 临时读取失败误判删除，确定性回归保留权限恢复及实际删除语义。
- [x] 两任务停稳后独立审查；修复重要问题后再验。
- [x] 统一 typecheck、build、博客／MCP／工作区相关回归，以及编译后的桌面／手机新旧博客操作。
- [x] JPEG 质量 65 截图检查，记录验证范围；仅提交本轮文件并按既有授权同步默认分支，保留原 8 项未提交工作。
