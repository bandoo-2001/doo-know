# Task 3 narrow plugin conflict alert — local visual fix

Base: `6b9376998bc5f683b34158106ef992fc9220957d`. Independent tree: `/home/bandoo/.codex/worktrees/platform-settings-alert/doo-know`. Status: local RED→GREEN and targeted regressions completed; root's same-reviewer review/capture/integration remain pending. **No stage or commit.** Main product/capture files were not edited.

## Problem and minimal implementation

The current runtime review's sole P2/ST-VIS-P2-001 is confirmed. AntAlert's flex content (`flex:1;min-width:0`) shared its row with the fixed-width reload action. At narrow widths the action consumed the text space: local 320px reproduction measured zero content width and one Chinese character per line; 390px measured 54px and four characters per line. The actual CAS conflict and real popconfirm had already opened; this is not a missed loading or screenshot state.

Modified only:

- `apps/web/components/PluginManager.vue`: add `plugin-config-conflict` to the existing remoteChanged AAlert. Within its existing ≤600px component media scope, use icon/content grid columns and place only that alert's action below the content. Constrain the direct reload button/text span to available width, permit wrapping and auto height with a 36px minimum target. Desktop selectors, shared Ant, vendor windows, popconfirm portal geometry and other alerts are untouched.
- `tests/e2e/plugin-conflict-layout.spec.ts`: new actual UI regression for 320/390/1440 real CAS conflict, popup/cancel/discard, original draft/version behavior and readable copy; one independent synthetic long-credential containment check at320/390. No mirrored CSS radius/grid constant assertions.

Static SFC comparison confirms script/scriptSetup match the base byte-for-byte. Template changes consist solely of the alert class; all dirty/busy/CAS/save/reload callbacks and copy stay the same. Resource-tree inherited-label P3 is deferred exactly as assigned.

## Actual layout measurements

| viewport | before content width | after content width | before widest description line | after widest description line | after action placement |
|---|---:|---:|---:|---:|---|
|320|0px|160px|1 character|12 characters|below text|
|390|54px|230px|4 characters|17 characters|below text|
|1440|618px|618px|35 characters|35 characters|original right side|

The 1440px alert remains 878×93.609375px in both runs. The 320px alert height changes1101.53125→227.21875px; 390 changes352.046875→183.609375px. These are observed browser rectangles, not hardcoded production sizes.

New tests measured actual character Range rectangles and the available content/alert width ratio, verified reload and both popup actions' center hits, keyboard focus/Enter opening, native disabled save during conflict, retained draft on cancel, and the actual remote config baseline after discard/reload. The final copy screenshot requires the whole alert to be in viewport with the popup closed, alongside a separate real popup frame. Long Git credential replace/remove controls are contained, hit-testable and at least36px high at320/390; synthetic credentials are removed afterward through the real bodyless DELETE contract.

## Commands and observed outcomes

All commands ran in the independent tree, only fixture ports4879/4880. Config origin was the actual `http://127.0.0.1:4879`; no accounts/services/real data outside the temporary fixture were used.

1. RED: `DOOKNOW_E2E_WEB_PORT=4879 DOOKNOW_E2E_API_PORT=4880 npm run test:e2e -- tests/e2e/plugin-conflict-layout.spec.ts --project=desktop --output=.local/settings-alert-red`
   - exit1; both320/390 actual readability checks failed,1440 passed. The unrelated long-credential geometry checks completed, but its new test cleanup failed400 because the helper sent JSON Content-Type with an undefined DELETE body. Corrected only that test helper to follow the actual API's bodyless contract; retained the original RED log/screenshots.
2. First GREEN: same dedicated file with `.local/settings-alert-green`: **4 passed**,21.0s.
3. Added the separate unobscured copy screenshot/full-alert-in-viewport assertion and formatted only the new test. Final dedicated run: same file with `.local/settings-alert-final`: **4 passed**,22.8s, exit0.
4. Existing semantic regression: `DOOKNOW_E2E_WEB_PORT=4879 DOOKNOW_E2E_API_PORT=4880 npm run test:e2e -- tests/e2e/plugin-config.spec.ts --project=desktop -g 'preserves input on remote changes' --output=.local/settings-alert-cas-regression`: **1 passed**,11.5s, exit0.
5. `npx vitest run tests/plugin-config.test.ts tests/mcp-authorization-ui.test.ts --maxWorkers=1`: **2 files /46 tests passed**,1.38s, exit0.
6. Scoped SFC CSS compilation/controller/template comparison and `git diff --check`: PASS. No dependency installation, full test suite, full E2E suite, typecheck/build or production operation.

## Visual evidence inspected

Author opened final actual `conflict-copy.png` for320/390/1440 and real popconfirm PNGs for320/390. Text is now normally readable, the reload action is below copy on phones, and1440 retains its previous layout. PNG/JSON artifact paths and SHA256 are in `task-3-alert-visual-fix-evidence.json`; original RED/first GREEN/final/regression logs remain in the native `.local` tree. This is local author verification, not the independent review gate or a global runtime completion claim.

## Patch handoff

Patch against exact base (only product file + new E2E): `/home/bandoo/.codex/worktrees/60c5/doo-know/.superpowers/sdd/2026-11-05-platform-ui-implementation/task-3-alert-visual-fix.patch`

SHA256: `7416f36368d00ae43aa51a160cfacc82b923e0469e1b0b4f419fc684ac45eb2b`

Main ignored report/patch/manifest only were written for handoff. Product changes remain unstaged/uncommitted in the independent tree. Root should independently review then integrate, and perform its own final combined-source capture. No other P3/settings/capture scope was added.
