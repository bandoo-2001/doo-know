# Excalidraw Whiteboards Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline. The user explicitly requested direct implementation and delegated routine decisions.

**Goal:** Add first-class `.excalidraw` whiteboards and a reusable full-page design workspace with embedded note previews.

**Architecture:** Extend the existing note lifecycle by inferred file kind. Keep scene validation/text extraction in a shared module, mount the lazy official React canvas behind a Vue component, and render Markdown diagram fences with reusable preview cards. Stable UUID references share one source scene across notes.

**Tech Stack:** Existing Vue, Fastify, SQLite, MarkdownIt/Tiptap; Excalidraw 0.18.1, React 19, Mermaid and its official converter.

**Spec:** `docs/superpowers/specs/2026-10-22-whiteboards-design.md`

## Global Constraints

- Preserve existing dirty working tree. No mixed commits or deployment.
- `.excalidraw`: 8 MiB, 10,000 elements; retain scene images; classify by file extension.
- Reuse version checks and idempotent write operations. Never overwrite a changed disk version automatically.
- Public access must be scoped to an active share and its explicit whiteboard references.

## Review Focus

- Scene JSON contains data images or malformed nested fields: reject invalid data without losing the original.
- Save response lost after commit: retry the original request identity, preserve newer edits.
- Parent note is dirty when its embedded board opens: returning keeps note source and selection intact.
- Whiteboard renamed/moved/deleted while referenced: stable identity resolves moves and shows an unavailable state after deletion.
- Public note references private content: only explicit whiteboard references can be read, and share revocation is immediate.

### Task 1: Scene format and durable file lifecycle

Files: `shared/whiteboard.ts`, `shared/contracts.ts`, `shared/knowledge-contracts.ts`, core files/notes/mutation/move/metadata/indexing/collections, transfers and web routes; tests `tests/whiteboards.test.ts`, `tests/whiteboard-format.test.ts`.

- [x] Add failing API tests for creation/read/meta, save/replay/conflict, invalid scenes, long image lines, move/trash/restore, import/export and sharing boundaries.
- [x] Implement shared classification, validation and text extraction. Adapt the existing lifecycle without new database identity tables.
- [x] Verify scoped API and existing lifecycle regressions.

### Task 2: Full design workspace and Markdown integration

Files: new `apps/web/whiteboards/*`, `WhiteboardWorkspace.vue`, `DiagramPreview.vue`, editor code-block extension, Workspace/Tree/Move/ShareReader integrations, package dependencies; tests `tests/e2e/whiteboards.spec.ts`.

- [x] Add failing browser cases for create/open/save/reload, embedded editing with dirty parent, preview refresh, conflicts, theme/mobile and readonly sharing.
- [x] Add lazy React mounting, local scene drafts, serialized autosave/retry, export/import, themed design chrome and standalone creation.
- [x] Add whiteboard/Mermaid fence previews in the two editor modes and public reader; Mermaid conversion creates a separate board.
- [x] Verify desktop and mobile actual canvas operations and persistence.

### Task 3: Verify and review

- [x] Run typecheck, complete unit suite, affected desktop/mobile browser regressions and production build in task-local output.
- [x] Request one focused independent review of all whiteboard changes, then fix material findings and rerun corresponding checks.
- [x] Record final evidence, screenshots and remaining limitations. Leave user work and running services intact.

## Execution ledger

- Worktree: existing linked worktree detected; no new worktree required. Relevant source baseline saved under ignored `.local/whiteboards/baseline`.
- User authorization: implement directly and choose appropriate handling of problems; no further design approval gate.

- Task 1: API/create/read/type/meta, 2.2 MiB scene reads, idempotent save and conflict protection, malformed scene validation, move/trash/restore, native and portable transfers, index projections, cloned-file identity and image-preserving backup all verified. Latest lifecycle run: 51 passed (`.local/whiteboards/lifecycle-final.log`).
- Task 2: actual drawing/save/reload, dirty parent retention, Mermaid conversion, aborted committed-save replay, external conflict/draft confirmation, sharing revoke, browser Back, themes and mobile bounds verified. Combined browser regression: 42 desktop + 42 mobile passed (`.local/whiteboards/regressions.log`). Actual PNG signatures and absence of external requests verified on both projects (`.local/whiteboards/png-export.log`).
- Final review: independent reviewer found malformed nested arrays and unstable imported file references. Both reproduced RED and fixed GREEN. Persistent file IDs additionally preserve references when the database is not copied. Scene imports allocate new IDs and rewrite both relative and prior-ID references after importing boards first.
- Additional fixes verified RED→GREEN: recovered drafts wait for manual save after an external change; browser Back closes the embedded design page while preserving the dirty parent; Mermaid themes rerender without losing SVG text.
- Typecheck, client production build (including local fonts), server compilation and changed-file whitespace checks pass. Final full unit run after code freeze: 905 passed, 1 intentionally skipped across 188 files (`.local/whiteboards/unit-complete.log`).

- Task 3 complete: full unit suite 905 passed / 1 skipped; desktop/mobile browser regression 42 + 42 passed; PNG export/offline-font checks 1 + 1 passed; typecheck, web/server builds and scoped whitespace/format checks pass. No commits or deployment; existing user changes retained.
