# To Doo Desktop Reminders Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the integration and dispatch independent browser worker/device tasks in parallel. Steps use checkbox syntax.

**Goal:** Deliver desktop reminders after the page closes and actionable reminder cards throughout the signed-in workspace.

**Architecture:** Keep the existing server-owned Web Push outbox. Add a bounded, authenticated reminder feed/context/action layer, a global card controller, safe worker-to-workspace messages, and accurate current-device enrollment status. Reuse task completion and habit check-in commands.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue, Fastify, Service Worker, Vitest, Playwright; no new dependencies.

**Spec:** docs/superpowers/specs/2026-10-30-to-doo-desktop-reminders-design.md (approved by user).

## Global Constraints

- Preserve all pre-existing uncommitted work and use the existing linked worktree.
- Do not deploy/restart production or automatically activate real push subscriptions.
- Use actual browser permission; distinguish current-device enrollment from other devices.
- Keep CSRF/session/revision checks, actual task/habit commands, quiet hours, and delivery-generation deduplication.
- System notifications use the OS appearance; support notification-button fallback by opening an actionable card.

## Review Focus

- Clicking a notification while a note has unsaved edits must not reload or discard the note.
- Current browser has no subscription while another device is active: do not claim this device is ready.
- Snoozed reminders, invalidated schedules, completed tasks, and habit period dates must resolve correctly.
- Retries and multiple tabs must not duplicate completion/check-in or repeatedly show the same generation.
- Malformed notification URLs/messages must not navigate outside the workspace or execute unauthenticated actions.

### Task 1: Worker delivery and safe notification activation

**Files:** apps/web/public/to-doo-sw.js; tests/to-doo-service-worker.test.ts.
**Interface:** Worker receives existing push payload with eventId/generation/url. Click posts `{type:'dooknow-to-doo-open-reminder', eventId, url}` to an existing authenticated workspace client and focuses it without navigation; opens a sanitized same-origin URL carrying `reminder=<eventId>` if none exists. Push posts `{type:'dooknow-to-doo-reminder-update'}` to existing clients while still displaying a system notification.

- [x] Add failing behavioral VM tests for no-window delivery, cold-open URLs, active-editor safety and untrusted data.
- [x] Implement minimal worker changes and run those tests.

### Task 2: Current-device enrollment and understandable settings

**Files:** apps/web/to-doo-push.ts; apps/web/components/to-doo/ToDooSettings.vue; tests/to-doo-push.test.ts.
**Interface:** Browser helper consumes request(url, method?, body?), server GET /api/to-doo/push and new POST /api/to-doo/push/device-status {endpoint}; returns capability/permission/current-device state. Backend returns `{deviceId,status}` or `{deviceId:null,status:'unregistered'}` without exposing subscription details. Backend implementation belongs to Task 3.

- [x] Test current browser vs other devices, denied permission, waiting for active registration, and actual subscription synchronization.
- [x] Implement helper/settings incrementally, retaining existing settings behavior and user-gesture permission.
- [x] Run helper tests; root integration covers typechecking.

### Task 3: Reminder context, real actions, and global card integration

**Files:** shared/to-doo-reminders.ts; packages/core/to-doo/reminders.ts; packages/core/to-doo/notifications.ts; apps/server/to-doo/push-routes.ts; apps/server/app.ts; apps/web/to-doo-reminders.ts; apps/web/components/to-doo/ToDooReminderCards.vue; apps/web/components/Workspace.vue; tests/to-doo-reminders.test.ts; tests/to-doo-reminder-controller.test.ts.
**Interface:** GET /api/to-doo/reminders/pending returns recent valid cards, missed count, timeZone; GET /api/to-doo/reminders/:id resolves one card; POST /api/to-doo/reminders/:id/complete accepts requestId/expectedRevision/optional amount and uses real domain commands. Existing /action handles read/acknowledge/snooze. Expose pure card/context types from shared/to-doo-reminders.ts. Add current-device endpoint from Task 2 using stored endpoint hash.

- [x] Test future snoozes, suppressed/invalid reminders, exact occurrence/date resolution, task completion, habit partial amount, idempotent retries and deferred complex tasks.
- [x] Implement core context/actions and authenticated routes; verify domain tests.
- [x] Test global controller polling, stop/unmount, generation deduplication, cold-open/worker messages, action failure recovery and cross-tab updates.
- [x] Implement controller/card and mount once in Workspace; use existing protected navigation for detail actions and never reload a live editor.

### Task 4: Integration validation and independent review

**Files:** tests/e2e/to-doo-reminders.spec.ts; docs/ToDoo使用与数据.md; this plan/spec.

- [x] Browser-check cards, snooze, completion, mobile layout and safe notification activation using isolated fixture data.
- [x] Run focused reminder/worker/device/navigation tests, typecheck, build, and affected browser cases sequentially.
- [x] Fresh reviewer checks only this feature's changes against the approved spec; fix material findings and rerun affected checks.
- [x] Record limitations: mocked push checks do not prove actual user-device receipt; actual subscription permission is a user action.

## Execution Notes

User explicitly requested implementation after design approval; proceed without another process approval. The workspace is already a linked worktree on txj/mcp-tools-extension. Existing reminder baseline: 17 tests pass. Preserve the shared dirty index/worktree; do not stage unrelated changes or create commits containing earlier work.

### Results

- Existing related regression run: 35 files / 332 tests passed. After final worker/receipt fixes, the focused reminder/device/navigation run passed 8 files / 118 tests.
- Browser validation: 8 desktop and 8 mobile cases passed, including the new reminder flows, existing recurring-task row behavior, and startup without the secure UUID API.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed. Build emitted dependency module-directive warnings without failing.
- Review fixes were reproduced before implementation: consume cold reminder URLs to prevent reopening read cards; clear or update exact occurrence selection during ordinary task navigation; remove remotely closed forced cards.
- Additional validation covers active-worker replacement, snooze re-alerting, current-device identity, stable retry receipts, dataset isolation and restore cleanup.
- No production deployment, real device permission, real external push delivery, commit, or service restart was performed. The existing shared dirty worktree is preserved.
