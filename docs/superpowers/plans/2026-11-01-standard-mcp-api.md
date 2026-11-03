# Standard MCP API Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and superpowers:dispatching-parallel-agents for the disjoint transport and UI tasks. Steps use checkbox syntax for tracking.

**Goal:** Replace product-owned Tunnel integration with OAuth and individually authorized API Keys, with no legacy data migration.

**Architecture:** Both MCP endpoints run on the existing host HTTP server and share the plugin protocol handler. Host-owned API client and credential tables reuse platform grants and live permission checks. Network exposure belongs to external infrastructure.

**Tech Stack:** TypeScript, Fastify, SQLite, Vue 3, Ant Design Vue, MCP SDK, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-standard-mcp-api-design.md`; the user's 2026-11-01 execution instruction overrides migration requirements: remove legacy implementations without migrating old credentials/configuration.

## Global Constraints

- Preserve existing uncommitted work; use incremental edits in the current checkout. Do not deploy, restart host services, migrate or delete production data.
- Remove dedicated Tunnel listener, configuration, UI, REST/OpenAPI adapters and Bridge adoption code. Historical records may retain historical names.
- `/mcp` accepts OAuth only; `/mcp/api-key` accepts generated API Keys only. No authentication fallback.
- New config booleans `oauthEnabled` and `apiKeyEnabled` default true. Existing HTTPS requirements still determine OAuth readiness.
- Keys default to 90 days; custom `expiresAt` is an ISO timestamp, `null` means forever. Rotate immediately invalidates the previous key and preserves identity/grant.
- Tests use temporary data. Final checks: full Vitest, typecheck, build, and Playwright desktop/mobile suites, with failures investigated and reported.

## Review Focus

- Stale queued actors must fail after rotation, expiration, revocation or global invalidation.
- API clients must not access owner management routes or other owners' metadata.
- Disabled auth modes must not remain usable through queued grants or plugin re-enabling.
- Explicit reauthorization must preserve identity without reviving a manually revoked connection.
- Management responses, logs and portable exports must never disclose persisted complete keys.

## Shared Interfaces

`shared/mcp-api-contracts.ts` defines `McpApiClientView`:
`{ clientId, name, status: 'active'|'requires_reauthorization'|'revoked', version, grantVersion, permissionPolicy, effectivePolicy?, key: { id, suffix, version, createdAt, expiresAt: string|null, revokedAt: string|null, lastUsedAt: string|null }|null }`.

`apps/server/platform/mcp-api-keys.ts` exports:

- `listMcpApiClients(db, ownerId): McpApiClientView[]`.
- `createMcpApiClient(db, ownerId, {name, permissionPolicy, expiresAt?}): {client: McpApiClientView, key: string}`.
- `authenticateMcpApiKey(db, authorization: unknown): Principal` (401 on failure).
- `updateMcpApiClient(db, ownerId, clientId, {name, expectedVersion})`.
- `setMcpApiClientPermissions(db, ownerId, clientId, {permissionPolicy, expectedGrantVersion})`.
- `rotateMcpApiKey(db, ownerId, clientId, {expiresAt?, expectedVersion}): {client, key}`.
- `reauthorizeMcpApiClient(db, ownerId, clientId, {permissionPolicy, expiresAt?, expectedVersion, expectedGrantVersion}): {client, key}`.
- `revokeMcpApiClient(db, ownerId, clientId): {revoked: true}`.
- `registerMcpApiKeyRoutes(app, db)` registers GET/POST `/api/platform/mcp/api-clients`, PATCH `/:id`, PUT `/:id/permissions`, POST `/:id/rotate-key`, POST `/:id/reauthorize`, POST `/:id/revoke`.

All management operations use the host's existing owner session and CSRF hooks. The list response is `{items: McpApiClientView[]}`. No full key appears in views. `expectedVersion` is the client version and is required for mutations except revoke; `expectedGrantVersion` is required for permission changes and reauthorization.

`packages/core/auth/mcp-api-credentials.ts` owns credential schema and `mcpApiCredentialValid(db, principal): boolean`. Principal gains `credentialKind?: 'api-key'|'oauth'`, `credentialVersion?: number`; `credentialRef` is the API Key ID. No raw secret is placed in Principal.

Connection contract replaces `tunnel` with `apiKey`; connection attempts mode is `'oauth'|'api-key'`. API clients are managed using their dedicated API, leaving the connection state's `clients` array for OAuth grants only.

## Task 1 Host credential lifecycle and authorization (root)

- [x] Write real SQLite tests for create/authenticate, hashed storage, expiry, immutable grants on rotate, revoked grants, scope ceiling, owner isolation, reset/restore invalidation and explicit reauthorization; observe RED.
- [x] Implement credential storage and platform API client service with transactional lifecycle and owner/CSRF management routes. Initialize tables additively; do not read old Tunnel tables.
- [x] Wire API routes into `apps/server/app.ts`; update Principal and platform live validation; integrate generation invalidation without changing OAuth/Agent behavior.
- [x] Remove Tunnel authorization from `mcp-client-permissions.ts`; update domain permissions and credential tests; verify GREEN.

## Task 2 MCP transport and protocol cleanup (transport agent)

- [x] Replace legacy transport tests with real packaged MCP HTTP tests for both endpoints, cross-auth denial, discovery, allowed/denied tools, disabled modes and protocol methods; observe RED.
- [x] Rewrite `mcp-transport.ts` to use the existing app listener. API Key authentication uses `authenticateMcpApiKey`; OAuth verifier remains existing. Keep `start`, `close`, `connection`, `latestAttempt` API for the host.
- [x] Remove REST/OpenAPI branches and `mcp.compat` from the plugin; both entries invoke `mcp.oauth` with shared verified call context. Update manifest booleans and remove Tunnel fields.
- [x] Remove adoption implementation/script and obsolete migration tests; update plugin web connection status. Do not edit root-owned management/shared types or UI agent files.
- [x] Verify targeted transport/packaged tests. Report changes and evidence; do not commit other people's changes.

## Task 3 Connection UI and browser tests (UI agent)

- [x] Update unit/browser tests for API Key creation, expiry selection, one-time display, rename, permissions, rotate, revoke, reauthorization and stale save rejection; observe RED.
- [x] Replace Tunnel guide with generic connection information; implement API Key client management using the shared interfaces. Reuse `MCPDomainPermissions` and existing resource inventory.
- [x] Remove Tunnel config visibility and key generation branches from `PluginManager.vue`/`plugin-config.ts`. Keep OAuth connection/revocation UI and unrelated plugin drafts.
- [x] Update affected `tests/e2e/mcp*`, plugin draft/config and relevant unit tests. Coordinate shared fixture config changes through root.
- [x] Verify unit tests and relevant browser scenarios. Report changes/evidence; do not touch backend or commit others' changes.

## Task 4 Integration, documents and complete validation (root)

- [x] Update management aggregation, active documentation, shared test fixtures and remaining obsolete assumptions; remove active Tunnel references without rewriting historical records.
- [x] Revise spec to record removal of migration as the user's explicit override.
- [x] Run focused integration tests, `npm run typecheck`, `npm run build`, then full `npm test` and `npm run test:e2e` with durable logs.
- [x] Investigate failing behavior from evidence; add/fix regressions and repeat affected checks. Separate existing unrelated failures from this change.
- [x] Get an independent review of touched auth/transport/UI; fix significant findings, run relevant checks and inspect the final diff for secrets and unrelated edits.
- [x] Deliver exact changed paths and validation results, with any remaining gaps. No production deployment in this task.

Final evidence: `docs/验收记录/2026-11-01-standard-mcp-api.md`. MCP focused browser46/46, core unit97/97, build/typecheck pass. Full-browser raw1041pass/87fail/14skip;18 original failures cleared by targeted reruns,69 unclosed. No full-green claim or deployment.
