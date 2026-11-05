# Task 4 final short-screen fix round 1

Delivered a three-file increment relative to the **unchanged b453 final source package**, in `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know` on `txj/platform-public-feedback-fix`. HEAD remains `0a890634f37fdc56037426ca01f1a0b2a27ca82c`; main integrated the equivalent prior package as fc3fe4b. No main product changes, staging, commit, or rewriting of previous patch/report/history.

## Finding, cause and fix

Read the complete `shortFocusP2` definition and inspected both exact reviewed 360×460 dark / 844×390 PNGs. The finding concerns default focus/nearest scroll, not permanent inaccessibility.

The expanded save receipt was 321.58px high inside a real 336px owner scrollport at 360×460; the 844×390 scrollport is 266px high and template tiles are 188.59px high. The old helper only pushed fields upward to clear sticky actions, ignoring the owner/header top. No scroll amount can fit both oversized surfaces together.

- `apps/web/blog-savebar.ts`: measure the real scrolling owner bounds, current savebar and tallest actual form control. Keep sticky actions only when these fit with the existing clearance. Otherwise keep the complete receipt/actions in normal document flow, with ordinary field scroll margins. Protect both owner boundaries, observe size changes and restore local style variables/listeners on cleanup. No fixed viewport-height cutoff, hidden fields, truncated feedback or remount.
- `apps/web/blog-admin.css`: consume the local measured sticky/static position variable for Studio/settings savebars. Existing palette, layout hierarchy and normal-size styling stay intact.
- `tests/public-final/public-final.spec.ts`: append two real short-screen cases. Each uses an actual accepted PATCH with its response lost, actual account theme preferences, nearest native scroll/focus on three template buttons, three selects and the intro textarea, eight native Tab steps, live tall→short viewport remeasurement, iframe identity, retained draft, explicit existing reconcile action and one PATCH total. Added JSON/PNG evidence; no DOM or success-result fabrication.

A linked issue appeared during validation: disabling the submitted save button natively moves focus to body, so the initial normal-flow change could leave the expanded receipt below the viewport. A diagnostic RED recorded body active with the savebar at y1295.05–1616.63. The helper now retains the last focused save action while native disabling leaves body active; it scrolls the complete action surface into view when it fits. A different focus surface clears this remembered action; normal active-element/connected/inert guards remain. The helper never calls focus or changes business state. Final body-active receipt bounds are y70.05–391.63 inside the actual y56–392 scrollport.

No HTTP API, UUID, CAS, pending receipt, save/retry, async ownership, draft, brand/font/width/template, editor or preview protocol was changed. All seven other original b453 files match their original manifest hashes.

## Actual RED and intermediate receipts

Logs and evidence are in the independent tree `.local/public-short-fix/` and hashed in the manifest.

- `red.log`: **2 expected failures** on actual template centerHit=false at 360×460 and 844×390 before product edits. Initial automated RED used light theme; the reviewed dark 360 before PNG is separately preserved by reference/hash.
- `green-1.log`: 844 passed; 360 failed the full feedback-visibility assertion after switching to flow.
- `green-2.log`: 2 passed before adding further live-resize assertions/diagnostics.
- `short-final.log`: fresh run exposed the 360 feedback-reveal race; 844 passed. It failed at feedback visibility, not the new resize assertions.
- `reveal-diagnostic.log`: the 360 race reproduced with body active and actual offscreen bar/alert JSON plus PNG. This is the meaningful RED for the native-disable/body continuation.
- `short-final-2.log`: final source, **2 passed** including the native-disable/body path and live resize assertions.

No intermediate failed run has been replaced or described as a final pass.

## Final commands and results

All ran in the independent tree and were fully awaited with exit 0:

1. `npm run test:e2e -- --config=playwright.public-final.config.ts --project=desktop --grep 'short viewport' --output=.local/public-short-fix/short-final-2` — **2 passed, 12.5s**. Explicit real viewport 360×460 dark and 844×390 light; desktop project with native keyboard traversal, not a software keyboard simulation.
2. `npm run test:e2e -- --config=playwright.public-final.config.ts --project=desktop --project=phone320 --project=phone390 --grep-invert 'short viewport' --output=.local/public-short-fix/original-final-2` — **36 passed, 1.7m**, after the final helper change. Original guest document/source/CAS, unknown/CAS feedback, normal-screen focus/hit, iframe identity/sandbox cases remain closed.
3. `npm exec -- vitest run tests/blog-studio-workbench.test.ts tests/blog-workbench.test.ts tests/blog-studio.test.ts tests/blog-security.test.ts --maxWorkers=1` — **57 passed in four files, 6.87s** (`unit-final-2.log`).
4. `npm run typecheck` — **exit 0** (`typecheck-final-2.log`).
5. `git diff --check`, incremental patch reverse-application check — **exit 0**. Empty Git index, unchanged HEAD and no listeners on own 4779/4780 are recorded in `delivery-checks.json` and manifest.

Earlier 36/unit/type runs before the final body continuation are also retained; final receipts above supersede them. The only runner warnings are the retained FORCE_COLOR/NO_COLOR warnings.

## Actual visual evidence and package

18 final PNGs plus JSON sidecars are listed by absolute path, dimensions and SHA256 in `task-4-final-short-fix-1-manifest.json`. Actual field metrics: 360 template top/bottom 79.89/189.89, font/width selects 324.28/368.28; 844 template 79.77/268.36, intro textarea 177.25/298.25. All 14 target records have focused=true and centerHit=true. The owner bounds are recorded alongside each probe.

Author inspected the two original before PNGs and four representative final PNGs: 360 complete feedback, 360 font, 844 template and 844 intro. Full independent visual/code rereview and capture against integrated main remain with root/closeout; no reviewer acceptance is claimed here. Normal-flow feedback naturally scrolls away while editing earlier fields and remains fully reachable by ordinary scrolling; it is never hidden or dismissed to make the probe pass.

- Increment: `task-4-final-short-fix-1-patch`, SHA256 **193ba6ce204c2d1278efa7bcecc2e1310253671673fe16fdd6fe94c8d46a2271**.
- Manifest: `task-4-final-short-fix-1-manifest.json`, SHA256 **0914c805ec62054f49bd16d61ea8c457a33eb24c7972e282f74f5bf2acf585a3**.
- Baseline changed-file fingerprint: **eef99543208f7b1b33e3e8b11819add59eb8a19a2aa37aa738a1742ba055fe7c**.
- Final changed-file fingerprint: **2e653747e2b54e52e0e73d3d9a4b3a82d9a712366edd1b528c7f7389f5d4776d**. Exact algorithm and each baseline/final file hash are in the manifest.

No full test suite, production build/release, real preview account/data or new API/permission work. Existing 1100/375 overlay-preview E2Es and full-App global auth-modal behavior were not newly rerun this round; current original focus cases and short cases verify iframe identity, and original focus cases verify sandbox. All owned tool sessions and isolated servers have completed; main/capture/other agents' services were untouched. No Git write or remaining actor work is pending from this agent.
