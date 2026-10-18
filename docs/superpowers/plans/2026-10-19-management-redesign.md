# Navigation and management implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all remaining navigation, settings and management improvements approved in the preceding proposal.

**Architecture:** Keep the existing source checkout and isolated development service. Extract settings into independently mounted Vue pages; register owner-only management and transfer route modules alongside existing platform routes. Reuse mutation, workspace-lock, authentication, backup and restore services; use a durable task ledger for asynchronous transfers.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue/Naive UI, Fastify, better-auth, SQLite, tar, existing encrypted backup primitives.

**Spec:** `docs/superpowers/specs/2026-10-19-management-redesign.md`

## Global Constraints
- Production 5173 must remain untouched; development 5180/3011 uses separate development data.
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
- [ ] Add failing unit/browser tests for old URLs, page isolation, avatar/footer/import placement and returning to dirty notes.
- [ ] Implement canonical section metadata/route parsing, browser/account-scoped editor preferences and theme providers.
- [ ] Integrate SettingsWorkspace, contextual sidebar and fixed footer actions; replace index floating bar with status drawer.
- [ ] Verify navigation/preferences tests, typecheck and relevant browser flows; commit.

### Task 2: Owner management APIs
**Produces:** `registerManagementRoutes(app, config, db, auth, platform)`; platform consumes existing platformRuntime object (`get`, `status`, `settings`). Export matching interfaces in `shared/management-contracts.ts`.
- [ ] Failing endpoint tests: unauth/CSRF rejection, shares pagination/filter/revoke, safe sessions, honest storage, diagnostics, trash collision/batch/purge.
- [ ] Implement GET `/api/manage/overview`, GET `/api/manage/storage`, GET `/api/manage/shares`, POST `/api/manage/shares/revoke`, GET `/api/manage/sessions`, DELETE `/api/manage/sessions/:id`, POST `/api/manage/sessions/revoke-others`, GET `/api/manage/diagnostics`.
- [ ] Implement GET `/api/manage/trash`, POST `/api/manage/trash/restore` and POST `/api/manage/trash/purge`; batch bodies `{ids,requestId,...}`; purge requires explicit confirmation. Return per-item results; preserve IDs, auth and conflict rules. Never follow links or delete active notes.
- [ ] Endpoint lists use `{items,nextCursor}` pagination (default 50, max 100); sessions return opaque IDs and device/timestamps/current flags, never tokens. Diagnostics contain status/counts/version, never source contents/secrets/private paths.
- [ ] Run endpoint/security tests and typecheck; report interfaces for UI integration.

### Task 3: Durable transfers, encrypted backup and isolated restore
**Produces:** `registerTransferRoutes(app, config, db, platform)`; module exports matching `shared/transfer-contracts.ts`. Root registers once; routes own close/restart lifecycle.
- [ ] Failing tests for preview/import collisions and traversal, attachment/reference preservation, export bounds, durable jobs, cancellation/retry/idempotency, encrypted backup and restore without live-data changes.
- [ ] Implement GET `/api/manage/tasks`, GET `/api/manage/tasks/:id`, POST `/api/manage/tasks/:id/cancel`, GET `/api/manage/tasks/:id/download` using opaque IDs and persistent owner-scoped records.
- [ ] Implement POST `/api/manage/import/preview` and POST `/api/manage/import` for relative Markdown/asset file entries (JSON UTF-8/base64, bounded batch size; bodyLimit route-specific); ZIP/tar upload may use a bounded extraction adapter reusing validated archives. Preview includes collision decisions; execution supports skip/rename, not overwrite, and per-item retry results.
- [ ] Implement POST `/api/manage/export` (`{folderPath?:string,requestId}`) for portable Markdown/attachment archives with validated references and a truthful scope manifest.
- [ ] Implement GET/POST `/api/manage/backups`, GET `/api/manage/backups/:id/download`, POST `/api/manage/backups/key` (currentPassword reauth, binary private-key response only), POST `/api/manage/restores` (`{backupId,requestId}`) and restore verification result. Support external encrypted backup/key import through bounded uploads if needed for independent recovery.
- [ ] Store artifacts in controlled per-job paths; backup and restore outputs are outside active data/knowledge roots. Use existing createPlatformBackup/restorePlatformBackup and reader/writer gates. Never accept arbitrary server destinations. Return isolated restore locations and verification counts, not secrets or automatic deployment activation.
- [ ] Add recoverable task states queued/running/succeeded/failed/cancelled/interrupted, cancellable capability flag, progress and per-item results. Do not pretend cancellation is available for noninterruptible critical phases.
- [ ] Run focused integration/security tests and typecheck; report precise API schemas for UI worker.

### Task 4: Settings pages and management interfaces
**Produces:** `components/settings/SettingsWorkspace.vue`; props `{section,username}`; emits `back`, `logout`, `open-note`, `preferences-changed`.
- [ ] Implement independently mounted EditorSettings, LibrarySettings, SearchSettings, BackupSettings, PluginsSettings, AccountSettings, AboutSettings pages and management dialogs/panels.
- [ ] Reuse root preference helper for editor/theme options; settings modify display defaults, not saved note formats.
- [ ] Search prioritizes actual capabilities/progress; advanced runtime info folds away. Plugins provide installed/add views and selected detail with standard fields/advanced JSON. Password form confirms the new password; sessions use safe management endpoints.
- [ ] Library includes bounded usage, source path labeling, share list/revoke, batch preview/import/export. Backup includes encrypted records/download, password-gated recovery key export, isolated restore workflow and truthful deployment activation guidance.
- [ ] About contains version/environment/capabilities, keyboard help and redacted diagnostics download. No dead or simulated controls.
- [ ] Add keyboard/responsive/browser tests and verify field-local errors/explicit saves.

### Task 5: Status, trash and complete integration
- [ ] Aggregate actual index/search/write-conflict/transfer tasks in the footer status drawer, with deep links, supported cancellation and background navigation continuity.
- [ ] Enhance trash with metadata, filtering, selected/batch restore, rename-on-conflict and explicit permanent deletion.
- [ ] Complete directory/import create menu, active username/avatar popover, route aliases and note context preservation; preserve plugin extension slots.
- [ ] Verify loading/empty/failure/retry, 390/743/1440 widths, Escape/focus return, scoped session actions and manual note saving.

### Task 6: Review, verification and development delivery
- [ ] Review whole change with a fresh independent reviewer; fix important findings with regression evidence.
- [ ] Run new unit/server suites, required relevant existing suites, typecheck, build and serialized browser suites. Inspect git changes/ignored data before commits.
- [ ] Restart only `doo-know-source-dev.service`; verify 5180/3011 health, development login and feature entry points, production 5173 process unchanged.
- [ ] Update user documentation and this ledger; commit tested implementation and report completed functions and concrete remaining deployment boundaries.

## Execution ledger
- Planning: inspected existing long-page settings, duplicate account entry, storage scanner, recovery/share APIs and encrypted backup/restore services. User explicitly authorized autonomous execution, so no approval pause.
- Isolation ruling: continue the already running source feature checkout with separate data/ports; production uses a different release path. No extra worktree or service-path migration is needed.
- Data ruling: implement and fixture-test management operations; never run destructive operations on actual user data during delivery.
