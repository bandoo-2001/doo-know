# Task 4 final visual fix report

Scope: the three approved public/guest/blog P2 groups only. Worktree `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know`, branch `txj/platform-public-feedback-fix`, exact patch baseline `0a890634f37fdc56037426ca01f1a0b2a27ca82c`. No Git staging or commit. Main/capture product trees were not changed.

## Delivered changes

- `apps/web/components/PublicShareEditor.vue`: override inherited fixed reader-header height for this editor container so the real editable badge and toolbar have separate space at 320px. Script/template are byte-identical to baseline; actual document/source/CAS badge containment, hover and center hit are tested.
- `apps/web/blog-workbench.ts`: translate recognized network/timeout failures into Chinese text explicitly saying the operation outcome is unknown, edits remain, and the user must read/reconcile versions before deciding whether to save. CAS and other errors retain their existing messages. No request, UUID, pending receipt, CAS or async ownership changes.
- `apps/web/components/blog/BlogDesignStudio.vue` and `apps/web/components/BlogWorkspace.vue`: put loaded-form error feedback and existing explicit reconciliation READ actions in the respective sticky save zones. Preserve existing local draft/status, manual save guards, preview component identity and model actions.
- New `apps/web/blog-savebar.ts` and `apps/web/blog-admin.css`: measure each actual footer with ResizeObserver and set local form scroll clearance. For an already focused current-form control covered by that footer, adjust the containing scroll area by the actual covered distance. No focus stealing, root shell modification, iframe/editor remount, or model mutation.
- `tests/blog-studio-workbench.test.ts`, `tests/blog-workbench.test.ts`: meaningful retained-draft/unknown-outcome/single-write/reconcile-read units.
- New `playwright.public-final.config.ts` and `tests/public-final/public-final.spec.ts`: isolated real API fixtures on 4779/4780; real-origin mutation headers; 12 cases at each of 1440, 320 and 390px.

The exact ten-file manifest and patch preserve the old P/fix1 artifacts and history. Main selection/native changes are outside this baseline and must remain during integration.

## RED evidence

All logs below are in the independent worktree `.local/final-public-visual/` and are hashed in the manifest.

- `unit-red.log`: two new unknown-outcome units failed on raw `Failed to fetch` before the presenter change; 32 unrelated cases were intentionally skipped by the targeted filter.
- `browser-red.log`: first 320px run had nine failures and three passes. Seven genuine failures were the three guest frames and four error/CAS feedback frames. Two focus cases initially timed out on labels that did not match the rendered implicit selects; these were test prerequisites, not product regressions.
- The first sparse focus targets did not reproduce the reported coverage. The corrected dense native-control test uses ordinary nearest scrollIntoView/focus and real center hit. `focus-red.log`: all five form families then failed center hit before product fixes.
- No CSS mirror assertions or fake DOM/success screens were used. Unknown-write cases let the real server accept the request with route.fetch, then lose the response. Conflict cases perform actual competing API writes.

## Final verification receipts

All commands ran in the independent worktree and were fully awaited with exit 0.

1. `npm run test:e2e -- --config=playwright.public-final.config.ts --project=desktop --project=phone320 --project=phone390 --output=.local/final-public-visual/browser-final` — **36 passed**, 1.7m (`browser-final.log`).
2. `npm exec -- vitest run tests/blog-studio-workbench.test.ts tests/blog-workbench.test.ts tests/blog-studio.test.ts tests/blog-security.test.ts --maxWorkers=1` — **57 passed in four files**, 5.47s (`unit-final.log`).
3. `npm run typecheck` — **exit 0** (`typecheck-final.log`).
4. `DOOKNOW_E2E_WEB_PORT=4779 DOOKNOW_E2E_API_PORT=4780 VITE_DOCUMENT_EDITOR_ENABLED=true npm run test:e2e -- tests/e2e/blog-admin-preview.spec.ts --project=desktop --output=.local/final-public-visual/preview-preservation` — **2 passed**, 10.8s (`preview-preservation.log`). The first existing case verifies actual 1100/375 preview, sandbox without scripts, enlarged-preview Escape/backdrop/close focus restoration and no design writes; the second explicitly uses 390px and verifies long collection member identity/clicking.
5. `git diff --check` and patch reverse-application check — **exit 0**. Index remains empty and HEAD remains the exact baseline.

The 36 new cases cover guest document/source/real CAS, design and settings unknown/CAS outcomes with existing reconcile actions and no repeat UI write, and dense appearance/navigation/modules/collections/settings controls. Native field focus, viewport bounds, actual footer clearance and center hit are asserted. Studio iframe identity and sandbox are retained. Reconciliation READ semantics are verified by units; browser cases click the existing READ action and count writes, without claiming an additional explicit GET-response waiter.

## Artifacts and limits

- Patch: `task-4-final-visual-fix-patch`, SHA256 `b4536386d37bebb84c6c060e92c5cfd945f189367ffe240f2968d142c842d10a`.
- Manifest: `task-4-final-visual-fix-manifest.json`, SHA256 `81ed66d6d87419c4a8b60270f3113125c0e9f50723a97c89ea44056de16337bb`.
- Manifest includes exact source hashes, baseline, original relevant review evidence/hash, log hashes and 36 actual final PNG paths/hashes/dimensions. Screenshots are in the independent worktree `.local/final-public-visual/browser-final/`.
- Author inspected representative guest-source320, design-unknown320, navigation-focus320 and settings-conflict390 PNGs. Independent review of the full 36 PNGs and final integrated capture remains with root/closeout; this report does not claim that review passed.
- Existing unknown-outcome local dirty flags are preserved; the visible Chinese error explicitly avoids a definitive server success/failure conclusion. No automatic new save or UUID retry was added.
- No full test suite, production build/release, real account data, API/permission additions or deferred P3 work. E2E FORCE_COLOR/NO_COLOR warnings are retained in logs.
- Own 4779/4780 test servers have stopped, all owned tool sessions are complete. Root capture on 4479/4480 was left untouched. No remaining actor or Git write is pending from this agent.
