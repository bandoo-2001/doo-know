# Git 验收问题修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复已复现的取消任务误报、撤销后旧草稿残留、恢复确认缺少取消和重试期间仓库状态误显。

**Architecture:** 沿用现有 Git 后台任务、Vue 状态与 IndexedDB 草稿机制，保留资料保护和结果核对。取消用户任务和关闭服务使用不同原因；未保存操作返回已保存正文后只删除本会话对应的旧草稿；临时忙状态不应显示为仓库缺失；恢复取消仅适用于尚未提交的确认。

**Tech Stack:** TypeScript、Vue 3、Vitest、现有 Git 执行器、IndexedDB。

**Spec:** 本次网页验收记录 `/home/bandoo/documents/dooknow-git-acceptance-2026-10-25/问题总结.txt`；步骤 A069、B111、B129、B163。

## Global Constraints

- 保留既有编辑器改进及未提交的 `docs/验收记录/2026-10-21-platform-full-audit.md`。
- 不改正式知识库、不重设账号、不停启正式服务；不引入依赖、不实现合并/变基，不取消大文件阈值。
- 使用受控测试夹具；凭据不进入代码、文档或测试输出。
- 先运行复现测试并确认预期失败，再实施最小修复；结果不确定的写操作仍要求核对，不能伪装取消成功。

## Review Focus

- 取消发生于只读检查与推送/拉取写阶段时，分别保留正确的确定/待核对结果。
- 服务关闭和用户取消不能混淆；并发取消不能覆盖已完成结果。
- 撤销至原文后的删除不得清除另一个标签页写入的新草稿，亦不得绕过存储错误处理。
- 重试期间忙状态不能误报仓库丢失；真实解绑和插件停用仍必须正确显示。
- 恢复尚未发起可取消；已发起且结果不明时必须保留原 requestId 和核对入口。

### Task 1: 用户取消任务的真实终态

**Files:** `apps/server/git/service.ts`、`apps/server/git/types.ts`、`apps/web/git-sync.ts`、`tests/git-remote-safety.test.ts`，按实际调查补充邻近测试。
**Interfaces:** 保持现有任务路由与 job receipt；使用可区分的取消/关闭原因；仅在已确认不会继续写入时标记取消。

- [x] 以受控执行器暂停运行中检查，取消并断言不再误报服务重启；覆盖服务关闭与写阶段结果不确定场景。
- [x] 运行新增用例，确认旧代码在终态/错误码断言处失败。
- [x] 最小修改任务终态和显示映射，保留核对与幂等保护。
- [x] 运行 Git 任务、安全及传输相关测试。

### Task 2: 撤销回已保存正文时清除本会话旧草稿

**Files:** `apps/web/useNoteDraft.ts`、`apps/web/drafts.ts`（如需）、`tests/web-note-drafts.test.ts`。
**Interfaces:** 沿用 `useNoteDraft`、草稿版本和会话比较删除，不引入全量清空。

- [x] 在真实草稿持久化后撤销到原文，再刷新远端基准，断言不出现旧草稿恢复；覆盖另标签页新版本和存储失败。
- [x] 确认旧代码能复现残留后，串行清理本会话已保存的草稿。
- [x] 运行草稿相关测试。

### Task 3: 未执行的 Git 恢复确认可直接取消

**Files:** `plugins/git/web/index.ts`、`tests/git-web-regressions.test.ts`。
**Interfaces:** 仅关闭 `confirmRestore`，不调用恢复命令；写入进行中及结果未知时保留待核对请求。

- [x] 查看历史差异、进入确认、取消，断言未调用恢复且差异与版本选择保留。
- [x] 覆盖进行中及结果未知时不能丢弃待核对请求，并运行确认旧代码失败。
- [x] 添加取消控件及必要状态守卫，保留原恢复流程。
- [x] 运行 Git Web、恢复与差异组件测试。

### Task 4: 重试任务期间保持真实仓库状态

**Files:** `apps/web/components/GitRemotePanel.vue`、`tests/git-remote-ui.test.ts`；如根因在服务投影，与 Task 1 协调共享文件。
**Interfaces:** 忙/未知状态显示待读取，不当成 missing；权威就绪/真实缺失状态仍刷新，绑定切换不保留旧关联。

- [x] 构造已连接状态→运行中忙状态→失败终态，断言不显示未初始化/未关联且结束后正确刷新。
- [x] 覆盖初次打开就在忙、真正解除关联以及知识库绑定变更。
- [x] 确认旧代码失败后最小修复投影与展示。
- [x] 运行同步面板测试。

### Task 5: 集成验证与审查

- [x] 检查每项 RED/GREEN 记录及生产改动，清除无关修改。
- [x] 运行 `npm test`、`npm run typecheck`、`npm run build`。
- [x] 独立审查取消竞态、草稿跨标签页保护、真实仓库缺失及未知恢复结果。
- [x] 记录修复与尚未扩展的能力；本次不发布、不合并，不改正式服务。

## 验证结果

- 完整 `npm test -- --reporter=verbose`：246 文件通过、1 文件跳过；1445 用例通过、1 用例跳过，无失败。
- 最终 `npm run typecheck`、`npm run build`、相关文件格式与 `git diff --check` 均通过。
- 独立审查四项修复：未发现 Important/Critical 问题。
- 本地源码已修复，未提交、未发布；正式安装仍为 v1.1.0-rc.45。本次不需要用户前置操作。
