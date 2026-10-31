# Native operation core — phase 1

Implemented current-document single move/rename/copy and batch organization/undo with a shared final-source preview registry. Server snapshots bind original note ID/path/hash/mtime, source hash, normalized moves and complete note inventory. Browser PNG preparation persists immutable resources and actor-bound primary leases or embedded durable receipts. Prepared source anchors use actual asset directories. Original immutable source/PNG remain retained.

Organization jobs expose awaiting_preview and resume the same operation after all preparations. Need replies page at 20 with signed actor/policy/fixed-plan cursors; owner helper follows every page. Single move retains its request identity across preparation, refuses stale inventory, and reconstructs an outer receipt from the committed inner journal after restart. Folder undo includes only verified new preparation resources while preserving original identity/mtime/hash and complete remaining tree checks. Ordinary bound and unbound Excalidraw path fences rebase without rewriting unrelated code. Copy creates a new UUID; primary copies share verified immutable resources until edited; raw legacy copy becomes Markdown only after a final asset-anchored PNG is prepared.

Verification:
- `npx vitest run tests/diagram-operation-previews.test.ts tests/native-link-operation-plan.test.ts tests/document-copy.test.ts tests/diagram-lifecycle-relocation.test.ts tests/knowledge/move-conflicts.test.ts tests/organization-service.test.ts tests/organization-journal.test.ts tests/organization-references.test.ts tests/organization-restore.test.ts tests/mcp-organization.test.ts tests/mcp-organization-integration.test.ts`: 11 files, 147 tests passed, latest `.local/markdown-diagrams/native-core-commit-tests.log`.
- Native tests include actual child exit at publish/source_removed/metadata; all recover source and target with the original IDs and retained original resources.
- `npx vue-tsc --noEmit`: earlier own snapshots exit 0 (`native-types-final.log` / `native-types-freeze.log`). Latest shared-tree run reported external `tests/portable-owner-workflow.test.ts(269,108)` callback Promise<Database> versus Promise<void>; root notified for owner correction.
- `git diff --check`: clean.
- Root ran actual desktop copy ordinary and legacy-to-Markdown workflows (2/2); root owns UI and broader browser operation workflow. This subagent did not start a competing browser server because the shared cookie file needs serialization.

MCP integration delegated to portable_mcp: registry metadata/readSource(max 32768 internally, transport clamp 16384)/prepare and diagramOperationPreviewNeeds max20 are frozen. All read/prepare calls require the original actor/client, current scope, original baseline and source hash.

Not claimed by phase 1: renamed trash-folder restore still used its prior relative-reference refusal. Root requested a separate follow-on archived physical-tree snapshot/restore journal phase. No production library, service deployment or restart was performed. Full-suite freeze is root's final integration task while other agents continue editing.

## Phase 2 — archived restore and proof audit

Renamed trash-folder restore now prepares exact final snapshots for archived documents and active incoming native dependencies, and rewrites ordinary incoming links. Archived UUID/path/tree identity/inventory and original source hashes remain fixed. New PNG/source bytes stay private in dataRoot until every required snapshot is prepared. A durable folder_native_restore_plans journal stores before-images, after-images and publication inode evidence before touching the archived tree; current grants are rechecked before activation. Existing directory rename/metadata recovery completes only those fixed images. Original changed documents receive typed history through the shared operation-revisions helper.

Actual child process tests exit during archived-note replacement, live dependency replacement, directory rename and metadata transaction. Recovery preserves all original IDs, fixed source/PNG tuples and idempotent receipts. External content/mtime conflicts are preserved; private preparation corruption and invalid UTF-8 fail before activation. A copied interrupted restore can rebind inode evidence only through the existing verified backup restore boundary after matching every fixed before/after digest.

The registry now binds the original workspace root and library binding; replacement roots cannot reuse old leases. Expired snapshot IDs retain an explicit DIAGRAM_PREPARATION_EXPIRED outcome when a fresh fingerprint is created. Structured needs remain paginated for inactive archived documents. Historical v1 embedded consumption may use a complete typed reference inventory only after verifying the actual history file hash plus source and PNG asset IDs/hashes; this supports ordinary large Markdown without treating it as a small file.

Source-proof audit found and fixed two further concrete cases: a valid literal wiki label in a mindmap outline can be rewritten by the library reference engine, so any changed inline primary source now requires a final-source/PNG snapshot; and an inbound note changed after generic enumeration cannot attach a stale rewrite to a newer manifest baseline. Native rewrites carry their exact document hash/mtime, and archived restore captures active inventory before enumeration.

