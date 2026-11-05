# Platform UI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. User explicitly authorized continuous implementation after the independent design gate; no renewed phase approval. All tasks below remain part of the parent full-platform task through verified new release artifacts.

**Goal:** 将已审非 ToDoo 设计落实为真实页面，保留现有数据、权限与交互，并交付运行证据、主分支代码和新发行制品。

**Architecture:** 先统一现有主题变量、Ant/Naive provider 与所有者共享外壳，再按不重叠文件边界修改工作区、设置/插件、认证/公开/博客。使用已有 Vue 组件、状态模型及接口；截图中的业务数据不进入源码。

**Tech Stack:** Existing Vue3/TypeScript/Ant Design Vue/Naive UI and editor/diagram engines; existing Vitest/Playwright and release scripts. No dependency upgrades.

**Spec:** `docs/design/platform-unification-2026-11-05/README.md`, `design/style-contract.md`, current `design/catalog.json` and SHA-bound `design/reviews/global-design-review.json`; parent plan `2026-11-05-platform-ui-unification.md`.

## Global Constraints

- Design gate is passed:390 selected assets, frozen digest `b422b7cb1336e0322291ad9ed619fa3c719f02859ec7f5427b7c76a2d6435879`. Do not mutate frozen asset plans/PNG/sidecars/reviews during implementation; runtime evidence is separate.
- Desktop owner rail64px/header56px; notebook context width still uses existing240–400px preference/resizer. ToDoo's208px context and completed internal layout remain intact.
- Use existing `--blue/--text/--muted/--border/--panel/--surface/--surface-soft/--blue-soft` aliases from the ToDoo palette;8px surface corners, flat CSS. Preserve document reading/font preferences, user blog brand/template/font/width and canvas content colors.
- Preserve API schema, owner/share/OAuth boundaries, drafts/CAS/request ownership/retries/unknown receipts/manual-save semantics. No new roles, registration/reset/share password, automatic connection/success or unapproved AI capability.
- Native OS dialogs and dormant/nonvisual sources remain correctly scoped. Use real components, not design bitmaps or hardcoded example numbers.
- All tests use the existing `/tmp/dooknow-browser-*`/isolated profile fixtures. No production account/reset/data operation or formal deployment. Original dirty workspace remains untouched.
- Pure styling earns runtime comparison, not source-text or implementation-mirroring tests. New behavior/confirmed bugs require meaningful RED→GREEN. Run broad suites centrally after all module changes, not once per styling patch.
- Commit only task-owned code/docs; design PNG bulk goes to a separately verified archive with committed text/hash/index, following host rules. Keep failed attempts/retries/skips explicit.

## Review Focus

- Short/coarse portrait windows: real controls and popup rectangles stay inside viewport, with focus/scroll/primary actions reachable; outer overflow alone is insufficient.
- Shared providers/lazy CSS: public routes receive colors without private navigation; ToDoo still has exactly its own header and navigation.
- Editors retain session/selection/history across theme/layout changes; old async responses cannot target a new note.
- Same-looking overlays retain their own busy/dirty/close/parent restrictions; no universal state-machine replacement.
- SSR/exports remain escaped/CSP-bound and honor template/brand/reading parameters; source graph and data colors survive theming.

## File ownership and interfaces

| Owner/task | Files and responsibility |
| --- | --- |
| Shared/root | `main.ts`, `App.vue`, `ant-design.ts`, new `platform-theme.ts`, new `platform-ui.css`, new `components/WorkspaceHeader.vue`; owner-only outer portion of `Workspace.vue`; owned sidebar selectors in existing global CSS. |
| Workspace | `Workspace.vue` content/window regions after root shell; `workbench.css` content selectors; `document*.css`; existing editor/history/share/large-file/diagram/graph/trash components; `graph.css`. |
| Settings/plugins | `components/settings/*`, `SettingsWorkspace.vue`, existing Plugin/MCP/Git components and their scoped styles; `plugins/mcp/web/index.ts` and `plugins/git/web/index.ts` own CSS only. |
| Public/blog | Login/Setup/OAuth/ShareReader/PublicShareEditor; BlogWorkspace and components/blog; `blog.css` blog selectors only, `blog-admin.css`, `blog-studio-admin.css`; server blog styles/templates; `reading-export.ts`. |

