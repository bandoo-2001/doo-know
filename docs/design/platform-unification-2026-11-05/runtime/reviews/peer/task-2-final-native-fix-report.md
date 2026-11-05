# Task 2 final native/theme fix — bounded delivery

Completed the three approved P2 findings and the two explicitly allowed same-source P3 corrections in the isolated worktree `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know`, branch `txj/platform-final-native-fix`. Main, coordinator harness/docs, index and Git refs were not edited. No commit/stage was performed. Baseline commit is `a14936d225c5c5aa8b252b3571df93489607287e`. Final commit is intentionally absent; file hashes and patch fingerprint identify the final worktree below.

## Product scope

- `apps/web/calm.css`: existing `.toolbar .n-button:not(.n-button--primary-type)` now uses existing panel/border tokens instead of a hardcoded white surface. The only matching owner toolbar consumers are Workspace and DiagramDocumentWorkspace; NoteActions inherits the corrected surface. Existing `.shared-status` uses surface/muted tokens, so its small text remains readable in both themes. Native canvas/user colors and global palette are unchanged.
- `apps/web/whiteboards/viewport-popovers.ts`: the already-installed geometry/scroll adapter selects the actual native `input.color-picker-input` instead of just the translated canvas-background label. This covers background, stroke and fill HEX popovers through the same bounds, max-height and scroll behavior. No new listener, observer, vendor/state/API/controller change.
- `apps/web/whiteboards/whiteboards.css`: the body-portal `.excalidraw.excalidraw-modal-container .Modal.Dialog.ttd-dialog` consumes existing `--workspace-bottom-inset` through `bottom`. Its existing card overflow remains responsible for scrolling. No field, preview, close/insert action or vendor package was hidden/modified. This rule applies to the native Mermaid dialog from integrated canvases; other vendor modals/Find/library are untouched.
- `apps/web/components/Workspace.vue`: the existing note/folder helper paragraph is gated to note/folder kinds. Whiteboard/mindmap/flowchart retain their Markdown-document explanation without falling into the child-folder hint. Only one template condition changes; pending creation, busy guards, reserve/commit/CAS, epochs and actions remain unchanged.
- New `tests/e2e/platform-final-native-fix.spec.ts`: real fixture cookies, creation UI, source API reads, native rectangle drawing, actual HEX focus/typing and actual Mermaid insertion followed by the original manual-save command. No mock model, fake DOM, force click, shortened Mermaid example or server quota/permission bypass. Fixture share creation is restricted to the isolated temporary owner to show the existing shared-status strip.

The product patch is 14 insertions/7 deletions across four files. No mindmap fit/camera/content/export code, vendor dependency, source/save protocol, WS016 recovery implementation or unrelated product polish changed.

## RED → GREEN and retained intermediate results

1. Original independent evidence remains in main `docs/design/platform-unification-2026-11-05/runtime/2026-11-05-efe5d15-workspace-compact/390-dark-rich-editor.png`, `844-short-vendor-extra-stroke-color.png`, and `runtime/2026-11-05-efe5d15-workspace-final/{320,390}-light-vendor-extra-mermaid-dialog.png`, with original sidecars untouched. Reviewed the corresponding source and `workspace-final-integrated-review.json`/`whole-branch-interim.md` before editing.
2. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/red.log`: first real run. More icon failed at 1.2257404 contrast; Mermaid 320/390 failed the genuine scroll/bounds/hit assertion. Stroke initially timed out because the recipe omitted the vendor mobile Edit sheet. This setup error remains preserved, not counted as the intended geometry RED.
3. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/red-stroke.log`: corrected actual Edit prerequisite reached the stroke HEX and failed the intended nav/hit assertion.
4. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/green-1.log`: Mermaid 2/2 passed with the packaged Christmas example. Initial SVG criterion 4.5 was too strict for the unchanged light focus icon (4.252946); SVG marks are non-text UI controls, so this new criterion was corrected to 3:1. No existing text or button-label assertions were weakened. Stroke geometry passed, but the follow-up draw attempted while the native property sheet remained open and produced no rectangle; this test-precondition failure is retained. The final test instead creates/saves a real rectangle first, then edits that selected object in short landscape.
5. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/green-2.log`: original four real cases passed.
6. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-red.log`: replayed the exact final behavioral tests against the clean a14936 four-product-file snapshot inside this isolated tree (final source snapshots preserved, then restored). All four reached the intended RED: icon 1.2257404 < **3**, stroke x259.5/y342.890625/h28 behind navTop322 and centerHit=false; Mermaid 320 y808.78125/h35 and 390 y794.78125/h35 behind navTop776, centerHit=false. Thus the final icon test still rejects the original bug at the correct non-text criterion.
7. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/status-red.log`: optional P3 shared-strip draft used blue-soft/muted; real light text contrast was only4.430578 (dark5.368445). Kept this failed draft and changed only its background token to surface. `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-status.log` passes text **4.5** at light4.700593/dark6.139310. The more icon remains dark13.550649/light focused4.252946 against its actual rendered button surface.

