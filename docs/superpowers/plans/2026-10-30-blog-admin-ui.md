# Blog Admin UI Implementation Plan

> **For agentic workers:** Use scoped parallel implementation, behavioral verification and independent review. User's direct execution preference and authorized production update persist.

**Goal:** Improve the complete blog management experience shown in the screenshot and deploy the verified UI update.

**Architecture:** Keep API/workbench contracts. Add a blog-admin root modifier with isolated CSS, refine existing page markup, and improve the studio preview interaction. Support both current hosted menu and rc.52's internal blog navigation.

**Tech Stack:** Vue3, existing Icon and CSS, Vitest/Playwright, native release/update tooling.

**Spec:** docs/superpowers/specs/2026-10-30-blog-admin-ui-design.md

## Global Constraints

- No new runtime dependencies, backend writes, automatic article/design publication or permission changes.
- Preserve existing/concurrent uncommitted work and all blog metadata/publishing behavior.
- Scope shared-menu styling to data-menu-id=blog; preserve other apps.
- New foundation CSS is apps/web/blog-admin.css; root class blog-workspace blog-admin. Use higher specificity than old blog.css, not broad global selectors.
- Desktop body15px/helper>=13px/mobile inputs16px, primary controls>=42px desktop/44px mobile, max content1280px; light/dark and no horizontal overflow.
- Real iframe viewport1100px desktop/375px mobile remains intact. Scripts stay disabled in preview.
- Package only blog UI files over formal rc52 commit43545ba; no unrelated dirty navigation/ToDoo/history/mainmenu rollout.

## Review Focus

- Existing labels used by screen readers and end-to-end flows remain actionable.
- New taxonomy search distinguishes empty data from empty results; choosing taxonomy clears an unrelated article query.
- Enlarged preview traps focus, Escape/backdrop closes, and focus returns to its trigger without publishing.
- Settings and article edits survive requests, section switches and saved/published state changes.
- Desktop1094/1440 and mobile390 have readable controls, no clipped menu labels, and visible save/preview actions.

### Task 1: Main management pages

**Owner files:** apps/web/components/BlogWorkspace.vue only; new tests/e2e/blog-admin-content.spec.ts if needed. Do not edit blog.css, new foundation CSS or child studio files.

**Interfaces:** Existing model and props unchanged, preserve hostedNavigation and current events. Import ../blog-admin.css and add blog-admin modifier. New CSS class names may use blog-admin-* and semantic wrappers; coordinate style owner.

- [ ] Refine header/context/status and five-page heading hierarchy; improve overview into real statistics/quick actions/recent rows.
- [ ] Refine article list, filtering controls, detail grouping, main action visibility and empty/pending/error states without changing model ownership.
- [ ] Implement useful taxonomy empty actions and local taxonomy search, including no-result reset and correct article filtering; keep backend manual publication.
- [ ] Group site settings in clear panels with explicit unsaved/save status; preserve all labels/API shapes and public toggle behavior.
- [ ] Add meaningful browser behavior checks for taxonomy interactions; run scoped model regression/typecheck and report.

### Task 2: Admin visual foundation

**Owner files:** apps/web/blog-admin.css only (new). Do not edit any Vue or existing blog.css/global menu CSS.

**Interfaces:** Applies to .blog-workspace.blog-admin and descendants; scoped hosted menu [data-menu-id=blog]. Main implementer produces wrappers and semantic classes. Studio-specific dialog CSS is separate owner.

- [ ] Establish coherent palette, typography, spacing, controls and focus styles; use existing dark-theme selector.
- [ ] Style header/nav/status, overview/statistics, article master-detail/search/forms/actions, taxonomy and grouped settings/empty states.
- [ ] Fix blog-only hosted menu label clipping with readable wrapping/minimum button size; internal tabs remain usable on formal rc52.
- [ ] Cover 1094px/1440px desktop, tablet and390px/mobile, long words and reduced motion; avoid fixed giant empty heights.
- [ ] Review style against markup and coordinate any required class additions; no CSS mirror unit tests.

### Task 3: Studio editing and enlarged preview

**Owner files:** apps/web/components/blog/*.vue, apps/web/blog-studio-admin.css (new), tests/e2e/blog-admin-preview.spec.ts. Do not edit BlogWorkspace.vue/foundation CSS/model/backend.

**Interfaces:** Existing model,1100/375preview and saved state remain. Add trigger 放大预览; accessible dialog named 主页预览; close action 关闭预览; Escape/backdrop/focus restore. Reuse current HTML; scripts remain disabled.

- [ ] Improve studio heading/subtabs/savebar, grouped controls/theme cards/module and collection actions.
- [ ] Implement enlarged preview with real desktop/mobile dimensions, focus and cleanup; write failing browser case then verify.
- [ ] Improve keyboard/mobile/error/loading readability and upload/crop presentation without changing API contract.
- [ ] Run existing workbench regression/typecheck, report changed paths and covering evidence.

### Task 4: Integration, visual acceptance and formal rollout

**Owner:** Coordinator; docs, isolated rc53 candidate, browser acceptance and release/deployment helpers.

- [ ] Record initial dirty file snapshots; review plan contracts and dispatch exclusive owners.
- [ ] Freeze rc52-based candidate with only UI deltas and compatible hostedNavigation support; preserve current dirty source.
- [ ] Run relevant unit/typecheck/build and all blog browser regressions with sealed frontend; visually inspect screenshots for all sections/states and fix material issues.
- [ ] Independent review, fixes and scoped reverification; accurately record bounds instead of rerunning unrelated20minute platform suite for CSS-only changes.
- [ ] Prepare rc53, verify archive/installed bytes and actual-data-copy preflight; backup and restore-verify production data.
- [ ] Update formal service through supported manager, check local/public readiness, deployed UI assets, notes/articles/settings preservation and prior version retention.
- [ ] Write docs/验收记录/2026-10-30-blog-admin-ui.md with screenshots and exact verification/deployment state.
