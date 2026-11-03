# Full test repair and green validation

User explicitly requested fixing all 69 unclosed browser failures, then rerunning complete tests until green. Preserve all existing work and the standard MCP changes. No deployment, production data migration, service restart, or mixed-worktree commit.

## Review focus

- Fix production defects or stale tests from observed evidence; retain meaningful data, authorization, request identity and visual assertions.
- Do not skip, delete, force-click or weaken assertions just to obtain green. Use exact durable completion receipts for asynchronous writes.
- Keep startup draft ownership and delayed navigation protection, native diagram identity/link/PNG integrity, real index/model and Git workflows.
- Use independent source snapshots/ports for parallel work, then one final integrated source for complete unit, typecheck/build and desktop/mobile browser validation.

## Work groups

- [x] To Doo: focus/history, date ranges, lazy loading, navigation/disclosures, notification accumulation and overlays.
- [x] Startup/navigation: draft identity, delayed reads, settings/tabbar/scroll/lifecycle and tree action boundaries.
- [x] Diagram/native workflows: draft conversion, restore, portable preview, migrations and whiteboard editing.
- [x] Editor/search/Git: table toolbar, directory short viewport, search/history pagination, filename search and real remote sync.
- [x] Review and integrate all changes, rerun affected cases with durable evidence.
- [x] Freeze final combined source, run complete Vitest, typecheck/build, complete Playwright desktop+mobile. Fix any remaining failures and repeat full suites until green.
- [x] Update acceptance records and deliver exact totals, skips and limitations. No production deployment.

Evidence directory: `.local/full-green/`. Initial 69-failure ledger: `initial-failures.json`. Original traces: `.local/standard-mcp-api/snapshot-e2e-results/`; extracted error blocks: `.local/standard-mcp-api/remaining-brief.txt`.

## Completed validation — 2026-11-02

Original69:69/69 passed. Complete unit coverage:3635 passed plus2 real-package conditional cases separately passed,459files exactly once. Complete browser projects:desktop576 passed/mobile572 passed,zero unexpected/flaky;581cases each exactly once. All19 supplemental browser cases and17 real installation/recovery cases passed. Typecheck/build passed. Final program inputs are unchanged from final9; final10 unit and final11 browser reports record exact grouped execution/provenance. Acceptance: `docs/验收记录/2026-11-02-full-test-repair.md`. No commit/deployment/production data migration.
