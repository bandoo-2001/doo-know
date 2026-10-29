# To Doo Full Implementation Plan

> **For agentic workers:** Use test-driven implementation, explicit file ownership, independent review, and the progress ledger. The user explicitly requested actual full implementation after the narrower design; proceed without an additional planning-only handoff.

**Goal:** Deliver the complete personal To Doo application inside DooKnow, together with clickable UI designs and recoverable Git-portable user data.

**Architecture:** One authenticated native application uses a shared typed domain service. Versioned per-entity JSON under the knowledge library's `_data/apps/to-doo/` is authoritative; SQLite provides local projection, scheduling and runtime receipts. Durable collection transactions support batch changes and repeat instances; Vue views share one workbench and real server APIs.

**Tech Stack:** Existing Vue 3, Ant Design Vue, Fastify, TypeScript, SQLite, Vitest and Playwright; add project-local dependencies only where needed for recurrence/calendar parsing and standards-based Web Push.

**Spec:** `docs/superpowers/specs/2026-10-29-to-doo-full-design.md` (replaces the limited first-version scope).

## Global Constraints

- Preserve all existing work. Development is isolated at `/home/bandoo/.codex/worktrees/to-doo-full/doo-know`, branch `txj/to-doo-full`; 88 original changed/untracked paths were copied as input and must not be committed as this task's work.
- Reference baseline copies are at `/home/bandoo/.codex/visualizations/2026/10/29/01a185bc-9e2c-7fb2-9e67-d2613655f500/to-doo-baseline/`.
- No production deployment, service restart, automatic Git push, external messaging or modification of real knowledge data.
- Durable content travels in `_data/apps/to-doo/`; credentials, push subscriptions, local queues, locks and device identity remain outside the library.
- All views operate on the same domain data; no in-memory demo data in the delivered application.
- Web Push is implemented but only reports ready after its origin, permissions, keys and subscription requirements are met. AI assistance uses explicitly authorized MCP tools; no fabricated model results.
- Keep ordinary note/share/search APIs from exposing `_data`. Do not expand existing credentials' grants.
- Independent workers may execute disjoint tasks concurrently after shared contracts are published. Integration files and package manifests belong to the root agent.

## Review Focus

- A crash between multiple JSON replacements must never produce silently accepted partial task batches or lost recurrence completions.
- Calendar dates, recurrence exceptions and multiple time zones must survive a fresh database rebuild and must not duplicate completion instances.
- Concurrent edits, missing synchronized files and stale revisions must preserve both versions and make conflicts visible.
- Push subscriptions and calendar URLs are untrusted network inputs; reject private/internal destinations and never place tokens in portable data or logs.
- A task's source note or an external AI client's permissions may change after creation; links must not imply new note authorization or silently expose unrelated content.

## Task 1: Shared contracts and durable task domain

**Owner:** Backend worker. **Files:** `shared/to-doo-contracts.ts`, `packages/core/to-doo/{store,service,recurrence,queries}.ts`, `tests/to-doo-{store,service,recurrence}.test.ts`.

**Interfaces:** Export `ToDooSnapshot`, `ToDooCommand`, `ToDooCommandResult`, versioned entity contracts, and `createToDooService(config, db, notes)` returning `snapshot()`, `command(input)`, and `close()`. Publish exact command/schema choices before Task 2 begins; changes after publication must be announced to consumers.

- [x] Write tests for persistent create/update, stale revision rejection, duplicate request replay, deletion/restore, partial transaction recovery and copy-to-fresh-database recovery; run and observe expected missing-feature failures.
- [x] Implement per-entity collection reads, validation, atomic entity writes and recoverable multi-entity transaction records. Reuse platform safe path and workspace gate primitives; no per-task SQL trigger generation.
- [x] Implement lists/goals/sections, tasks/subtasks, ordering, tags, priorities, custom views, batch edits, subtree actions and source/evidence references.
- [x] Implement repeat series, independently addressable instances, exceptions, whole-series/future/current edits and idempotent completion/skip actions. Cover month ends, leap years, weekly anchors and time-zone changes.
- [x] Implement habit/check-in, focus session, anniversary and progress-record entities with durable actions; make counts and statistics derivable from real records.
- [x] Run task-domain suites and report exact APIs, paths and tests. Do not modify UI/integration/package files or commit inherited work.

## Task 2: Full real application UI

**Owner:** UI worker. **Files:** `apps/web/components/to-doo/*.vue`, `apps/web/components/ToDooWorkspace.vue`, `apps/web/to-doo-workbench.ts`, `apps/web/to-doo.css`, `tests/to-doo-workbench.test.ts`, `tests/e2e/to-doo.spec.ts`.

