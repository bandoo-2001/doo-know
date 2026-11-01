# Single-note trash native restore integration

The missing regular-note path now restores the same note UUID using captured archive-time stable references. The exact outside-copy case passes: Topic/board.md and its target move to 00-Inbox/NewTopic while copied.md remains archived outside that source folder and keeps historic shared Topic/assets; restore rewrites the retained source against the target's current UUID/path, obtains a new actor-bound fixed PNG preparation, publishes new immutable source/preview assets, and only then activates copied.md.

## Storage and boundaries

- Archive context lives in note_archive_contexts and a deterministic immutable history file. It reuses typed recordRevisionContext/captureRevisionReferences without adding an edit to visible revision history. Legacy backfill requires exact archive hash or published document hash plus recorded identity changes; insufficient native evidence conflicts.
- note_trash_restore_plans and dataRoot/note-restores hold the frozen after-image. The original trash byte file stays unchanged through preparation and committing recovery, and is cleaned only after successful activation.
- noteTrash is a server-derived inactive-note context for the existing generic operation-preview registry. Public inputs remain snapshot ID, source hash and PNG; callers cannot supply final source or host paths.
- Commit authorization checks token cutoff, original caller ceiling, current machine/OAuth policy, lifecycle identity grants, referenced target reads and root/workspace binding in the same immediate SQLite transaction as the durable committing marker.
- Journals retain source/preview hashes, UUID descriptors, preparation receipt hashes, private source modes, old resource signatures, published inode/mode/mtime/stamp evidence and after-image signature. Recovery reuses fixed bytes and refuses external changes or missing receipts.
- Raw .excalidraw restores stay raw legacy and retain type protection; primary Markdown, bound native groups, unbound v1 pairs, prose and own self-links are covered. Unchanged files above 20MB retain streaming archive/restore behavior; no new large-file editing path was added.
- Owner management restore propagates note-level DIAGRAM_PREVIEW_REQUIRED so its existing operation-preview workflow can prepare then retry the same batch request. MCP uses the existing generic actor-bound preparation tools.
- Backup retains note-restores via the native agent's retained-directory change, rejects a committing unresolved note journal, and successfully restores archived identity context at new host paths. No custom rebind of host paths is needed: trash files are freshly derived from UUID/current root and old archive host paths are never used for file access.

## Verification

- Original RED: regular core.restore silently activated a primary's retained old native target after the referenced target UUID had moved.
- Latest focused run: 3 files / 40 tests pass (29 new note cases, ordinary restore recovery and six existing real child crash stages).
- Earlier broader run: 8 files / 80 tests pass, with the exact shared-folder case temporarily skipped before its dependency landed. Native author then ran both full note-trash-native-restore and organization-retained-move files: 30/30 pass. Latest focused run includes the exact shared-folder case and all later cases.
- New child exits cover asset copy, asset link, main link, in-transaction activation, trash cleanup, completed receipt and unauthorized premarker intent. Postmarker conflicts cover source tamper, lost preparation receipt and a main-file mtime change; original trash stays preserved.
- Additional coverage: bound/unbound ordinary native pairs, raw legacy optional filename/type protection, primary and ordinary self-reference, source/PNG tamper, occupied destination, old published-hash backfill despite replacement at the old target path, third-phase grant revocation and root change, pending backup rejection and verified backup restore to new roots.
- vue-tsc rerun after archive hash hardening passed. The final rerun after the last main-file/cleanup proof check also passed. git diff --check passed.
- Latest full note-only run: 29/29 passed after the final main-file and cleanup proof check. Additional API regression: 67 passed and one no-library bootstrap test failed during eager organization-route registration in web-routes.ts, outside the owned restore changes. Root agent confirmed this is a task regression from eager organization-route registration and owns its lazy-provider fix; no clean baseline checkout was run by this agent.
- No browser lease, production service, mobile action or full suite was used.

## Coordination

native-link-plans.ts includes the native-operation agent's small existing-source-anchor semantic trigger in addition to the inactive-note options. That trigger ensures a fresh immutable source/PNG even if final-source bytes happen to match while the retained old anchor would resolve links differently. Folder retention, directory journals and active dependencies remain owned by that agent.


## Independent final review follow-up

Three confirmed gaps in 8f4cec5 were reproduced with five new RED tests and fixed:

1. Unchanged primary/ordinary restores now use the same final cutoff, current-policy/original-ceiling, source-version and root check as transformed restores. A dedicated note_restore_commits row is written with the committing operation status in the same immediate transaction. Every finish/recovery branch requires this durable binding; a premarker ordinary intent remains inactive on repeated recovery. The ordinary crash fixture's durable-intent fault moved to the first copy boundary after the authorized marker; its six existing crash scenarios still pass.
2. Native asset temps are opened exclusively as mode 0600, and their owned inode/device/mode is recorded durably before descriptor-based streaming fills the file. Recovery rejects a changed mode or an equal-byte inode replacement at the copy-before-publication crash window. It never adopts an existing temporary inode or its current mode as ownership evidence. The native asset_copy child fault now triggers after fsync of the owned descriptor, preserving the same completed-copy/pre-publication window.
3. Optional filename restoration of a reference-free ordinary file above 20MB uses a complete bounded no-reference scan, then the unchanged streaming restore path. No large body edit or whole-body load was added.

Verification after these fixes: 35 note restore cases plus ordinary recovery and all six authorized ordinary child crash cases, 46/46 passed across three files. Five initial review reproductions were RED on 8f4cec5 and GREEN after the changes; an additional repeated-recovery premarker case also passed. Final typecheck passed (vue-tsc exit 0), and git diff --check passed before the follow-up commit. Existing unmarked interrupted restore intents conservatively require reconciliation rather than publication.


### Final captured-target closure check

The follow-up review found that an unchanged note still dropped captured target-read authorization when its transformed plan was undefined. The exact unchanged primary with a Topic/target.md node link reproduced RED when current write rights to 00-Inbox remained but Topic read access was removed immediately after write_intent insertion.

The preparation result now always carries a separate target UUID/path authorization closure, independently of whether any body/source rewrite is necessary. The common immediate commit transaction verifies each captured active identity/path and applies both current-policy and original-ceiling read checks. Its durable marker retains that closure, and recovery refuses target identity movement rather than publishing a stale fixed source. The denial leaves original trash bytes intact, and repeated recoveries cannot activate the denied intent. The complete reference-free >20MB fast path continues returning no transformed plan.

Verification: the new exact target-read revocation regression is GREEN; the final 36 note cases plus six ordinary child-crash cases passed (42/42); vue-tsc and git diff --check also passed before the narrow three-file follow-up commit.
