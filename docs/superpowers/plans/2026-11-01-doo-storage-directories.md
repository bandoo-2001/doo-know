# DooKnow storage directories implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. Preserve existing uncommitted work. Request one fresh review at the end.

**Goal:** Adopt `_doo-data` and `_doo-assets`, preserve source projects, and migrate the current knowledge library with working portable downloads.

**Architecture:** Central naming/compatibility helpers; existing knowledge-data writer and asset services; dependency-aware portable delivery; an offline migration with consistent backup and recovery evidence.

**Tech Stack:** TypeScript, Node, SQLite, Vue, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-11-01-doo-storage-directories-design.md

## Global constraints

- User explicitly authorized the names, program/download changes, and old-directory/reference migration.
- Preserve frontend projects' own assets and all unknown files.
- Keep relative Markdown links and current IDs/history/shares.
- Real data is backed up before mutation; do not run an old binary against a migrated library.
- Public `/api/assets` and blog asset URLs keep their existing names.
- Keep old portable archives readable; no mandatory Markdown frontmatter.

## Review focus

- Old and new application data both exist: fail without overwriting.
- User frontend resources registered as attachments: registration alone does not establish ownership.
- Native diagram bindings and historical resources must not silently become unreadable.
- Failed or interrupted migration must remain recoverable and rerunnable.
- Downloads must contain referenced resources and work after being moved to another machine.

## Tasks

- [x] 1. Centralize directory names and compatible data-root adoption. Update data consumers, path security, scanning and watchers. Red/green tests for legacy roots, root collision, and frontend assets visibility.
- [x] 2. Update upload, media, diagram and transfer destinations/readers to namespaced assets. Test new resources, legacy references, copy/move/restore, and portable archive compatibility.
- [x] 3. Implement migration planning/apply/recovery and download presentation. Test owned/mixed resources, reference rewriting, hashes, history and idempotency. Preserve the existing raw-download action alongside complete export.
- [x] 4. Run appropriate regression suites and build, request a fresh review, then back up/quiesce the live service, apply the verified migration using the updated runtime, verify references and service behavior, and record recovery paths.

## Execution ledger

- Initial inspection: current bound library is `/home/bandoo/workspace/knowledge/knowledge-base`; deployed runtime is rc.59; root `_data` has manifest/library/apps/plugins; the live library currently has one `00-Inbox/assets` with 18 generated diagram resources. The SQLite assets registry includes 29 paths, so it cannot be treated as a complete directory ownership proof.
- Ruling: retain public API URL names and app-internal `apps/*/assets` subdirectories; only knowledge-root application data and document attachment namespaces change. Internal app assets already sit inside the reserved application data root.

- Ruling: preserve flat attachment UUID/hash filenames in the first namespaced layout rather than adding a mandatory document-ID subdirectory. Existing native-scene rewrites assume sibling source/preview directories; preserving depth avoids changing ownership on import and reduces historical-link risk. Independent resource identity remains in filenames and registry, and the export package is free to reorganize its own copy. A future resource-group layer can be added without migrating IDs.

- Review fixes: require successful creation receipts (never filenames alone); reject destination registry/ancestor conflicts before mutation; revalidate library manifest identity; refresh embedded Excalidraw reference binding hashes; preserve legacy bundle snapshot classification; canonicalize historical retention lookups; follow aliases by stable asset ID through subsequent moves; block server startup on incomplete journals.
- Validation so far: 156 targeted unit tests green; 107 native relocation/restore tests green; 19 namespace/migration tests green; isolated production build green; 10 production browser cases green (three real editor/offline-export cases, three shares, three chrome cases, mindmap controls). Shared-worktree full-suite run was not a frozen snapshot and had old-path expectations plus a concurrently introduced missing tunnel-identity module; stop it and validate the isolated rc.59-based release instead.

- Final reviewed hardening also verifies the filesystem root identity against the bound database before any mutation, and verifies the encrypted backup covers that same bound knowledge root. New regression uses a copied root with the original database and proves zero changes.

- Completion: installed isolated local release 1.1.0-rc.59.doo-storage.4 (source ae091789b4d5f3a592fe529a1846b1c7605450e5, compatibility 5); encrypted backup taken; migrated 18 proven resources and 3 Markdown documents; preserved 64 note IDs, 29 asset IDs, share state and all 39 prior application data files. Real three-type editing/PNG/complete export checks pass, database integrity and foreign keys pass, pre-migration encrypted backup restored and self-checked in a separate private temporary location, then removed. Ordinary complete downloads now save current edits before freezing their package. Detailed record: docs/验收记录/2026-11-01-doo-storage-migration.md.
