# Semantic Knowledge Graph Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent model, engine and UI tasks. Root owns the shared contracts, runtime/routes, integration, evidence and final review.

**Goal:** Complete the automatic content-aware graph with local/model analysis, provenance, review, exploration and a calm UI.

**Architecture:** Independent graph analysis jobs and derived SQLite tables, portable user decisions, bounded provider adapters, progressive Vue UI. Keep the legacy graph API compatible.

**Tech stack:** TypeScript, SQLite, Fastify, Vue/Ant, Cytoscape, fetch, Vitest/Playwright.

**Spec:** docs/superpowers/specs/2026-10-29-semantic-knowledge-graph-design.md

## Global constraints

- Only work in `/home/bandoo/.codex/worktrees/knowledge-graph/doo-know`, base commit 412ce1e. Do not touch the original dirty checkout, deploy, install global components, or expose credentials.
- Shared API authority is `shared/graph-semantic-contracts.ts`; ask root about contract conflicts, do not silently invent a different shape.
- Workers own disjoint files. No independent commits while workers run. Tests must demonstrate meaningful red/green behavior.
- No model or token is preconfigured; local baseline works immediately, model enhancement is genuinely configurable and accurately labeled.
- All source-derived data is filtered and version fenced; manual decisions are portable. All operations have byte/time/count/queue bounds and observable failure/partial state.

## Task 1: Model configuration and adapters

Own `packages/core/graph/model.ts`, `packages/core/graph/model-*.ts`, `tests/graph-model.test.ts` only. Export `createGraphModel(config, db): GraphModelPort` from model.ts. Shared settings/extraction/answer types are fixed.

Defaults: provider none, baseUrl empty, model empty, automatic true, remoteContentAllowed false, timeoutMs 60000, maxInputCharacters 12000. Persist CAS version and encrypted/private credential, GET returns boolean only. Validate local HTTP loopback/LAN Ollama and HTTPS remote endpoints, deny credentials/query/fragment and redirects; token must not follow a host change. Only remoteContentAllowed permits sending note content off-loopback. Test uses synthetic text only. Expose sanitized failure codes. Ollama structured JSON and OpenAI-compatible structured response are strictly bounded, validated and tied to exact quotes in supplied text. Answers must cite only known context IDs. No automatic provider substitution or unannounced fallback to a different remote endpoint. Stable fingerprint excludes plaintext secret but changes for pipeline/config updates.

Write protocol fixture tests, actual red, implement, green; no real credentials or actual private-note network calls.

## Task 2: Persistent automatic graph engine

Own `packages/core/graph/analysis-*.ts`, `packages/core/graph/knowledge-*.ts`, `tests/graph-analysis.test.ts`, `tests/graph-knowledge.test.ts`. Do not modify legacy service/schema/contracts, routes/runtime or model/UI files. Export `createKnowledgeGraph(config, db, notes, model: GraphModelPort)` from `knowledge-service.ts`.

Methods: `start(): void`, `close(): Promise<void>`, `explore(p, query: GraphExploreQuery): Promise<GraphKnowledgeResponse>`, `status(p): GraphAnalysisStatus`, `control(p,{action:'pause'|'resume'|'retry'|'rebuild'|'cancel'}): GraphAnalysisStatus`, `review(p,{status?,limit?}): GraphReviewItem[]`, `userState(p): GraphUserState`, `command(p,input:GraphUserCommand):GraphUserState`, `questionContext(p,input:GraphQuestionInput):Promise<GraphEvidence[]>`. No direct model answers here; root will pass questionContext to model.answer and return known citations. You may add pure helper files under owned prefixes. Use an independent migrate schema and queue, leases/epoch/version fencing, startup automatic scheduling, database source-change triggers and controlled external-change compensation. Root will eagerly start this service and close before host DB.

Local analysis uses headings/tags/aliases plus body tokenization (Intl.Segmenter), representative terms and sentence co-occurrence, explicit method local. Do not pretend this is model entity reasoning. Model extraction augments with exact validated evidence, stable normalized entity IDs, candidate predicates and confidence. Full-source/chunk handling must be bounded and honestly report partial/failure. Prefer <=20MiB source platform ceiling with chunk limits; allow analysis progress across chunks, never silently call truncated body full.

