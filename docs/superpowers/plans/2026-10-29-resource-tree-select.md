# Resource Tree Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat knowledge-resource selection with a searchable checkbox tree and reuse directory selection in the remaining directory forms.

**Architecture:** Keep the existing path-based single-directory picker; allow its empty-value label to match each caller. Add a knowledge-resource picker whose values remain stable `{kind,id}` identities, whose explicit selections remain separate from inherited inclusion, and whose ceiling allows narrowing to descendants. Continue using ordinary selects for flat business resources.

**Tech Stack:** Vue 3, Ant Design Vue 4.2.6 TreeSelect, Vitest, Playwright.

**Spec:** The design discussion in this chat and the user's instruction to implement it directly.

## Global Constraints

- Work in the existing linked worktree; preserve pre-existing uncommitted changes.
- No new dependencies, commits, production service changes, or deployment.
- Directory permissions include current and future descendants and follow IDs across renames.
- A note permission grants only that note; choosing all visible children must never create a parent grant.
- Keep missing selected identities visible/removable; do not replace them by a resource at their former path.
- Keep `mode:all` distinct from selected directory roots.

## Review Focus

- Parent inclusion must be visible without making inherited children independent grants.
- Descendant filtering must respect path boundaries and retain context ancestors as unselectable.
- Empty/default values mean root, all directories, or default destination depending on the caller.
- Popup navigation, search, Escape, mobile viewport, and long names must remain usable.
- Loading/missing resources must not silently erase a saved selection.

### Task 1: Resource permissions and tree picker

**Files:** `apps/web/knowledge-resource-tree.ts`, `apps/web/components/KnowledgeResourceTreeSelect.vue`, `apps/web/components/MCPDomainPermissions.vue`, `apps/web/mcp-permissions.ts`, `apps/server/platform/mcp-permissions.ts`, `tests/knowledge-resource-tree.test.ts`.

- [x] Add and run failing behavioral tests for hierarchy, stable IDs, inherited display, strict explicit selection, unavailable IDs, and descendant ceilings.
- [x] Implement tree helpers and the AntDV picker; add explicit path metadata to the permission inventory.
- [x] Integrate only the knowledge branch of the shared permission editor.
- [x] Run focused permission tests and browser validation.

### Task 2: Remaining directory forms

**Files:** `apps/web/components/DirectoryTreeSelect.vue`, `apps/web/components/Workspace.vue`, `apps/web/components/to-doo/ToDooOutcomeNote.vue`, `apps/web/components/settings/TransferPanel.vue`.

- [x] Support a caller-specific empty/root label while preserving existing defaults.
- [x] Use the picker for search scope and outcome-note destination.
- [x] Add directory selection beside the custom batch-import path, preserving custom paths and blank restoration behavior.
- [x] Verify single-selection behavior and existing directory flows in the browser.

### Task 3: Verification and review

**Files:** `tests/e2e/resource-tree-select.spec.ts` plus relevant existing tests.

- [x] Cover parent inclusion, exact note narrowing, no automatic parent promotion, tag folding, search and keyboard dismissal in desktop/mobile browsers.
- [x] Run focused tests, typecheck, build, and the full unit suite; report unrelated failures separately.
- [x] Obtain an independent review and resolve material findings.

## Verification record

- Helper regression tests: 6 failures with empty implementations, then 6 passes.
- Focused permission suites: 4 files / 56 tests passed.
- Typecheck passed; production build passed (upstream module-directive warnings remain).
- Independent review: no material findings; additional helper probes covered unordered inventories, parent removal, new descendants and identity preservation.
- Browser tests use a temporary mirror with independent ports and fixture data because other ongoing work uses the default browser-test ports.
- Final browser verification: 4 specs, desktop 14/14 and mobile 14/14 passed using independent temporary data, ports and fixture files; all test services exited.
- Browser checks also caught and fixed duplicate accessible labels for explicit IDs. Long resource titles are limited to two lines and the extra built-in leaf icon is hidden.
- Existing short-viewport bounds checks passed in the final desktop/mobile run without relaxing assertions.
- Final typecheck and build passed.
- Full `npm test`: 340 files passed, 1 failed, 1 skipped; 2237 tests passed, 37 failed, 1 skipped (1251.01 seconds).
- The 37 failures all belong to the existing `tests/workspace-save-recovery.test.ts` harness. A targeted reproduction confirmed `Unexpected Workspace dependency: ../app-shortcuts` at line 133. The `Workspace.vue` app-shortcuts import was already present in the user's uncommitted work before this task; this task only changed the search-directory template in that file. That unrelated harness was not modified. Full-run log: `/tmp/doo-know-resource-tree-unit.log`.
- Preview screenshots saved outside the repository under `/home/bandoo/.codex/visualizations/2026/10/29/01a187f3-4ab2-7511-9f3c-273935d7e467/knowledge-resource-tree-{desktop,mobile}.png`.
