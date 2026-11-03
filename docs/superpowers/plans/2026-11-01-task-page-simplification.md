# Task Page Simplification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task with TDD. The user has authorized execution of the preceding concrete analysis.

**Goal:** Make task board, details, groups and menus cohesive while preserving the ToDoo appearance and all existing features.

**Architecture:** Reuse task rows and one shared task menu across surfaces; add deterministic grouping helpers and versioned group operations on existing command APIs. Keep the existing detailed editors and move optional entry points into compact summaries/menus.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-01-task-page-simplification-design.md

## Global Constraints

- Preserve the existing shell, tokens, explicit save, separate plan/deadline, advanced features and unrelated work.
- No dependency, data migration, deployment, service or branch changes; leave mixed uncommitted changes reviewable.
- Menu actions use authoritative subtree revisions without changing multi-selection; group creation positions apply only on save.

## Review Focus

- Filtered children and multiple recurring occurrences must not disappear or cross group/column boundaries.
- Empty groups and missing/deleted groups must preserve all task content and insertion context.
- Partial datasets and failed/retried commands must not mutate selection or duplicate operations.
- Hidden detail properties and unsaved inputs must survive menu navigation and save validation.
- Keyboard and touch users must reach all operations in both themes and narrow layouts.

### Task 1: Group and operation contracts

**Files:** new apps/web/to-doo-task-groups.ts; apps/web/to-doo-workbench.ts; tests/to-doo-task-groups.test.ts; tests/to-doo-workbench.test.ts.
**Interfaces:** Group items using all known ancestors, preserving item keys; expose `batchTasks(ids, operation, extra)` independently of current selection; read/reorder group members through existing APIs.

- [x] Add tests for inherited groups, filtered parents, recurring item keys, empty/deleted groups and menu batches with paged descendants.
- [x] Observe failures, implement the helpers, then pass focused regressions.

### Task 2: List, board and menus

**Files:** new ToDooTaskMenu.vue and ToDooTaskGroupMenu.vue; ToDooTaskViews.vue, ToDooTaskRow.vue, ToDooEntityEditor.vue, ToDooWorkspace.vue, ToDooNavigation.vue; task style files.
**Interfaces:** Shared row/menu events preserve open/create/edit actions; groups use Task 1 helpers and atomic position-aware saves.

- [x] Add failing behavior/browser tests for grouped lists, lean board cards, parent/child cards and per-object menus.
- [x] Implement groups and reusable menus, preserve all board modes and batch actions, retain scope titles and view selection.
- [x] Verify actions, context menus, grouping and hidden defaults through real components/API.

### Task 3: Content-first details and timeline

**Files:** ToDooTaskDetail.vue, ToDooCalendar.vue, task detail/style files; tests/to-doo-task-surfaces.test.ts and browser specs.
**Interfaces:** Keep every existing editor, validation and save path; reveal optional properties through an attribute menu and show populated content directly.

- [x] Add failing tests for empty/default property suppression, primary children/materials and access to all optional settings.
- [x] Implement compact properties, direct child/material sections and expandable timeline planning tools.
- [x] Verify recurrence, deadlines, reminders, attachments, outcomes and draft retention.

### Task 4: Verification and review

**Files:** tests/e2e/to-doo-task-simplification.spec.ts; existing relevant task browser tests; task-local screenshots and records.

- [x] Run relevant ToDoo unit/integration and browser regressions, typecheck and build.
- [x] Inspect desktop/mobile and light/dark screenshots; verify no horizontal overflow and keyboard/touch reachability.
- [x] Obtain one independent code review; fix material defects with regression evidence; record remaining limitations.
