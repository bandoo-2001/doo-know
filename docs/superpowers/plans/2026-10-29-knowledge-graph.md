# Knowledge Graph Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute independent core and UI tasks, with root-owned integration and final review.

**Goal:** Deliver a usable, permission-aware native knowledge graph for explicit Markdown/Wiki note references.

**Architecture:** Incrementally refreshed SQLite derived graph, bounded authenticated API, lazy Vue/Cytoscape workspace. Existing stable note identities and source boundaries remain authoritative.

**Tech stack:** TypeScript, better-sqlite3, Fastify, Vue 3, Cytoscape.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-knowledge-graph-design.md`.

## Global constraints

- Work only in `/home/bandoo/.codex/worktrees/knowledge-graph/doo-know`; original dirty checkout is preserved.
- No production services, actual notes, credentials, or external writes.
- Each implementer owns disjoint paths; root owns public registration, dependencies, browser tests and documentation.
- Write meaningful failing behavior tests first; verify failures before implementation.
- Do not commit independently while other workers are active. Root reviews and commits the graph change after validation.

## Task 1: Incremental graph core

Create `shared/graph-contracts.ts`, `packages/core/graph/schema.ts`, `packages/core/graph/service.ts`, `packages/core/graph/relations.ts`, `tests/knowledge-graph.test.ts`. The relations helper owns compact adjacency and batched exact graph calculations.

Expose `createGraphService(config, db, notes)` with `query(principal, input): Promise<KnowledgeGraphResponse>` and `close(): Promise<void>`. Shared contract names are `GraphQuery`, `GraphNode`, `GraphEdge`, `KnowledgeGraphResponse`. Query fields: folder?, q?, focus?, depth?: 1|2, mode?: all|orphans, limit?: number. Nodes: id/title/relativePath/directory/incoming/outgoing. Edges: id/source/target. Response: nodes/edges/totalNodes/totalEdges/truncated/focus? and index: scanned/indexed/skipped/pending/complete. Defaults: depth 1, limit 300; max output 1000 nodes and 5000 edges. Each round must have file/candidate/read budgets and continuation through pending state. Validate runtime input, not only TS types.

Use stable safe file reads, a source identity/version fingerprint and only active readable catalog rows; revalidate before publishing. Reuse existing Markdown link parser. Prefix policy, missing/unreadable source, conflict/writing state and unavailable root must never leak or publish stale edges. Rebuild only changed sources and resolve stored targets against current paths. Degrees and totals must use only authorized nodes. Parameter filters induce the displayed graph; orphans have no links within the selected scope. Focus expands undirected adjacency one/two hops while retaining directed edge arrows. Avoid running the text/vector worker and avoid copying its model dependencies.

Write tests, run red, implement, run green, report exact verification and limitations.

## Task 2: Graph workspace and request model

Create `apps/web/graph-workbench.ts`, `apps/web/components/GraphWorkspace.vue`, `apps/web/graph.css`, `tests/graph-workbench.test.ts`. Do not edit navigation, AppsWorkspace, Workspace, Icon, package files, API client or server integration.

Consume the exact Task 1 response contract (root coordinates). Component props: `tree: TreeEntry[]`; events: `back: []`, `open-note: [id: string]`. Keep filters and selection inside this read-only application. The model requests `/api/graph`, supports folder/q/mode/focus/depth, rejects stale responses, retains useful results on retry failure, and prevents infinite polling. Pending index batches may continue boundedly with progress and a manual refresh. Clear timers and listeners when unmounted.

Use existing components/styles where suitable, async-load Cytoscape within the graph application. Provide graph/list access, search input accessible name `搜索图谱笔记`, folder selector `图谱目录`, mode `仅显示孤立笔记`, graph region `笔记关系图`, refresh `刷新图谱`, selected node `笔记详情`, and action `打开原文`. Provide keyboard-capable list, selected details with incoming/outgoing links, local 1/2-hop controls, canvas zoom/fit, and responsive layout. No unsafe HTML or note body loading. Respect reduced motion and Vue disposal. Test model concurrency, params, retry/error and disposal.

## Task 3: Host integration and product acceptance (root)

Add Cytoscape dependency with locked version; wire graph runtime creation/close, thin authenticated `/api/graph` route, graph application card and lazy loading, route parsing/types in navigation/Workspace. Add graph icon if needed. Keep changes minimal around existing To Doo draft guards. Add API and navigation regressions and desktop/mobile Playwright cases. Document user workflow, partial-index limits and isolated development usage.

If another session occupies the standard browser ports, parameterize Web/API fixture ports and propagate origin through the runner, fixture and graph test. Preserve default ports and verify the production bundle and source proxy on isolated ports.

Run focused tests before broader affected regressions, `npm run typecheck`, `npm run build`, then browser acceptance. Review the complete graph diff with an independent reviewer, fix material findings, rerun affected checks, and commit only graph-owned files. Deliver worktree/branch and evidence; do not deploy or merge into original dirty checkout.