**Consumes:** Task 1's frozen shared contracts; authenticated `GET /api/to-doo/state` and `POST /api/to-doo/commands`; root-supplied interop/push endpoints. **Produces:** Native component with `open-note` and `back` events; all task interactions use the shared workbench.

- [x] Deliver and inspect the separate clickable UI design and desktop screenshots, including compact/comfortable density and narrow-width rendering.
- [x] Write failing workbench/browser tests for create, details edit, completion, view switching, errors and refresh persistence.
- [x] Implement goal overview, task list/tree with editable details, kanban, month/week calendar, timeline and quadrants over the same records.
- [x] Implement pomodoro/stopwatch, habit check-ins, anniversaries, notifications, records/statistics and settings/import/export surfaces.
- [x] Implement real batch controls, tags/search/saved filters, sorting, drag/drop where appropriate, keyboard operations and unsaved-input preservation.
- [x] Implement source/evidence selectors and clear unavailable-link states, recurrence scope selection and date/time-zone forms.
- [x] Test desktop/mobile, real persistence and error handling. No placeholder product handlers, fake success notifications, or hardcoded demo metrics.

## Task 3: Calendar/data interchange and notifications

**Owner:** Integration worker or root, disjoint from Task 1. **Files:** `packages/core/to-doo/{interop,calendar,notifications}.ts`, `apps/server/to-doo/{interop-routes,push-routes}.ts`, `apps/web/public/to-doo-sw.js` (or existing public directory equivalent), relevant tests. Package manifest edits belong to root.

**Consumes:** Shared service command/snapshot contracts. **Produces:** Import preview/confirm, JSON and ICS export, read-only calendar feed subscriptions and local notification runtime; all content changes go through the service.

- [x] Write failing import/export round-trip tests and malformed-input/duplicate-import tests.
- [x] Implement versioned JSON full export/import, TickTick CSV mapping preview and confirm, and ICS file import/export with explicit unsupported-field reporting.
- [x] Implement selected-calendar subscription links with separate revocable local bearer secrets; export only chosen fields. External ICS subscription fetches enforce HTTPS, per-hop/pinned address checks, timeouts and size limits.
- [x] Write failing notification tests for restart, deduplication, completion/cancellation, snooze, expired subscription and restored-host inactivity.
- [x] Implement durable station notifications and Web Push subscription/test/revoke with a minimal push-only service worker and feature-detected UI capabilities. Push keys/subscriptions never enter `_data`.
- [x] Test scheduler lifecycle and not-ready states without pretending a live phone delivery was verified.

## Task 4: Host routes, navigation and MCP

**Owner:** Root. **Files:** `apps/server/app.ts`, `apps/server/platform/runtime.ts`, `apps/server/to-doo/routes.ts`, `apps/web/components/{AppsWorkspace,Workspace}.vue`, `apps/web/navigation.ts`, `shared/authorization-scopes.ts`, `packages/plugin-sdk/index.ts`, `apps/server/plugins/services.ts`, MCP plugin contracts/operations/config and authorization UI, focused tests.

- [x] Write failing host tests for authentication/CSRF, To Doo API persistence and navigation parse/serialize.
- [x] Add authenticated To Doo routes using platform runtime binding; close scheduler/service on runtime stop and respect maintenance/gate conditions.
- [x] Add native application card and route persistence without overwriting inherited UI changes.
- [x] Write failing MCP tests for separate task read/write grants and old-grant denial.
- [x] Add a typed To Doo SDK port and explicitly authorized MCP list/get/create/update/complete/batch-plan operations. Keep source-note access subject to existing note grants.
- [x] Add plan-preview and explicit plan-apply semantics through the same service; no autonomous AI execution or synthetic model response.
- [x] Verify existing blog, notes, portable-data and MCP authorization behavior still passes.

## Task 5: Whole feature verification and review

**Owner:** Root and fresh reviewer.

- [x] Check the full-design feature matrix against actual runnable modules; each claimed capability must have an implemented UI/API path and appropriate evidence.
- [x] Run all new domain/interop/notification/MCP tests, then the project unit suite, typecheck and production build. Investigate failures and report any inherited baseline issues by name.
- [x] Run targeted real-server Playwright desktop/mobile workflows: create goal/task, switch all views, complete/check in/focus, import/export, notification settings and copy-library recovery.
- [x] Capture the implemented UI, compare with the design, inspect screenshots and correct material layout defects.
- [x] Prepare a task-only diff relative to the preserved baseline and request independent correctness/security review. Fix material findings and re-run affected checks.
- [x] Record delivered scope, actual checks, notification deployment prerequisites and any remaining limitations in an acceptance document. Keep product work in the attached isolated workspace; do not merge or deploy without the user's request.
