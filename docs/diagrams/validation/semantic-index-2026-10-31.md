# Independent semantic / portable MCP review

Reviewed task commits exactly:

- `4654623525d1d28aca811b060b95caa6edbed983`, parent `fe24474` (semantic projection).
- `97cb8eb04d237a8dd0e24c9635372e6334c408ab`, parent `4654623` (portable MCP adapter).

Read the approved design and completion plan Task 2/4, raw scan/inventory publication, original UTF-8 research citations, graph/model evidence/cache decisions, strict MCP transport/import receipts/paging/entitlement and old-bundle fixed binding gate. Necessary current shared media/portable integration was reference material; unrelated parent migration/history/media work was outside this review. No whole-suite claim.

## Reproduced findings and corrections

1. **P2 semantic classifier truncation** (`shared/diagram-text-projection.ts:21`, `packages/core/indexing/chunks.ts:54` in reviewed semantic commit). A valid diagram with YAML/frontmatter or blank-line prefix beyond 16 KiB enters ordinary indexing; the graph projection similarly returns unmasked machine metadata. A shorter non-ASCII YAML prefix can pass the character probe and fail the separate byte probe. Direct reproduction returned `{parser:'diagram',spans:undefined,machineInGraph:true}`. Corrected in `daca8f36851cbd8fa980740996c43fcc037571b1`: constant-memory incremental header probe with no prefix cutoff, shared in in-memory and streamed classification. Three long-header RED tests became GREEN; 2,197 delimiter combinations matched the existing full frontmatter/marker rules. Ordinary Markdown still avoids tokenization during classification.

2. **P1 media transfer survives current asset grant removal** (`apps/server/plugins/knowledge-tools.ts:269` in reviewed MCP commit). Under a directory grant, download an unreferenced valid WAV using an unrelated readable note. Tighten the principal to that note only. A fresh download rejects, but authorizing and reading the previous transfer still returns 8,192 bytes, because the stream gate checks note access and asset stamp/path without current asset entitlement. Reproduced with real `pluginRuntimeFixture`, direct runtime asset upload (no MCP upload receipt), port authorization and transfer store read. Reported directly to root and `portable_mcp`; owner added current entitlement plus parser-derived note-version/path reference proof and regressions. Independently inspected that owner diff; no new gap found in the examined correction. Owner owns its final commit/evidence.

3. **P2 legacy scene semantics regressed to raw JSON** (`packages/core/indexing/chunks.ts` ordinary fallback in reviewed semantic commit). All legacy JSON metadata/coordinates/files/base64 entered `content` and `embeddingInput`; there was no separate semantic embedding path. Existing `tests/whiteboards.test.ts:50` correctly failed; its semantic exclusion contract was not stale. Corrected in `9b72bbbd46d6ee8d9b9c919861babd76ecb40da7`: locate original `elements[n].text` string ranges lexically, honoring last duplicate keys and excluding deleted/non-text elements. Raw citations contain actual escaped inner JSON string slices with original UTF-8/line offsets; embeddings and text search use decoded labels. Literal SQL and post-recall checks use the same decoded semantics, so escaped Unicode remains searchable. Raw chunk ranges are independently bounded to 8 KiB, including six-byte JSON escapes; empty boards retain title/path search with a zero-length source anchor instead of fabricated text. Full legacy raw scanning remains capped at the existing 8 MiB bound and still writes the mandatory raw hash/size plus exact chunk inventory only after complete iteration.

4. **Derived cache upgrade required for corrections**. The original v1 marker would retain both raw legacy scene indexes and graph caches created through the long-header bypass. Production text chunker/checkpoint marker is now `semantic-spans-v2`; old v1 chunks are retired/requeued once, and subsequent current checkpoints remain unchanged. Graph projection marker is `diagram-spans-v2`; a specific v1 restart test failed RED before correction and now rebuilds while preserving the separate manual decision store. Research accepts original-range v1/v2 citations during transition. This is included in `9b72bbb`.

## Focused verification

- `.local/markdown-diagrams/semantic-classification-review-red.log`: long header regression RED (ASCII YAML, UTF-8 YAML, leading blank lines).
- `semantic-classification-boundary-final.log`: 25/25 passed after classifier correction; full-range, raw proof, citation and graph helper cases included.
- `legacy-semantic-review-existing-red.log`: existing legacy label-only expectation RED against raw JSON indexing.
- `legacy-semantic-review-escaped-red.log`: escaped Unicode/quotes/newlines plus scene metadata/base64 fixture RED before semantic correction.
- `legacy-semantic-byte-bound-red.log`: escaped raw citation budget regression RED.
- `legacy-semantic-upgrade-red.log`: prior semantic-v1 scene index remains active before upgrade correction.
- `legacy-semantic-empty-red.log`: empty scene title search regression RED.
- `legacy-semantic-focused-final.log`: **6 files / 43 tests passed**, including diagram projection (30), real legacy whiteboards, text search, MCP locations, index worker and collection text consumers.
- `legacy-semantic-memory-final.log`: real ordinary **20 MiB UTF-8 document passed** exact source coverage/token/range checks and **RSS increase <=64 MiB**, 46.69 seconds.
- `semantic-graph-v1-upgrade-red.log`: specific v1 graph restart RED (no new model extraction without version change).
- `semantic-graph-v1-upgrade-final.log`: **13/13 graph tests passed**, including actual model semantic input, evidence and preserved manual decisions.
- `legacy-semantic-typecheck-final.log`: final `npx tsc --noEmit -p tsconfig.server.json` exited 0, empty output.
- Exact owned-file cached diff check passed before committing.

No real knowledge base, services, deployment, broad directory/permission change, global installation or unrelated source edits. Full acceptance, integrated build/full tests and other domains remain parent-owned; these focused results do not establish total completion.
