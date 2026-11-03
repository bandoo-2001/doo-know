# Current storage format cleanup

User decision: development-only product; keep current formats and remove old-data migration/compatibility code. No support promise for old libraries or archives. Current test knowledge library must continue to edit, preview, share and download correctly.

## Constraints and scope

- Keep `_doo-data` and `_doo-assets` in one shared module, including SQL and UI consumers.
- Remove legacy `_data` adoption, resource aliases, the directory migration CLI/journal and compatibility-only startup/backup hooks.
- Ordinary user `assets` directories remain ordinary source/resources. Native diagram documents use the current reserved attachment directory.
- Preserve current IDs and current document contents. Inspect and normalize any references that still depend on compatibility before deploying the cleanup. Retain encrypted backups outside the product code.
- Normal document history, recovery after interrupted writes, and current database schema initialization remain required behavior.
- Ask asynchronously whether old standalone-whiteboard conversion, old-draft conversion and legacy preview entry points are also in scope; proceed with storage work while awaiting the optional answer. The user's general preference supports removing them if no narrower scope is given.
- Preserve unrelated concurrent source edits. Work in the existing linked checkout; freeze a private source artifact for release verification if needed. Do not commit the shared checkout wholesale.

## Tasks

- [ ] 1. Update behavior tests for current-only roots, ordinary source directories and current native attachments; observe failures before code changes.
- [ ] 2. Simplify root resolution and asset handling; remove directory migration and alias machinery; centralize remaining directory literals.
- [ ] 3. Remove the related old-format conversion paths confirmed by the scope decision, including unused UI/API/schema/tests. Keep current diagram operations and history working.
- [ ] 4. Run targeted tests, type checks/build and browser downloads/shares. Review the final source changes with a fresh reviewer.
- [ ] 5. Back up and normalize the current test library if needed, deploy an isolated current-format build, verify live diagrams/downloads, and update current guides with the final support policy.

## Ledger

- Baseline: live local version `1.1.0-rc.59.doo-storage.4`, knowledge root already uses current directories, 18 aliases, zero standalone `.excalidraw` notes and zero whiteboard migrations. Native source files themselves contain no old `assets/` references; remaining alias dependencies are in historical metadata/receipts.
- Ruling: user explicitly replaces the previous backward-compatibility requirements with current-only support. No additional design approval is needed for removing those requirements.
- Ruling: the existing checkout is a linked worktree on a development branch; preserve parallel work and reuse existing project dependencies.
