# Diagram history/leave autosave race fix

**DONE, frozen commit `72781e2`.** Exactly three files: `DiagramDocumentWorkspace.vue`, `Workspace.vue`, and the new `tests/e2e/diagram-autosave-decision.spec.ts`. Runtime/tests remained untouched until root explicitly ended the full-unit freeze. No services, real knowledge bases, or original-project files were changed.

## Behavior

- Parent History/leave decisions pause automatic server saves for both full and embedded diagram workspaces. The component's own closing/discard decisions also pause automatic saves. The 150 ms local-draft writer continues, while both 1200 ms autosave and 300 ms save-followup scheduling honor the pause. Closing/cancelling the decision resumes normal autosave; explicit Save is allowed while automatic saves are paused.
- Concurrent `save()` calls now receive one complete `saveJob` covering the document session commit/proof, fresh note/resource reads, saved event, and preview asset refresh. Discard awaits that task before processing pending evidence or deleting a draft. Unresolved native commits still retain their exact pending request and cannot be silently discarded.
- The parent guard waits `settleSave()` before evaluating primary-diagram dirty state; it does not start a new save. This covers the period when the inner session is clean but its outer baseline/preview refresh is unfinished. Existing navigation-intent checks remain.
- Async refresh ownership is checked against disposal and session identity at each boundary. Preview assignment also checks captured note/resource references. Editor remounts do not invalidate valid saves. The initial candidate used editor `epoch`; independent review demonstrated that normal view changes also advance it. A real browser RED confirmed the resulting stale-parent `VERSION_CONFLICT`; the final code uses session identity only.
- History retains its existing disabled state while a save is busy. The exploratory test expecting it enabled was rejected as an expansion and was not promoted.

## Verification

RED evidence before runtime edits:

- `autosave-race-red.log`: holding History beyond 1200 ms actually caused native prepare/commit; Discard during controlled save produced the busy exception. Unknown-pending safety passed.
- `autosave-race-complete-red.log`: corrected controlled Discard still failed on the actual busy exception; a final-assets refresh gate demonstrated History prepare ran before the complete save settled.
- `autosave-view-red.log`: candidate editor-epoch ownership caused History restore `VERSION_CONFLICT` after a normal switch to Reading while fresh GET was gated. This was corrected before final freeze.

Final runtime verification:

- `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/diagram-autosave-decision.spec.ts tests/e2e/diagram-history-restore.spec.ts --project=desktop ...`: **6/6 passed**, 50.4 s, exit 0. Log: `autosave-decision-final-browser.log`.
- The five new browser cases cover decision dwell beyond debounce with durable draft and resume, Discard after an explicit manual save starts, exact unknown-pending protection, History waiting through the final resource refresh, and a normal view switch preserving the fresh parent baseline for subsequent History restore.
- Final `npx vue-tsc --noEmit`: **exit 0**, empty `autosave-decision-final-typecheck.log`.
- Related unit run: **9 files, 102 tests passed**, exit 0, `autosave-decision-unit.log`. This ran after the save/pause/guard implementation; the later single ownership predicate correction was verified by the final six browser tests and final typecheck.
- Exact staged diff inspection and `git diff --check` passed. Only the scoped three files were committed. Their working-tree state is clean; the exclusive browser server on 4179 has exited and the lease is released.

Root owns final independent review and the expanded full desktop suite (original 67 plus five new cases), unified type/build, and any decision about overall goal readiness. This scoped fix does not claim the remaining broad goal is complete.


## Independent final review

The actual frozen three-file commit `72781e254d10e2fb78112a2129df6a8132c85e27` passed independent review after the editor-epoch finding was corrected. The reviewer compiled both Vue SFCs and the new e2e TypeScript, checked the exact diff, and tested functions extracted from the actual frozen source for shared-save identity, normal view switching, disposed/replaced sessions, exact pending retention and parent guard settlement. No actionable findings remain. No browser or production state was touched by that reviewer. Root's final broad verification is recorded in the unified acceptance report.