All failure directories, traces and intermediate logs remain under `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix`. No original fail/PNG was replaced. Final tests persist JSON geometry, source scenes and color measurements alongside the screenshots.

## Final verification commands and outputs

All commands ran from `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know`; ports4971/4972, independent `.local` and fixture-owned temporary database/knowledge directory, separate Vite cache. Coordinator4861/4862 and main/capture ports were not used.

```sh
DOOKNOW_E2E_WEB_PORT=4971 DOOKNOW_E2E_API_PORT=4972 npx playwright test tests/e2e/platform-final-native-fix.spec.ts --project=desktop --output=.local/platform-final-native-fix/final-red-results
# exit1: intended four regression REDs against a14936 snapshot

DOOKNOW_E2E_WEB_PORT=4971 DOOKNOW_E2E_API_PORT=4972 npx playwright test tests/e2e/platform-final-native-fix.spec.ts tests/e2e/platform-native-visual-regressions.spec.ts tests/e2e/platform-shared-ui.spec.ts tests/e2e/platform-creation-recovery-safety.spec.ts --project=desktop --grep='more actions remain|stroke HEX|native Mermaid|native canvas background HEX|native canvas find and library|native library controls remain|unfinished|cancel|resume|creation' --output=.local/platform-final-native-fix/final-desktop-results
# exit0:17/17, including all8 existing WS016 safety cases

VITE_DOCUMENT_EDITOR_ENABLED=1 DOOKNOW_E2E_WEB_PORT=4971 DOOKNOW_E2E_API_PORT=4972 npx playwright test tests/e2e/platform-final-native-fix.spec.ts tests/e2e/platform-native-visual-regressions.spec.ts tests/e2e/platform-shared-ui.spec.ts --grep='more actions remain|stroke HEX|native Mermaid|native canvas background HEX|native canvas find and library|native library controls remain' --output=.local/platform-final-native-fix/final-rich-results
# exit0:18/18 (9desktop +9mobile), including original background HEX320/390/844,
# Find/library320/390/844 and short native library, with rich document editor enabled

VITE_DOCUMENT_EDITOR_ENABLED=1 DOOKNOW_E2E_WEB_PORT=4971 DOOKNOW_E2E_API_PORT=4972 npx playwright test tests/e2e/platform-final-native-fix.spec.ts --grep='more actions remain' --output=.local/platform-final-native-fix/final-status-results
# exit0:2/2 after the final P3 surface-token adjustment; desktop/mobile rich editor

npx vitest run tests/diagram-document-session.test.ts tests/diagram-save-policy.test.ts tests/diagram-primary-creation.test.ts --maxWorkers=1
# exit0:3files/21tests; .local/platform-final-native-fix/unit.log
npm run typecheck
# final exit0; .local/platform-final-native-fix/delivery-typecheck.log and status JSON

git diff --check
# exit0
git apply --check --reverse .superpowers/sdd/2026-11-05-platform-ui-implementation/task-2-final-native-fix.patch
# exit0: final files match the delivered patch; index untouched
```

The last product edit only changes shared-status surface background. The two affected theme/status cases were rerun after it; native geometry and eight recovery safety cases were not needlessly rerun. Node emitted existing NO_COLOR/FORCE_COLOR warnings during E2E; no test errors in final GREEN runs. No full npm test/E2E/build was run. Final typecheck was rerun after the final test changes and exited0. Fixture processes shut down;4971/4972 are free.

## Exact after-evidence for scoped visual review

The following are real screenshots, not synthetic replacement windows. Mobile-project PNGs use device scale3; geometry JSON uses CSS pixels. Desktop-project screenshots at the specified viewport are easiest to compare directly with original images.

