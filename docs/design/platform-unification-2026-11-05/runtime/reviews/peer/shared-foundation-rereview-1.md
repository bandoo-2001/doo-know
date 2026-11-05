# 共享基础层第一次修复复审

审查范围为 `5ff535f..763d200` 的完整修复补丁、原 I1–I4 和本轮引入的行为。核对了报告、测试源、运行日志、失败 trace 与 Find 最终帧。未重跑已记录用例，未变更产品源码、测试、服务或 HEAD。

| 原问题 | 结论 | 修复及证据 |
| --- | --- | --- |
| I1 紧凑侧栏焦点 | **ADDRESSED** | `Workspace.vue:1947–1955,2705–2719,2756` 采用与主菜单相同的 compact 条件，仅使已关闭的紧凑侧栏 inert。显式打开时焦点移入目录，选择设置分类时若焦点来自目录则送入 main。真实 Enter→Escape→Tab 和设置分类用例验证焦点落在窗口内，desktop/mobile 均通过。 |
| I2 trigger 上的嵌套 Escape | **ADDRESSED** | `Workspace.vue:2720–2735,2831`、`platform-shared-ui.spec.ts:148–174`。焦点在创建菜单 trigger 时，首次 Escape 关闭弹层、保留父层和 trigger 焦点；第二次 Escape 仅在紧凑侧栏打开时折叠并返回外层 trigger。另验证了桌面第二次 Escape 留在常驻目录中。 |
| I3 遗留 owner sidebar 选择器 | **ADDRESSED** | 剩余规则已收敛至 `#notebook-navigation`（`motion.css:164`、`scrollbars.css:100,103,137`、`document.css:531`）。`platform-ui.css:114–116` 恢复短屏 owner 8px 间距，实际 844×390 owner 用例校验了计算值。390/320 原生 Find/Library 在失败运行中先后走完。844×390 原生控件的独立未通过项见下。 |
| I4 长卡片滚动和圆角 | **ADDRESSED** | `platform-ui.css:69–82` 在外层裁切，在实际正文节点 `.n-card-content` 上滚动，并移除了两处旧 !important 圆角。真实导入窗在 390×460 展开批量区后，正文 scrollTop 随滚动增加，标题/关闭和末尾动作在窗口内可命中，圆角计算值为 8px。未单独操作有 Naive footer slot 的卡片。 |

## 844×390 原生画板

**交 Task 2 的图形文档与原生白板适配负责人处理，保留两个失败记录。** 共享层按合同给 main 留出 266px（390 减 56px 顶栏、68px 底栏）；`platform-ui.css:38–48,90–101` 的 header 是普通流内元素。Find 的失败 trace 在长时间重试中反复报告真实 owner header 截获指针。最终画面中，主栏内先显示图形文档的导航、模式和格式工具区域，下方原生菜单只露出了底部几项。源码对应 `DiagramDocumentWorkspace.vue:588–608,715–753,804–838,902–912`。其中正文裁切溢出，mount 按正文实际高度填充；锁定 Excalidraw 样式 `.App-toolbar-content .dropdown-menu--mobile` 在工具栏上方向上展开，`.dropdown-menu .dropdown-menu-container` 却使用相对于**整窗**的 `calc(100vh - 150px)`。按 390px 高计算其限高为 240px，超过图形文档多个工具行之后的实际可用区域。owner header 作为错误点击位置的命中对象，并不表明其越过自身矩形。此处应修正 diagram 宿主内菜单与可用空间的关系，保留已批准的外壳尺寸及第三方包源码。

素材库的独立记录确实在 844×390 返回中心命中 false。trace 中 resize 返回至最终命中取样约 80ms；该用例在真实点击之前失败，未记录遮挡元素，也未证明稳定布局下持续失败。Task 2 应先等待原生布局完成并记录命中对象，再检查打开、浏览与关闭。Find 及 Library 均须用保留的真实行为用例验证，不能用 owner 间距测量代替。

## 新发现与原 Minor

- **新 Minor，测试可移植性。** `tests/e2e/platform-shared-ui.spec.ts:232–236` 动态导入开发服务的 `/preferences.ts`。在仓库支持的 `DOOKNOW_E2E_PRODUCTION=1` 下，fixture 服务构建后的静态目录并绕过 Vite（`tests/support/e2e-server.ts:207–209,282`），该证据用例将无法导入源码。当前固定的 release-browser 用例列表不含它。可复用 `tests/e2e/scroll-containment.spec.ts:125–141` 的 system 偏好与浏览器 colorScheme 流程，或通过实际设置控件切换主题。此次实际 dev 截图仍可用。
- **M1 部分完成。** 已核对 fix-host 的两张实际 owner 截图文件和计算色日志。浅色 Ant 为 #4566c6 白字；深色 Ant 使用 #798edc 背景、#13151e 文字。深色主色与合同 #8ba4ff 的差异仍在，本轮没有另外操作实际页面上的 Naive 主按钮。
- **M2 仍待验证。** 两条现有候选用例分别在编辑器 locator 与 seed 请求 403 阶段失败，均未到达设置返回。这两次结果无法用于证明返回目标/选区保留，也未证明产品回归。留在工作区验收中。

**未在本轮判定**：其余原提交、全模块样式、全部可视化/移动场景、最终集成与发行。fix-host 的 11 通过/1 个 desktop coarse-pointer 跳过、fix-mobile 的 4 通过、23 项单测与类型检查均按原日志保留。

**Spec / quality verdict**：I1–I4 均已处理，未发现本轮新增的 Critical/Important。可冻结此次共享外壳修复供后续模块使用。短横屏白板属于明确待修的 Task 2 用户功能，M1/M2 和新增测试可移植性仍单列跟踪。此结论只覆盖共享修复。
