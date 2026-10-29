# Graph vector similarity implementation plan

> Use independent subagents for vector reading/math, graph integration, and real-model acceptance. Root owns shared contracts, routes, AntDV UI and final verification.

**Goal:** Replace lexical-only graph similarity with genuine note embedding cosine using the existing local BGE index.

**Spec:** docs/superpowers/specs/2026-10-30-graph-vector-similarity-design.md

## Constraints

- Work only in `/home/bandoo/.codex/worktrees/knowledge-graph/doo-know`, base 8126d74, current isolated branch. No live data, production services, model download, global installation or credential output.
- Reuse active published vectors. No implicit lexical similarity fallback or repeated embedding requests.
- Shared semantic DTO is `shared/graph-semantic-contracts.ts`; GraphKnowledgeEdge similarity metadata and GraphEvidence embedding method are authoritative.
- Default threshold 0.65, top 3 neighbors, finite/correctly sized current vectors only. Comparison/retrieval yields and budgets are observable. Preserve 80-node/120-edge calm AntDV display.
- Tests demonstrate actual red/green behavior; no independent commits while workers run.

## Task 1: Existing-vector adapter

Own `packages/core/graph/vector-similarity.ts`, `tests/graph-vector-similarity.test.ts`, optional `tests/support/graph-vector-fixture.ts` only. Export `createGraphVectorSimilarity(config,db)` and `GraphVectorSimilarityPlan`.

Interface: `status(p):GraphSimilarityStatus`, `prepare(p,query:GraphExploreQuery,seedNoteIds?:readonly string[]):Promise<GraphVectorSimilarityPlan>`, `assertFresh(p,plan):void`, `close():Promise<void>`. Plan fields: nodes:GraphKnowledgeNode[], edges:GraphKnowledgeEdge[], noteIds:string[], status:GraphSimilarityStatus, truncated:boolean; internal fence fields may be added. Do not expose vector/token payloads in DTOs.

Read desired space, active generation, current source/indexed hashes, active complete chunks, vector rows/points/cache as described in spec. Validate exact 512-d Float32 normalized data and complete nonoverlap coverage. Build normalized coverage-weighted note means; cosine/default threshold and per-note top3; select actual two-side chunk evidence. Candidate discovery must go outside seed lexical/link neighbors. Support note-focus and bounded 2-hop expansion, prioritize seeds/tail focus; global sampling/budgets explicitly truncated. Start with e.g. <=8192 note metadata candidates, <=32768 chunk vectors/64MiB reads, <=32 global seed notes and bounded topK comparisons; choose sensible stricter budgets when needed. Serialize/limit memory-heavy preparation, yield batches and reject/abort queued work at close. Include source/generation/space fences.

status is cheap metadata only, scoped before counts/revision; ready caches work without online runtime. Missing/partial/invalid status must be truthful. Do not edit shared contracts or existing FlatFileStore/worker.

## Task 2: Knowledge graph integration

Own `packages/core/graph/knowledge-service.ts`, updates to `tests/graph-knowledge.test.ts`, new `tests/graph-vector-integration.test.ts` only. Consume Task1 interface. Remove Jaccard construction entirely. Create adapter once, close it, add its principal-scoped revision to status.revision and expose status.similarity.

Only explore(includeSimilarity) awaits prepare; keep status/review/commands synchronous and cheap. Derive seed note IDs from current focus/lookup/canonical merges with metadata queries; render must accept a prepared plan without storing per-request mutable shared state. Load plan.noteIds as additional bounded sources, include plan note nodes even when no entity analysis exists if adapter has strong source validation, then add actual similarity edges. Apply folder/node/edge/focus/path filters and direct/two-hop semantics. Semantic threshold is independent of minConfidence, includeSuggested still only controls model suggestions. assertFresh before response plus existing graph fence.

Update old term-similarity expectations to no edge + explicit unconfigured status. Add genuine adapter-backed integration fixtures for no-shared-term focus neighbors, stale index change, vector status/revision refresh and ACL. Coordinate fixture setup with Task1, do not import another test file with registered tests.

## Task 3: Real BGE acceptance

Own `tests/graph-vector-real.test.ts`, optional backward-compatible test options in `tests/support/vector-runtime.ts` only. Reuse existing helper/runtime/FlatFileStore and actual model documents embeddings. Expose optional test paths via `DOOKNOW_TEST_VECTOR_PYTHON` and `DOOKNOW_TEST_MODEL_DIR` or helper options; preserve existing defaults. Root found read-only resources at original checkout `runtime/vector-service/.venv/bin/python` and `.local/models/bge-small-zh-v1.5` (full paths supplied in dispatch). No copies or installs.

Build only synthetic notes in tmpdir, embed through actual BGE documents protocol, publish valid chunks/current source metadata through FlatFileStore, then query complete graph. Show paraphrase pair scores above unrelated note with fixed assertions, and two-side provenance. Stop temporary runtime after indexing and confirm cached semantic similarity still works. Prove missing/unsupported state isn't called ready. Env absence can skip normally but root explicit real run must pass. Report measured fixed-corpus scores; do not choose thresholds dynamically in tests merely to force a pass.

## Task 4: Root routes, AntDV UI, docs and final acceptance

Add similarityThreshold query parsing/validation (0..1) and readable metadata. AntDV checkbox, optional threshold Slider and small state Alert; evidence labels embedding; edge detail shows cosine/space, no probability claim. Keep no new broad configuration surface and reuse Settings/Search preparation guidance. Update docs and API/E2E synthetic vector fixture as appropriate, run real BGE test with existing resources, relevant tests/typecheck/build and desktop/mobile acceptance; independent review, bounded fixes, local commit and preserve worktree.

## Execution result

All four tasks implemented and independently reviewed. Actual metadata bound is 2,048 notes, with explicit focus priority; undirected similarity degree is at most three. Fixed mixed reference/similarity two-hop discovery and automatic refresh for focused notes outside the metadata page, both with regression-first verification. Final graph tests: 136 passed, zero skipped with actual BGE resources; typecheck/build passed; desktop/mobile production workflows and affected final repeats passed. Preserve this branch/worktree without deployment. Detailed results and the independently reproduced baseline-only search test failure are recorded in `docs/验收记录/2026-10-30-graph-vector-similarity.md`.
