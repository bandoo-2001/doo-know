# Settings actual runtime 逐图设计对照

审查对象：`docs/design/platform-unification-2026-11-05/runtime/2026-11-05-55174d4-main-remaining/` 中带 ST-* 的 sidecar。仅审已有 captured 的实际 PNG；未生成、捕获失败、未打开的 controls 帧均保留 pending。没有改产品、harness、Git、服务或真实数据，也没有启动浏览器/测试/server。

机器可读逐图账本：`docs/design/platform-unification-2026-11-05/runtime/reviews/settings-main-review.json`。含全部 **330 个 ST 关联 sidecar** 的 sourceIds、viewport、state、PNG SHA、设计引用 SHA、实际查看标记、逐图结论、缺口和问题。

## 已完成范围与结论

已实际打开全部 **286 张 captured 主 PNG**：1440 为 97 张、390 为 95 张、320 为 94 张；另实际打开必要 controls 帧并通过相同 SHA 复用相同图像，账本共记 **131 张 controls 图已看**，其余 controls 明确 `pending-unreviewed`。已打开 **65 个 current 设计参考**；每张已审主图至少有一个实际打开的对应设计参考。全部 286 张主图最终 SHA 与 sidecar 相符，所有 supplied ST 设计引用 SHA 核对无差异。

| 宽度 | 主图已看 | 仅可见帧布局无问题 | 可见帧带 Minor | 可见布局失败 | 状态未完整入图 | 受后续版本影响待补拍 | 捕获失败 pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1440 | 97 | 88 | 0 | 0 | 7 | 2 | 13 |
| 390 | 95 | 86 | 0 | 1 | 6 | 2 | 15 |
| 320 | 94 | 85 | 1 | 1 | 5 | 2 | 16 |

“仅可见帧布局无问题”不是 source 全状态通过；这些行的最终 acceptance 仍为 `pending-full-state-gate`。本 run 全部是 **light**，不能借此宣称 dark 或全平台通过。原集中测试的非零退出与失败报告不受本图审影响。

## Important / P2

**ST-VIS-P2-001：插件配置冲突 Alert 在 320/390px 被右侧 action 挤成竖长文字列。**

- 实图：`390-light-settings-extra-plugin-reload-confirm.png`、`320-light-settings-extra-plugin-reload-confirm.png`；ST-051 / ST-052。对应参考已看 `MP-D040` / `MP-S017` / `MP-R020` / `MP-D014`。
- 实际状态已经出现：已保存配置冲突 Alert、重新载入按钮，以及实际点击后的“重新载入会丢弃当前未保存输入，确定继续？”popconfirm 都在图中。因此这不是未触发或未滚到该状态。
- 390px：action 占去警告正文右侧，message/description 只剩约 5–6 汉字宽。320px：正文只剩约一个汉字宽，“保存配置在其他位置发生变化…”逐字竖排并延伸到视口下方，反馈阅读严重受损。popover 本身和两个确认动作仍在视口内；没有证据表明点击被完全阻断。
- 代码定位供实施者收口：`apps/web/components/PluginManager.vue:610` 的 remoteChanged AAlert 与 `:616` action slot，重载按钮在 `:626`。
- 最小方向：只在 PluginManager 的这个冲突提示范围，窄宽将 action 放到正文下方，保持正文可用宽度；按钮可收缩/必要时换行。保留原 CAS、草稿与 popconfirm 流程，不作全局 AntAlert 重写。
- 验收应补拍 320/390 的真实 conflict + reload popconfirm，正文横向正常阅读、完整按钮可见，并实际保留当前输入/放弃重载各验证一次。

## Minor / P3

**ST-VIS-P3-001：320px 资源树的“随父目录包含”占据长标签宽度。**

实图 `320-light-settings-extra-mcp-resource-tree.png`（ST-063；对应已看 `MP-D050`）。popup 处于视口内，但固定同行 hint 加上缩进/图标，把多个长 fixture 名压成 `captu` / `re-…` 这样的两行小片段，条目辨认性弱于设计参考。建议在窄 popup 将 hint 放到次行或减少其保留宽度，让名称有更多空间；未证明资源选择被阻断，不升级为 P2。

## 图像证据缺口：不等同产品 after-click 反馈不可见

以下是 **18 个 captured 帧未完整证明所声明状态**；详细逐图 sourceIds/说明已入 JSON。没有重新操作浏览器，因此除上面的 P2 可见排版外，不把“图片没拍到”推断成“产品无法显示/滚到”。