- Existing props/events/controllers remain interfaces. Root header contract: `WorkspaceHeader.vue` props `context:string`, `app?:boolean`, `status?:string`, `drawerOpen?:boolean`; emits `open-sidebar` and `return-app`, wired to existing drawer/return callbacks. Header is a `header[aria-label="DooKnow 工作区"]`, not a new route/controller. Notebook trigger id `workspace-sidebar-toggle` exposes its actual expanded state; closing the drawer returns focus when focus was inside it.
- Root class `.workspace-platform-shell` applies only when active app menu is not ToDoo. Header is outside the main scroller; module sticky offsets therefore start at0, not a hardcoded46/56px overlay offset.
- `platform-theme.ts` exports `platformPalette`, `platformAntTokens(mode:'light'|'dark')` and `platformNaiveOverrides(mode:'light'|'dark')`. Provider algorithms remain their existing defaults; only shared color/geometry tokens change. Primary foreground is white in light and dark ink on pale dark-mode accent.
- Root globally imports existing `to-doo-tokens.css`, then final `platform-ui.css` after existing global styles. Existing CSS names alias ToDoo tokens; no per-module root palette.
- Root scopes class-token `.sidebar` rules to owned `#notebook-navigation` across its global CSS, preserving the DOM class for existing callers/tests and leaving vendor `.sidebar` untouched. Existing already-scoped ancestor selectors remain valid with the id replacement.
- `.apps-home` belongs to workspace; public/blog may split combined selectors but must preserve it. Workspace adjusts AppsWorkspace scoped rules, not `blog.css`. `reading-export.ts` belongs only to public/blog. Common `DiffView` logic/API remains unchanged.
- Freeze shared/root files before parallel module edits. Module edits have disjoint files; Workspace content changes are serial after root finishes its outer template. Any later shared-layer fix is coordinated and revalidates affected screenshots.

### Task 1: Shared theme, owner chrome and sidebar collision

**Files:** root files above; new `tests/e2e/platform-shared-ui.spec.ts`. Read existing `diagram-document-chrome.spec.ts`, `responsive-layout.spec.ts`, `tests/support/browser-test.ts`, `settings-navigation.ts`.

- [ ] Write `owner chrome keeps rail/context/content aligned without duplicating ToDoo header`: real authenticated fixture,1440 desktop header across context+main, rail64, header56, context/main below it; keyboard resizer changes persisted width by16; switching settings and back retains selection; at390/320 and short/portrait representatives navigation remains reachable. On opening ToDoo, shared owner header is absent and existing ToDoo header remains one.
- [ ] Write `native find and library controls are inside narrow canvas`: create/open real primary whiteboard as existing tests do;390 and320 open actual Find and library, assert target and close controls have in-window rects, hit/focus/click work and Escape/close returns to usable canvas. Fail the old source on negative sidebar x; do not assert CSS source strings.
- [ ] Run only these new tests against unchanged product code; capture genuine RED failures and fixture logs. Use `npm run test:e2e -- tests/e2e/platform-shared-ui.spec.ts --project=desktop`, isolated ports if necessary.
- [ ] Implement typed palette/provider aliases,8px surfaces and matching light/dark controls without overriding user content colors/fonts. Move existing provider styling out of App into the shared module; no re-key/re-mount of editor/workspace.
- [ ] Implement header and outer grid. Desktop header spans columns2–3, rail stays full height, context/main occupy row2, resizer starts below header. Preserve all current compact media conditions (phone, short landscape, portrait tablet/coarse pointer) and bottom safe-area inset; compact main height subtracts the external header. Replace old mobile-bar only for the same owner scope; do not add private chrome to public/auth.
- [ ] Scope owned sidebar CSS to `#notebook-navigation`; never edit Excalidraw bundle. Preserve desktop collapse, drawer, resizer and route callbacks.
- [ ] GREEN the new focused tests and run existing `responsive-tabbar.spec.ts`/`to-doo-two-level-navigation.spec.ts` relevant host cases. Verify representative light/dark computed control colors and real screenshots; no palette-constant unit tests. Record original failures and reruns.
- [ ] Commit shared foundation after focused checks; root publishes stable interfaces to module workers.