Queries return notes and/or knowledge with derived mentions/cooccurs/model/similarity/manual edge types, source evidence, per-scope degrees and bounded topological communities. Similarity must be named term-based unless actually using embeddings. Keep exact source ACL (case-sensitive and v2 resources), source freshness, old-version removal and fail closed on maintenance/conflict. Scope filters before aggregates, recommendations, review and counts. Default 80 nodes/120 edges UI, maximum 1000/5000 API, path start/target BFS and one/two-hop. Decisions accept/ignore/reset/merge/alias/manual relation and named saved views must use portable knowledgeDataDomain with version/CAS and requestId idempotency; rejects survive rebuild.

Test automatic updates without browser refresh, deletes/restarts, invalid evidence, blocked/failed model, stale publication, restricted principal with shared entities, aliases/merge/rejection after rebuild, user-data migration/conflict, exact graph filters/paths, and bounded dense cases.

## Task 3: Calm full graph UI

Own `apps/web/graph-workbench.ts`, `apps/web/graph.css`, `apps/web/components/GraphWorkspace.vue`, `apps/web/components/graph/**`, `tests/graph-workbench.test.ts`. Do not modify shared contracts or host routes/runtime. Use the shared semantic contract and endpoints below.

- GET `/api/graph/explore` with encoded GraphExploreQuery; arrays comma-separated.
- GET `/api/graph/status`, GET/PUT `/api/graph/settings`, POST `/api/graph/settings/test`, POST `/api/graph/jobs` `{action}`.
- GET `/api/graph/review?status=suggested|accepted|ignored&limit=50`, GET `/api/graph/state`, POST `/api/graph/commands` GraphUserCommand, POST `/api/graph/ask` GraphQuestionInput.

Props tree and events back/open-note(id) remain. Use local model config, both providers, secret write-only, test connection, clear remote-content permission and collapsed advanced values. One toolbar/canvas; nodes/edges details only on selection, mobile drawers; no simultaneous card grid+canvas+empty inspector. Include type/filter popover, knowledge/notes views, graph/list mutually exclusive, path selection, evidence/open source line where possible, review/confirm/ignore/edit predicate, merge/alias/manual relations, pause/retry/rebuild/cancel status controls, named views, JSON/PNG exports and grounded question panel. Use SettingsOverlay and Ant; keep scale/positions on updates, labels and edges subdued unless active. Auto-update via bounded polling while active, no overlapping floods, visibility/unmount cleanup, stale request protection, clear missing-model vs baseline state. Preserve original source graph workbench API behavior where feasible or root will adapt legacy tests.

Write model tests red/green for API serialization, concurrent responses, polling disposal, selected details and versioned commands. Product UI must be functional, not static placeholders.

## Task 4: Root integration, docs and acceptance

Root owns thin semantic routes, eager runtime lifecycle, shared contract coordination, docs/research record, package dependencies only if required, API integration tests, desktop/mobile E2E and screenshots. Keep legacy graph API tests. Validate authenticated settings and mutations, safe source/provenance output, real background update, model fixture extraction and QA, source opening, portable review, saved views and exports, responsive clean screen. Run relevant Vitest, typecheck, build, isolated-port production/source browser tests. Independent full review and bounded fixes, then commit only this task's files and preserve branch/worktree.

## Review focus

1. A configured token must never be returned, logged, exported or sent to an endpoint changed without a new token.
2. A hidden source sharing an entity name cannot change the visible label, relation, confidence, description, review count or answer evidence.
3. A note modified/deleted/moved while a model call is in flight cannot publish or remain readable through old evidence.
4. Pausing/canceling or closing the service must abort model work and release leases; restart recovers interrupted work.
5. Manual acceptance/ignore/alias/merge survives rebuild and library migration, with CAS/idempotency and no silent conflict overwrite.