| scene / sources | 宽度 | 已见与缺失 / 需要补拍 |
| --- | --- | --- |
| preferences-preview / ST-010 | 1440 | 主图与 controls 都只有预览标题/说明，sample 在 y≈1000 下方；明确未滚到样例内容。390/320 能看见实际 sample，不因此替代桌面帧。 |
| settings-extra-client-cas-conflict / ST-071, ST-066 | 1440 | 冲突提示与保留名称起始可见，但 save/reload 动作不在这两张图；补 form/action 对齐帧。 |
| settings-extra-client-permission-conflict / ST-067, ST-071 | 1440,390,320 | 可见 disabled save/reload 区域，冲突提示自身未入图；需补 alert 与 draft/动作。不能仅凭“有 reload 按钮”验收完整冲突提示。 |
| settings-extra-oauth-narrow-error / ST-060 | 1440 | 表单与动作可见，错误提示未入图；390/320 的同类真实错误提示已见。桌面需要明确滚到错误。 |
| settings-extra-oauth-revoke-error / ST-061 | 1440,390,320 | 图中最多到 revoke confirmation，rejection alert 不在主图/controls。sidecar 声明 rejection fixture，但无法据图裁定是否已触发 renderer、未滚到，或 after-click 应自动露出；请补准确 error target。 |
| settings-extra-plugin-config-conflict / ST-051, ST-049 | 1440,390 | 主图 dirty、controls 页面底部，两者跳过中部冲突 banner；320 此 recipe 捕获失败。补实际 banner/draft/save/reload 帧。 |
| settings-extra-plugin-restart-warning / ST-054, ST-049 | 1440,390,320 | sidecar 明确注入 registry restartRequired flag，但已看主图和 controls 没有 restart warning；尚不能区分未触发 renderer 与未滚到，需要精确 warning 状态帧。 |
| mcp-create-client / ST-065 | 390,320 | primary/controls 各只覆盖部分创建表单；390 name/expiry 本身缺失，320 name/expiry 仅部分露出；补 name/expiry/policy 与 actions 可对照的滚动帧。 |
| settings-extra-import-preview-error / ST-021 | 390,320 | 初始选择表单可见，错误在下方；390 controls 到已选择文件处仍没有错误，320 controls 未看。补 body 滚到 error/保留文件的帧；不据此断言产品 after-click 不可见。 |

普通 `settings-library` 是多 source 父页面：主图只见上半部，1440 controls 跳到分享列表底部；不能顺带把正常 storage/organization/retention/Git 全状态标通过。专门的 storage-error controls 已实际看到错误和刷新入口，不能混写为 storage 错误仍未出现。类似地，mcp-config 父图不能替代 bridge、完整贡献面板、OAuth/CAS 等互斥内层状态；账本已逐帧限制。

## 版本与其它 pending

- `settings-extra-git-auth-failed-task`（ST-080）与 `settings-extra-git-import-owner`（ST-081）三宽共 **6 帧**：历史图已看，但 root 告知 `6b937` 又修 Git feedback / setup；标 `pending-latest-affected-recapture`，不能当最新 main 通过。长凭据 controls 的 320/390 ASCII/中文动作已实际看到完整换行和图标，不把这个观察扩大成所有 Git feedback 通过。
- **44 个 selector/flow failure** sidecar 保持 pending，逐图保存在 JSON；其 failure PNG 不作验收。涉及 import preview/review、disk confirm/409/busy、retention、plugin UI load failure、部分 native Git review/unknown/preview、reading/API error 等缺失，不从其它 parent 帧推导通过。
- 未看的 distinct controls PNG 都有 `controlsComparison:pending-unreviewed`；不作完成声明。此次结束的是全部 available captured **主图** 的实际查看与对应设计对照。

## Probe 的裁定边界

已读取全部 ST captured sidecar 的失败 control indices：均为 in-viewport 且 `focused:true` 的 Ant combobox 内部 INPUT `centerHit:false`，没有出现其它种类的失败 index。结合实图能看到正常 selector wrapper、selected 值，且资源树 popup 等 recipe 的实际打开状态存在，不能把这些透明内部 input 一律判为阻断；也没有把所有 popup/input 的交互一律免检。多数 sidecar `primaryAction:untested`，本审查不冒充新点击/Tab 测试。长页面的 targetWithinViewport=false 与 measured-no-failure 都不是独立视觉通过条件；上面的 P2 恰恰需要看实际图才能发现。

**结论：需先修 1 项 P2，另有 1 项 Minor。** 已审可见画面的整体标题、工具栏、平面表面、字段与 overlay header/body/footer 基本承接设计合同；完整 ST/全平台图像状态验收仍 pending，待 root 处理明确补拍清单与 latest 受影响帧。
