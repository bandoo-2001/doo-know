# ToDoo 两级菜单设计落地 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the file ownership below; user authorized continuous execution through push and preview.

**Goal:** Implement the approved 28 scenes with real controls, consistent two-level navigation, flexible content and usable 320/390px layouts.

**Architecture:** Reuse the host module rail and ToDoo business components. Add a validated `appPage` route selection for contextual entries; the workspace owns navigation and passes controlled context into modules. Shared CSS and form layouts provide common geometry; existing APIs and data contracts remain authoritative.

**Tech Stack:** Vue 3, TypeScript, Ant Design Vue, existing theme tokens and isolated Playwright fixtures.

**Spec:** `docs/design/to-doo/layout-redesign-two-level-2026-11-04/README.md`, `generation-plan.json`, approved images and user's 2026-11-04 requirements.

## Global Constraints

- Desktop module rail + contextual sidebar; primary and secondary current states agree with content. Notifications/settings at rail bottom.
- Preserve task drafts, subtree completion confirmation, filters/pagination, timezone/cross-day calendars, focus history sync, habit correction, import retries and reminder states.
- Do not hardcode concept data. Existing contracts decide field constraints and behavior.
- Preserve original checkout and all its uncommitted work. Isolated worktree carries the existing ToDoo polish as reviewed prerequisites; no unrelated files are integrated.
- Test data is temporary and isolated. Preview accounts/data retained; official service unchanged.
- 320/390px forms retain scrolling, focus and reachable footer buttons. Use drawer for contextual navigation.
- Commit/push the reviewed implementation branch; update immutable 5180 preview snapshot with existing explicit profile.

## Review Focus

- Route reload/back/forward must restore context and calendar date/view without resetting unsaved preferences.
- Contextual filter changes must retain query/pagination semantics and avoid stale notification responses.
- Mobile drawer and task detail must return keyboard focus and avoid outer overflow.
- Completed focus sessions and habit edits must retain history independent of timer project/date selection.
- Import progress/retry and notification status actions must remain operable after moving navigation.

## Shared interfaces

- `WorkspaceRoute.appPage?: string` is validated against per-section values in a shared navigation module; invalid values fall back to that module's default.
- Settings/Review/Rhythm/Focus receive optional `context?: string`, `contextualNavigation?: boolean`; emit `context-change: [value: string]`. Controlled mode is on in the actual workspace; standalone mode retains original local navigation for existing embedding.
- `ToDooNavigation` receives the resolved context and emits `context`; task/calendar callbacks remain existing events.
- Settings values: `preferences`, `connections`, `data`, `lists`; Focus: `projects`, `history`; Habits: `today`, `history`; Anniversaries: `all`, `upcoming`, `today`, `past`; Stats: `overview`, `goals`, `reviews`; Notifications: `all`, `unread`, `read`, `acknowledged`, `snoozed`, `dismissed`.

### Task 1: Shared shell and route state (root)

- [ ] Add behavioral unit coverage for context validation/defaults and route serialization.
- [ ] Implement shared context descriptor, route propagation and workspace controlled context. Always display module-specific context sidebar; calendars/matrix use their own labels.
- [ ] Remove duplicate task scope picker from ordinary task pages, retain useful scope metadata and extra filter controls in a compact aligned row. Keep range selector where timeline requires it.
- [ ] Set sidebar width 208px and rail 64px; readable flexible main, demand detail, mobile drawer. Test actual DOM geometry.

### Task 2: Management/review contexts (management agent)

**Files:** ToDooSettings.vue, ToDooReview.vue, optional dedicated `to-doo-management-layout.css`, focused tests.

- [ ] Inspect images 11–16,23,26,28 and current behavior.
- [ ] Adopt shared controlled context interface; hide moved settings/notification tab strips only in contextual mode. Notification query applies selected actual status. Stats entries scroll to real metric/goal/review sections.
- [ ] Improve card/form/notification geometry using shared variables, retain import preview/actions and unsaved preference guarding.
- [ ] Add relevant behavior tests; report changes and checks without running browser servers concurrently.

### Task 3: Focus and life contexts (life agent)

**Files:** ToDooRhythm.vue, ToDooFocus.vue, to-doo-focus.css, to-doo-anniversary.css, optional dedicated layout CSS, focused tests.

- [ ] Inspect images 08–10,19,20,22,27 and current behavior, preserve copied polish.
- [ ] Adopt controlled context interface for focus anchors/mobile panes, habit today/history and anniversary filter. Remove duplicate navigation in contextual mode; maintain independent timer/history filters.
- [ ] Preserve recording/correction modals and reachable actions; improve module geometry for available main width and 320/390px.
- [ ] Relevant unit checks; no concurrent browser server; report concerns.

### Task 4: Task/planning surfaces and shared windows (task agent)

**Files:** ToDooTaskViews.vue, ToDooCalendar.vue, ToDooTaskDetail.vue, ToDooEntityEditor.vue, ToDooOutcomeNote.vue, ToDooFormLayout.vue, to-doo-task-detail.css, optional dedicated CSS, focused tests.

- [ ] Inspect images 01–07,17,18,21,24,25 and common window structure.
- [ ] Match flexible list/board/matrix/calendar/timeline alignment; hide calendar view selector when parent owns contextual navigation (new optional `contextualNavigation` prop on Calendar, passed by root).
- [ ] Separate global/range/extra-filter empty states and working clear/filter/all-task actions. Preserve business state and form constraints.
- [ ] Common modal body scroll/sticky footer, task detail adaptive width; keep all eleven windows functional. Relevant unit checks and report.

### Task 5: Integration, real evidence and release (root + independent reviewer)

- [ ] Integrate modules, update existing E2E helpers to choose actual contextual controls, run scoped unit regression, typecheck and production build.
- [ ] New 28-scene real capture spec with identity/action assertions; desktop 1440 and mobile 320/390. Real interaction tests for context reload/history, task draft/filter, forms and data flows. Save screenshot index/mapping.
- [ ] Independent code and visual review; fix confirmed issues and rerun affected checks. Report actual failed commands/retries.
- [ ] Review staged prerequisites/source/design/acceptance only, scan for secrets, commit/push branch. Update immutable preview release using existing account/data/profile, validate health/login/read-only UI, leave official service unchanged.
