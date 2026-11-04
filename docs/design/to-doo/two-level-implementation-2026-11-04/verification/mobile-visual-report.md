# Mobile visual acceptance

Review date: 2026-11-04. Reviewer: `two_level_mobile_visual`.

Status: **28/28 actual 320 × 844 scenes accepted; no unresolved P1/P2 visual finding.** This is a visual review of actual rendered product captures, using the approved concept scene descriptions for functional context rather than desktop geometry. No product code, tests, or services were changed by this reviewer.

All 28 final JSON records were verified as `source.commit: f44d6086f3977e27dfd7c9703a38050ca29a93c0`, source SHA-256 `f9e29633e3e19ba023cebb731ce52de875db99d77c8277c8de4e74955706e954`, and `consecutiveCapturePixelsStable: true`. Every actual PNG SHA-256 matches its adjacent final JSON. Sources are under `docs/design/to-doo/two-level-implementation-2026-11-04/screenshots/`; accepted scene titles and filenames come from `docs/design/to-doo/layout-redesign-two-level-2026-11-04/generation-plan.json` and its README. Generic or old draft screenshots were not used.

The first visual pass individually viewed 27 actual 320 px images after verifying source `e7a98c3477533265dffa436b966dbc3328b4a126`; scene 15 had no eligible image then. At the `1339c06` freeze, all 11 new or changed PNGs were individually viewed again: **12, 15, 16, 20, 22, 23, 24, 25, 26, 27, 28**. The other 17 PNGs were byte-identical to the first pass; those visual reviews carried forward. Old hashes were retained before overwrite and cross-checked against `pre-visual-fix-captures.json`.

For the final delivery freeze `f44d608`, all 28 JSON/PNG pairs were verified again. **Only scene 15 changed against `1339c06`; it was individually re-viewed and accepted. The other 27 PNGs are byte-identical to their already reviewed versions.** Thus all final scenes have actual 320 px visual review coverage, with no changed image carried without re-review.

## Findings

No unresolved P1/P2 visual finding remains.

Resolved after the final source freeze and visual re-review:

- Scene 15 now keeps the ToDoo top bar and “数据与恢复” heading visible, bounds the 49-pending/0-duplicate preview, and shows page 1/3, next-page, confirm-49, and cancel-preview controls above the host bottom navigation. No title overlap or outer overflow is visible. Accepted PNG SHA-256: `4fcb58c82b5fc562b0496a9af7bf3efd1fa9286261908d13e1d9c77b41b104bf`. The earlier deep-scroll image was replaced.
- Scene 20 now shows the actual quantity-recording/correction dialog opened from Today, including the existing record, undo, numeric entry, record action, and close footer. The initial history-only capture was replaced.
- Scene 28 now exposes a labeled native color field and the save/cancel footer. Scenes 25–27 also expose their new color field without losing footer visibility.
- Scene 16 now renders the blue “新建清单” primary action with a white label.
- Scene 23 now visibly includes the actual statistics snapshot (1 completed, 125 minutes, 0 outcomes), snapshot time and explanation, with save/cancel visible.

## Scene-by-scene review

All rows below identify the actual image viewed. “Pass” refers to the shown viewport and visible controls, not a claim of interaction or complete scrolling validation. The capture harness supplies separate assertions; this reviewer did not rerun tests.

