# Blog production rollout and remaining regression repairs

> **For agentic workers:** Use systematic debugging, task-scoped implementation and independent review. User explicitly authorized resolving the three remaining anomalies and updating production after validation; no additional approval is pending.

**Goal:** Fix the crash recovery, containment and lifecycle test anomalies, validate the release candidate, then safely update the existing production DooKnow service with the completed blog.

**Architecture:** Preserve application behavior while making test fixtures own their ports and readiness signals and use internally coherent timing budgets. Prepare an immutable local release from reviewed code, snapshot the current installation/data, use the installation's existing update/rollback mechanism and verify actual service/API/UI health.

**Tech Stack:** TypeScript, Vitest, Fastify, Playwright, SQLite, systemd user service and native DooKnow release/update tooling.

## Constraints

- Preserve all existing/concurrent dirty work; never reset, stage or commit unrelated changes.
- Test fixes retain all business assertions and production security/timeout behavior.
- No production mutation before test fixes, blog regression checks and build verification pass.
- Inspect actual production configuration without printing secrets; use current authorized user and sudo -n only as needed.
- Back up consistent production data/config and preserve prior code and a tested recovery path before rollout.
- User authorized deployment of the new blog, not publication to a remote forge or broad feature rollout; construct the narrowest compatible candidate and record included code precisely.
- Do not alter blog public access settings, publish user articles, reset accounts or revoke user grants as a deployment shortcut.

## Tasks

- [ ] Crash fixture: child-owned kernel-selected port, exact-origin auth, diagnostic IPC and bounded ownership cleanup; original crash/replay/one-commit assertions pass under concurrent fixtures.
- [ ] Containment fixture: preserve all business and byte/HEAD assertions; align whole-test budget with three sequential 15 s job windows and provide stage diagnostics; normal targeted command passes.
- [ ] Lifecycle fixture: ownership-specific readiness and isolated port; preserve startup cancellation and cleanup/sibling invariants; ordinary Playwright defaults remain compatible.
- [ ] Independent review of the repairs; fix all material findings.
- [ ] Snapshot source, run repaired tests and blog/MCP suite, typecheck/build and actual desktop/mobile browser acceptance. Run consolidated checks in isolation to avoid shared caches/ports and collect accurate results.
- [ ] Inspect production unit/current release/profile/data/plugins/health and choose compatible local-release preparation path; record safe rollback and whether a data compatibility change is necessary.
- [ ] Prepare candidate without unrelated dirty changes, verify package manifests, fresh self-test and isolated restored-data preflight; retain prior release and consistent backup.
- [ ] Update authorized production service through supported tooling; verify systemd, health/version, authenticated blog UI, read-only public endpoints, retained data and logs. Roll back if service verification fails.
- [ ] Record deployment artifact, paths, version/source identity, validation and remaining limits in docs/验收记录/2026-10-29-blog-production-rollout.md.