| Original finding | Final evidence | Actual result |
| --- | --- | --- |
|390 dark rich-editor more + shared strip | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-status-results/platform-final-native-fix--13463-ght-note-and-diagram-chrome-desktop/dark-note-more.png` (+contrast JSONs) | More13.550649; strip6.139310; real note-action dialog opens |
|390 dark primary-diagram more | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-status-results/platform-final-native-fix--13463-ght-note-and-diagram-chrome-desktop/dark-diagram-more.png` | Real primary actions opens; same token skin; light counterpart in same dir |
|844×390 stroke HEX | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-rich-results/platform-final-native-fix--a94d0--saved-rectangle-in-844x390-desktop/stroke-hex-open.png` + `stroke-hex-open-geometry.json` | y266.890625/h28<nav322; centerHit=true; actual click/focus/typing |
|Sibling fill HEX / preserved background | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-rich-results/platform-final-native-fix--a94d0--saved-rectangle-in-844x390-desktop/fill-hex-open.png` + `saved-rectangle.json` | fill also y266.890625/h28; saved rectangle stroke#c92a2a/fill#d5eadc; canvas background unchanged |
|320 Mermaid Insert | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-rich-results/platform-final-native-fix--e6270-e-above-navigation-at-320px-desktop/mermaid-insert-scrolled.png` + geometry JSON | y733.78125/h35<nav776; centerHit=true; unforced click succeeds |
|390 Mermaid Insert | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-rich-results/platform-final-native-fix--0d0e2-e-above-navigation-at-390px-desktop/mermaid-insert-scrolled.png` + geometry JSON | same usable y733.78125/h35; centerHit=true |
|Actual insertion/manual save | `mermaid-inserted-saved.png` and `inserted-scene.json` in both Mermaid dirs | server-read scene contains >5elements and Christmas text after existing save command |
|P3 new whiteboard document hint | `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.local/platform-final-native-fix/final-status-results/platform-final-native-fix--13463-ght-note-and-diagram-chrome-desktop/new-whiteboard-document-form.png` | Markdown-document hint present; no child-folder hint. Same template condition covers mindmap/flowchart |

Mobile counterparts live in the same final-rich-results/final-status-results paths with `-mobile` suffix. All original three defects were visually compared against source screenshots, and after PNGs were inspected by the implementer. Independent code/visual review and integration/full release gates remain the parent/coordinator's responsibility; this report does not claim whole-branch acceptance. Out-of-scope P3 close-decision emphasis remains deferred. No new mindmap fit or orientation/camera change.

## Delivery identity

Full five-file patch: `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.superpowers/sdd/2026-11-05-platform-ui-implementation/task-2-final-native-fix.patch`

Four-product-file patch: `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.superpowers/sdd/2026-11-05-platform-ui-implementation/task-2-final-native-fix-product.patch`

Manifest (all baseline/final file SHA256, both patch hashes and evidence PNG/JSON SHA256): `/home/bandoo/.codex/worktrees/platform-final-native-fix/doo-know/.superpowers/sdd/2026-11-05-platform-ui-implementation/task-2-final-native-fix-manifest.json`.

Final product fingerprint SHA256: `22aac9b1c968f06a1c98fd5bc6f68f75f7be7485f0e395711350bb83b7d5357d`. Final five-file fingerprint: `48b9bb693219d2398dbaf3ca16ea06b3d04b4f26363cde9dcf7dc5f719553e9b`. Full patch SHA256: `986ae4776f9c123979b381b89a41612d653339fbe34fc9d6ac5359485acc490f`. No final Git commit was fabricated.

| File | Baseline SHA256 | Final SHA256 |
| --- | --- | --- |
| apps/web/calm.css | 21faacc1478a2735326693381219fa4279479128c1704c6c156faa90a4e28699 | 1b319212a8eb4415f9bad59d7728dd1d7a1993efd2419a63cf864da3a204f2f7 |
| apps/web/components/Workspace.vue | 55906c032cf658d625f2379812b42c6ca51338d588791fe9cde512b4d9dbb6ef | 190ffbefe00250dd5a4a18c8712748f97efb3eadeffad17ca18f6b17024d3967 |
| apps/web/whiteboards/viewport-popovers.ts | 19a23e8cf377db891991e493e2be9e594ee8da8c2305718a102c0842e4011c30 | ec15c3e5f7e0b58a54ba828cbca7f57db4f1da766230bb8d1d73d1d2f5f819ce |
| apps/web/whiteboards/whiteboards.css | fcccc17d1f6eb4dc9482f3a3042da6d2c2202bb67b4262781baf47ea521221d9 | 866d4dd195d940d35fbbc4223468392bcb3e711db93856e0f0df050fc9e7f3ed |
| tests/e2e/platform-final-native-fix.spec.ts | new file | d25b253ff3f54fe9652f5af97c5cc50a06c981bebc7f6bbd4e0b903993f365f1 |
