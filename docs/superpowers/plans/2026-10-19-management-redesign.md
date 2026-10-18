# Navigation and management implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement all remaining navigation, settings and management improvements approved in the preceding proposal.

**Architecture:** Keep the existing source checkout and isolated development service. Extract settings into independently mounted Vue pages; register owner-only management and transfer route modules alongside existing platform routes. Reuse mutation, workspace-lock, authentication, backup and restore services; use a durable task ledger for asynchronous transfers.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue/Naive UI, Fastify, better-auth, SQLite, tar, existing encrypted backup primitives.

**Spec:** `docs/superpowers/specs/2026-10-19-management-redesign.md`

## Global Constraints

- This task must not change production 5173; development 5180/3011 uses separate development data.
- No real credentials or private note contents in logs, commits or diagnostics.
- Authentication, origin/CSRF, workspace writer gates and path/link validation remain enforced.
- Restore into new empty directories only; never overwrite/hot-swap current data or deployment configuration.
- TMPDIR=/var/tmp/dooknow-validation.lpvStn; browser suites serialize on 4179/4180.
- Current branch baseline `c3e4d0d`; repository initially clean. Continue this authorized source checkout rather than changing the running source path.

## Review Focus

- Same-name imports, retries after cancellation and idempotency must never overwrite or duplicate existing material (Task 3).
- Deep paths, symlinks, encoded traversal and malicious archive entries must remain inside owner-managed roots (Tasks 2–3).
- Backup/restore must preserve active credentials/data while returning a usable separate verified copy (Task 3).
- Leaving settings or returning to a note must retain dirty drafts and restore context, with correct history and old URLs (Tasks 1, 4).
- Status polling must not initialize inactive pages or expose credentials/contents; mobile and keyboard flows remain usable (Tasks 1, 4–5).

## Contract and file ownership

- Root: `shared/settings-contracts.ts`, `apps/web/settings.ts`, `apps/web/preferences.ts`, navigation.ts, Workspace.vue/App.vue integration, footer/status/preferences/theme, server app.ts registration, final E2E.
- Management worker: `shared/management-contracts.ts`, `apps/server/platform/management.ts` and focused helpers/tests; existing storage/core files only as needed. No app.ts edits.
- Transfer worker: `shared/transfer-contracts.ts`, `apps/server/platform/transfers.ts` and focused helpers/tests; existing backup primitives only as needed. No app.ts edits.
- Settings UI worker: new `apps/web/components/settings/` components; existing SearchRuntimeSettings.vue/StorageSettings.vue/PluginManager.vue/MaintenanceSettings.vue improvements. No Workspace.vue/App.vue/navigation.ts edits.

### Task 1: Navigation, preferences and application shell

**Interfaces:** Settings section union `editor|library|search|backup|plugins|account|about`; old `maintenance` maps to backup. Settings view emits `back`, `logout`, `open-note(id)`, `preferences-changed`; props active section and username. Root owns route changes and active-note restoration.

- [x] Add failing unit/browser tests for old URLs, page isolation, avatar/footer/import placement and returning to dirty notes.
- [x] Implement canonical section metadata/route parsing, browser/account-scoped editor preferences and theme providers.
- [x] Integrate SettingsWorkspace, contextual sidebar and fixed footer actions; replace index floating bar with status drawer.
- [x] Verify navigation/preferences tests, typecheck and relevant browser flows; commit.

### Task 2: Owner management APIs

**Produces:** `registerManagementRoutes(app, config, db, auth, platform)`; platform consumes existing platformRuntime object (`get`, `status`, `settings`). Export matching interfaces in `shared/management-contracts.ts`.

- [x] Failing endpoint tests: unauth/CSRF rejection, shares pagination/filter/revoke, safe sessions, honest storage, diagnostics, trash collision/batch/purge.
- [x] Implement GET `/api/manage/overview`, GET `/api/manage/storage`, GET `/api/manage/shares`, POST `/api/manage/shares/revoke`, GET `/api/manage/sessions`, DELETE `/api/manage/sessions/:id`, POST `/api/manage/sessions/revoke-others`, GET `/api/manage/diagnostics`.
- [x] Implement GET `/api/manage/trash`, POST `/api/manage/trash/restore` and POST `/api/manage/trash/purge`; batch bodies `{ids,requestId,...}`; purge requires explicit confirmation. Return per-item results; preserve IDs, auth and conflict rules. Never follow links or delete active notes.
- [x] Endpoint lists use `{items,nextCursor}` pagination (default 50, max 100); sessions return opaque IDs and device/timestamps/current flags, never tokens. Diagnostics contain status/counts/version, never source contents/secrets/private paths.
- [x] Run endpoint/security tests and typecheck; report interfaces for UI integration.

