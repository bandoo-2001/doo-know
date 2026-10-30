# MCP tools extension implementation plan

**Goal:** Cover ALL existing knowledge, blog and To Doo business functionality with discoverable tools, compatible independent grants and reliable request recovery, as explicitly requested in the user's latest correction.

**Spec:** `docs/superpowers/specs/2026-10-29-mcp-tools-extension-design.md`.

**Architecture:** Optional typed domain ports behind the existing plugin SDK; named tool adapters reuse core services, shared entity/command schemas and existing receipts. New drafts use an explicit blog action. Existing HTTP transport remains stateless but active cancellation controllers are shared within a plugin activation and isolated by identity.

## Constraints

- Work on `txj/mcp-tools-extension` from `d67a166`, preserving the independent rc.51 release input.
- Preserve all old tools and grants; new blog draft editing, site management, sharing and integrations are explicit separate actions and do not widen existing connections.
- Do not expose web-owner recovery wrappers, SQL, machine paths, secrets or unrestricted application files.
- Keep request/response/instruction budgets; paginate catalogs and data. Use real temporary-library/SDK/HTTP tests.
- No actual deployment, user-data migration, automatic activation, publication or remote release.

## Parallel tasks and ownership

### 1. Knowledge lifecycle

- [x] Inventory every knowledge business route and add typed optional adapters for history/trash/folders/backlinks/collections/assets/documents/shares not already covered by existing tools.
- [x] Write failing authorization, cross-note revision, paging, CAS, idempotent replay and selected inactive-note tests.
- [x] Implement through existing snapshot/file-job/core services with bounded metadata and live scope checks.
- [x] Add named knowledge tool definitions and targeted SDK/integration tests; verify RED/GREEN.

### 2. Blog library and drafting

- [x] Inventory every blog business route; add independent draft/site-management capabilities and optional ports/tools for article/site/version/resource workflows.
- [x] Write failing grant-isolation, resource filtering, cursor, expected-version and no-publication/no-site-change tests.
- [x] Implement bounded adapters and narrow core draft authorizations, preserving current web behavior and public snapshots.
- [x] Extend actual grant/OAuth/editor tests and verify RED/GREEN.

### 3. Typed To Doo tools

- [x] Add create/update schemas for lists/goals, habits and anniversaries without defaulting omitted update fields.
- [x] Cover every existing command/entity plus imports/exports/attachments/calendars/feeds/reminders/devices/outcome-note workflows with named tools or explicitly discoverable typed commands.
- [x] Prove public-schema invocation, restricted lists/domains, CAS, duplicate IDs, replay and omitted-field preservation via real SDK/domain tests.
- [x] Keep all current nine task tools compatible; verify RED/GREEN and complete discovery budgets.

### 4. Shared integration and HTTP lifecycle

- [x] Integrate optional SDK services, host capability/version declarations, manifest and full catalog/error schemas.
- [x] Add shared opaque, bounded and principal/client/resource-bound upload/download sessions for large attachments and document/import/export payloads.
- [x] Add task-specific bounded error field paths and actionable version/unknown-outcome recovery using the original task receipt identity.
- [x] Add real HTTP cancellation RED test; isolate active controllers by authenticated principal, client and RPC ID; clean up on completion/disposal.
- [x] Review combined discovery/OpenAPI/permission semantics and adapt fixtures to traverse complete catalogs.
- [x] Run unified tests, typecheck, build, browser permission checks; obtain independent review and record exact outcomes before local commit.

## Execution record

The user selected the three-domain expansion and blog drafts/publication scope, then explicitly requested full capability coverage. Routine adapter and schema decisions use the existing TypeScript architecture; service permissions remain explicit. Independent domain work is delegated; the controller owns shared SDK/host glue, common transfers, protocol lifecycle, coverage accounting, verification and final review. Detailed progress stays in `.local/mcp-tools-extension-20261029/`.

## 完成验收

最终统一单测：336 文件通过、1 文件条件跳过；2,245 项通过、1 项条件跳过，退出码 0。类型检查、构建通过；浏览器桌面33/手机33通过。博客R2、待办R2、共享框架R2、知识库R3独立复核全部闭环。完整证据见 `docs/验收记录/2026-10-29-mcp-full-coverage.md`。
