# ToDoo Focus Trend Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the current existing worktree. Preserve unrelated working changes; no commits or deployment.

**Goal:** Show complete per-project weekly, monthly and yearly focus duration curves.

**Architecture:** Extend the existing history query with optional trendPeriod/trendDate and a bounded aggregate. Parent owns selection and request lifecycle; a presentation component renders native SVG and accessible values.

**Tech Stack:** TypeScript, Vue, Ant Design Vue, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-01-to-doo-focus-trend-design.md

## Global Constraints

Keep existing theme, timer/draft/history behavior, server authorization and focus duration accounting. No new dependencies, service changes, commits or deployment.

## Review Focus

Cross-midnight and DST durations; totals beyond pagination; fast project/period changes; independent history range; narrow/dark presentation and keyboard access.

### Task 1: Full scoped period aggregates

**Files:** shared/to-doo-contracts.ts, packages/core/to-doo/focus.ts, apps/server/to-doo/routes.ts, tests/to-doo-focus-history.test.ts, tests/to-doo-routes.test.ts.

**Interfaces:** optional query trendPeriod: week/month/year, trendDate: local YYYY-MM-DD; response trend: { period, from, to, bucket: day/month, totalMinutes, points: { date, minutes }[] }.

- [x] Write and run failing service tests for week/month/year buckets, empty dates, leap year, settings timezone/week start, DST, corrections, excluded sessions and authorization/paging.
- [x] Extend validation and produce trend before history paging using existing focusMinutes.
- [x] Add HTTP validation/forwarding coverage and pass related focus/route tests.

### Task 2: Accessible project curve

**Files:** apps/web/components/to-doo/ToDooFocus.vue, new ToDooFocusTrend.vue, new apps/web/to-doo-focus-trend.ts, focused tests and browser spec.

**Interfaces:** Consume Task 1 optional trend response; parent query owns trend selection, refresh and request epochs. Component emits period/date changes.

- [x] Write and run failing UI tests for entry, cycle navigation, project scope, independent history range and stale response rejection.
- [x] Add collapsed overview entry, project menu entry and responsive SVG with exact point values/data table; keep selected period across polling.
- [x] Pass focus UI/lifecycle regressions, desktop/mobile browser tests; inspect actual light/dark captures.

### Task 3: Verify and review

- [x] Run relevant ToDoo tests, typecheck and production build, reporting any scope-external errors accurately.
- [x] Review the task diff independently; address material findings and verify.
- [x] Record acceptance and deliver a concise explanation with a real screenshot.
