# Git 远程知识库管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 打通知识库远端导入、后续关联、手动同步、凭据及插件下载恢复，并发布上线。

**Architecture:** 核心Git管理服务提供账号隔离的凭据、守卫传输和异步任务；复用本地Git插件提交预览。原生Vue同步面板在初始页、知识库/插件设置及工作区共享。

**Tech Stack:** Node22.22.1、TypeScript、SQLite、系统Git/OpenSSH、Vue3、Ant Design Vue、Vitest、Playwright；不加依赖。

**Spec:** docs/superpowers/specs/2026-10-20-git-remote-design.md

## Global Constraints

- 保留既有业务数据、配置、历史及恢复上限；不强推、不自动合并、不覆盖已有目录。
- 远端仅GitHub/Gitee；凭据AES-GCM加密、按账号/主机隔离、禁止回显或进入仓库。
- 所有网络/写操作使用任务、固定错误码、工作区门及守卫进程。
- 版本rc.23、Git1.1.0、MCP1.0.2、数据兼容2；生产只读验证，测试不使用真实远端凭据。

## Review Focus

- 操作超时但远端实际成功：固定提交重试，不重复提交。
- URL/config重写、SSH主机变化：请求前拒绝，不泄露令牌。
- 目标目录在克隆途中被替换：发布前重新验证，不覆盖。
- 远端默认分支及空仓库：保留用户分支，首次推送可完成。
- 重启、删除凭据、知识库绑定改变：旧任务不能对新目标执行。

### Task 1: 账号凭据和守卫传输

Files: create shared/git-contracts.ts, apps/server/git/credentials.ts, transport.ts; modify packages/core/workspace/exec.ts for abort; tests/git-credentials.test.ts, git-transport.test.ts.

Interfaces: `gitCredentials(config,db)` exposes list/save/get/remove; summary never secrets. `normalizeRemote(value)` returns `{url,host,protocol,repository}`. `gitTransport(config,db,options?)` exposes `run(cwd,args,{credential?,url?,signal?,timeoutMs?})`, `scanHost(host,signal?)`. Fixed option types exported from transport and shared contracts. Default runner workspaceExec; constructor-only injectable executor supports isolated bare repositories.

- [ ] RED: reject URL credentials/path traversal/private protocols; decrypt only owner+host; DB ciphertext lacks token; SSH key trust required; blocked config does not launch network; abort reaps child.
- [ ] Implement encryption, validation, temporary SSH files, strict known_hosts, safe HTTPS credential environment, fixed network hardening; no raw stderr in API.
- [ ] GREEN: focused real process/unit tests; self-review and commit task files.

### Task 2: 异步仓库任务与API

Files: create apps/server/git/service.ts, routes.ts; modify apps/server/app.ts; tests/git-remote.test.ts, git-remote-routes.test.ts.

Interfaces: `/api/platform/git/status`, `/credentials` GET/POST/DELETE; `/jobs` GET/POST, `/jobs/:id` GET. Job input `{kind,requestId,url?,branch?,credentialId?,name?,parentPath?,timeZone?,expectedHead?,confirm?}`; kinds test/clone/connect/check/push/pull/disconnect/ssh-host. Job response `{id,kind,status,phase,error?,result?,createdAt,updatedAt}`. Status contains plugin installed/enabled, repository/local changes, connection metadata and cached ahead/behind/lastCheckedAt. `gitRemoteService(config,db,platform,plugins,{exec?})` owns jobs/recovery/close. `createApp(config,dependencies?)` accepts constructor-only Git executor for tests; no environment/profile code injection.

- [ ] RED: real local bare clone→bind, connect local→empty remote, read check, fixed-head push, fast-forward pull, dirty/diverged block, wrong owner/binding, same request replay, restart status.
- [ ] Implement persistent jobs, one active task, automatic explicit-flow plugin install/enable, staged clone publication and binding, connection ownership, safe fetch/push/pull and refresh.
- [ ] GREEN: route auth/CSRF tests and real repository tests; review task and commit.

### Task 3: 远端导入与同步界面

Files: create apps/web/components/GitRemotePanel.vue, GitRepositoryImport.vue, apps/web/git-sync.ts; modify SetupWizard.vue, Workspace.vue, PluginManager.vue, settings/LibrarySettings.vue, SetupFeatures.vue, plugins/git/manifest.json. Test SFC and tests/e2e/git-remote.spec.ts; extend fixture server with constructor-only executor mapping fixture hosts to local bare repositories.

- [ ] RED: remote source option; private token never persisted; pending job resumes; conflict leaves actions; unsaved drafts block pull/commit; push failure retains commit and exposes push-only retry.
- [ ] Implement shared component with credentials/help/host trust, connection status, clone location, branch, job phases, commit preview→commit→push. Preserve local commit button; add cloud sync entry.
- [ ] GREEN: actual component tests, desktop/mobile real UI clone/bind/sync and error recovery; no assertion/time-limit weakening. Review and commit.

### Task 4: 通用下载代理与安装任务

Files: modify scripts/manage.ts, apps/server/plugins/routes.ts, apps/web/components/PluginManager.vue/SetupFeatures.vue, apps/web/api.ts as needed; create apps/server/plugins/install-jobs.ts; tests/download-proxy-cli.test.ts, plugin-install-jobs.test.ts and slow download UI case.

- [ ] RED: serve loads saved proxy before fetch, explicit env wins, loopback bypass; slow install returns202 immediately; duplicate request/restart status and install idempotence.
- [ ] Implement saved proxy fallback for serve; install jobs with phases/owner/result; browser polls and reconciles after lost response. Existing direct install endpoints remain compatible.
- [ ] GREEN: proxy process/CLI, installer and UI tests. Review and commit.

### Task 5: 全量验收及rc.23上线

Files: README.md, release validation list, docs/部署记录; private artifacts/evidence under .local/git-remote-rc23.

- [ ] Update usage, limits and official credential references; verify no secrets/unrelated changes.
- [ ] Run type/build, full unit/API, release gate, exact-artifact native install/backup/restore and full desktop/mobile browser checks; address real failures.
- [ ] Whole-branch review; prepare public release, installer entries, checksums and rollback.
- [ ] Fresh encrypted production backup and business/config/plugin baseline; update fixed release; upgrade already installed Git only preserving desired state, not auto-install on existing local-library users.
- [ ] Public anonymous read-only smoke and unchanged production data/config checks; synchronize original source preview safely; publish deployment record and verify clean pushed source.

Execution ruling: user approved the full written requirement in chat and requested implementation. Continue without routine reconfirmation; use explicit task implementer/reviewer dispatch per subagent-driven-development for independent modules, controller owns integration and release. No remote actions against user repositories without specific repository authorization.
