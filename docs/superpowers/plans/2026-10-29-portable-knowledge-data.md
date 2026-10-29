# Portable knowledge data implementation plan

**Goal:** Keep favorites, built-in app publications and durable plugin data in knowledgeRoot/\_data so a fresh machine can rebuild local records by syncing the knowledge directory. Missing plugins/dependencies only produce informational status; no automatic installation or activation.

**Architecture:** Versioned JSON files are authoritative portable records; SQLite is the local projection and runtime store. Atomic writes and a SQLite outbox retain pending file writes, compare file digests and reject conflicting or malformed synchronized data. Library identity/favorite, blog and per-plugin domains share the storage primitive. Existing database data migrates on first use without deleting the original database. Credentials, sessions, local paths, installation/activation and temporary plugin state remain local.

**Tech stack:** TypeScript, node:fs, better-sqlite3, Vue, Vitest, Playwright.

**Spec:** User-approved design in this chat (2026-10-29).

## Constraints

- Preserve all pre-existing uncommitted UI edits; implement in this checkout so accepted changes remain present.
- No service deployment/restart or actual production data migration in this task; migration runs when the updated application binds/uses a library.
- Preserve existing authorization and source/publication checks; imported files never authorize code execution.
- Root \_data stays inaccessible through ordinary notes/assets APIs, search and document exports, and included in whole-library sync/backup.
- Missing or invalid dependencies are visible, never silently installed or started.

## Review focus

- Fresh DB with different owner ID must retain note identities, favorites, blog snapshots/resources and plugin user content.
- Malformed files, incompatible format, conflict copies, symlinks and write failures must preserve original data and fail visibly.
- Remote changes/removals cannot be overwritten by stale SQLite projections; pending local writes must survive restart.
- Moving/archiving notes and restoring backups must retain source association while respecting public withdrawal semantics.
- Syncing plugin metadata must never import executable code, secret references, lifecycle flags or machine paths.

## Tasks

- [x] Build and test safe atomic storage, version envelope, transactional dirty tracking/outbox and refresh/flush integration with workspace writes.
- [x] Persist and hydrate note identities and favorites across all discovery paths; exclude \_data from watchers/storage classification; test copy-to-fresh-machine, move and ownership mapping.
- [x] Persist and hydrate blog settings/posts/version snapshots/resources; test existing migration, fresh-machine import, edits/removals and backup withdrawal.
- [x] Persist portable plugin config/user storage, keep temporary storage and secrets local; surface unavailable requirements without auto install/activation; test absent package and loaded config paths.
- [x] Run targeted regression suites, typecheck and browser checks; review all changes; document portable layout and recovery behavior.

## Execution notes

Proceed within the user's explicit implementation authorization. Independent domains are delegated following dispatching-parallel-agents; shared storage and integration are implemented here. Do not commit unrelated dirty changes.

Review fixes: imported archive/restore now revokes shares; asynchronous plugin config checks source revision before commit; full backup restore rebinds/replays pending data before hydration. Malformed optional plugin data cannot block local disable/uninstall or unrelated note writes. Git exclusive snapshots discover note IDs before staging portable metadata. Plugin lifecycle authorization remains machine-local.

## Final verification

- Targeted final portability/plugin suites: 8 files, 71 tests passed.
- Repository-wide run: 259 suites passed, one skipped; 16 suites initially failed while source changes were still being compiled/cached. Those 16 suites were rerun against the frozen final code: 158 tests passed, zero failures. Existing navigation test harnesses were updated for the already-present search-matching dependency and expanded line-navigation arguments.
- Desktop and mobile browser dependency-hint checks: 2 passed; no installation/activation requests.
- vue-tsc, production Vite build, server TypeScript build, and git diff --check passed.
- No production service deployment or live knowledge-library migration was performed.
