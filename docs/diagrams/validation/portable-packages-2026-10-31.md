# Portable review fixes (2026-10-31)

Commit: `2ab2664` — `fix(portable): roundtrip full packages within staging and preserve navigation` (12 explicitly owned files). Addresses the independently reproduced P1 staging roundtrip and P2 passive navigation findings in `14cbf39`.

## P1 — supported large package roundtrip

The original 2 × 126 MiB incompressible WAV package produces an approximately 252 MiB archive. Keeping that valid receipt and a 252 MiB extraction fits the agreed 512 MiB budget, but the old importer additionally reserved/copied an entire 126 MiB asset and failed.

- New trusted `portableInputSnapshot` streams each incoming file into a private hidden sibling directory of its **actual destination parent**, rather than a data-root extraction followed by an asset-sized copy. Actual parent placement preserves the filesystem relationship even for nested mount targets; dataRoot and knowledgeRoot need not share a filesystem. No cross-filesystem hardlink is attempted.
- Whole-manifest membership/digests, asset types, native links and all diagram source/PNG bindings still preflight before any asset or main publication. Only then does the ordinary short publication gate exclusively link the validated source entry into its final immutable asset, unlink the private source and decrement staged bytes. Subsequent primary reads resolve the verified promoted file through the internal snapshot. Plain caller-owned extracted directories remain non-consuming.
- Snapshot bytes are in the existing `portable_staging_runs` aggregate with retained deliveries; no limit increases, receipt eviction, allocation-sized Buffer, untracked archive copy or early asset publication. Durable locator rows support one-hour crash/expiry cleanup, and empty directories created only for rejected input are reclaimed. A regression additionally verifies cleanup after an enclosing target folder moves during upload; fallback cleanup searches only this run's exact private names, skips symlinks, and fails closed with accounting retained if an owned shard cannot be found.
- Owner archive uploads with early validated target context stream directly into this snapshot, so no second incoming archive file is retained. Put `folderPath`/`requestId` before the file, or provide both as query parameters; body duplicates must match. The browser now supplies query context and captures the original request ID for all retries. Actual file-first multipart upload is tested with query context. Legacy small file-first/no-query uploads retain the original bounded spool compatibility path; large legacy requests without early context may exceed staging and are **not** the full-budget protocol. Documentation states this distinction explicitly.
- Complete-directory browser uploads with metadata first use the same destination snapshot allocator and promotion. Unknown/unsafe archive entries, mismatched target context and interrupted authorization reclaim private files and expose no main/asset publication. Owner success is acknowledged after staging cleanup.

Evidence:

- `portable-native-review-max-red.log`: original 2 × 126 MiB random PCM regression fails at the extra per-asset reservation with `PORTABLE_STAGING_QUOTA_EXCEEDED`.
- `portable-native-review-max-green.log`: both the new 252 MiB and previous exact 128 MiB retained-archive roundtrips pass; original receipt remains valid, imported stream hashes match, peak tracked staging stays <= 512 MiB, no stage rows remain.
- `portable-native-review-owner-max-green2.log`: actual HTTP **252 MiB file-first archive upload**, original own export retained, dataRoot on `/tmp` tmpfs and knowledgeRoot on the workspace ext4 filesystem. Per-entry private directories are observed beneath their actual nested target parents on the destination device; source hashes and retained receipt remain valid, staging/locator rows are zero before 201. 1/1 passed, 20.44 seconds.
- A real newly mounted nested filesystem could not be created: `unshare -Urnm true` is denied at uid_map. No host mount was changed. Per-file target-parent allocation and the actual different-filesystem test cover the relevant device placement; this report does not claim a mounted nested-volume test.
- `portable-native-review-owner-order.log`: small legacy file-first/no-query compatibility and mismatched early target rejection pass.
- `portable-native-review-reject-cleanup.log`: all five invalid/alias upload cases plus small legacy upload pass with no visible empty target directories left behind.
- `portable-native-review-stream-revocation.log`: current write grant revoked during extraction rejects before any main or asset publication and removes all source shards/ledger rows.
- `portable-native-review-shard-move-{red,green}.log`: moving the target parent originally stranded an owned hidden source; cleanup now reclaims it while preserving ordinary moved folders.

## P2 — passive external navigation

A shared `externalNavigation` classifier now serves ordinary Markdown export/import and native element links. HTTP(S) URLs on other origins remain navigation even when their path begins `/api`; mailto and telephone links also remain byte-exact passive navigation. App-owned API/identity references still use explicit authorized resolution; unknown/unsafe protocols still fail. Passive hyperlinks are never fetched as resources.

- `portable-native-review-navigation-{red,green}.log`: both native scenes and ordinary Markdown reproduce the original rejection, then pass exact-byte export/import/re-export. Ordinary Markdown remains resource-free, including an instrumented request port proving zero network acquisition.

## Verification and scope

- Focused seven-file run: **94/94 passed**, 261.15 seconds, including thousand-document MCP import/result pagination, prior private preview/owner/media/native cases and both maximum-size regressions. Log: `portable-native-review-focused1.log`.
- Additional focused extraction grant-revocation: 1/1 passed; archive safety guards: 2/2 passed; moved-shard and owner rejection/order checks: 7/7 passed across two files.
- Final fast checks: **11/11 passed** across three files, including moved input shard cleanup, rejection/order compatibility, fixed-source browser helper and import lease checks. `portable-native-review-final-fast.log`.
- `npx vue-tsc --noEmit` exited 0 with empty diagnostics in `portable-native-review-final-types.log`; `git diff --check` exited 0 before commit.
- No full suite or browser run was launched. Root owns final integrated verification and scoped re-review. No production knowledge base, deployment, service restart, host mount or dependency installation was changed.

The existing MCP transfer store uses its own transfer quota and may retain upload/download payload replicas; this patch does not claim a combined cross-domain 512 MiB cap or modify that separate store. The 252 MiB bound is verified for direct core retained-archive import and the actual owner HTTP streaming protocol. Parent was explicitly informed so any broader aggregate MCP-store requirement can be assessed separately.
