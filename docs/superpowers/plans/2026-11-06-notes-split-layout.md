# Notes Split Layout Plan

> Inline execution using executing-plans; one final fresh review.

**Goal:** No global notes header; fullheight directory and functional document panes, avatar aboveNotes in rail.
**Architecture:** Remove last iteration controlTeleports andfunctionalheader slots; use existing sidebar/rail controls. Give notes a one-row ownergrid and compact document-local drawer trigger.
**Tech Stack:** ExistingVue3/TypeScript/Ant/Naive.
**Spec:** docs/superpowers/specs/2026-11-06-notes-split-layout-design.md

## Constraints / Review Focus
Preserve query/new-note drafts/editoridentity across module switches/resizes; no inaccessible compact directory trigger; resizer startsat0; rail avatar visiblyaboveNotes; no duplicate visibleheader; sharecue remains readable320px. NoAPI/schema/dependency/accountdata changes.

### Task1: Correct structure and real regressions
Files: Workspace.vue, WorkspaceHeader.vue, WorkspaceFooter.vue, DocumentNavigation.vue, platform-ui.css; migrate notes-functional-header E2E to notes-split-layout and update shared geometry assertions for the new contract.
- [x] Add real RED for desktop y0 panes/no header/avatar order and compact drawer access.
- [x] Restore sidebar/rail controllers in place, remove obsolete header Teleports/styles, one-row notes grid; compact local drawer entry and focus return.
- [x] Verify desktop/320/390, shared short-landscape regression, and query/input/editor/draft identities; document/native sharing. Folder/collection local entry inspected in source; no separate E2E claim.

### Task2: Validate and deliver
- [x] Related unit/E2E, typecheck/build and actual screenshots. Record failures separately: 52 scoped E2E and 83 related unit tests passed; 2 phone capture cases passed after waiting for the closing scrim.
- [x] Fresh review: no Critical / Important findings. Minor screenshot timing corrected without product changes.
- [ ] Commit/push, immutableindependent5180 preview update, freshbackup/preservation/servedassets/health checks; actualaccountlogin onlyif existingprivateidentitymatches (noreset).

Final deployment status is recorded after activation in `/home/bandoo/documents/doo-know/design-artifacts/notes-split-layout-2026-11-06/delivery-receipt.json`; this pre-deployment plan does not claim activation in advance.

Pre-flight: sharedgrid+drawerfocus andDocumentNavigation props ownedserially, noparallel implementation. Priorheaderproposal is superseded.
