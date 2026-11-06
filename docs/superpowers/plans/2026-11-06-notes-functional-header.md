# Notes Functional Header Implementation Plan

> Execute inline with superpowers:executing-plans; one fresh final review. User approved the concrete layout and continuous execution.

**Goal:** Restore useful global controls to the notes header and reclaim sidebar/document space.
**Architecture:** Move existing search/create/account control subtrees through Vue Teleport, preserving their state and callbacks across compact/desktop layouts. Keep existing document toolbar and expose sharing through its action.
**Tech Stack:** Existing Vue3, TypeScript, Ant Design Vue, Naive UI.
**Spec:** docs/superpowers/specs/2026-11-06-notes-functional-header-design.md

## Global Constraints
No new API/schema/dependency. Preserve editing, drafts, navigation, sharing and real account/data. Existing compactWorkspaceQuery and theme tokens remain authoritative.

## Review Focus
Search with collapsed directory must expose actual results; resizing must preserve query/filename/editor draft; account Escape returns focus to the moved trigger;320px controls remain inside viewport; shared state must still warn about public saves.

### Task 1: Functional header and compact control reuse
Files: WorkspaceHeader.vue, Workspace.vue, WorkspaceFooter.vue, platform-ui.css; tests/e2e/notes-functional-header.spec.ts.
- [x] Write real E2E asserting desktop search/new/account in header, no duplicate visible sidebar controls, real new-note form and search results, account Escape focus; watch RED.
- [x] Move existing subtrees without duplicate controllers; retain compact drawer controls and add compact search/new entry points. Auto-reveal results when searching with collapsed desktop directory.
- [x] Verify320/390/1440 and resize query/draft retention; existing shared navigation and ToDoo host cases.

### Task 2: Document sharing density and delivery
Files: Workspace.vue, DiagramDocumentWorkspace.vue (same note sharing cue), focused E2E above, existing share/editor regressions.
- [x] Assert shared note has visible shared cue and accessible public-save explanation near share action, no full-width banner; watch RED.
- [x] Remove redundant banner, preserve share management API and document toolbar callbacks.
- [x] Run focused regressions/typecheck/production build; inspect actual screenshots. Preserve previous full-suite limitations rather than rerun unrelated release suites for a client layout edit.
- [ ] Fresh review complete; commit/push and update independent5180 preserving account/key/data, then record live acceptance outside the source tree.

Pre-flight: Task2 consumes Task1 header layout; both touch Workspace.vue serially. Approval is already provided in conversation; no new feature/design choice requires another confirmation.
