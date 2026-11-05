# Task2 final visual fix round2 — monotonic reservation ID progress

Read the full `task-2-final-visual-rereview-1.md`. Scope is the sole new WS016 same-window ID-allocation finding. Main already contains the authorized changes; no stage/commit/Git command, other product polish, server/storage coordinator or cross-tab protocol edit occurred. Original fix1 and earlier patches/manifests/logs remain unchanged. Root's6504996 harness commit was not modified.

## Exact delta and artifacts

Only `apps/web/components/Workspace.vue` and existing `tests/e2e/platform-creation-recovery-safety.spec.ts` changed. The guard still requires exact requestId/path/type/title. Known intentId/noteId cannot change or disappear while a pointer exists; a previously absent ID can be filled by the current descriptor for that same immutable target. The missing-pointer branch used by the existing published-intent coordinator retry remains intact.

Before invoking the existing coordinator, actions retain the verified target in UI state. On owned failure callbacks, UI progress is refreshed only if it still passes that same monotonic guard. A replacement is never promoted by the catch path. Busy/inbox exclusion, type=button, captured owner scope/form/navigation identity, failure unlock and normal submit behavior are unchanged from accepted fix1.

Artifacts in this ledger:

- `task-2-final-visual-fix-2.patch`: incremental two-file patch against fix1 final SHA256, not a replacement original patch.
- `task-2-final-visual-fix-2-manifest.json`: exact incremental baseline/final hashes, checked against fix1.
- `task-2-final-visual-fix-2-full-manifest.json`: refreshed complete eleven-file package. All other nine package paths were checked byte-identical to fix1 final hashes.
- Starting files retained under `final-visual-fix-2-baseline/`.

Non-Git reverse `patch --batch --dry-run --reverse --fuzz=0 -p1` succeeded for both files. Do not apply this patch twice to the already-edited main tree. Same-reviewer acceptance/integration and final captures belong root/delivery coordinator.

## Real regression sequence

The fixture starts in one actual open New Whiteboard dialog. It really sends the initial reservation to the server, then loses only that response. It confirms the client descriptor has requestId/path/type/title with no intentId/noteId. Without closing/reopening the dialog it clicks Resume. The real idempotent reservation succeeds using an identical request payload and acquires the same actual server IDs, then only that next prepare transport fails. It confirms the descriptor and real IDB draft now hold those IDs while keeping the same immutable tuple.

Two variants then continue in that unchanged window:

- Resume: publishes the original note/path once, only one commit, no extra ordinary-note POST, and no third reservation. The two original reservation bodies are exactly equal.
- Cancel: sends one DELETE to the actual allocated intent, clears that own pending/draft after success, keeps the form/filename, and sends no commit/ordinary-note POST/third reservation.

Both genuinely failed against unchanged fix1 after the same-target IDs were acquired (`task-2-final-visual-fix-2-red.log`:2 failures). A control using a different real reserved intent's IDs in a controlled corrupt client descriptor passed rejection. That control starts after the real ID progress, changes only already-allocated IDs while keeping the immutable tuple equal, and requires both Resume and Cancel to perform no diagram request, leave both server intents reserved, and retain the original draft. It prevents a loose “allow any ID because the old UI was missing IDs” fix. This is a client-boundary fixture, not fake business response/DOM or a new storage format.

## Actual verification

1. Original focused RED command selected the two progress variants and ID-replacement control:2 failed/1 passed,37.5s. Kept unchanged in `task-2-final-visual-fix-2-red.log`.
2. Final real browser command:

```sh
VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/platform-creation-recovery-safety.spec.ts --project=desktop --output=.local/platform-ui-final-visual-fix-2-green
```

Result8/8 passed,37.3s (`task-2-final-visual-fix-2-green.log`). This includes the previous slow Cancel/Resume/manual-create locks, no ghost note creation, failed/unknown cancellation data preservation, published-no-pointer last-read reconciliation with one commit, both new same-window progress continuations, and rejection of different allocated IDs. Existing strict temporary fixture/default4179/4180 lease only.
3. Related unit command:

```sh
npm test -- --maxWorkers=1 tests/workspace-save-recovery.test.ts tests/diagram-primary-creation.test.ts tests/diagram-draft-envelope.test.ts tests/diagram-document-session.test.ts tests/web-note-drafts.test.ts
```

Result5 files/82 tests passed,7.23s (`task-2-final-visual-fix-2-unit.log`).
4. `npm run typecheck` → exit0, no diagnostics (`task-2-final-visual-fix-2-typecheck.log`).

No full suite/build, unrelated native UI rerun or new source/runtime screenshot acceptance claim. Mindmap, native color, pure styles and export helpers are unchanged hashes and retain their separately recorded fix1 evidence. Cross-tab atomicity and the existing cancel coordinator's pointer behavior are unchanged/unverified boundaries; there is no new reserve/commit/cancel protocol or automatic recovery entry. Minor HEX layout-read work remains deferred as instructed.