### Task 3: Durable transfers, encrypted backup and isolated restore

**Produces:** `registerTransferRoutes(app, config, db, platform)`; module exports matching `shared/transfer-contracts.ts`. Root registers once; routes own close/restart lifecycle.

- [x] Failing tests for preview/import collisions and traversal, attachment/reference preservation, export bounds, durable jobs, cancellation/retry/idempotency, encrypted backup and restore without live-data changes.
- [x] Implement GET `/api/manage/tasks`, GET `/api/manage/tasks/:id`, POST `/api/manage/tasks/:id/cancel`, GET `/api/manage/tasks/:id/download` using opaque IDs and persistent owner-scoped records.
- [x] Implement POST `/api/manage/import/preview` and POST `/api/manage/import` for relative Markdown/asset file entries (JSON UTF-8/base64, bounded batch size; bodyLimit route-specific); ZIP/tar upload may use a bounded extraction adapter reusing validated archives. Preview includes collision decisions; execution supports skip/rename, not overwrite, and per-item retry results.
- [x] Implement POST `/api/manage/export` (`{folderPath?:string,requestId}`) for portable Markdown/attachment archives with validated references and a truthful scope manifest.
- [x] Implement GET/POST `/api/manage/backups`, GET `/api/manage/backups/:id/download`, POST `/api/manage/backups/key` (currentPassword reauth, binary private-key response only), POST `/api/manage/restores` (`{backupId,requestId}`) and restore verification result. Support external encrypted backup/key import through bounded uploads if needed for independent recovery.
- [x] Store artifacts in controlled per-job paths; backup and restore outputs are outside active data/knowledge roots. Use existing createPlatformBackup/restorePlatformBackup and reader/writer gates. Never accept arbitrary server destinations. Return isolated restore locations and verification counts, not secrets or automatic deployment activation.
- [x] Add recoverable task states queued/running/succeeded/failed/cancelled/interrupted, cancellable capability flag, progress and per-item results. Do not pretend cancellation is available for noninterruptible critical phases.
- [x] Run focused integration/security tests and typecheck; report precise API schemas for UI worker.

### Task 4: Settings pages and management interfaces

**Produces:** `components/settings/SettingsWorkspace.vue`; props `{section,username}`; emits `back`, `logout`, `open-note`, `preferences-changed`.

- [x] Implement independently mounted EditorSettings, LibrarySettings, SearchSettings, BackupSettings, PluginsSettings, AccountSettings, AboutSettings pages and management dialogs/panels.
- [x] Reuse root preference helper for editor/theme options; settings modify display defaults, not saved note formats.
- [x] Search prioritizes actual capabilities/progress; advanced runtime info folds away. Plugins provide installed/add views and selected detail with standard fields/advanced JSON. Password form confirms the new password; sessions use safe management endpoints.
- [x] Library includes bounded usage, source path labeling, share list/revoke, batch preview/import/export. Backup includes encrypted records/download, password-gated recovery key export, isolated restore workflow and truthful deployment activation guidance.
- [x] About contains version/environment/capabilities, keyboard help and redacted diagnostics download. No dead or simulated controls.
- [x] Add keyboard/responsive/browser tests and verify field-local errors/explicit saves.

### Task 5: Status, trash and complete integration

- [x] Aggregate actual index/search/write-conflict/transfer tasks in the footer status drawer, with deep links, supported cancellation and background navigation continuity.
- [x] Enhance trash with metadata, filtering, selected/batch restore, rename-on-conflict and explicit permanent deletion.
- [x] Complete directory/import create menu, active username/avatar popover, route aliases and note context preservation; preserve plugin extension slots.
- [x] Verify loading/empty/failure/retry, 390/743/1440 widths, Escape/focus return, scoped session actions and manual note saving.

### Task 6: Review, verification and development delivery

- [x] Review whole change with a fresh independent reviewer; fix important findings with regression evidence.
- [x] Run new unit/server suites, required relevant existing suites, typecheck, build and serialized browser suites. Inspect git changes/ignored data before commits.
- [x] Restart only `doo-know-source-dev.service`; verify 5180/3011 health, development login and feature entry points, production 5173 release path and HTTP availability remain separate from development.
- [x] Update user documentation and this ledger; commit tested implementation and report completed functions and concrete remaining deployment boundaries.

