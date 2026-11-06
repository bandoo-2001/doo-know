# ToDoo 桌面浅色布局概念稿

这套图稿用于讨论 ToDoo 的整体布局与主要操作流程，是本地静态文档附件。所有任务、清单、目标、日期、统计及连接状态都是示例数据，不对应真实账号数据。本次仅产出概念图和图集，未部署产品 UI 或修改产品账号。图集另有临时只读查看入口。

打开 [图集 index.html](./index.html)，可按主页面、空状态、操作窗口筛选，搜索标题或编号，并点击预览查看原图。图集不依赖网络服务或额外库，可直接从本地文件打开；桌面显示两到三列，手机显示单列。目录默认收起，展开后的导航区域最高 160px，可独立滚动。

已完成 28 张最终图：16 张主页面、1 张筛选空状态、11 张操作窗口。最终图集已通过完整性检查。[参考草稿](./reference-draft.png) 仅用于风格参考，不计入最终图。

## 最新菜单方向

用户已将菜单方向调整为“窄模块栏＋任务上下文栏”，以[两级菜单修订样张](http://100.93.35.65:5181/menu-revision/)为准。这里的原28张图保留作内容布局参考，尚未逐张套用最新菜单；历史提示词保持原样，后续生成应优先使用新的两级菜单参考。

## 共同布局原则

- **统一导航**：任务范围、命名清单和其他模块使用一套左侧导航。品牌 / 工作空间菜单保留返回目标总览及知识库的入口，避免目标总览被任务范围取代。
- **弹性内容**：列表、看板、日历、时间线等视图根据内容使用可用宽度；长时间线保留横向滚动空间，不将所有日期压成过窄的列。
- **按需详情**：选中任务或执行相关操作时展开详情或窗口；没有选中任务时，内容区域恢复完整宽度。
- **空状态分三种**：全库无任务用于引导创建第一项任务；时间范围为空用于解释当前范围并提供切换范围入口；附加筛选无结果用于保留筛选上下文并提供清除筛选入口。第 17 张展示第三种状态，不代表账号没有任务，也不代表任务全部完成。

原图的风格不是唯一实现约束。实际落地仍需根据现有组件、真实数据与屏幕尺寸进行响应式布局、键盘操作、表单校验、滚动和交互状态验证。静态图中的控件不是可操作的产品功能。

## 主页面

| 编号 | 图稿 |
| --- | --- |
| 01 | [目标总览](./01-overview.png) |
| 02 | [任务列表与详情](./02-tasks-list-v2.png) |
| 03 | [看板](./03-board.png) |
| 04 | [四象限](./04-matrix.png) |
| 05 | [月日历](./05-calendar-month.png) |
| 06 | [周日历](./06-calendar-week.png) |
| 07 | [时间线](./07-timeline.png) |
| 08 | [专注](./08-focus.png) |
| 09 | [习惯](./09-habits.png) |
| 10 | [纪念日](./10-anniversaries.png) |
| 11 | [统计与复盘](./11-stats.png) |
| 12 | [通知中心](./12-notifications.png) |
| 13 | [偏好设置](./13-settings-preferences.png) |
| 14 | [提醒与连接](./14-settings-connections.png) |
| 15 | [数据与恢复](./15-settings-data-v2.png) |
| 16 | [清单管理](./16-settings-lists.png) |

## 空状态

| 编号 | 图稿 |
| --- | --- |
| 17 | [筛选无结果](./17-tasks-filtered-empty.png) |

## 操作窗口

| 编号 | 图稿 |
| --- | --- |
| 18 | [新建任务](./18-task-create-v2.png) |
| 19 | [新建习惯](./19-habit-create.png) |
| 20 | [习惯记录与更正](./20-habit-entry-v2.png) |
| 21 | [新建时间安排](./21-schedule-create.png) |
| 22 | [新建纪念日（农历）](./22-anniversary-create.png) |
| 23 | [新建复盘](./23-review-create.png) |
| 24 | [成果笔记与预览](./24-outcome-note.png) |
| 25 | [新建目标](./25-goal-create-v2.png) |
| 26 | [新建清单](./26-list-create.png) |
| 27 | [新建专注项目](./27-focus-project-create.png) |
| 28 | [新建标签](./28-tag-create.png) |

## 提示词与重新构建

- [generation-prompts.json](./generation-prompts.json)：第 02、17 张基础图稿的提示词、来源及尺寸。
- [generation-plan.json](./generation-plan.json)：其余 26 张图稿的生成提示词和参考图关系。
- 后续生成的图片旁有同名 JSON，记录对应提示词、参考图、来源与尺寸；已存在的记录可从图集卡片打开。
- [build-gallery.mjs](./build-gallery.mjs)：仅使用 Node 内置模块，读取上述两份清单并生成 [index.html](./index.html)。它不会生成、编辑或删除图片。

在仓库根目录运行：

```bash
node docs/design/to-doo/layout-redesign-2026-11-04/build-gallery.mjs
```

全部图片生成后，可使用严格模式检查 01—28 张均已存在且具有 PNG 文件头，再生成图集：

```bash
node docs/design/to-doo/layout-redesign-2026-11-04/build-gallery.mjs --require-complete
```

普通模式允许缺图并生成占位卡片；每批图片生成后重新执行即可更新预览、尺寸、生成记录链接和数量。严格模式如发现缺图会退出并列出文件名。生成器不会检查概念图的视觉或业务正确性，最终图数与内容仍需人工复核。

## 选稿校准

已统一数据页四个设置页签及导入范围；未完成筛选的列表不混入已完成分组；习惯记录的“记录”负责提交本次增加，“关闭”只关闭窗口；目标类型使用“目标/清单”。旧图与参考草稿保留，不计入28张最终选稿。

日历刻度、进度数值、字段必填与长度、导航细节在正式实现时以真实数据和现有契约校准；弹窗背景为模块上下文示意。所有图均为内置图像生成工具产生的静态概念，不能作为已上线功能或交互测试证据。

## Tailscale 图集预览

访问地址：`http://100.93.35.65:5181/`（需连接同一Tailscale网络）。此入口只展示生成的概念图片与提示词，不是可交互的ToDoo产品界面。

图集副本：`/srv/stacks/knowledge/doo-know-ui-concepts/releases/2026-11-04-v1/`。临时用户服务：`doo-know-ui-concepts.service`，使用Python标准库只读提供该目录，端口仅绑定本机Tailscale地址；未设置开机自启。

停止查看服务：

```sh
systemctl --user stop doo-know-ui-concepts.service
```

如需重新启动：

```sh
systemd-run --user --unit=doo-know-ui-concepts --collect \
  --property=WorkingDirectory=/srv/stacks/knowledge/doo-know-ui-concepts/releases/2026-11-04-v1 \
  --property=UMask=0077 \
  /usr/bin/python3 -m http.server 5181 --bind 100.93.35.65 \
  --directory /srv/stacks/knowledge/doo-know-ui-concepts/releases/2026-11-04-v1
```

## 图集检查结果

最终选稿28张（16主页面、1空状态、11操作窗口），所有PNG均1568×1003；5处修订已选入图集，旧版本不计最终图数。172个本地文件/锚点引用核对有效，HTTP服务上的28张图片与源文件散列一致，所有原图请求200。真实Chromium验证：28卡、无生成中，操作窗口筛选11、空状态1、关键词“农历”1；1440px三列和390px单列均无横向溢出，展开目录最高160px，无脚本异常。
