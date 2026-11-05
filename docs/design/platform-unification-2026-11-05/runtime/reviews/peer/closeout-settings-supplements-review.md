# ST 补拍独立视觉复核

结论：本轮所纳入的 194 张 captured 主图均已实际查看（含注明依据的同 SHA 历史复用）；没有新增 Critical / Important 布局问题。此前唯一 P2 `ST-VIS-P2-001` 的局部 Alert 修复继续保持 addressed。这里的结论仅限真实可见画面，未把捕获成功、probe 测量或父图 sourceIds 当作全状态验收通过。

证据清单：`docs/design/platform-unification-2026-11-05/runtime/reviews/closeout-settings-supplements.json`。每行含绝对 PNG 路径、sidecar/sourceCommit、期望与实际 SHA、actuallyViewed、判定、观察、当前设计图链接与查看依据。保留原主审、旧失败和 P2 before/after，不覆盖历史结论。

| completed 批次 | 行数 | captured 主图已看 | failed 保留 |
| --- | ---: | ---: | ---: |
| 2f55818-failed-only-rerun1 | 57 | 55 | 2 |
| d3cfe8d-compact | 30 | 28 | 2 |
| d3cfe8d-compact-retry | 2 | 2 | 0 |
| d3cfe8d-frames | 36 | 36 | 0 |
| d3cfe8d-state-retry | 9 | 9 | 0 |
| ec86b32-settings-final | 45 | 45 | 0 |
| 4f64ef7-plugin-versions（收尾扫描发现的新 completed 批次） | 15 | 15 | 0 |
| targeted-regressions/plugin-upgrade-verified | 4 | 4 | 0 |
| 合计 | 198 | 194 | 4 |

194 个 captured 主图对应 185 个唯一 SHA。49 张有顺序映射的联系表覆盖必要新增主图；另有直接原图查看和同 SHA 历史真实查看依据。必要 controls 补看 28 行，合计 88 行 controls 已看或与已看图 SHA 相同；其余 102 个不同 controls 未看，明确保留，未冒称全部截图副本均验收。63 个当前设计资产有真实查看或精确同 SHA 历史复用，其中本轮专门打开 16 个新增/必要参考。所有 captured 主图、controls 和所链接设计资产的最终 SHA 均匹配。

重点结果：

- 库卡片主体：三宽 storage 七行数据、Git 主体/本地状态/关联入口已真实入图；旧父图只显示上沿的 gap 得到可见内容补充。批量整理主体也入图，但仍是刷新转圈、零选择且目标/移动禁用的暂态，不代替 ready 选择态。
- 偏好预览：三宽实际展开示例和保存工具栏可见，桌面原预览截断的画面缺口得到补充。
- 冲突与错误：client 名称 CAS 的提示、保留输入、禁用保存及 reload/cancel 同时可见；权限冲突的提示和上部表单可见。import-preview-error、OAuth 收窄失败/撤销失败、库读取失败、密码 API 错误、磁盘 409 和 busy、任务逐项失败均有真实对应反馈。extension UI load failure、retention read error、最新资源读取错误通过必要 controls 帧实际看到了完整错误和重试。
- Alert：d3 状态补拍中 320/390 conflict 正文保持正常段落宽度，reload 动作置于下方；先前独立 fix after 图已看过三宽 Alert/popconfirm，关闭的 P2 不重开。最新 ec/4f 的 primary+bottom controls 仍会跳过中间的该 Alert，这个个别 capture gap 没有被推断成产品缺陷或最新状态覆盖。
- 短屏：360×460 深色与 844×390 横屏的主图只见上部；实际 controls 帧看到了下部凭据字段/取消保存动作、长凭据换行后的操作、账户退出设备、插件按钮和状态页下沿操作，未看到导航遮挡动作。画面为深色；相关 computed 样本有深色 `rgb(27,30,41)` 背景及危险文字约 6.154 的对比度。部分 modal 样本为空，因此不声称所有文字均完成对比度审核。
- 跨角色：ST Git owner/import source 三宽有真实 GitHub/Gitee 选中态；controls 里 repo/branch/credential、导入名称/保存位置、条件禁用的导入动作可见。其余首次安装流程仍归 PB。

仍 pending 的既有状态/证据边界：

1. restartRequired：d3 三宽、最新 4f 三宽实际画面仍只有 MCP guide/环境提示/客户端列表，看不到指定重启警告；已看的 controls 也未补到。这是未触发或未入图，静态证据不能区分，不能判定 after-click 产品反馈不可见。
2. ready 批量整理、权限编辑/创建 client 全部底部动作：此次部分帧仍是暂态或上部表单；不由父画面和 probe 补齐其余状态。
3. 最新 remoteChanged Alert：上述 individual capture gap 保留；独立定向修复的布局结论保持关闭。
4. 四个失败 sidecar 保留：2f 的 320 library-read-error / plugin-config-conflict，以及 compact 的 1440-dark / 844-short settings-plugins。重试成功是新记录，不抹掉旧失败。

真实升级补充：receipt 记录同一临时 DB、rc61 的 MCP 2.0.0 / Git 1.1.3，经手动两次升级成为 2.0.1 / 1.1.4，并保留已有 Git 配置。四图实际已看并核 SHA，桌面 after 有完成提示及旧资料/新安装版本说明。320/390 只提供 before，未声称窄屏 after 已看。

同时注意真实语义差异：before 图卡片已经写 v2.0.1 / v1.1.4，却仍有“升级”；receipt 的已安装版本当时仍为旧版本。`apps/web/components/PluginManager.vue:446` 使用 catalog `entry.version`，`:493` 才比较 installedVersion。版本标签单独不能证明已升级，也不能证明自动升级。此差异已报 Root/coordinator 作范围判断，不对本轮 CSS 归因，不扩写新 P3。若要消除歧义，最小改为已安装卡片展示 installedVersion，另标可升级目标版本。

范围排除：PB-only ec86b32-setup-final 的 176 张按 Root/coordinator 分工由 PB 审者负责；native-properties 无 ST；其余未分配非 ST 页面不纳入。旧测试非零失败报告仍保留。本轮只读图、设计、sidecar/receipt 和必要源码，没有修改产品/测试/harness/Git，没有启动服务、浏览器或重跑测试。新代码或新状态不从旧截图自动获得通过。
