# Native-source quarantine follow-up

Reproduced desktop integration failure in an isolated real organization service fixture: a published primary A whose immutable source was deleted blocked an independent legacy dependency B from reaching its fixed final-source preview with ORGANIZATION_FAILED. The underlying planner read every primary source, and the later organization/undo plan also attempted publication validation for wholly unchanged primary documents.

The fix captures complete syntax-level elements[].link strings in a server-generated published manifest, bound to source path/hash and the exact note publication hash/path. The existing native JSON scanner supplies the strings, including duplicate JSON keys; unknown metadata links are excluded by the same rewrite rules. Primary publication, fixed relocation, and legacy migration capture this proof from verified source bytes.

An unavailable/hash-conflicting primary can be quarantined only if its exact current publication has the proof, its main document and source base stay fixed, its Markdown stays byte-identical, and replaying every recorded native link under the proposed moves changes none. Organization and undo only create relocation publications for changed/moved main files. The migration preflight uses the same proof and still scans ordinary Markdown inbound references.

Missing-source target/main/source moves, missing older proof, native inbound migration, and Markdown inbound migration remain explicit conflicts. No proof is inferred from directory names, text summaries, missing data, or a PNG. Quarantined source bytes are never regenerated or changed; the original Markdown/PNG remain unchanged and resolve as stale/read-only. Unproven older corrupt/missing sources remain explicit refusal until their genuine source can be restored.

Regression coverage includes missing and conflicting sources, real organization final-source preview + commit + undo, exact unchanged Markdown/PNG, absent source staying absent, conflicting source bytes preserved, read-only/stale resource state, four affected/unproven conflicts, actual unrelated migration commit, three migration refusal variants, and duplicate JSON-key complete inventory.

Commands:
- RED: npx vitest run tests/native-link-operation-plan.test.ts -t 'unrelated published primary source is missing' -> original ORGANIZATION_FAILED instead of awaiting_preview.
- RED: missing target/main/source/unproven cases -> original generic HttpError/ENOENT instead of DIAGRAM_SOURCE_CONFLICT.
- GREEN focused full file: 25/25.
- Lifecycle verification command and output: native-source-quarantine-tests.log (11 files).
- npx vue-tsc --noEmit -> exit 0, native-source-quarantine-types.log.
- git diff --check -> clean.

No browser launch, production data, deployment, service restart, or mobile changes. Root owns final integrated desktop rerun.


## Frozen independent review

Runtime commit `091a5a36a652b4258d730afbcfa573fd35cc9bca` reviewed by a separate reviewer: PASS, no actionable findings. Independent planner file rerun: 25/25 passed; additional read-only assertions covered relative/encoded paths and suffixes, UUID/API references, passive external links and source-base binding. Organization inventory/coverage and migration Markdown inbound checks remain enforced. No browser or production state was touched by the reviewer.

Root owns final full-unit/browser verification. This scoped report is not a claim that a final desktop command has passed.
