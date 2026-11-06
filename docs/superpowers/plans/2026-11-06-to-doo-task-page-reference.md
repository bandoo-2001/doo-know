# ToDoo task page reference implementation

> **For agentic workers:** Apply executing-plans and verification-before-completion; keep all changes bounded to the task module.

**Goal:** Implement the supplied two-level task design using real data, preserving other pages and existing uncommitted work.

**Architecture:** Preserve the existing shared shell, navigation, task events and data contracts. Restyle the task list and goal overview with component-local selectors; load overview summary data in a dedicated component without changing the shared snapshot.

**Tech Stack:** Vue 3, existing Ant Design Vue controls, scoped CSS, Vitest and Playwright.

**Spec:** `docs/design/to-doo/layout-redesign-two-level-2026-11-04/01-overview.png` and task-list companion `02-tasks-list-v2.png`.

## Constraints

- Do not edit calendar, focus, habits, anniversaries, review, notifications or settings pages, shared style tokens, API contracts or stored data.
- Preserve all pre-existing changes; keep shared shell changes conditional on tasks/overview.
- Preserve filtering, sorting, completion confirmation, creation seeds and accessible controls.
- Keep existing rail/sidebar/header geometry; screenshot proportions adapt to the real application.

## Review focus

Narrow screens and long names; empty goals and no tasks; partial/paginated data; local dates and recurring actions; returning from task views to unrelated modules.

## Implementation

- [x] Capture baseline component/test state and compare live page with reference.
- [x] Restyle overview as summary strip, full-width today actions and a two-column goal grid, with accurate progress and actionable empty states.
- [x] Restyle only the list presentation: tab toolbar, quick capture below filters, selected rows and restrained grouping surfaces. Retain all existing mechanics.
- [x] Verify relevant component tests and typecheck; inspect desktop/mobile/light/dark in an isolated browser fixture.
- [x] Review the task-only diff and safe preview publication path; report exact verification and runtime status.

## Execution decisions

- Work in the existing feature checkout to preserve its uncommitted dependencies; snapshot touched files before editing. Do not commit or switch branches.
- The user explicitly requested implementation from the supplied design; proceed without another design approval round.


## Verification and delivery

- Task component baseline: 96 tests passed. Final targeted suite: 7 files, 104 tests passed.
- Typecheck passed; isolated frontend production build passed using the live `cdde12d` source plus only the task delta, with `VITE_DOCUMENT_EDITOR_ENABLED=1`.
- Browser regression: 36 desktop/mobile cases passed, followed by 10 final targeted cases after review fixes. These cover creation/list context, goal progress, keyboard operation, detail selection, narrow hierarchy indentation and shared shell boundaries.
- Review fixes: preserve subtask indentation at 320/390px; refresh running focus totals without reloading habits; reject stale hidden-summary replies; keep compiled dark-theme variables scoped to task pages.
- Strict CSS comparison: all 6,635 non-task rules unchanged, zero non-task additions/removals. Calendar/focus/settings source and backend/runtime payloads were preserved.
- Live read-only verification: 13 desktop/mobile/theme states, zero horizontal overflow, browser errors, failed requests or application write requests.
- Preview: `http://100.93.35.65:5180/?view=apps&app=to-doo&appSection=tasks`; the supplied 01 image is the adjacent `appSection=overview` route.
- Active frontend release: `/srv/stacks/knowledge/doo-know-preview/releases/tasks-redesign-20261106-2788c303`; previous releases retained, including original `/srv/stacks/knowledge/doo-know-preview/releases/notes-reference-cdde12d`.
- Existing preview service reused: user unit `doo-know-tailscale-preview.service`, user bandoo, port 5180. Only profile `applicationRoot`/`staticRoot` were changed. Data paths, credentials, backend, production service and the UI concept service were not changed.
- Rollback: stop only that preview unit, restore its previous mode-600 profile from the private task snapshot, and recreate the unit with the previous release's bundled node/manager and matching working directory. Task scripts under `.local/tasks-redesign-20261106/` record exact startup properties and verified manifests. Do not roll back or overwrite the data directory.
- No commit or branch switch performed; pre-existing uncommitted work retained. The preview account remains empty; populated scenarios were tested only in an isolated fixture.


## Detailed reference and Ant Design Vue follow-up

- Verified actual Ant Design Vue 4.2.6 imports and browser-rendered components. The task module already used Button, Checkbox, Input, Segmented, Dropdown/Menu, Select/DatePicker wrappers. Added real Card, Progress, Tag and Empty to overview presentation, and Alert/Button to summary retry feedback; native semantic layout and project SVG icons remain appropriate.
- Scoped font-synthesis:weight to task pages because installed CJK fonts have no bold face and the global default disables synthetic weights. Raised desktop headline to36px, section titles28px, task names20px, goal titles24px, summary values24px and primary action height46px; mobile sizes remain compact.
- Reworked goal header into icon/title/status grid with description spanning remaining width. Removed AntCard clearfix pseudo-elements only from goal cards to avoid extra flex gaps; restored inherited list-name sizing suppressed by legacy child rules.
- Calibrated task overview spacing against the reference with populated isolated data. Shared rail/header/sidebar dimensions remain platform defaults; no global navigation token changes.
- Final targeted104 tests passed, typecheck passed, and12 final desktop/mobile browser cases passed (including real AntDV DOM classes, accessible percentage, empty controls, keyboard operation, indentation and shell isolation).
- Final frontend release: `/srv/stacks/knowledge/doo-know-preview/releases/tasks-redesign-20261106-79d3fec7`. Previous release2788c303 retained. Online13-state verification reported zero errors, failed requests, application writes or overflow. All6,635 non-task CSS rules unchanged.
- Follow-up artifacts: `.local/tasks-antdv-20261106/`; screenshot data is fixture-only and was never written into the live account.


## Runtime conflict after follow-up verification

At2026-11-06 07:18 UTC, a final read-only status check found the preview directory/profile and both5180/5181 listeners removed; other previously running DooKnow release processes were also absent. The follow-up had already been deployed and verified at07:16 UTC. No removal of these deployment directories or unrelated services was performed by this task. Source, build proofs and screenshots remain in the checkout. The user was asked whether a parallel cleanup/migration is in progress; do not recreate deployment state until that is clarified. The previous “active release” records above are historical deployment/verification results, not the current service status.


## User-requested restart and state comparison

The user subsequently requested restart and another comparison. Restored only the latest archived task preview79d3fec7 and selected two-level concept gallery to5180/5181. The main/QA installations remain unstarted; source, original data and archives were preserved. Reused the archived current profile and restored its recorded vector-service runtime path. No new boot enablement was added.

Fresh verification: both services active and HTTP200;13 read-only live states with zero application writes;17 fixture states using byte-identical deployed frontend, covering actual selected overview, Next7days with task details, editing-footer visibility,390/320px light/dark, and reload persistence. No console exceptions, failed requests or horizontal overflow. Active-row tint and4px stripe verified, detail widths440px desktop/viewport width mobile. Source code was not changed in this restart turn.

Candid remaining visual differences from companion02: current list uses existing section grouping rather than date headings; task detail typography, description/property ordering and collapsible sections differ; shared navigation geometry intentionally follows the platform. These are visual differences, not failures demonstrated by the interaction checks. Restart proofs and screenshots are in `.local/tasks-restart-20261106/`.