### Task 2: Workspace/editor/diagram/graph/trash presentation

**Files:** workspace ownership above; detail input map in `.superpowers/sdd/2026-11-05-platform-ui-unification/workspace-implementation-plan-proposal.md`. New meaningful tests can extend `platform-workspace-unification.spec.ts`.

- [ ] Preserve existing content/empty/search/collection renderer and all APIs; align headings/toolbars/forms/lists to shared surfaces and padding. Collection virtual card height252 and gap16 are behavioral constraints, not free design values.
- [ ] Update existing editor/large-file/draft/history/share/diagram windows through their real components and own scroll/footer rules. Retain source eligibility, full diagram Markdown vs inner Mermaid distinction, manual note save, diagram pending prepare/commit and busy close guards. Current loaded DiffView uses existing real renderer, not a table recreation.
- [ ] RED Graph saved-view UI: enter80 characters and persist the exact value via real command; try81st user keystroke/paste and verify actual value stops at80 and no invalid81 request is emitted. Old maxlength100 must fail. Reuse existing API validation/CAS tests; do not expand backend limits or add redundant string-policy tests.
- [ ] GREEN by changing only that existing frontend maximum100→80; retain raw-length-before-trim server rule and100-view limit.
- [ ] Apply graph/list/inspector/overlay and trash surface/layout changes with existing permission, semantic/similarity, request/pending/snapshot/rename/purge guards. No generic modal rewrite or hidden essential actions.
- [ ] Run appropriate focused existing save/history/diagram/graph/trash regressions from proposal, consolidating shared cases instead of re-running all suites per file. Save actual scope screenshots for final frozen capture; changed-source captures are historical until final fingerprint confirmed.
- [ ] Commit task-owned changes with concise result/failed/skipped evidence.

### Task 3: Settings/plugins/owner integration surfaces

**Files:** settings ownership above; detailed source map `.superpowers/sdd/2026-11-05-platform-ui-unification/settings-implementation-plan-proposal.md`.

- [ ] Reuse SettingsWorkspace/ActionCard/Overlay, canonical tokens and8px geometry; set sticky offset from actual external-header scroll contract. Preserve draft preview theme independently of saved global theme.
- [ ] Normalize storage/search/status/maintenance/backup/transfer/paged-record presentation. Long paths and actions wrap, wide tables scroll internally; no conditional remount that loses selected files/targets/request IDs.
- [ ] Normalize plugin directory/config/MCP permissions/API client forms and popup geometry in their own scopes. Preserve independent drafts, limits, grant ceilings, CAS/conflicts, one-time secret clearing, read-after-write errors and polling ownership.
- [ ] Normalize Git and actual plugin panels/CSS strings while preserving distinct native/plugin flows, SSH trust, push-only retry, unknown-result acknowledgement and existing close behavior. Do not invent contribution busy protocols.
- [ ] Use targeted existing transfer/status/plugin/MCP/Git tests. Only add a new behavioral test if a real changed layout exposes an uncovered interaction problem; pure radius/color changes receive screenshots and existing regressions.
- [ ] Verify desktop/390/320 long overlays and explicit dirty/busy states using isolated fixtures; commit only owned files.

### Task 4: Authentication/public/guest/blog/SSR/export presentation

**Files:** public/blog ownership above; detailed source map `.superpowers/sdd/2026-11-05-platform-ui-unification/public-implementation-plan-proposal.md`.

