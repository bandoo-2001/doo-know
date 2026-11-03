# ToDoo Cohesion Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans, preserving disjoint page ownership and test-first verification.

**Goal:** Apply the approved habit/task simplification themes to remaining ToDoo pages and deliver real before/after images.

**Architecture:** Keep all existing business models and handlers; reorganize optional controls within current page components and reuse disclosures/menus/theme tokens. Separate page-owned CSS to avoid shared-style races.

**Tech Stack:** Vue, Ant Design Vue, TypeScript, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-01-to-doo-cohesion-design.md

## Global Constraints

- Preserve all existing features, draft bindings, explicit save, page shell and prior task/habit work.
- Before/after use identical seeded data, clock, theme, viewport and route; no fabricated screenshots.
- No dependency, backend, migration, service, branch or commit changes.
- Page owners edit only assigned files; shared styles and capture harness belong to the coordinator.

## Review Focus

- Hidden fields retain unsaved values and auto-reveal validation errors.
- Date/calendar/timezone and cumulative/statistical meanings remain accurate.
- Focus timers, history, active notes and polling retain lifecycle behavior.
- Empty-state suppression must not hide real data, active errors or recovery work.
- Every optional action remains reachable by keyboard/touch at narrow widths.

### Task 1: Baseline and theme audit

- [x] Audit remaining pages against the six themes; save current source copies.
- [x] Capture all routes in desktop light and phone dark with the fixed visual fixture.

### Task 2: Planning pages

**Files:** ToDooTaskViews.vue (overview/matrix only), ToDooCalendar.vue, dedicated page stylesheet/tests.
- [x] Add focused failing behavior tests for metadata suppression, completed reveal, layers and agenda controls.
- [x] Implement the reviewed scene-first layout without changing date/drag/preview semantics.
- [x] Pass related task/calendar tests and preserve previous task views.

### Task 3: Focus and anniversaries

**Files:** ToDooFocus.vue, ToDooFocusTimerFields.vue, to-doo-focus.css, anniversary template in ToDooRhythm.vue, focused tests.
- [x] Add tests for settings/history access and meaningful calendar details.
- [x] Implement compact primary actions and optional secondary content without resetting any state.
- [x] Pass timer/history/draft/date tests.

### Task 4: Statistics, notifications and settings

**Files:** ToDooReview.vue, ToDooSettings.vue, dedicated page stylesheet/tests.
- [x] Test conditional range fields, non-conflicting empty states, notification actions and folded validation.
- [x] Implement reviewed information hierarchy and save/error-safe disclosures.
- [x] Pass period, reminder, preferences and recovery checks.

### Task 5: Integrate and deliver comparisons

- [x] Run relevant regression tests, typecheck/build and desktop/mobile checks.
- [x] Perform independent review and address material findings.
- [x] Capture after screenshots with the same fixture and generate labeled comparison sheets from originals.
- [x] Inspect final images and deliver comparison images with only necessary status text.
