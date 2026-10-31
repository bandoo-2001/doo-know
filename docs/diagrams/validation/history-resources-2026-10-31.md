# Historical resource identity and relocation completion

Scope: isolated managed worktree only. No real library migration, deployment, service restart, browser run, or full-suite run.

Implemented:

- Typed revision resources now retain their stable `assets.id` alongside the original logical path and fixed hash. A separate versioned `references_manifest` captures ordinary attachment IDs/hashes, linked-note IDs, native-source targets, and original source bases. Recording happens through the existing pre-path-change hook; organization journal capture can read exact committing asset destinations while the registry still names original paths.
- Restore resolves the actual current asset path by its retained ID and verifies original bytes with bounded hashing. It never infers that moving a main file moved its attachments. Linked notes and self links follow current note identities. Current note authority is checked before a destination's new path can enter restored text; failures expose only `FORBIDDEN_REFERENCE`.
- Older typed rows can recover IDs through exact organization file records (`id`, original path, original hash), and untyped diagram rows can recover an original logical context from the same UUID's exact document-hash publication recorded before the revision. Ordinary move and migration receipts also supply original-path evidence. Missing/tampered fixed source or PNG bytes produce an explicit integrity conflict.
- Primary historical restoration prepares the exact final source and PNG after identity relocation. Authoritative mindmap outlines retain their supported plain-text syntax; prose wiki links retain labels/navigation as ordinary Markdown links. Frontmatter, code examples, unknown JSON fields, and unrelated prose stay intact.
- Historical native groups in ordinary Markdown and diagram prose, including older unbound source/PNG pairs, use the shared fixed-preview registry. Changed scene bytes require a prepared final source/PNG tuple before activation. Unchanged scenes reuse the retained pair while relocating group source paths and code hashes. Small recovery, background submission preflight, and background execution use the same rules. Preview requirements occur before request receipt creation, so preparing and retrying the original request works.
- Large ordinary history transformations use byte-range edits over bounded reads. Reference-free 20 MiB history is never loaded as one history buffer/string. A final background integrity check rehashes the historical original before publication.

RED evidence:

- Real v1 → v2 → whole-folder organization move → target rename → historical restore initially failed with old-source 404s, incorrect tamper errors, and broken prose image/note paths.
- Truly untyped history without its write-intent association initially failed original-context restoration despite surviving exact publication proof.
- Ordinary generated groups and older unbound pairs initially activated without requesting updated native previews; historical diagram prose had the same omission.
- Historical mindmap source retained the old target spelling until the managed source was relocated separately from prose.
- Bounded syntax tests initially treated raw HTML/comment examples as links and mishandled bare-CR files.

Verification:

- Focused normal/history/migration/native/journal/backup group: 18 files / 114 tests passed. Commands and final smaller verification are reported to the parent with this commit.
- Dedicated real-operation cases cover moved v1 source and PNG, prose attachment identity, target rename, self links, unchanged-resource individual main-file moves, old context backfill, explicit missing evidence/tamper refusal, restricted restore authority, small/background native groups and unbound pairs, diagram-prose native groups, and authoritative mindmap relocation.
- Dedicated 20 MiB patch/capture/relocation/restore budget test observes zero history `readFileSync` calls and sync read buffers no larger than 64 KiB. Large ordinary reference transformations and native group replacement also execute through background jobs.
- Syntax regression covers LF, CRLF, and bare CR, preserving frontmatter, quoted code, raw HTML, and comments while editing only real destinations.
- Final post-guard focused subset: 7 files / 37 tests passed. Final `npm run typecheck` exited 0; staged diff check exited 0. An intermediate concurrent parent draft implementation briefly introduced errors outside the owned files; those were reported immediately and cleared before the final typecheck.

Explicit remaining limitations:

- An old row with neither an original logical context/publication receipt nor retained IDs/exact move evidence cannot reconstruct missing originals. It refuses with an explicit path/context/integrity error instead of guessing from the current document directory or finding an unrelated equal-hash asset. Old ordinary attachments without an original fixed hash or a validated journal before-image cannot be promoted into a complete relocation proof from current bytes alone.
- The bounded large-document parser limits reference-bearing units to 256 KiB and retained destination spans to 10,000. A relocation requiring unsupported/oversized context returns `REVISION_REFERENCE_CONTEXT_INCOMPLETE`; the 20 MiB reference-free streaming path remains supported.
- Browser preview collection is parent-owned. The parent is wiring the ordinary restore and primary-history planning requests through the existing preview-collection client. This backend never substitutes a fake PNG or activates changed native source without its prepared tuple.

Owned files: revision-context, revision-relocation, revision-identities, revision-native-restore, diagram-history-restore, narrow file-jobs/recovery changes, three focused test files, and this report. Organization journal/folder/preview-registry changes remain owned by the native-operation agent.

## Review follow-up: retained native source bases

The review reproduced an incorrect reuse decision when a note and its linked target move individually while the historical source stays in the old assets directory. Planned new source bytes can equal the original bytes even though those bytes resolve the wrong target at the retained asset's actual path.

The shared historical native helper now tests reuse at the actual retained source path. If mapped destinations require a change there, restoration prepares a new source/PNG at the planned upload base even when that final source text equals the original. This applies to bound groups, older unbound source/PNG pairs, and diagram-prose groups through the same helper.

RED: two actual organization regressions (small bound group and 2 MiB background unbound pair) restored without requesting the required preview. A whole-folder move control already passed and reused the correctly located original. GREEN: all 20 historical-resource integration cases pass; the restored native href resolves from its actual published source path to the current target UUID, new source/PNG paths match the verified prepared tuple, and the original source bytes remain unchanged. Focused follow-up validation: 8 files / 43 tests passed; `npm run typecheck` and diff checks exited 0. No browser or full suite run.