- [ ] Consume root theme in Login/Setup/OAuth/share reader/guest edit, with their existing role-specific hosts and real APIs. Preserve session-expiry/owner switching in root App, caller permission editors and pending CAS/draft/focus behavior. No owner rail in public routes.
- [ ] Normalize blog admin and studio using existing component/CSS layers, no fourth override layer. Preserve selected article identity, all metadata/textarea/order fields, manual saves/publication snapshots, draft-only history restoration and actual1100/375 preview viewport/sandbox.
- [ ] Normalize SSR neutral typography/surfaces/navigation/mobile wrapping while keeping journal/magazine/profile structure and configurable brand/font/width/cards. Preserve escaping/CSP/private preview/no-JS/skip-link and revoked assets. PB060 stays HTTP-only.
- [ ] Update only static readingStyles in `reading-export.ts`; preserve signatures, resource resolution, script-free/standalone/print semantics and real diagram preview data. Do not import Vue styles into exports.
- [ ] Run focused existing login/setup/OAuth/share/blog/SSR/security/export tests; new regression only for an actual uncovered behavior. Verify actual320/390 controls, preview iframe Escape/focus, three public templates and exported HTML.
- [ ] Commit owned files and truthful targeted evidence.

### Task 5: Final runtime evidence, broad validation and independent branch review

- [ ] Consolidate module commits; freeze application source/fingerprint. Build actual isolated browser fixtures, no real-user data. Capture all active page/window/state families from coverage at1440/390/320 plus current compact representative dimensions, light/dark representatives and exports. Reuse established188 baseline flows and existing tests rather than redo inventory.
- [ ] Store new PNGs separately from generated designs/baseline. Index sourceId/role/state/design current asset/viewport/theme/source commit+application fingerprint/hash/target bounds and actual interaction result. Distinguish absent/unmounted/nonvisual/hardware-unverified sources and genuine selector/test failures; design PNGs never count as runtime.
- [ ] Compare every active source family to approved composition and actual data/constraints; fix material failures and recapture affected states. Validate popup targets/hit/focus/scroll/main actions, not only root overflow.
- [ ] Central final commands: `npm test -- --maxWorkers=2`, `npm run typecheck`, `npm run build`, `npm run test:e2e`, and `npm run test:e2e -- --config=playwright.diagrams.config.ts --project=desktop`. Include relevant setup/release-browser coverage where existing runner differs. Keep each original run/result, skips and targeted reruns explicit.
- [ ] Request fresh independent whole-branch review with requirements, frozen design and diff/test/evidence package. Fix important findings with meaningful regression where applicable; run necessary affected checks. Do not claim completion from agent reports alone.

### Task 6: Preserve assets, integrate default and verify new executable artifacts

- [ ] Verify a separate design/runtime PNG archive outside Git with full hash manifest and restore/hash check; commit text prompts/reviews/indexes plus archive instructions/manifest. Do not commit credentials, databases, private exports, dependencies or unrelated original-workspace changes.
- [ ] Commit/push this task. Fresh-fetch actual remote default branch and latest tags using existing SSH identity; integrate without force, resolve only task conflicts, validate the actual integrated source and push normally. Do not switch/reset dirty original checkout.
- [ ] Select an unused new prerelease version at that time; use existing `scripts/release.mjs` and `verify:release` with previously verified local Node/search/legacy inputs. Source must be clean and bound to final commit; same-source alternate-version rollback artifact is built outside primary output.
- [ ] Run existing isolated install/browser/recovery/rollback gates and record version/paths/sourceCommit/SHA256. Artifact verification outputs stay outside committed source to avoid changing bound HEAD. No external Release publication or formal deployment.
- [ ] If updating the already-authorized independent5180 preview, inspect latest unit/release/profile first, preserve auth key/account/data and rollback pointer, use a new immutable release, verify real health/UI; formal service remains untouched.
- [ ] Deliver current URL(s), final remote SHA, actual screenshot index, complete original/rerun test results, verified new artifact paths/checksums and material remaining limits. The full parent objective ends only here.

## Plan self-review and execution ruling

The plan covers the full parent scope, consumes the approved390-asset contract and existing APIs, and reserves global interfaces to root. Three module proposals conflict only at `.apps-home`, `reading-export.ts`, root shell and common CSS; ownership above resolves those before work. User authorization already selects continuous execution, so generic skill handoff questions do not pause it. Shared foundation is sequential; later module files are disjoint and may proceed in parallel after the root interface handoff. Final broad verification and one fresh whole-branch review remain mandatory.
