# Task 3 — Settings / plugins 独立代码审查

Review range: `763d200f5cf8b7d177d6cd878b215b25073a61b1..f8d209e47a71839b10b3200da1983d1c6125f52e`（25 个源码文件）。本报告使用 `requesting-code-review/code-reviewer.md` 模板，仅读取这段提交及必要的相邻宿主/样式，不把其他模块正在修改的 working diff 计入结论。唯一写入为本报告。

## Strengths

- 范围克制：完整 diff 中，业务 script / props / events / controller / API 均无修改，唯一 template 变化是 SettingsWorkspace 的 `settings-page` class。插件实际注入的字符串 CSS 也有同步处理，未假设 owner settings CSS 能进入所有贡献界面。
- 共享主题确有承接：`main.ts` 在已有样式之后加载 `to-doo-tokens.css` / `platform-ui.css`；所用 aliases 与语义变量都定义于 `:root`，暗色覆盖同源。`App.vue` 同时向 Ant/Naive provider 传入当前保存主题，SettingsOverlay 内部的 popup-container provider 没有另起调色板。删除 overlay 的 primary/default/error/disabled 色覆盖是合理的，尤其消除了原 primary 前景使用 panel 色的问题。
- 偏好预览继续由 `data-preview-theme` 消费独立的两套 local preview 变量，未与全局已保存主题绑死。sticky top 归零与共享 header 位于 `.main-content` 外的实际结构一致。
- Overlay 仍保留不可收缩 header/footer、可收缩且内部滚动的 body；dirty actions 增加 wrap，table scroll 与长摘要增加 containment。SettingsActionCard 规则整体归位至 settings.css，没有新建第二套组件。
- 根据完整 diff，独立插件草稿、CAS/version conflict、permission ceiling/consent、one-time secret、SSH trust、unknown-result/retry、分页与 polling 的已有状态机和守卫没有被重写。现有功能回归证据按实现报告引用，不虚称本次重跑。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

1. **[P2] Git 长凭据名仍使管理动作超出窄抽屉，任务要求的动作换行尚未覆盖。**
   - 定位：`apps/web/components/GitRemotePanel.vue:1442`（`.credential-list li`）；实际按钮绑定在同文件 `:1070` / `:1074`。
   - 触发：已有凭据名称为 60 个中文字符或 120 个连续英文字符，打开“管理云端同步”的凭据列表。该输入是正常可达数据：`apps/server/git/credentials.ts:180` 接受长度最多 120 的名称，前端编辑表单也允许输入；无需更改接口或构造非法数据。
   - 问题：列表只给整个 flex row 设置 `flex-wrap: wrap`。两个 AButton 都把完整 `entry.name` 拼入自身标签；所用 Ant 的 button 基础样式为 `white-space: nowrap`（本地依赖 `node_modules/ant-design-vue/es/button/style/index.js:19`），本模块没有为这些按钮设置 `max-width`、内容换行或可增长高度。父级 `overflow-wrap:anywhere` 不会覆盖 nowrap。换行只能移动整颗按钮，不能把一颗比 320/390px drawer 可用宽度更大的按钮装进去。
   - 用户影响：长名称下“更换凭据 / 移除凭据”的标签和点击区域横向越出可见正文；正文可能出现横向滚动，但纵向滚动和 flex-wrap 不能让完整动作在窄视口内可见。这违反 brief/proposal 中长内容和操作在 320/390px 可见、换行的目标。
   - 最小修复：仅在 Git 的 `.credential-list` 范围约束按钮最大宽度，并使标签允许任意处换行、按钮高度随内容增长（同时保留图标与至少 36px 点击高度）；可适当让长名称独占自己的行。保持原名称、点击回调、禁用和凭据清理流程。
   - 定性：这是现存排版缺口在本次视觉范围内未收口，并非本提交新增的业务逻辑回归。静态证据足以确定 nowrap/min-content 冲突；具体像素、命中与 Tab 尚未由浏览器验证。
   - 验收：root 后续隔离 browser lease 中，以合法长假凭据名分别打开 320/390px 的连接管理；确认两颗按钮左右边界均在 body 可见范围内，完整标签能读、点击/Tab 可用，且不依赖横向拖动。