| Scene | Actual image | Viewport | Visual result |
| --- | --- | --- | --- |
| 01 目标总览 | `320-01-overview.png` | 320 × 844 | Pass: headings, goal/list content, creation actions, and host bottom navigation fit. |
| 02 任务列表与详情 | `320-02-tasks-list-v2.png` | 320 × 844 | Pass: actual task detail is open; readable fields and saved state; focus footer and host navigation visible. |
| 03 看板 | `320-03-board.png` | 320 × 844 | Pass: stacked status columns and cards; labels wrap within cards; new-task action visible. |
| 04 四象限 | `320-04-matrix.png` | 320 × 844 | Pass: stacked quadrants, scope counts, task priority selector, and primary action fit. |
| 05 月日历 | `320-05-calendar-month.png` | 320 × 844 | Pass: mobile agenda, period controls, task/event labels, and add-schedule actions readable. |
| 06 周日历 | `320-06-calendar-week.png` | 320 × 844 | Pass: mobile agenda and calendar controls fit; event information remains readable. |
| 07 时间线 | `320-07-timeline.png` | 320 × 844 | Pass: timeline remains a scoped horizontal area; surrounding controls and guidance fit. |
| 08 专注 | `320-08-focus.png` | 320 × 844 | Pass: project names wrap; timer, start/settings controls, and host navigation remain visible. |
| 09 习惯 | `320-09-habits.png` | 320 × 844 | Pass: three habit cards, quantity/unit inputs, and record actions readable. |
| 10 纪念日 | `320-10-anniversaries-v2.png` | 320 × 844 | Pass: birthday/lunar cards, dates/countdowns, details, and new action fit. |
| 11 统计与复盘 | `320-11-stats.png` | 320 × 844 | Pass: statistic cards, explanatory text, chart, and new-review action fit. |
| 12 通知中心 | `320-12-notifications.png` | 320 × 844 | Pass: date controls stack; notice content, status, and task link fit. |
| 13 偏好设置 | `320-13-settings-preferences.png` | 320 × 844 | Pass: form sections and visible selects/inputs fit; save preference action visible. |
| 14 提醒与连接 | `320-14-settings-connections.png` | 320 × 844 | Pass: reminder/calendar connection sections and visible input/actions fit. |
| 15 数据与恢复 | `320-15-settings-data-v2.png` | 320 × 844 | Pass: top bar/header visible; bounded 49-row import preview; pagination, confirm-import, and cancel-preview controls visible above host navigation. |
| 16 清单管理 | `320-16-settings-lists.png` | 320 × 844 | Pass: corrected white primary label; cards and structural actions fit. |
| 17 筛选无结果 | `320-17-tasks-filtered-empty.png` | 320 × 844 | Pass: scope, query/filter context, empty state, clear-filter and all-task actions visible. |
| 18 新建任务 | `320-18-task-create-v2.png` | 320 × 844 | Pass: actual creation sheet; stacked create/retain/abandon footer entirely visible above host navigation. Long form has separate content scrolling. |
| 19 新建习惯 | `320-19-habit-create-v2.png` | 320 × 844 | Pass: actual modal open; readable fields; cancel/save footer fully visible. |
| 20 习惯记录与更正 | `320-20-habit-entry-v2.png` | 320 × 844 | Pass: actual record/correction dialog open from Today; saved row/undo, numeric record field/action, and close footer visible. |
| 21 新建时间安排 | `320-21-schedule-create.png` | 320 × 844 | Pass: actual modal open; date/time/duration fields and cancel/save visible. |
| 22 新建纪念日（农历） | `320-22-anniversary-create.png` | 320 × 844 | Pass: actual modal open; lunar fields, options, appearance controls, and fixed cancel/save footer fit. Preview stays within scrollable body. |
| 23 新建复盘 | `320-23-review-create.png` | 320 × 844 | Pass: actual modal open; period/body fields, actual statistics snapshot, timestamp/explanation, and cancel/save footer visible. |
| 24 成果笔记与预览 | `320-24-outcome-note-v2.png` | 320 × 844 | Pass: actual modal open; rendered Markdown preview, completion option, retain/create-and-link actions fit. |
| 25 新建目标 | `320-25-goal-create-v2.png` | 320 × 844 | Pass: actual modal open; goal/list type, target date, color, additional-fields disclosure, and footer visible. |
| 26 新建清单 | `320-26-list-create.png` | 320 × 844 | Pass: actual modal open; list/goal type, color, additional-fields disclosure, and footer visible. |
| 27 新建专注项目 | `320-27-focus-project-create.png` | 320 × 844 | Pass: actual modal open; name, color, additional-fields disclosure, and cancel/save visible. |
| 28 新建标签 | `320-28-tag-create.png` | 320 × 844 | Pass: actual modal open; name, labeled color field, and cancel/save footer fit. |

Extra waiting-period checks at 390 × 844: scenes 01, 02, 05, 06, 18, 22, and 24 were inspected via `view_image` during the initial `e7a98c3` pass. They do not substitute for the final 320 px coverage above and are not described as final-source re-review.

The mobile shell uses the context-drawer entry and host bottom navigation rather than reproducing the desktop two-column navigation geometry. No outer horizontal overflow, heading overlap, or fixed-dialog-footer obstruction is visible in the accepted captures. Scenes 19–28 all visibly show their actual operation windows and primary controls. A static image alone does not establish hit-target size, actual scrolling, drawer interaction, keyboard behavior, or hidden-content reachability; those remain covered by the main acceptance process.
