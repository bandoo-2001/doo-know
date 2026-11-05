# Task2 final visual fix round1 — two Important findings

Read the full `task-2-final-visual-code-review.md`. Main already contains these authorized edits; no stage/commit or Git operation was performed in this round. No PluginManager/ec86 source, other P/setup/GitRoot/ref file, server contract or storage coordinator was changed. Original ten-file final-visual patch, manifest, reports and all prior failures remain unchanged.

## Artifacts and exact scope

- `task-2-final-visual-fix-1.patch`: incremental against the original ten-file final SHA256 values, four paths only:
  - `apps/web/diagrams/mindmap.ts`;
  - `apps/web/components/Workspace.vue`;
  - `tests/e2e/platform-native-visual-regressions.spec.ts`;
  - new `tests/e2e/platform-creation-recovery-safety.spec.ts`.
- `task-2-final-visual-fix-1-manifest.json`: incremental before/after hashes, with the three existing starting hashes checked equal to the previous final manifest.
- `task-2-final-visual-fix-1-full-manifest.json`: full current eleven-file package, preserving original6b937 baseline hashes. Unchanged original-scope files were checked against their previous final hashes. Workspace's script is now explicitly marked changed for the authorized safety fix; it is not incorrectly labelled presentation-only/unchanged.
- Baselines: ignored `final-visual-fix-1-baseline/`. `patch --batch --dry-run --reverse --fuzz=0 -p1 < ...patch` succeeded on all four final files without modifying source/index.

Do not apply the incremental patch twice to current main. Delivery coordinator owns same-reviewer assessment, integration/freeze and affected runtime evidence.

## Important1: readable initial view for a large legal mindmap

Original round1 reproduction uses real UI/API flow at320×844: create a primary mindmap, replace its real managed source in full Markdown with24 nested ordinary child labels, save through the real renderer/prepare/commit pipeline, then enter live design mode. This is25 nodes/24 child levels, within the supported64-depth/500-node limits. The old whole-hull/min0.2 camera moved the root outside the actual canvas and failed the root-visibility assertion (`task-2-final-visual-fix-1-red.log`). No tree/text shortening, fake canvas or requirement that the entire tree fit on one phone screen was used.

The initial-fit decision now checks whether whole-tree fit would retain at least12px effective text while respecting existing zoom minimum. If it cannot, it leaves the library's readable root-centred initial camera intact instead of shrinking/centering the entire deep tree. Small overflowing trees still use the previously validated fit and wrapping; two-node long-name examples remain complete/readable. User gesture cancellation of delayed fit and subsequent pan/zoom retention remain unchanged.

The new actual large-tree test verifies visible readable root, readable topic font scale, user wheel-pan to the level24 label with full target bounds, retained user transform, exact labels/hierarchy count, unchanged server Markdown and byte-exact original Markdown download. It does not claim that all25/500 nodes are initially visible. Reader/PNG export function suffixes remain byte-identical; no content/export API was modified.

## Important2: unfinished creation cannot submit or race its enclosing form

Both existing recovery buttons are explicitly type=button. Restore, Cancel and manual Create share the existing synchronous createBusy guard; inboxBusy is also respected, and both recovery controls are disabled while that work is active. Finally releases the lock on either result.

The handlers capture original scope and frozen pending target before awaits. A different current descriptor (requestId/path/type/title/intentId/noteId) is rejected before an action. Resume also captures the form request identity/navigation intent before assigning UI results. Old-scope or superseded-form replies do not clear/open the new UI. This preserves the existing coordinator's request identity and server protocol.

A pointer can legitimately be absent after the existing coordinator published successfully and cleared it, but lost its last note read. An overstrict interim UI check blocked this reconciliation, so a real extra regression was added before relaxing only the absent-pointer condition. Existing different-pointer rejection remains. The retry uses the held frozen original target through the existing published-intent path and commits only once.

New real transport cases cover:

1. Slow undelivered DELETE: Cancel against an ordinary valid note-create form sends no POST /api/notes, sends one original-intent DELETE, disables Restore/Cancel/Create while held, then cancels the original intent, clears its local data and preserves the typed ordinary filename/form.
2. Slow original-intent GET during Resume: opposite Cancel and manual Create are disabled, no DELETE/reserve/new-note POST occurs, and one prepare/commit publishes exactly the original intent/path once.
3. DELETE lost before delivery: unlocks with exact original local pointer/IDB record and server reserved intent preserved.
4. DELETE committed but receipt lost: unlocks with exact original local pointer/IDB record preserved; fixture verifies server cancelled. This is preservation of unknown client evidence, not a false claim that a server-cancelled intent can be republished.
5. Published-intent last note-read loss: the original UI-held target can retry after its local pointer was legitimately cleared; opens the original note with only one commit.

No change was made to `primary-creation.ts`. Its existing cross-tab pointer-removal behavior and storage atomicity are unchanged/unverified, per root's explicit scope ruling. These same-window guards and UI-result ownership checks do not claim full-tab atomicity. Old data and immutable identity are not overwritten merely to clear an error.

## Actual RED/GREEN history and current checks

All server data belongs to the existing guarded temporary browser fixtures. No full suite/build or production-data operation was run.

- `task-2-final-visual-fix-1-red.log`:5/5 intended failures before changes. Actual extra ordinary-note POSTs were observed in cancellation cases; Restore's opposite Cancel stayed enabled; deep-chain root was offscreen.
- `task-2-final-visual-fix-1-green.log`:the five initial cases passed after first minimal guards/fallback,22.8s.
- `task-2-final-visual-fix-1-reconcile-red.log`:an initial extra-case setup failed on an ambiguous unscoped New Note button. Kept as a setup failure, not RED proof. Helper was scoped to the real Create/Import menu.
- `task-2-final-visual-fix-1-reconcile-red-2.log`:after real publish and a deliberately lost final note GET, retry was genuinely blocked by the interim missing-pointer check; original note editor did not open. This is the meaningful reconciliation RED.
- **Final combined actual browser:**

```sh
VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/platform-native-visual-regressions.spec.ts tests/e2e/platform-creation-recovery-safety.spec.ts tests/e2e/platform-shared-ui.spec.ts --project=desktop -g 'native canvas|long mindmap|deep legal mindmap|unfinished diagram locks|original intent locks|cancellation.*unlocks|published creation with a lost|native library controls remain usable' --output=.local/platform-ui-final-visual-fix-1-verified
```

Result14/14 passed,57.2s (`task-2-final-visual-fix-1-verified.log`): all five creation safety cases, original HEX320/390/short, original two-node long labels320/390/1440, the new deep tree, Find/library narrow/short and explicit short-library wheel scrolling.

- **Existing adapter:** Chinese edit/child composition/undo and500-node PNG bounds,2/2 passed,2.9s (`task-2-final-visual-fix-1-adapter.log`); uses its existing dedicated4196 harness, after main fixture run ended.
- **Related unit:** `npm test -- --maxWorkers=1 tests/diagram-save-dialog.test.ts tests/web-note-drafts.test.ts tests/diagram-draft-envelope.test.ts tests/editor-opaque-source.test.ts tests/mindmap-outline.test.ts tests/diagram-document-session.test.ts tests/workspace-save-recovery.test.ts tests/diagram-primary-creation.test.ts` →8 files/110 passed,5.79s (`task-2-final-visual-fix-1-unit.log`).
- **Typecheck:** `npm run typecheck` exit0 with no diagnostics (`task-2-final-visual-fix-1-typecheck.log`).

The Minor HEX no-popup layout-read suggestion is deliberately deferred: no measured performance regression evidence was supplied, so this round did not expand its observer/source scope. The existing per-frame coalescing remains.

Final live/deep-map and creation screenshots/trace artifacts are under `.local/platform-ui-final-visual-fix-1-verified/`; they are targeted modified-source evidence, not a substitute for the delivery coordinator's frozen final-source screenshots or independent review. Main app includes root's separate ec86 PluginManager correction outside this package; this actor did not edit or revert it.