## Execution ledger

- Planning: inspected existing long-page settings, duplicate account entry, storage scanner, recovery/share APIs and encrypted backup/restore services. User explicitly authorized autonomous execution, so no approval pause.
- Isolation ruling: continue the already running source feature checkout with separate data/ports; production uses a different release path. No extra worktree or service-path migration is needed.
- Data ruling: implement and fixture-test management operations; never run destructive operations on actual user data during delivery.

- Task 2 complete: owner management endpoints, bounded storage, safe sessions/diagnostics, shares and snapshot-scoped trash operations; 27 focused/legacy tests passed.
- Task 3 complete: durable transfers, encrypted backups/key reauthentication and isolated restore; 13 dedicated transfer regressions passed after review fixes.
- Task 4 complete: seven settings pages, live staged display preview, plugin tabs/details and status drawer.
- Task 1/5 integration: contextual sidebar and persistent footer, note/tree DOM preservation, account-scoped preferences/themes, independent page routes and enhanced trash connected. Desktop/mobile navigation tests passed; six full management workflows passed on both projects (12 cases).
- Review fixes: source-span rewriting preserves code literals; all external restore terminal paths remove uploaded private keys; restored copies clear artifact-only ledgers. Independent re-review passed 23 focused checks and closed all three findings.
- Verification underway: full unit suite and full serialized browser suite, including migrated legacy settings/plugin/import/responsive tests. Source development service restarted successfully with explicit development marker; production PID and HTTP availability unchanged.

- Final UI review closed dirty-draft navigation, popstate return target, import destination, completion propagation and moving pagination boundary findings. Twelve runtime UI regressions pass; current cursor chains preserve and refresh all opened records.
- Full browser regression exposed a pre-existing deferred SQLite WAL snapshot upgrade race after source publication. Two deterministic create/update cases first failed with SQLITE_BUSY_SNAPSHOT; receipt recording now reserves the writer before reading the intent. Independent durability/idempotency/crash/move review passed 42 cases.
- Actual source-development login, all seven settings pages, the status drawer and widths 390/743/1440 passed a read-only smoke check; its dedicated login session was signed out. Test traces, credentials and temporary diagnostics remain ignored.
- Production observation: a separate service restart occurred at 2026-10-18 19:48:28–30 UTC while this task only operated the development unit. Production still runs installed release 1.1.0-rc.19 under its release directory. The original process-ID equality cannot be claimed; no production service/deployment write was performed by this task.
- Integration ruling: the user's standing request authorizes a tested local commit and autonomous completion. Preserve the existing source branch/workspace; do not merge, publish, or clean up the user's checkout.

## Final verification and delivery

- Complete unit suite: 133 files passed, one optional file skipped; 516 tests passed. The skipped real bundled-search installation test was then explicitly enabled against the cached artifact and passed separately (offline installation, editing during preparation and offline restart). All 517 unit/integration scenarios are covered.
- Desktop browser coverage: full run 69/71 passed; final focused rerun 9/9 passed after the initial-tree readiness fix and an exact runtime-status selector correction, covering both prior failures and the new delayed-tree case. All 72 current desktop scenarios have passing evidence.
- Mobile browser coverage: prior full run 65 passed with architecture/optional skips; final affected-scope run passed 20 with two architecture skips. Its two harness failures (already-open sidebar and typing before route editability) were corrected without weakening assertions; focused rerun passed 2/2. Coverage includes all 69 applicable current mobile scenarios.
- Independent reviews closed all important management, transfer, navigation and pagination findings. The SQLite concurrency fix passed an independent 42-case durability/recovery/idempotency review. Delayed initial-tree loading now prevents premature root-destination creation; desktop and mobile regression cases pass.
- Fresh production build, full TypeScript/Vue typecheck, changed-file formatting and Git whitespace checks passed. Source/data credentials, databases, generated artifacts, model files and browser traces are ignored and excluded from the commit.
- Only the isolated development service was restarted for delivery. Frontend 5180, API 3011 and production 5173 each returned HTTP 200; production PID was unchanged across that development restart. Read-only development login, all seven pages, status drawer and 390/743/1440 layouts passed; its dedicated login session was signed out.
- Remaining deployment boundary: restore creates and verifies an independent copy and returns activation guidance; it never switches the active service. Permanent trash removal applies to the selected archived originals, with history/backup/audit retention reported separately.
- Delivery: commit the complete tested implementation on the preserved source branch; no push, production deployment or user-workspace removal.
