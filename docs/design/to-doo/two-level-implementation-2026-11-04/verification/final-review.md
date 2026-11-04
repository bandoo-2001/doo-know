# Whole-branch source/spec review

## Verdicts

- **Spec compliance: PASS for the reviewed implementation.** The shared module rail/context directory, validated contextual routes, controlled module interfaces, retained standalone navigation, scope-aware task filters, and shared form/detail geometry implement the approved design's functional structure. No additional actionable spec deviation was found.
- **Code quality: PASS.** No new confirmed defect found in this review. The three P2 issues from `shell-life-review.md` are resolved in the current source.
- These verdicts are source-review verdicts. Final real-browser interaction results and the 28-scene visual acceptance remain separate integration evidence; this review does not claim their pending runs passed.

## Findings

None requiring a code change.

## Verification of previous findings

1. **Calendar list scope retained:** `apps/web/components/ToDooWorkspace.vue:616` now merges the current selection for calendar/timeline directory navigation, including date/Today/view changes. Both directory instances use this handler. List and task-filter selection therefore survive these transitions, while changing to another module retains its existing navigation semantics. The hosted-navigation unit coverage includes a list-scoped calendar context change.
2. **Standalone secondary controls retained:** `apps/web/components/ToDooWorkspace.vue:137` resolves controlled context only under hosted navigation, and the module call sites at lines 1370, 1385, 1396, 1404 and 1415 pass `hostedNavigation` as the controlled-navigation flag. The existing local selectors remain available when no replacement directory exists.
3. **Mobile Focus internal links transfer focus:** `apps/web/components/to-doo/ToDooFocus.vue:93` captures whether the outgoing pane contains keyboard focus before the DOM update, then focuses the revealed pane after `nextTick`. Drawer-originated selection does not satisfy that containment check, preserving the shell's return-to-opener behavior.

## Review scope and checks

- Read the implementation plan, approved design README and scene specification, supplied full source/test diff against `5f45983`, and current implementations. Included the intentionally reused anniversary appearance and dismissible-hint changes.
- Traced `appPage` through parsing, URL writes, app navigation memory, workspace selection, browser-route application, and module context resolution. Invalid contexts fall back to their module default. Context-only navigation does not trigger the shell's date/list/task-filter reload watcher or discard Settings preference inputs.
- Checked removal of the moved settings/notification/habit/calendar controls in hosted mode, the list/board presentation switch, matrix scope directory, calendar-family scope merge, task extra-filter baselines, individual removal, clear and all-task actions, and cursor resets on changed queries.
- Checked notification status reconciliation, actual query status/search/date arguments, pagination reset and source-request invalidation; reminder actions and bulk-read continuation retain their existing dataset/idempotency protections.
- Checked that focus timer project selection remains independent of history filters and that context changes do not replace history synchronization logic. Habit history correction/undo and anniversary date calculation continue through their existing business helpers.
- Checked that the Settings content stays mounted across context changes, preserving preference/import state and existing preview/retry logic. Task drafts, subtree completion handling, outcome ownership and date/timezone logic are not replaced by the navigation changes.
- Checked modal body scrolling and sticky form actions, separate task-create footer with a real form association, responsive detail width, management container breakpoints and narrow Focus layout. Actual viewport geometry and keyboard behavior require the integration browser evidence mentioned above.

## Evidence

- `/tmp/todoo-two-level-unit-final.log`: **52 files, 682 tests passed**.
- `/tmp/todoo-two-level-types.log`: supplied successful `vue-tsc --noEmit` run; log contains no diagnostics.
- Reviewed new context/navigation/life/task coverage and the browser navigation/scene-capture checks. Did not rerun tests, start browser servers, modify product code, or delegate further work.