### Minor (Nice to Have)

无单独的模块级 Minor 问题。

## Recommendations

- 修复上述长凭据动作后，保留实现报告已列明的集中 runtime 核验。优先覆盖 360×460 深色 password/recovery-key 的正文与 dirty footer，以及 320px Git/MCP 长内容；检查实际 bounding rect、hit target、focus 和滚动。删除 Ant 局部覆盖后的控件依赖 provider 是正确方向，但静态审查不能证明所有 hover/disabled/password suffix/dropdown 的最终计算样式。
- 共享层另有一个可量化的后续选择：当前浅色 `--todo-green:#438674` 对白色的比值约为 4.285:1，`--todo-danger:#b75b66` 约为 4.466:1；这些变量在本提交用于 12/13px 的反馈文字。旧 settings-success `#34815a` 约为 4.736:1。本任务遵照 handoff 消费既有 palette，因此不建议模块自创替代色；root 可在共享文字色对比度检查中一起裁定。

## Review evidence / limits

- 先完整阅读 `review-763d200..f8d209e.diff` 与 `task-3-report.md`，再核对 `task-3-brief.md`、`module-handoff.md`、原 `settings-implementation-plan-proposal.md`、`style-contract.md`。
- 读取当前 catalog 的 gates 与所有 ST 关联条目：`developmentPermitted:true`，ST 关联 current 均 passed；按需查看 current `MP-R035-v2.png` / `MP-R041-v2.png`。图稿仅作状态/家族参考，未作为运行时或像素达标证据。
- 全部 25 文件 diff 已分段阅读。额外只读追踪了 root token/provider/import 顺序、Workspace 的外置 header/utility scroller、SettingsOverlay/ActionCard、native Git 数据长度约束、Ant button 基础样式与薄 wrapper。独立 Node 颜色计算只使用静态十六进制颜色，没有访问账号、服务或真实凭据。
- 实现者报告的 8 文件 / 146 tests passed、CSS 编译/parse、边界检查与 diff-check 作为已报告证据；本次未重复同源码测试，也没有运行新测试、E2E、浏览器、服务器、typecheck、build 或全套回归。
- 没有修改 HEAD、index、源码、服务或真实数据。其余模块的未提交改动不在此次审查内。

## Declined to judge

- 全平台 desktop/mobile 截图、浏览器布局/命中/焦点/滚动实测、全量 type/build/release：module-handoff 明确集中由 root 调度，本次未执行；实现报告也明确没有宣称这些已完成。
- 共享 ToDoo palette 的全局语义文字色重选：属于 root/shared 层权威，本模块按 handoff 消费；已在 Recommendations 留下具体对比值供裁定。
- Generic PluginPanel 的 contribution busy/dirty 协议、MCP bridge 层级、MCP plugin `more()` 的既有本地错误/忙状态：proposal 明确保留已有协议与限制，本次没有修改这些行为。
- 未挂载 IndexStatus、未证明生产可达的旧 git.history 新入口、Git diff renderer 重写与 backend 流程扩展：明确不在本任务范围；已确认没有新增入口或重写模型。
- 其他并行模块与 short-native 修改：不属于该 commit range，不以其工作区当前状态评价 Task 3。

## Assessment

**Spec alignment:** 部分达成。主题、8px 表面、sticky、draft preview、portal/provider 和业务契约保持的实现与计划一致；Git 长凭据动作仍未满足窄屏动作换行要求。集中 browser 验收是已明确移交的后续工作，不构成虚报完成。

**Code quality:** 范围和职责控制良好，无发现新的 controller/API/secret/CAS 回归；需要一项局部排版修复。

**Ready to merge? With fixes.**

**Reasoning:** 修复合法长凭据名下的动作越界后，该模块静态实现可进入 root 的集中 browser 验收；当前证据不能宣称最终 runtime/pixel/viewport 验收通过。
