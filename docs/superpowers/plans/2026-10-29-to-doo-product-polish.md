# To Doo Product Polish Implementation Plan

> **For agentic workers:** Execute in this session, preserving existing uncommitted application work.

**Goal:** Improve capture, scanning and mobile list access using researched product patterns.

**Architecture:** Existing Vue workbench and persisted drafts remain authoritative. Changes stay in presentation, composer and navigation; task storage and command semantics are unchanged.

**Tech Stack:** Vue 3, TypeScript, CSS, Vitest, Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-to-doo-product-polish-design.md`

## Global Constraints

Preserve app shortcuts, HTTP compatibility and the prior To Doo simplification. No production deployment, account reset or user task writes. Only one browser test server at 4179/4180 at a time.

## Review Focus

Explicit date selection versus recognized title dates; per-list draft identity; mobile selected option after navigation; plan/deadline distinction; active detail versus batch selection; keyboard use inside fields and dialogs.

## Tasks

- [x] Root: regression for progressive quick capture, explicit plan date and Q focus; implement composer and visual hierarchy CSS.
- [x] Mobile navigation worker: expose actual lists and common views via existing guarded navigation; isolated browser regression.
- [x] Task row worker: separate active/detail selection and planned/deadline labels; regression for conflicting dates and selection.
- [x] Run related unit and mobile/desktop browser suites, typecheck, build; inspect screenshots.
- [x] Independent review and final read-only Tailscale smoke check.

## Results

72 relevant unit tests passed. New capture plus prior daily UX scenarios passed desktop 13/13 and mobile 13/13; row clarity, mobile lists, prior full To Doo workflows and app-shortcut browser scenarios also passed in the integration run. Typecheck, build and diff checks passed.

Review P2 (cleared date restored contextual Today) fixed with persisted `planDateCleared`, a JSON draft restoration unit regression RED→GREEN, and browser clear/reload/submit verification. Existing filter-navigation regression caught collapse moving the toolbar between pointerdown and click; collapse now waits for the pointer gesture to end. The timezone test drains its intercepted responses before teardown. One intermediate desktop run lost its global temporary fixture directory during concurrent workspace test activity; a standalone desktop rerun completed 13/13. All original failures and rerun logs retained under `/tmp/doo-know-product-polish-*`.

Real Tailscale smoke check verified authenticated tasks, Q focus, plan input, grouped mobile menu and zero runtime errors without writing tasks. Before/after and live screenshots are under `.local/to-doo-product-polish/`. No production deployment or commit of unrelated work.
