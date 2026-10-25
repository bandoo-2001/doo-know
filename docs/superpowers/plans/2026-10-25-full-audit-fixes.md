# 全功能验收缺陷修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复全功能验收中确认的 AUD-01 至 AUD-07，保留原文、恢复安全检查与既有功能。

**Architecture:** 在受控恢复时重绑归档目录身份；为异步 Git 回执增加任务/请求归属；合并并校验保存请求；目录就绪后重算本地搜索；编辑器就绪后重放搜索定位；让矮窗口侧栏保留可滚动的目录区域。

**Tech Stack:** TypeScript、Vue、SQLite、现有文件日志、Vitest、Playwright。

**Spec:** `/home/bandoo/documents/dooknow-full-acceptance-2026-10-25/问题清单.json` 及项目内 `.local/full-audit-20261025/issue-definitions.json`；各项均有真实页面或独立恢复副本复现。

## Global Constraints

- 当前工作区已隔离，保留上一轮四项未提交 Git 修复；不覆盖 `docs/验收记录/2026-10-21-platform-full-audit.md`。
- 只用隔离夹具，不修改正式服务、账号、知识库和凭据；不发布、推送或合并。
- 先运行失败测试，再实施最小修复。BOM 导出观察项不属于本轮七项缺陷。
- 不放宽目录替换、链接、跨账号与结果不确定保护；不增加依赖。
- 原始审计证据不改写。对过时测试仅更新已证实的界面前置条件、角色和文案，保留实质断言。

## Review Focus

- 备份恢复只重绑受控副本内真实归档目录；缺失、链接、路径异常和替换仍须拒绝。
- 相同 Git 任务 ID 的重试也有新代次；旧回包不得改写新任务、提示、轮询或密钥输入。
- 输入法组合期间合并保存，同时允许继续输入；异步预检后再次核对笔记/版本/草稿。
- 重算文件名结果不得删除正文搜索结果或覆盖其精确行号；目录刷新/查询切换均正确。
- 搜索定位必须等当前异步源码适配器就绪；迟到的定位不得影响其他笔记或用户新选区。
- 矮窗口可滚动且目录可点击，正常桌面/手机导航、弹窗和键盘操作不退化。

### Task 1: AUD-01 备份恢复后的文件夹回收站

**Files:** `apps/server/platform/restore-state.ts`、必要的 `packages/core/folders.ts` 恢复辅助函数；新建 `tests/restore-folder-trash.test.ts` 或相关恢复测试。

- [x] 受控加密备份→独立副本→列出并还原文件夹，确认旧代码失败。
- [x] 在恢复边界安全重绑身份，保留正常运行时的替换检查。
- [x] 验证缺失/链接/替换、子文件字节和笔记身份，以及单篇回收站不退化。

### Task 2: AUD-05/AUD-06 Git 异步回执归属

**Files:** `apps/web/components/GitRemotePanel.vue`、`tests/git-remote-ui.test.ts`。

- [x] 将审计中旧错误复活、旧任务顶替新任务两种时序转成失败用例。
- [x] 为任务意图、同 ID 重试、回执读取和后续刷新添加一致的归属校验。
- [x] 验证旧响应不影响新成功提示、轮询、取消入口及原请求核对。

### Task 3: AUD-02/AUD-03/AUD-07 保存与搜索

**Files:** `apps/web/components/Workspace.vue`、必要的 `apps/web/components/NoteEditorHost.vue`；`tests/e2e/document-editor-recovery.spec.ts`、`tests/e2e/search-filenames.spec.ts`、`tests/e2e/search-location.spec.ts` 及相邻单元测试。

- [x] 确认输入法重复保存、延迟目录搜索和跨模式定位的失败行为。
- [x] 合并待刷新/预检的保存请求，保持写入幂等与笔记/草稿归属。
- [x] 目录变化后更新文件名匹配，保留正文命中与分页信息。
- [x] 当前适配器就绪后应用定位，跨模式及同笔记第二命中保持正确。
- [x] 运行对应页面、保存、搜索和编辑器邻近测试。

### Task 4: AUD-04 矮窗口导航与测试前置同步

**Files:** `apps/web/management.css`、`apps/web/workbench.css` 等最小布局范围；`tests/e2e/short-actions.spec.ts`，以及已审计证明前置失配的界面测试。

- [x] 显式打开侧栏后，在 568×240 复现目录被遮挡。
- [x] 调整侧栏滚动/固定区域，验证目录点击与更多操作可达。
- [x] 将审计中已验证的默认模式/控件角色/H6/偏好前置更新到官方测试，不改产品来满足旧假设。
- [x] 验证桌面与手机视口，避免与其他工作者共用测试端口。

### Task 5: 集成验证和交付

- [x] 独立审查四个修改域，处理重要发现。
- [x] 完整 `npm test`、`npm run typecheck`、`npm run build`。
- [x] 当前生产构建上运行七项页面回归、相关模式/搜索/恢复路径及测试前置维护用例。
- [x] 记录通过与跳过范围，核对原有文档及正式服务未改动，更新修复结果。

## 验证调度记录

完整 Vitest 包含使用固定 4179 端口的实际 Vite 夹具关闭测试，需避免与官方浏览器验收同时占用端口。本轮并行时该项失败，释放端口后隔离重跑对应文件 5 项全部通过；产品代码未因调度问题调整。

## 最终验证

- 七项实现及整合独立审查通过；Git 已接受导入通知的复审问题已修复。
- 针对性：备份 40 项、Git UI 53 项、保存/搜索 44 项、视图切换 9 项通过。
- 生产构建：桌面 62 通过；手机 60 通过、2 条桌面快捷键分支按平台跳过。首次 Git 导入两端各 1 项通过；独立初始化 1 项通过。类型检查、构建通过。
- 完整自动化首次运行 1488 通过、1 失败、0 跳过，退出码 1。失败为 `tests/e2e-server-lifecycle.test.ts > cleans the actual Vite fixture after a graceful shutdown`：与并行浏览器验收共用 4179，误认其他服务后提前终止自己的子进程。释放端口后该文件 5 项隔离重跑通过，未改产品代码来处理调度冲突。
- 原有未提交验收文档哈希不变，正式服务仍为 rc.45；本轮未提交、发布或部署。已有恢复副本需重新执行受控恢复，普通启动不自动重绑身份。

机器记录：`.local/full-fixes-20261025/result.json`；用户简版：`/home/bandoo/documents/dooknow-full-fixes-2026-10-25/修复结果.txt`。
