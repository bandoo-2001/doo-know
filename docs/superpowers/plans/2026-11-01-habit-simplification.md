# Habit Simplification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Simplify habit creation and check-in while retaining the existing ToDoo appearance and old cumulative data.

**Architecture:** Extend versioned habit rules with optional goal mode and interval fields. Use small habit-specific form/reminder components within the existing entity editor and reuse existing cards, modal and theme tokens.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue, Zod, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-01-habit-simplification-design.md

## Global Constraints

- Preserve the existing ToDoo shell and all unrelated uncommitted changes.
- No new dependencies, data migrations, service changes or automatic commits of mixed changes.
- Missing goal mode means legacy quantity behavior; new forms default to check-in.
- Week/month goals retain cumulative semantics; rule changes retain historical versions.

## Review Focus

- Historical mode/cadence changes must not reinterpret earlier quantities or streaks.
- Repeated check-in, failed writes and retries must not double-count or erase input.
- Weekday and interval dates must remain consistent across month boundaries and reminders.
- Existing absolute/offset reminders must survive edits to basic times.
- Both themes and narrow screens must preserve controls, labels and scroll bounds.

### Task 1: Rules and compatibility

**Files:** shared/to-doo-contracts.ts, shared/to-doo-habits.ts, packages/core/to-doo/service.ts, tests/to-doo-habits.test.ts, tests/to-doo-habit-history.test.ts.

**Interfaces:** Produce optional goalMode (`checkin`/`quantity`), intervalDays (1–365), icon and versioned rule support; `getHabitGoalMode` retains legacy quantity semantics.

- [x] Add failing tests for weekday/interval exemptions, check-in deduplication, invalid dates and historical mode/rule changes.
- [x] Run the focused tests and inspect expected failures.
- [x] Implement validation, aggregation and versioned service behavior.
- [x] Run habit/service regressions. Expected: all pass.

### Task 2: Habit form and daily interaction

**Files:** apps/web/components/to-doo/ToDooHabitFields.vue, ToDooHabitReminders.vue, ToDooEntityEditor.vue, ToDooHabitCard.vue, ToDooRhythm.vue; apps/web/to-doo.css; tests/to-doo-entity-editor.test.ts, tests/to-doo-rhythm-controls.test.ts.

**Interfaces:** Consume Task 1 rules. Produce default check-in forms, explicit cadence summaries, basic time reminders and quantity additions with existing component styling.

- [x] Add failing editor/control tests for new defaults, old quantities, completion and explicit additive inputs.
- [x] Run focused tests and inspect expected failures.
- [x] Implement specialized fields/reminders, compact cards, icon choice and history detail actions.
- [x] Run editor, rhythm, reminder and habit regressions. Expected: all pass.

### Task 3: Browser verification and review

**Files:** tests/e2e/to-doo-habit-cards.spec.ts, tests/e2e/to-doo-habit-simplification.spec.ts; task screenshots under .local/.

**Interfaces:** Consume real page and command API; preserve existing API legacy fixtures.

- [x] Test creation, one-click completion, quantitative additions, cadence validation, reminder preservation and historical actions.
- [x] Verify desktop/mobile, dark/light, reload persistence and no horizontal overflow.
- [x] Run typecheck, build and relevant regression checks; inspect screenshots and final task diff.
- [x] Obtain a fresh code review and address material findings before reporting results.
