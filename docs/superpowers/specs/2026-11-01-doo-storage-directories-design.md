# DooKnow storage directory names and portable downloads

## Approved intent

The user selected `_doo-data` and `_doo-assets` and explicitly requested program changes, downloads, migration of existing directories, and rewriting affected references. Earlier decisions: keep Markdown portable with relative links; distinguish application resources from a frontend project's ordinary `assets`; keep application metadata in the knowledge root; preserve stable document identity without adding mandatory frontmatter.

## Design

- `_doo-data` replaces the root `_data` application data directory. Preserve its manifest identity, revisions and complete app/plugin contents. A legacy installation is upgraded only when its manifest proves application ownership; do not merge two data roots implicitly.
- New document attachments live near the Markdown in `_doo-assets/`. Resource filenames are stable opaque identifiers; imported references remain valid even when document IDs change. Do not rename existing resource groups merely because a document is reimported.
- Ordinary frontend `assets` directories remain normal user source directories. Stop treating that name alone as evidence of application ownership. Old resource references remain readable until migrated.
- Migration selects only proven DooKnow-created legacy resources, preserves unknown/user files, rewrites Markdown destinations and native diagram references, and preserves note/asset IDs and history readability. Mixed directories are handled file by file, empty legacy directories alone may be removed.
- Migration is planned read-only first, verified against file hashes, backed up consistently, journaled for recovery, and applied with the service quiescent. A conflict leaves the originals intact and is reported.
- Complete-document download collects actual dependencies and rewrites only the exported copy. Keep raw Markdown download explicitly labeled as excluding attachments. Preserve existing portable archive import/export compatibility; do not rename public HTTP asset endpoints.

## Approaches

The conversation considered centralized attachments under the application data root, per-document filename-based folders, and nearby namespaced resources. Centralized storage would break folder portability; filename-based folders couple resources to renames. The user chose nearby `_doo-assets` with separate `_doo-data` metadata. Reuse the existing portable delivery pipeline rather than adding an independent export implementation.

## Verification

New and legacy data roots; conflicting data roots; normal frontend `assets` scanning; upload/media/diagram destinations; ordinary and diagram reference migration; mixed assets directories; idempotency and interruption recovery; native diagram source/preview integrity; exports/imports/offline viewing; sharing; consistent backup and actual service checks after migration.
