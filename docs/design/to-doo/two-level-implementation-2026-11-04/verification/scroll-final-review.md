# Final scroll-change review

## Resolved finding

### [P2] Preserve the remaining-height allocation for short Focus pages

**Location:** `apps/web/to-doo-layout.css:4`.

The new `auto` second grid row inherits `align-content: start` from `.to-doo-workspace` (`apps/web/to-doo.css:5`). Unlike the previous `1fr` row, an auto row with start alignment does not consume spare height in a viewport-sized grid. Focus relies on that allocated main-row height: its main/page/content/panels chain distributes remaining height with `flex: 1` so the timer rests at the content bottom. With a short project/history area the new row can size to its intrinsic contents and leave the timer above the viewport bottom. Preserve viewport filling for short content while allowing the outer shell to grow for long content (for example by adjusting track alignment/sizing together with the non-shrinking flex item).

The parent's subsequent exact regression run confirms this: `/tmp/todoo-two-level-scroll-focus-final.log` reports the short-project test failing at `expectBottomBar` with a **351.703125px** bottom gap (allowed: at most 1px). The long-project case and five window/import cases pass. This reviewer read the completed log and did not run the browser.

## Other changes and evidence

- The non-shrinking hosted workspace addresses the measured mismatch between its box and overflowing content, extending the containing block used by sticky descendants.
- The import preview item list has a viewport-responsive maximum height and its own vertical scrolling; pagination and confirmation remain outside that scrolling list. No import data/action logic changes.
- The new regression exercises actual import preview and second-page navigation at 320px and 1440px, asserting visibility of the sticky header and confirmation/pagination controls.
- Inspected `/tmp/todoo-two-level-scroll-final.log`: **10 tests passed**, including both import widths, all-module shell boundaries, light/dark detail sizing and the earlier window tests. Build/typecheck reruns and final image recapture are owned by the parent.
- No tests or servers were rerun, no product files edited, and no subagents started.

**Verdict:** FAIL pending the confirmed P2 short-Focus layout fix. No other concrete issue found in the supplied diff.

## Final re-review — resolved

Reviewed `scroll-final-confirmed.diff`, the actual hosted-grid rule and the final browser log. The hosted grid now explicitly sets `align-content: stretch` alongside the non-shrinking flex item and auto content row. This allocates spare viewport height to the auto row for short content while preserving natural growth for long content, directly addressing the cause above.

`/tmp/todoo-two-level-scroll-all-final.log` confirms **12/12 tests passed**: both exact short/long Focus timer checks, long import at 1440px and 320px, mobile contextual navigation after deep scrolling, management contrast, persisted tag color, saved review metrics, long settings header behavior, module shell boundaries, and light/dark detail geometry. The added mobile check navigates to Lists after preview pagination and verifies the resulting heading.

**Final verdict: PASS for spec compliance and code quality in this bounded scroll change. The P2 is resolved; no outstanding finding.** The earlier failed verdict and 351.7px measurement are retained above as history. Fresh delivery build/typecheck and the 84-image recapture are separate parent-owned checks. No tests, servers, or product edits were performed by this reviewer.
