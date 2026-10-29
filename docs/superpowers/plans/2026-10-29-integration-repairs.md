# Three-feature integration repairs

**Goal:** Combine settings/data portability, To Doo, and domain permissions/library organization while fixing all six confirmed review findings.

**Architecture:** Preserve the current portable JSON/SQLite projection and To Doo transaction stores. Extend the host's domain permissions with the existing To Doo scope names and resource restrictions. Validate ownership and identity before any mutation; preserve archive identity and interrupt imported runtime records.

**Spec:** The six reproduced findings in this chat and the user's explicit instruction to repair them.

## Constraints

- Preserve original staged input and the two other workspaces; source snapshots and original index are retained in `.local/integration-fix-20261029`.
- No deployment, service restart, real-library migration, secret output, automatic dependency installation, or remote publication.
- Existing grants must not gain new permissions implicitly. To Doo permissions remain independent of knowledge and blog permissions.
- Root `_data` is reserved for application data; nested ordinary `_data` directories remain supported.
- Keep existing settings appearance and To Doo features; resolve conflicts by combining behavior, not dropping either side.

## Tasks

1. Add failing tests for duplicate-ID creation and outcome overwrites across MCP list restrictions; reject collisions before mutation and preserve idempotent receipt replay. Add focus export/import tests and normalize imported running sessions to interrupted records.
2. Add failing tests for portable archive identities across a fresh database, root `_data` reads/scans/organization, and undo after imported identity changes. Persist a portable tombstone marker, reserve the root data directory at the common path boundary, and reject identity changes before undo modifies files.
3. Resolve OAuth, grants, SDK/host, MCP tool and UI conflicts. Register To Doo as an implemented independent domain with existing `to-doo:read/write` scopes; enforce domain, owner, instance and list/content restrictions, and preserve legacy scope compatibility. Add integrated authorization tests for explicit grants, denials, and revocation.
4. Run the unified unit suite, typecheck, production build, and desktop/mobile checks for settings, permissions and To Doo; obtain an independent code review and fix actionable regressions. Record exact validation results and remaining external-device limitations.

## Verification focus

- Failed authorization and undo preflights leave both files and projections untouched.
- New content cannot inherit archived IDs, favorites, or references after migration.
- Scoped clients cannot overwrite or move objects outside their prior authorization.
- Existing grants stay unchanged until explicitly updated; knowledge/blog grants never imply task grants.
- Imported focus records cannot accumulate transfer/offline time or block a new session.
