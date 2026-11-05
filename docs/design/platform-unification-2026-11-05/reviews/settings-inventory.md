# Settings / plugins / MCP / Git inventory review

Baseline: `933d63d942b6499fee964f8a060c7b22b9d299d1`. Source-only inventory at `/home/bandoo/.codex/worktrees/60c5/doo-know`. No application files changed, no images generated, no services/tests/dependencies started or installed.

Coverage: **91 surface records**: 8 page, 11 dialog, 60 state, 7 popover, 5 drawer. These include **8 actual settings pages**; embedded cards and alternate states are not counted as pages. **85 records require distinct future design images**. Five dormant records (ST-042, ST-085–ST-088) are retained for traceability and excluded from that image queue; these are not verified live surfaces. ST-015 reuses the canonical WS-023 DirectoryTreeSelect visual while retaining its own host permissions and selection contract.

## Route and ownership check

- SettingsWorkspace resolves editor, library, search, backup, status, plugins, account and about using `/?view=settings&section=…`. `maintenance` is a legacy alias of backup. See `apps/web/settings.ts:8`, `apps/web/navigation.ts:118`.
- Batch import interiors are ST-018 choose, ST-019 preview, ST-020 confirm, ST-021 invalidation/error. Portable import/resume is ST-022/ST-023. Export is ST-024. Workspace owns its outer import modal; public inventory owns first-run SetupImport/SetupWizard.
- GitRemotePanel sync content is ST-074; connection ST-075; HTTPS/SSH credentials ST-076/ST-077; review/unknown-results ST-078/ST-079; job recovery ST-080; clone controls ST-081. Workspace/public inventories own their respective outer shells.
- Actual packaged plugin web UI is covered: MCP connection/calls ST-073; Git repo/init/acknowledgement ST-082; commit contribution ST-083/ST-084; registered legacy history/diff/restore ST-085–ST-088 (production entry not found; not counted as a confirmed dialog). Native NoteHistoryDialog belongs to workspace and shares `packages/plugin-ui/git-history.ts`.
- No independent storage page, client-manager route or Git route was invented. MCP API client forms and OAuth narrowing/revoke are inline states, not dialogs.

- ST-056 describes the common PluginPanel host, not an extra live window. ST-077 is the SSH variant of ST-076. ST-091 is a real MCP navigation bridge: the sidebar opens `mcp.navigation`, then its button opens `mcp.settings` (ST-073).

## Behavior that designs must preserve

- Separate local save, Git commit, remote push and backup. Commit requires a current reviewed preview, stable request identity and configured author; pull requires saved/clean state and stops at divergence. A completed local commit survives push failure.
- Keep load failures, empty results, stale preview/config/grant versions, partial success, cancelled/interrupted jobs and unknown transport results distinct. Existing request receipts support reconciliation instead of blindly creating duplicates.
- Backups download encrypted artifacts; recovery-key download rechecks the current password and is throttled. Restore creates an independent copy, provides verification/location guidance, and does not switch production deployment.
- MCP displayed local readiness never claims external reachability or current client presence. Global domain ceilings intersect client grants; narrowing is immediate, widening requires explicit authorization. API credentials have one-time display, individual expiry/rotation/revocation, and optimistic versions.
- Domain resources use stable identities and directory descendants. Scope trees preserve unavailable saved selections; To Doo app UI remains the baseline/excluded, while its MCP authorization controls remain platform scope.
- Secret fields record labels and constraints only. Any design asset must use synthetic masked values and placeholder paths. No live token, key, password or export content was read into this inventory.

## Responsive evidence and limitations

- Settings page CSS has 743/720/600/430px breakpoints, max-width 1000px and a 46px mobile sticky offset. Overlay widths clamp to the viewport, constrain height, scroll content, preserve footer and trap/restore focus.
- Existing tests inspect 390×844 mobile, 1280×720 desktop, 1100×720 intermediate cards and 360×460 dark password overlays; references are in each record. Tree popovers dynamically choose above/below placement and clamp their bounds.
- Plugin web uses its own injected CSS and Naive UI. PluginPanel is capped at 820px with mobile bounds; plugin layouts have 600px adjustments. CSS support and test source were inspected; tests were not executed.

## Remaining source/implementation review points

- 本轮只读源码与已有测试；未启动服务、执行测试、验证实时插件目录/安装状态或屏幕布局。所有responsive结论区分CSS/已有测试证据与未运行验证。
- GPT Image 2模型可用性未核实；本轮无图像生成、无UI实现。全部requiresDistinctImage为设计覆盖要求，不代表已生成或审核通过。
- ST-041后台写入计数当前未包含organizationConflicts，详情维护页包含；应在全局设计评审决定是否同步显示，不能默默改动业务。
- 通用PluginPanel没有连接贡献内部busy/dirty的关闭guard；Git恢复/提交模型锁内部操作，但容器仍允许关闭。设计前须保留并明确这条现状，是否补保护属后续实现决定。
- MCP实际插件more()缺本地错误捕获/忙状态；加载更多调用失败后的用户反馈本轮不能运行确认。
- Change-password内部认证与最大长度依赖Better Auth；已确认UI至少8字符及revokeOtherSessions=true，未臆测依赖内部最大长度。
- 已补追Git分支≤200、库名UI40字符/服务端120字节、目标目录策略、512MiB空闲要求、HTTPS令牌16Ki字符与SSH口令4Ki字符约束；运行环境目录/安装权限本轮未实测。
- 旧git.history贡献仍打包但未找到生产宿主入口，已按注册未证实可达状态列出；当前原生Git历史由workspace inventory负责。
- MCP侧栏navigation点击先打开仅含MCP连接按钮的桥接窗口，再进入mcp.settings；是否消除此额外跳转应经全局设计评审明确。
- IndexStatus.vue未发现生产挂载，ST-042设source-only-unmounted、requiresDistinctImage=false；不能把旧悬浮组件当作已上线入口。

## Inventory verification

- JSON parsed successfully; record IDs are unique, every parent exists, and every source/test reference points to an existing file and in-range source line.
- Every record contains roles, permission rules, field constraints, guarded actions, important states, responsive evidence, test references and an explicit distinct-image decision. Reachability is `confirmed-source`, `registered-only` or `source-only-unmounted`; none is runtime-verified. State requirements are a future design checklist; no image is claimed complete.
- Server guards were traced through `apps/server/app.ts:141` (owner session, same-origin CSRF, maintenance), management/transfers ownership, MCP ceiling/version checks and Git owner-bound routes. `/api/auth/change-password` uses the separate Better Auth auth route.