Verification:
- Final focused command in native-operation-core-commit-tests.log: eight test files, 109 tests passed.
- Fresh final registry/native/archive regressions: three files, 34 tests passed (includes expiry replacement); native-operation-core-final-regressions.log.
- History resource relocation plus lifecycle: 44/44 passed after the typed-history consumption guard change.
- `npx vue-tsc --noEmit`: exit 0 in native-operation-core-final-regressions-types.log. Earlier shared-tree type failures were in concurrently authored legacy-draft/history test files and were reported to their owners; no passing claim was made for those failed runs.
- Actual desktop TrashWorkspace workflow: 1/1 passed in 9.5 seconds against the frozen archive/history code; folder-restore-history-browser.log and screenshot/trace artifacts in folder-restore-history-browser/. Both archived and active outside final scenes were rendered by the browser before restored UUID activation; both resulting previews are ready.
- `git diff --check`: clean.

Commits so far: 80d187b (current operations); d80f7b5 (typed journal revisions). Parent owns actual move/copy/batch/trash UI integration, MCP preview transport, final full-suite freeze and independent review. No production data, deployment, existing service restart or mobile work was performed.

New follow-on requested by root after phase 2: allow ordinary live folder movement with shared retained resources, keeping delete/archive refusal strict. That work is not claimed by this phase; it requires explicit retained identity/path proof and current/trash/history/preparation coverage.

## Independent review fixes

- Archive authorization P1: reproduced the third-revalidation denial leaving a recoverable marker. Final actor, folder and active dependency grants now run in the same SQLite transaction before the restoring/committing marker. A denial leaves the archive trashed and cannot be activated by recovery.
- Archive full-tree P1: reproduced changing an untouched plain note / adding an extra Markdown file after directory rename. The journal now seals every original path, file digest and identity/mode/version plus the complete expected result. Recovery rejects both cases independently, keeps external bytes, and cannot index unplanned notes. Registered immutable resources are pinned by exact asset identity/path/hash so a controlled repair of the correct original bytes remains recoverable.
- Partially rewritten live documents remain behind a pending-folder read/write barrier. Startup and owner tree refresh finish only the frozen restore journal under an exclusive gate before opening a knowledge read lease. Ordinary write-intent startup recovery is unchanged when no folder restore is pending.
- Backup includes private diagram-operation-previews, folder-restores and the forthcoming note-restores materials; pending directory commits are rejected like pending organization commits. The actual backup/restore regression verifies prepared source/PNG bytes, original before-images, stable restored UUIDs and a ready fixed preview.
- Copy inline-primary P2: 975fe21 prepares final relocated source and PNG before first copy activation, retries the same key and leaves the original tuple unchanged.

Fresh archive P1 verification: six files / 66 tests passed (`archive-p1-commit-tests.log`), including ordinary file-intent recovery startup and independent ordinary-tree mutation cases; typecheck exit 0 (`archive-p1-commit-types.log`). Earlier six-file review bundle passed 68 checks. Copy 4/4 passed. The root final reviewer was asked to rerun the exact original repro scripts.

### Active outside after-image review completion

The remaining activation-boundary repro was reproduced: an active ordinary inbound note edited after the restored directory rename could previously bypass diagram-only checks. Final activation now verifies every changed active file's afterHash, owned publication inode/birthtime/mtime and mode, before any metadata activation and again before index enqueue. Both direct outside-content replacement and replacement with its exact original owned timestamp restored are covered by real child-process crashes; external bytes remain untouched and archived UUIDs stay inactive. Folder/lifecycle bundle passed 55 tests. The later frozen shared integration bundle (same production code) passed 172 tests and typecheck 0.

## Shared live folder movement — completed normal path

Published resources held by outside copies, typed history, current/trash/folder-trash links are retained at their exact original physical base, with canonical asset ID, digest and file evidence. Reference planning carries exact identity no-move exceptions; note files and other resources move through the existing journal. Only the required asset-only source directories remain as explicit retention roots (no automatic GC). Delete/archive checks remain strict. Current native sources are newly prepared whenever keeping an old shared source base would otherwise change link meaning, even if the new source uploaded at its final base has identical bytes.

Undo reuses only the recorded original stub identity/catalog ID and complete fixed output inventory. An added user note or changed retained bytes/catalog identity conflicts and remains untouched. Native inverse preparation uses the same complete move map; an exact previously published after-image may reuse only its fully matching retained source/render/PNG tuple and paths, with actual immutable hashes rechecked. No old PNG is rebound to a new tuple.

Final shared tests cover active outside copies and retained original bytes/IDs, normal undo, source/PG-safe internal native links, conflicting new user data in the stub, typed history restore then a complete portable archive download, protected changed-scene unpublished preparations, and a real metadata worker exit/recovery with one history record and stable identities. The single-note restore agent's exact outside archived-copy → source folder move → native/prose identity rebase → ready PNG case is green with this planner.

Frozen checks: `shared-retention-freeze-tests.log` — 10 files / 172 tests passed; `shared-retention-freeze-types.log` — vue-tsc exit 0. After adding the final real-worker shared regression without production changes, `tests/organization-retained-move.test.ts` passed 8/8. Source remains isolated from the original protected checkout; parent owns independent re-review and the full release matrix.
