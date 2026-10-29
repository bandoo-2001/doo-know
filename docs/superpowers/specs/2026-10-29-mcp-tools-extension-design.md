# MCP domain tool extension

## Intent and approved scope

The user requested a further MCP improvement, selected knowledge/blog/To Doo tools and blog queries/drafts/publication, and then explicitly corrected the scope to **all existing business capabilities**, rather than a small common-tools iteration. This implementation covers the existing knowledge, blog and To Doo services and records every capability in a coverage matrix. Work starts from verified commit `d67a166` on `txj/mcp-tools-extension`; rc.51 packaging remains pinned to the previous verified commit in the separate release workspace.

## Approach

Use named tools with discoverable, strict schemas for common actions, calling the same host domain services used by the existing tools. Keep existing generic tools compatible. A generic-only extension would keep discovery smaller but retain the current opaque To Doo payload problem; clear named tools fit the user's selected goal. Shared schema factories and bounded standard discovery pages keep the larger catalog maintainable.

## Knowledge tools

- `list_note_revisions`: paginated, authorized revision metadata, without machine-local history paths.
- `read_note_revision`: explicit revision selection using the existing version-bound snapshot/page service and reading quotas.
- `restore_note_revision`: restore through the file-job service with current note version, stable request ID and normal asynchronous operation receipt.
- `list_archived_notes`: bounded, authorized single-note trash entries; omit unrelated hidden/inactive identities and application data.
- `restore_archived_note`: restore a specific archived identity with a stable request ID and optional safe file name, through the existing core restore service.

Complete the remaining existing knowledge workflows as well: backlinks; favorites/recent collections; note and folder lifecycle including folder trash/restore; managed attachments and diagram/whiteboard resources; note/document import/export and bounded file transfer; share status/create/rotate/revoke with a separate explicit sharing action. Reuse existing organization/search/index/read/write tools where they already cover a capability. Record which tools cover every current business route, rather than creating redundant wrappers. Global account, installation and host deployment APIs are not knowledge business APIs.

History reads require knowledge read permission; revision restoration also requires write. Trash listing requires read/archive; restoration also requires write. A selected inactive note grant must work for its own archive workflow without granting ordinary access to an unrelated new note at the same path. Resolve this in the lifecycle service, not by globally projecting inactive paths. Directory grants remain bounded to their current permitted paths. Do not call web-owner recovery wrappers or read arbitrary files directly.

## Blog tools

- `list_blog_posts`: bounded article summaries, search/state filtering and opaque continuation, excluding dashboard settings and unrestricted taxonomy.
- `get_blog_post`: management metadata and source version state; source bodies continue through authorized knowledge read tools.
- `create_blog_draft`: create a managed draft from an authorized note with a stable request ID.
- `update_blog_draft`: update article metadata using the expected article version; changes do not republish public snapshots.

Full coverage also includes site settings read/update, article deletion, taxonomy filtering, current/published version and resource/diagram workflows, and existing publish/withdraw actions. Separate draft editing from site management and public disclosure permissions. Site settings and deletion use explicit new management rights; publishing remains separately granted. Typed, bounded metadata is the default; large resource transfer is chunked and authorized by its associated article/source.

Add independent `blog:write` / draft-edit and `blog:manage` / site-management authorization. Existing read and publish grants do not acquire either. The permissions editor, OAuth, SDK and host all recognize the new explicit actions. Draft permission does not authorize site settings, article deletion, or public publication/withdrawal. Selected post/site resources and source-note read restrictions apply at invocation; site-wide operations require the site resource. Existing owner UI behavior remains compatible. Blog action receipts must remain queryable through the normal operation recovery path.

## To Doo tools

Cover every existing To Doo command and entity collection: lists/goals/sections/tags/views/templates; tasks and execution instances/recurrence; bulk/cascade and dependencies/planning/time blocks; focus; habits/check-ins; anniversaries; outcomes/evidence/records/reviews/statistics/settings; notifications/reminders; task attachments; JSON/CSV/ICS preview/apply/cancel/resume/export; external calendars and private feeds; and the recoverable outcome-note workflow. Use named tools or typed domain commands with public schema discovery where that avoids an excessively large catalog. Every currently allowed UI operation must be represented in the capability matrix.

Reuse the command engine and shared field schemas; do not duplicate business mutations. Update fields are optional without materializing create defaults into omitted patch values. Stable IDs, expected revisions, list/content-domain restrictions, note-reference permissions and duplicate-create protection remain enforced. Add explicit sharing/integration/device-management grants for operations that disclose data, connect external services or administer notification devices; existing task write permission does not silently gain them. Cross-domain note creation requires current knowledge write plus task access and does not call the web-owner privileged service as a shortcut.

Keep `manage_to_doo` for compatibility. Add precise recovery for task version conflicts, missing/invalid task fields and unknown write outcomes; unknown task writes use the To Doo receipt query with the original request ID, not a knowledge-only operation lookup.

## Supporting protocol work

Preserve 128 KiB requests, 64 KiB complete JSON-RPC frames and instructions at most 4096 UTF-8 bytes. New discovery remains paginated and every tool has complete input/output schemas. Version the MCP plugin and optional SDK services for hosts supporting the extension, keeping old plugins compatible.

Large attachments/imports/exports use opaque, owner/client/resource-bound transfer sessions with bounded chunks, declared length/hash, expiration, cleanup and idempotent finalization. User inputs never select filesystem paths. Transfers recheck current access, resource revision and request identity before committing. Browser/device enrollment still requires the browser's actual device permission; MCP exposes the corresponding authorized status/management operations rather than manufacturing a browser subscription.

A real HTTP cancellation notification currently reaches a different stateless SDK server instance from the active request. Correct it with an activation-scoped, authenticated principal/client/request-ID controller registry. Read cancellation reaches the active work; writers retain the existing receipt/unknown-outcome semantics. Different identities cannot cancel or replace each other's requests; completion and disposal clean up tracking.

## Acceptance

- Real SDK discovery exposes all new parameter schemas within frame budgets and old tools still work.
- A checked capability matrix covers all existing knowledge/blog/task business APIs and To Doo command actions; browser-only boundaries identify the corresponding MCP query/management path and the actual browser prerequisite.
- End-to-end knowledge history/trash workflows reject unauthorized revisions, unrelated IDs, path collisions and expired current versions, while repeated requests replay original receipts.
- Explicit draft editors can create/update only authorized articles; cannot publish, change site settings or delete articles without their separately defined capabilities.
- To Doo named tools preserve all existing runtime semantics, CAS checks, list/content boundaries, omitted fields and idempotency.
- HTTP cancellation is tested through actual local HTTP with identity isolation and no duplicate writer effects.
- Run focused RED/GREEN regressions, the unified unit suite, typecheck, build and relevant desktop/mobile permission flows; obtain independent review.

Only source code, tests and documentation are changed. No deployment, real-data mutation, automatic dependency activation, remote publication or inclusion in the in-progress rc.51 package is part of this iteration.
