# Desktop visual acceptance — 1440 × 1000

Status: **Final delivery freeze — 28 of 28 desktop scenes reviewed and accepted. No open desktop visual findings.**

Final evidence is source commit `f44d6086f3977e27dfd7c9703a38050ca29a93c0` and source SHA-256 `f9e29633e3e19ba023cebb731ce52de875db99d77c8277c8de4e74955706e954`. All 28 adjacent JSON files identify this source; all 28 PNG byte hashes were independently recomputed and match their JSON. Compared with the personally inspected `1339c06` batch, delivery scenes **15, 22, 24, 27** changed and were reopened with `view_image`. The other **24 delivery images are byte-identical** to already inspected and accepted images, so their prior image inspection is retained.

Review history: the first inspection covered 27 scene pairs while scene 15 awaited current evidence. The `1339c06` batch then received all 28 scene inspections, including reopening the 10 images changed from `pre-visual-fix-captures.json`. That intermediate batch's automated capture completion did **not** establish final visual acceptance: its scene 15 was rejected by human image review. Only the delivery evidence above closes that rejection.

Each scene was compared against its selected PNG in `docs/design/to-doo/layout-redesign-two-level-2026-11-04/`, with primary/secondary expectations from `generation-plan.json` and the README. Fixture titles, dates, counts, task/habit values, and connection state were not treated as defects. No server, tests, or application code were changed for this review.

## Findings

**Closed — scene 15 retains its shell and complete import-preview controls.** The final delivery image (PNG SHA-256 `54600eb87b782086a9e53a1bb85b6e5da0aa4927f7b65aa22cccd01ff2b2062f`) visibly retains the compact top app bar, global rail, and contextual settings sidebar with **数据与恢复** selected. The preview summary and bounded record list are coherent; **第 1 / 3 页**, 下一页, **确认导入 49 项**, and 取消预览 are visible inside the 1440 × 1000 viewport. The fixture's 49 import entities need not equal the concept's 23 example rows. The previous shell loss and cut-off control issue is no longer present. Evidence: [delivery scene 15](../screenshots/1440-15-settings-data-v2.png), [approved scene 15](../../layout-redesign-two-level-2026-11-04/15-settings-data-v2.png).

The three initial findings are **closed by direct reinspection**:

1. Scene 20 now selects **习惯 → 今天**, retaining today's habit cards behind a visibly open record/correction dialog. Entry, saved record, undo, and Close actions are visible.
2. Scene 23 now visibly presents the statistics snapshot, snapshot time/timezone, and the explanation that it is recomputed for the selected dates and saved with the review. The expanded card fits with the footer fully visible.
3. Scene 28 now visibly includes a labeled native color control and its color value. It retains a compact, complete dialog with Cancel/Save. Shared color controls on scenes 25–27 also fit without hiding their footers.

## Shared visual checks

Reviewed delivery captures consistently show a narrow global module rail, an adjacent contextual sidebar, and the compact app bar beginning after the rail. No old combined sidebar, third navigation column, duplicate settings tab strip, or duplicated module/view navigation was visible. Lists, board, calendar, matrix, and timeline use the available main width without a shell collision. The timeline retains wider-than-viewport content instead of forcing all dates into the visible width. Scene 16's primary 新建清单 button uses readable white text.

All eleven operation scenes (18–28) visibly show their actual panel/dialog, readable visible fields, and footer action buttons inside the desktop viewport. Scene 22 is a tall dialog with the footer retained at the bottom; its window itself is not clipped outside the viewport. The twelve applicable JSON records (detail scene 02 plus scenes 18–28) report `primaryActionReachable: true`; this supports, rather than replaces, the image inspection. Screenshots cannot establish keyboard operation or the reachability of content below a scroll area.

The actual UI has denser typography and spacing than the conceptual images, while preserving readable desktop fields and navigation. Different data-driven row/card counts and compact optional-field disclosures were not counted as navigation regressions.

## Scene coverage

Actual evidence directory: `docs/design/to-doo/two-level-implementation-2026-11-04/screenshots/`. Each filename below has the `1440-` prefix and `.png` extension; its approved counterpart has the same base filename without `1440-`.

| Scene / image base | Expected primary → secondary | Visual result |
| --- | --- | --- |
| 01-overview | 任务 → 目标总览 | Shell and alignment accepted. |
| 02-tasks-list-v2 | 任务 → 近七天 | Shell accepted; detail panel fully open. |
| 03-board | 任务 → 近七天 | Four board columns use remaining width; add actions visible. |
| 04-matrix | 四象限 → 近七天 | Correct two-level context; quadrants align to main width. |
| 05-calendar-month | 日历 → 月视图 | Correct context; full month grid. |
| 06-calendar-week | 日历 → 周视图 | Correct context; week grid and events readable. |
| 07-timeline | 日历 → 时间线 | Correct context; long timeline preserves horizontal extent. |
| 08-focus | 专注 → 项目 | Correct context; project/history areas and timer footer visible. |
| 09-habits | 习惯 → 今天 | Correct context; cards and record controls readable. |
| 10-anniversaries-v2 | 纪念日 → 全部 | Correct context; cards aligned without collision. |
| 11-stats | 复盘 → 统计概览 | Correct context; chart/progress/review areas aligned. |
| 12-notifications | 通知 → 全部 | Correct context; status links moved to sidebar. |
| 13-settings-preferences | 设置 → 偏好 | Correct context; no duplicate settings tabs. |
| 14-settings-connections | 设置 → 提醒与连接 | Correct context; connection fields readable; main page extends vertically. |
| 15-settings-data-v2 | 设置 → 数据与恢复 | Accepted on delivery reinspection: top bar/context retained; bounded preview, pagination and confirmation controls visible. |
| 16-settings-lists | 设置 → 清单管理 | Correct context; list/tag management aligned. |
| 17-tasks-filtered-empty | 任务 → 近七天 | Correct filtered-empty semantics; filter chip, clear filter and all-task exits visible. |
| 18-task-create-v2 | 任务 → 近七天 | Correct context; creation panel and draft/footer actions visible. |
| 19-habit-create-v2 | 习惯 → 今天 | Correct context; complete dialog and footer visible. |
| 20-habit-entry-v2 | 习惯 → 今天 | Accepted after reinspection: Today selected with actual record/correction dialog and complete actions. |
| 21-schedule-create | 日历 → 周视图 | Correct context; complete schedule dialog and footer visible. |
| 22-anniversary-create | 纪念日 → 全部 | Correct context; lunar fields, preview, and retained footer visible. |
| 23-review-create | 复盘 → 统计概览 | Accepted after reinspection: snapshot, time and save explanation visible; footer retained. |
| 24-outcome-note-v2 | 任务 → 近七天 | Correct context; Markdown preview and retained-input/create footer visible; no obsolete completed group visible. |
| 25-goal-create-v2 | 任务 → 目标总览 | Correct context; 目标 selected with 清单 alternative; color and complete footer visible. |
| 26-list-create | 设置 → 清单管理 | Correct context; 清单 selected with 目标 alternative; color/footer visible; no settings tab duplicate. |
| 27-focus-project-create | 专注 → 项目 | Correct context; color and complete project-dialog footer visible. |
| 28-tag-create | 设置 → 清单管理 | Accepted after reinspection: color control present; compact complete dialog. |

## Remaining acceptance work

None for this desktop visual review. All 28 desktop scenes are accepted at the delivery source freeze `f44d608`; this report does not claim completion of the separate mobile or full capture-suite work.
