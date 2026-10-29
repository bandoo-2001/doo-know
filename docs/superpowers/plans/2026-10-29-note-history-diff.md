# Note history diff implementation plan

> **For agentic workers:** Use the existing diff2html view and test the user-visible behavior before claiming completion.

**Goal:** Let users select a saved note revision, automatically preview it, compare it with the current saved note, and restore through the existing guarded save flow.

**Architecture:** Move the existing Git diff renderer to a shared browser module while retaining its Git exports. Generate bounded unified patches from complete note texts with the already installed `diff` library. A lazy note-history dialog owns list, read, selection, comparison and error state; Workspace retains restore and unsaved-draft protection.

**Tech Stack:** Vue 3, Naive UI modal, Ant Design buttons, diff2html 3.4.56, diff 8.0.4, Vitest and Playwright.

**Scope:** User asked to directly reuse the existing component. Execute in the existing linked worktree and preserve all unrelated uncommitted changes. No deployment, service changes or Git commits.

## Constraints and review focus

- Existing Git imports, rendering, lazy loading, layouts and HTML-as-text behavior remain compatible.
- Normal note history works without a Git repository or enabled Git plugin.
- Compare complete historical text with current saved text; exclude unsaved drafts and label the baseline.
- Bound each input to 1 MiB and the generated patch to 256 KiB; bound algorithm work. Never display partial comparison as complete.
- A first preview page loads automatically. Large texts retain explicit paged preview and restore independently of comparison.
- Switching revision, closing the dialog or changing notes invalidates pending read/comparison work.
- Failed snapshot preparation, failed reads and failed imports have visible local errors and retry paths.
- Keep existing restore preservation, draft handling, expectedModifiedAt and requestId behavior.

## Tasks

### Task 1: Share the existing diff renderer

Files: `packages/plugin-ui/diff-view.ts`, `plugins/git/web/diff-view.ts`, `tests/git-diff-view.test.ts`.

- [x] Add a regression proving the shared `DiffBody`/`readDiff` parse and render real unified patches, preserving text escaping and old/new line numbers; observe red.
- [x] Move implementation to the shared module; export `DiffView`, `DiffBody`, `readDiff`, `DiffInput`, `DiffDocument`; retain all existing `Git*` exports through aliases.
- [x] Allow callers to customize the truncated-result message, retaining Git's existing default.
- [x] Run `npx vitest run tests/git-diff-view.test.ts`.

### Task 2: Bounded history reads and patch generation

Files: `apps/web/note-history.ts`, `tests/note-history.test.ts`, dependency manifests (owned by primary agent).

Interfaces: `HistoryApi`, `NoteRevision`, `readRevisionPage(call, noteId, revisionId, input?, active?) -> Promise<ReadPage | undefined>`, `createRevisionDiff(previous, current) -> Promise<{ status: 'ready' | 'empty' | 'too-large' | 'too-complex'; diff: string }>`, `HISTORY_COMPARE_MAX_BYTES = 1024 * 1024`.

- [x] Test real patch generation for Chinese, newline differences, unchanged text, size/work bounds and parsing by the shared renderer; observe red.
- [x] Test snapshot ready/accepted/failure/cancellation behavior using API boundary fixtures; observe red.
- [x] Implement snapshot polling at 1 second with bounded attempts and stale-selection checks. Always preserve read cursors and handle failed/cancelled/needs_reconciliation terminal states.
- [x] Generate unified patches asynchronously using `diff.createTwoFilesPatch`, context 3, timeout 250 ms and maxEditLength 10000. Suppress partial or oversized results.
- [x] Run `npx vitest run tests/note-history.test.ts`.

### Task 3: Integrate note-history dialog

Files: `apps/web/components/NoteHistoryDialog.vue`, scoped integration in `apps/web/components/Workspace.vue`, `tests/e2e/note-history.spec.ts`.

- [x] Add real-browser coverage for automatic preview/diff without Git, view switching and selection, unchanged saved text with an unsaved draft, guarded restore, snapshot/read errors and large-text preview; observe failure before implementation.
- [x] Use a version list and a selected-version preview/comparison panel. Show original modification time (nanosecond mtime conversion), exact timestamp tooltip, size and current saved baseline.
- [x] Load the first page with maxBytes 128 KiB and a 200-line range; for comparable texts assemble complete immutable pages within the 1 MiB / 512-page bounds. Show large previews as explicit pages, never as a complete comparison.
- [x] Reuse `DiffView` with lazy import; keep loading/error/retry states and raw historical text available. Confirm the selected version before emitting restore; disable duplicate actions while busy.
- [x] Replace the old inline modal and reading state in Workspace. Preserve its existing restore guard and save pipeline. Keep all unrelated Workspace edits.
- [x] Add `diff: 8.0.4` as a direct devDependency, matching its existing locked installation.
- [x] Run focused unit tests, `npm run typecheck`, `npm run build`, and desktop/mobile history plus Git diff browser regressions. Request an independent review and resolve relevant findings.

## Verification record

- Focused Vitest regression: 6 files, 92 tests passed.
- Note-history Playwright: desktop 8/8 and mobile 8/8 passed in an isolated source snapshot, including >200-page session renewal, failed renderer retry, stale reads, restore/draft protection and footer visibility.
- Existing Git diff browser tests: desktop 3/3 and mobile 3/3 passed; large-file browser tests: desktop 2/2 and mobile 2/2 passed.
- Typecheck passed. Production build passed; final CSS-only follow-up build recorded in the validation log.
- Independent review found session-budget renewal and local renderer retry gaps; both were fixed and the scoped re-review found no remaining issue.
- The expanded UI-feedback run also exposed the existing `reports share errors inside the dialog and locks the submitted action` failure on desktop and mobile. No share implementation changed in this task.
- Full `npm test` was started and stopped before completion; no whole-suite success is claimed.
- Validation logs and screenshots are retained under `.local/note-history-validation/` (ignored). No commit, deployment or production service change.

## Visual refinement

- Added an icon and note title to the header, a shaded version sidebar, concise timestamps and a clearer selection marker.
- Styled preview and layout switches as compact controls; the diff heading now uses the actual note title. Git retains its filename label by default.
- On phones, replaced horizontally clipped version cards with an accessible native version selector. Kept the footer visible while the content scrolls.
- Focused regression: 38 unit tests passed. Final browser checks for selection, both layouts, source preview and guarded restore passed on desktop and phone (2 each). Typecheck, production build and final frontend build passed.
- Earlier cold dev-server visits exceeded the fixture's 5-second editor readiness assertion. The fixture now explicitly waits up to 15 seconds for editor readiness; production loading behavior is unchanged.
- Updated previews: `.local/note-history-validation/polished-desktop.png` and `polished-mobile.png`. No deployment.
