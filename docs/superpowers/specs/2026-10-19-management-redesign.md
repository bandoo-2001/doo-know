# Navigation and management redesign

Approved scope: the user requested autonomous planning and execution of all remaining items in the preceding comprehensive proposal. No additional design approval is required. This file records the resulting decisions.

## Outcome
- Daily tools are separate from personal identity: import in create/directory actions; persistent Trash, Settings, Status; avatar popover with real username, account/security, help, sign out.
- Settings replace notebook navigation with seven real page categories: editor, library, search, backup, plugins, account, about. Only the active page mounts. Existing account/search/maintenance/plugins URLs remain compatible. Return to notes restores note/folder/search/scroll context and preserves unsaved drafts.
- Editor preferences: default edit/preview/split, wrap, line numbers, display size, reading width, theme; persist per browser/account without changing note contents. Keyboard help and reset are available.
- Library: honest bounded storage statistics, real server directory labeling, import/export, authenticated share-link overview/revocation. Never claim partial scans or managed upgrade backups represent complete backups.
- Search: actionable capabilities/status before advanced environment details; index status moves into a global status drawer rather than floating over content.
- Backup: managed encrypted snapshots, records/download, private recovery key export only with password reauthentication, restore into a new isolated copy with verification receipt. Never overwrite/hot-swap live data, deploy config, or production services. Existing CLI activation instructions remain explicit where deployment configuration owns the binding.
- Transfers: preview and batch import Markdown/attachments with relative paths, skip/rename conflicts, per-item results/retry/cancel; folder/all-library export with attachments. No silent overwrite; bounded quotas and validated archive paths. Managed out-of-place restore/copy artifacts support migration without rewriting deployment configuration.
- Trash: search, original path/deletion time/size, restore and open, batch restore and explicit scoped permanent deletion; collisions offer another filename and do not overwrite. Owner authentication/CSRF apply.
- Plugins: installed/add tabs, dedicated detail view, visible capability/state, common fields use normal controls; raw JSON stays advanced. MCP/Git dedicated contributions remain functional.
- Account: password confirmation, current identity, session list/revoke other devices. About: version/environment/capabilities, help, redacted downloadable diagnostics.
- Status drawer: actual search preparation/index updates/write conflicts plus persistent transfer/backup tasks; meaningful failure links and cancellation only where supported. Tasks continue after navigation; interrupted jobs are truthfully marked on restart.

## Constraints
- Work in the existing clean source feature checkout; current isolated development service uses frontend 5180/API 3011 and separate development data. Production 5173 must remain untouched.
- Use existing Vue 3, Ant Design Vue/Naive UI, Fastify, SQLite, tar and encrypted platform backup implementations. No new global dependencies or third-party services.
- All server-side management endpoints require the existing owner session and CSRF/origin checks. Never return session tokens, passwords, private keys in JSON, raw private configs or note contents in diagnostics.
- Browser filesystem paths are relative imports or opaque managed artifact IDs, not arbitrary server read/write paths. Exports and restore artifacts are owner-only and symlinks/path traversal are rejected.
- Restores create fresh empty data/knowledge/profile/plugin directories, preserve the active database and live knowledge root, and reset restored remote auth via the existing restore implementation.
- Preserve manual document saving, draft recovery, single-owner security, plugin contracts and validated source boundaries.
- Test only disposable fixtures. TMPDIR=/var/tmp/dooknow-validation.lpvStn; browser suites serialize on 4179/4180. Never log real credentials or use actual development notes as mutation fixtures.

## Completion
Every planned item has working UI/API or an explicit deployment-owned boundary with an executable export/restore result. Tests cover navigation/dirty drafts, sessions, shares, traversal/symlinks, cancellation/restart, collision handling, backup/restore consistency and responsive keyboard flows. Record final commits and actual limitations in the user report.
