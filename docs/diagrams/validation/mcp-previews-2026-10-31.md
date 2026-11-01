# Bounded MCP native preview preparation

Commit: `7b1b861334435950a9546799413616cddf7c36e4` — `feat(mcp): prepare native operation and private portable previews`.

Worktree: `/home/bandoo/.codex/worktrees/markdown-diagram-documents/doo-know`.

## Implemented transport

- Generic operation tools: `list_operation_diagram_previews`, `get_operation_diagram_preview`, `begin_operation_diagram_preview_upload`, `prepare_operation_diagram_preview`.
- Private portable tools: `list_portable_previews`, `get_portable_preview`, `begin_portable_preview_upload`, `prepare_portable_preview`, `cancel_portable_preview`.
- `resume_organization_operation` continues the original organization job after all fixed native previews are prepared. It requires current read/write/organize authority and passes a fresh authorization callback into the existing core service.
- Every source reply contains metadata and at most 16 KiB of exact Base64-encoded raw source bytes. Complete MCP text/structured duplication is measured; chunks shrink further if metadata needs the frame budget. No 8–10 MiB source is emitted in a frame or accepted as a substitute final source.
- PNG uploads are opaque actor/client/workspace-bound transfer sessions, with two distinct purpose bindings. Exact preview ID, final source hash, role and portable direction are checked before consumption. Payload SHA-256, `image/png`, the 10 MiB bound and core structural PNG validation all apply.
- Private export preparation retains `knowledge:read` authority and writes only private staging. Private import preparation rechecks the fixed target's current write authority in core. Cancellation authenticates the actor and calls the core's owned private-stage cleanup without requiring the now-revoked source/target grant.
- Generic and private metadata/source reads delegate to their authoritative registries and current root guards. No browser-owner principal, arbitrary source path or other actor's preparation is used.

## Error discovery and SDK behavior

SDK errors previously discarded `DIAGRAM_PREVIEW_REQUIRED` details. They now preserve a schema-validated first page containing only typed IDs, roles, directions and version hashes, plus the complete total count. Remaining IDs are available through the explicit paged tools. Source, renderer config, server paths and unknown fields are excluded from errors. Repeated SDK error annotation preserves the original total count.

The existing SDK operation schemas now accept `awaiting_preview` and retain the bounded `previewRequired` page instead of dropping it. Unknown preparation outcomes preserve the exact original request and opaque transfer. All new tools are registered through the shared MCP definitions and actual SDK discovery.

## Verification

`npx vitest run tests/mcp-operation-previews.test.ts tests/mcp-full-errors.test.ts tests/mcp-knowledge-sdk.test.ts tests/mcp-transfers.test.ts`: **28 passed**.

Coverage includes:

- An actual 8 MiB fixed native source with exact first/tail byte reads, 16 KiB maximum raw chunks and measured complete frame sizes.
- Generic PNG preparation and durable matching core receipt.
- All 41 generic pending needs and all 41 private preview IDs paged without truncation; permission-bound cursors.
- Foreign actors, revoked current path/scope rights, changed baseline, changed workspace, wrong-purpose/family handles and structurally invalid PNGs.
- Read-only private export preparation without increasing knowledge assets; import rejects missing write scope; cancellation reclaims owned staging after source grants are revoked.
- Actual MCP Client/Server/InMemoryTransport calls for both generic and private chunk/upload/prepare workflows.
- A real native-linked primary plus organization move, all fixed previews prepared through MCP, then original organization operation resumed to `succeeded`.
- RED → GREEN regression for the repeated-annotation bug that reduced `totalCount: 41` to `20`.

Server TypeScript and scoped whitespace checks pass. Typecheck evidence: `.local/markdown-diagrams/mcp-native-previews-typecheck.log`.

The parent separately owns the actual OAuth read-only original-export → preview → same-request export → opaque archive → new-grant whole import SDK roundtrip and reported it green. Core registry source readers/list/cancel/workspace guards remain in the native/portable core agents' commits; this commit contains only the nine owned MCP adapter/schema/SDK/test paths.

No full repository suite, browser lease, deployment, real knowledge-base operation or global install was run.

## Frozen-suite compatibility correction

Follow-up commit: `cf8994bbd35ce59b528bbe76463e9dfaa6f1a5d5` — `fix(mcp): retain legacy preview-required document references`.

The full frozen suite found a real regression in the SDK error sanitizer: it required every document reference to have a fixed `snapshotId`, although the existing primary-publication policy emits a note/role/hash tuple before any fixed operation snapshot exists. This removed `details.documents` from `get_knowledge_operation`.

The correction separates **error document references** from **fixed operation needs**. Error references require a valid note UUID and retain only valid optional role, document/source/render hashes, and snapshot UUID. Missing optional fields preserve the legacy need; invalid optional fields and unknown source/config/path values are omitted without dropping other valid notes. Known flat note-ID errors are normalized into a document reference. The first page remains at most 20 references, with the full count preserved across repeated SDK annotations. Fixed generic operation metadata/list schemas still require the complete tuple and `snapshotId`.

Verification:

- RED: the actual background-primary-title-patch producer plus four new compatibility/filter/frame regressions all failed before the correction.
- GREEN: the unchanged actual producer assertion plus all four new cases passed (5 passed; 10 unrelated entrance tests skipped).
- Focused helper/native-MCP/SDK-error regression suite: 18 passed.
- Server TypeScript and scoped whitespace checks passed.
- Evidence: `.local/markdown-diagrams/mcp-preview-required-{producer-test,compat-test,compat-typecheck}.log`.

Only `shared/mcp-preview-required.ts` and `tests/mcp-preview-required.test.ts` changed. The historical logical-path/WAL fixtures and other frozen-suite failures remain parent-owned; no full suite or 1,000-document archive test was rerun for this correction.
