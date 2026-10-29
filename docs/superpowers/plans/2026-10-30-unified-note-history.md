# Unified note history implementation plan

> **For agentic workers:** Implement the approved direct integration in the existing worktree. Preserve unrelated work and use focused regression tests before completion.

**Goal:** One “历史版本” entry with “保存记录” and “Git 提交” sources, preserving each source's existing data and restore semantics.

**Architecture:** Extract Git's existing history loading, difference, capability and restore state into a shared browser model. Reuse it in the legacy plugin panel and the polished native history dialog. The native dialog calls the existing authenticated plugin API; Git remains optional. Remove the Git note-action contribution and suppress the legacy action from already installed plugin manifests.

**Tech Stack:** Vue 3, existing plugin API, shared diff2html view, Vitest and Playwright. No new dependency or backend mutation route.

**Authorization:** User explicitly requested direct integration after discussing this approach. No additional design approval, commit, deployment or service change is needed for this source change.

## Constraints and review focus

- Preserve all existing saved-note reads, paging, diffs, draft guard, original preservation and background large-file restore behavior.
- Default to 保存记录. Git 提交 appears when the Git plugin is enabled. No Git history/difference calls are made by the saved-record source.
- Distinguish historical-note-versus-current comparison from the Git commit's own changes. Do not present Git patches as a comparison with current unsaved or saved content.
- Git restore continues through git.restore / knowledge.update with expectedModifiedAt and stable requestId. It preserves unsaved editor drafts.
- An uncertain Git restore keeps its original target and request ID, exposes 核对恢复结果, and prevents switching source/target or silently abandoning the pending action.
- Capability limits remain source-specific. Git may be readable while restore is unsupported; saved history keeps its larger-file support.
- Guard late list/diff replies on note change, reset and unmount. Handle missing repository, missing history, disabled plugin, plugin errors and retry visibly.
- Hide the standalone Git note action for both new and already-installed old plugin manifests; keep unrelated plugin actions.

## Tasks

### Task 1: Reuse Git history state

Files: `packages/plugin-ui/git-history.ts` (new), `plugins/git/web/index.ts`, `tests/git-history-model.test.ts` (new), `tests/git-web-regressions.test.ts`.

- [x] Test and observe missing shared-model behavior before implementing.
- [x] Export `createGitHistoryModel`, `GitHistoryCall`, `GitHistoryEntry`, and `gitRestoreMessages`.
- [x] Model options: `call(kind, id, input)`, `context(): {noteId: string; expectedModifiedAt?: string}`, optional `onRestored(noteId)` and `friendlyError(cause)`.
- [x] Preserve refs `rows`, `cursor`, `diff`, `diffTruncated`, `diffCommit`, `diffLoading`, `error`, `selected`, `confirmRestore`, `restoreNeedsReload`, `restoreBlockedCode`, `busy`, `pendingRestore`; add `loading`. Methods `load(next?)`, `show(commit)`, `restore(): Promise<boolean>`, `cancelRestore()`, `reset()`, `dispose()`.
- [x] Reuse model in the existing Git panel; preserve its legacy rendering and regression expectations. Remove the unused Git history note-action component registration.
- [x] Verify targeted model and Git web regressions; no full-suite run by subagent.

### Task 2: Remove duplicate menu entry

Files: `plugins/git/manifest.json`, `apps/web/components/PluginSlot.vue`, focused plugin-action tests, `tests/e2e/git.spec.ts`, `tests/e2e/git-diff-view.spec.ts`.

- [x] Remove git.historyAction from the shipped note-action contributions.
- [x] Suppress only the old Git note action in PluginSlot so an installed older plugin cannot restore the duplicate entry.
- [x] Keep Git history provider/panel and unrelated plugin actions compatible.
- [x] Update Git browser flows to open 历史版本 and select the Git 提交 source, retaining existing difference, restoration, large-file and parser-fallback assertions.

### Task 3: Unified history dialog

Files: `apps/web/components/NoteHistoryDialog.vue`, optional typed source adapter `apps/web/git-note-history.ts`, new `tests/e2e/unified-note-history.spec.ts`.

- [x] Add source tabs while retaining the saved-record interface and its existing browser tests.
- [x] Detect enabled Git using plugin registry state. Pass authenticated plugin calls to the shared model.
- [x] Show commit messages, author, timestamp and short SHA; select a commit to view its changes using the shared difference view.
- [x] Integrate capability explanations, confirmation and pending-result checks into the common footer. Keep source/target locked during uncertain restore; preserve the draft semantics of each source.
- [x] Refresh saved records after a confirmed Git restore and notify Workspace through its existing change event.
- [x] Test disabled/missing Git, both source lists, absence of duplicate action, correct diff baseline, successful restore, failure/retry, uncertain restore identity, and desktop/mobile layout.

## Verification

- [x] Focused unit regressions, typecheck and build.
- [x] Desktop/mobile unified history plus existing Git/history browser regressions in an isolated temporary source snapshot and unused test ports.
- [x] Independent review; resolve material findings and retain screenshots and logs under ignored `.local/note-history-validation/`.

## Results

- Focused Vitest regression: 8 files / 134 tests passed, including four mounted native-dialog context tests and legacy Git UI regressions. Workspace preservation was rechecked after minimizing formatting-only changes.
- Eleven distinct browser scenarios were verified for each of desktop and mobile: Git installation/commit/history, commit differences, truncation, failed parser fallback, large-note restore limits, saved large-file restore, saved-note comparison and draft guard, unified restore, uncertain-result retry identity, and disabled Git.
- The first expanded browser run exposed obsolete parser-asset interception, a mobile test helper selecting hidden desktop controls before data arrived, and a five-second restore assertion deadline. The fixture now intercepts both host and plugin parser URLs, waits for the actual visible selector, and waits for the Git result with a bounded fifteen-second assertion. Focused follow-up: desktop 3/3 and mobile 3/3 passed. Production behavior was not changed to accommodate those test conditions.
- Independent review found pending-context and stale-baseline issues. Mounted regressions failed before the fixes and passed afterward; scoped re-review is clean. A successful Git restore with a retained draft now leaves the editor baseline visibly stale until fresh metadata is loaded.
- Saved list reads retry only explicitly retryable workspace read-lock responses, at most three attempts. Mutations are not automatically replayed after network failures.
- Production build and formatting/whitespace checks passed. Final typecheck output and browser/unit logs are retained with screenshots under ignored `.local/note-history-validation/unified/`.
- Existing installed legacy plugin actions are suppressed; Git data/API compatibility is retained. No dependency installation, Git commit, production service change or deployment.

## Reading-area enlargement

- Expanded the dialog to viewport height with a desktop width up to 1480px; phones use nearly the full viewport.
- Moved source selection into the header, narrowed the sidebar and compressed Git metadata and comparison controls. Preserved the fixed footer and independent content scrolling.
- Existing saved-history and unified-Git browser flows passed on desktop and phone (two each). Typecheck and frontend build passed; previews are saved as `expanded-desktop.png`, `expanded-git-desktop.png` and `expanded-mobile.png` in the validation directory. No deployment.

## Compact content toolbar

- Combined the saved-history view tabs and difference layout controls into a single row. Layout controls disappear in original-text mode.
- The shared viewer retains ownership of layout and responsive state and optionally docks its existing toolbar in the parent row. Git's default inline toolbar remains compatible.
- Shared renderer regressions passed (10 tests), saved-history browser checks passed on desktop and phone (two each), and typecheck/frontend build passed. Captured previews are `compact-toolbar-desktop.png` and `compact-toolbar-mobile.png`; no deployment.
