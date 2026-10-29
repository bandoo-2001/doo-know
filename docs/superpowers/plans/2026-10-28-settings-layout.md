# Settings Layout Implementation Plan

> **For agentic workers:** Use independent implementation tasks with a final read-only review. Preserve the current checkout's existing work.

**Goal:** Unify the settings layout while making saving easy to reach, shortening storage statistics, and keeping action cards readable on desktop and phones.

**Architecture:** Retain Vue components, current icons, controls, routes, and service APIs. Make shared page spacing and action-card layout consistent; keep editor and storage details local to their components.

**Tech Stack:** Vue 3, TypeScript, CSS, Ant Design Vue, Playwright.

**Spec:** The user's approved layout analysis and explicit request in this chat.

## Global Constraints

- Preserve existing uncommitted changes and the previous icon work.
- Keep desktop and phone layouts concise and usable, including 320px and medium-width desktop windows.
- Keep manual preference saving, all seven storage categories, partial-statistics caveats, warnings, refresh, and existing dialog behavior.
- Do not change service configuration, storage APIs, authentication, or running services.

## Tasks

### 1. Capture layout regressions

- [x] Add `tests/e2e/settings-layout.spec.ts` for visible/reachable saving and persisted changes, compact complete statistics, and readable working import/export cards at 1100px.
- [x] Run the new desktop checks against the current UI and confirm failures reproduce the reported problems.

### 2. Make editor saving easy to reach

- [x] In `EditorSettings.vue`, move save/cancel/reset before controls into a sticky toolbar with preserved handlers and labels.
- [x] Collapse the live preview into an accessible native disclosure; preserve all preview behavior.
- [x] Mark switch rows so they remain horizontal on phones.

### 3. Compact storage statistics

- [x] In `StorageSettings.vue`, replace seven large cards with seven compact category/size/count rows. Move the existing import/export panel above statistics in `LibrarySettings.vue` so common actions are reached sooner.
- [x] Preserve partial counts, load/error/refresh states, timestamp, scope limits, and all server warnings; put long scope information in a labeled disclosure with a visible caveat and hint count.

### 4. Unify the shared settings layout

- [x] In `SettingsWorkspace.vue`, `settings.ts`, and shared settings styles, align navigation/page names and icons, reduce mobile header height, and standardize card spacing.
- [x] Make `SettingsActionCard.vue` and its styles adapt to their own width, placing actions below text in narrow cards.
- [x] Reduce redundant plugin-page introductions and normalize embedded panel spacing without changing plugin operations.

### 5. Verify and review

- [x] Run focused desktop/mobile layout and existing settings/plugin browser checks, unit checks, typecheck, and production build.
- [x] Inspect real screenshots at 320px, 390px, 721px, 1100px, and desktop widths, plus dark appearance and relevant dialogs.
- [x] Obtain a read-only code review, address actionable findings, and report the final changes and verification.

## Review Focus

- Sticky saving stays clickable below the mobile navigation and does not cover the active form field.
- Preview expansion and defaults retain unsaved changes until Save is used.
- Zero, partial, and unavailable statistics remain distinguishable.
- Narrow action cards keep descriptions readable and their buttons inside the card.
- Shared styles preserve overlays, plugin details, keyboard access, and dark appearance.

## Verification Results

- The three initial desktop regressions failed for the expected layout defects before implementation.
- Six final desktop/mobile layout checks pass, including persistence, pointer hit testing, and reverse keyboard focus under the sticky toolbar.
- Thirty-four existing settings-overlay, return-navigation, and plugin-configuration browser checks pass.
- Thirty-six related unit checks, typecheck, production build, formatting, and diff checks pass.
- Manual inspection covers 320px, 390px, 721px, 1100px, and 1568px widths, dark appearance, and partial-statistics disclosures.
- Read-only review completed; the dark partial-statistics label uses the existing theme-aware muted color.
