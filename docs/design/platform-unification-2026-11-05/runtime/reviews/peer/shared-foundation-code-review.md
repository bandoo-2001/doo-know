# 共享外壳与 Graph 名称边界审查

范围为 `933d63d..5ff535f` 的两个提交，对照该版本实施计划 Global Constraints、Task 1、Task 2 名称边界及已批准的 style-contract。以下代码行均指 `5ff535f`。核查了完整补丁、现有调用方、锁定依赖的实际 DOM 实现以及 shared-foundation-report 和原运行日志。未重跑报告中的测试。补充探针均在空白 Chromium 页面内使用项目现有 CSS 或实际 Ant/Naive 组件，未连接服务或业务数据。组件探针与整页运行证据分开记录。

### 已核实

- `Workspace.vue:2711–2722` 与 `platform-ui.css:30–64,85–111` 将 owner header 放在主滚动区之外，保留四类 compact 条件、底栏安全区域、笔记侧栏宽度偏好与 resizer。ToDoo 注册独立菜单后使用自身 header，公开路由沿用 App 的独立渲染分支，没有 owner rail。报告中的实际布局、持久化宽度和单个 ToDoo header 检查通过。
- 390/320 下实际创建的白板覆盖原先 Find 移出视口的故障，校验了输入、素材库标签、浏览入口和关闭控件的边界及命中，最后可点击画布。仍有遗漏的其他 CSS 见 I3。
- `App.vue:82–85,176,257–260` 继续使用已有主题解析与框架算法，未引入主题切换重挂载、读写权限或数据路径的变更。Graph 产品改动只有 `GraphWorkspace.vue:1252` 的长度上限。服务端 `packages/core/graph/knowledge-state.ts:230–238` 仍分别实施 80 名称上限、100 视图数上限。两条浏览器测试使用实际输入与剪贴板，原实现都在第 81 字失败，修复后覆盖完整 81 字粘贴、真实 POST、服务端读回及按测试 UUID/CAS 清理。
- 旧 overflow 测试的修改成立。基准 `WorkspaceMainMenu.vue:142–148,185–198` 已固定显示“更多”，通过当前图标和 aria-current 表示 overflow 激活。新测试 `responsive-tabbar.spec.ts:72–92` 同时检查习惯的 URL、页标题、更多的固定文字和当前态、打开菜单后的习惯项当前态，以及 Escape 返回焦点。产品菜单在此范围无差异。
- 原始失败、修订后单项通过及 desktop 对 coarse-pointer 专项的跳过有各自记录。类型检查与相关 23 项单测通过。未将局部成功视为整个测试项目通过。

### Critical

无。

### Important

1. **I1 · 紧凑侧栏关闭后，Tab 会立即进入屏外按钮。** `Workspace.vue:2702–2706,2719–2726`、`workspace-tabbar.css:59–75`。新 header 在 aside 前，关闭后明确把焦点交给 header trigger，但 aside 仅平移出视口。用项目 CSS、同序 DOM 和 390px 视口，等动画完成后，trigger 上按 Tab 实际聚焦“关闭侧栏”，其右边界为 −19px。设置侧栏选分类还直接写 `drawer=false`（`Workspace.vue:1946–1952`），焦点可以留在刚藏起来的分类。用键盘打开时焦点仍在外层 trigger，立即按 Escape 也到不了绑定在 aside 的处理器。最小修正是在现有 compact 条件下让关闭的 aside 不参与键盘焦点，打开时将焦点送入可见侧栏，关闭时仅在需要时恢复到可见触发器，保留编辑器导航明确指定的焦点。加一条按 Enter→Escape→Tab 和选择设置分类的真实键盘回归，检查最终焦点可见及可操作。桌面常驻目录必须仍可使用。
2. **I2 · Escape 在“创建与导入”触发器上关闭了错误的层。** `Workspace.vue:2726,2763–2770,2795–2803`。Ant click Popover 在触发按钮用 Enter 打开时，焦点仍位于按钮。绑定在弹层内容的处理器接不到 Escape，aside 的无条件 `.esc.stop.prevent` 却会关闭父层。复用锁定版本的 Ant Popover、相同绑定和真实键盘，得到“弹层展开 true、侧栏关闭、焦点转到外层 trigger”。桌面 aside 同样无条件截获 Escape。最小修正是在 trigger 上也处理已展开弹层的 Escape，先关弹层并保留/恢复 trigger 焦点；只在真实打开的 compact 侧栏消费剩余 Escape。测试两次连续 Escape，第一次只关闭子层，第二次关闭父层并返回可见触发器。保留已自行消费 Escape 的 DirectoryTreeSelect 和原有弹窗 busy/dirty 守卫。
3. **I3 · 共享 CSS 仍命中第三方 sidebar。** `scrollbars.css:99–104,137` 的短视口规则仍向任意 sidebar 注入 8px 顶部 padding，`motion.css:163–166` 在窄屏给任意 sidebar 添加侧栏动效；`document.css:531` 也保留旧的 owner 直系选择器。后者范围较窄，前两处会匹配有同名 class 的原生白板侧栏。现有 390/320 高 844 的测试无法验证短屏 padding。新 `platform-ui.css:102–107` 的 16px 又压过原给短屏目录预留空间的 8px。将遗漏的 owner 规则全部限定到 notebook-navigation；让短高规则在 owner 上保留原有优先级。用短 landscape 的原生 Find/Library 与 notebook 目录分别验证控件和间距。
4. **I4 · 长 Naive 卡片没有获得声明的内容滚动。** `platform-ui.css:69–81` 针对 `.n-card__content`，锁定版本实际渲染 `.n-card-content`。在 390×844 真正的 `NModal preset="card"` 中，长正文 client/scroll height 同为 1224、overflow 为 visible；外层卡片高度 818、scrollHeight 为 1344，滚动外层 450px 后标题顶边到 −437px。长表单滚动中失去标题和关闭入口。相同卡片圆角实测 10px，`calm.css:612–615` 和 `style.css:783–787` 的旧 !important 使共享 8px 规则失效。最小修正是命中实际正文节点，明确外层/正文滚动职责，移除或统一冲突的共享圆角。用带长数据的真实卡片检查标题/关闭入口保持可见、有 footer 时可达；保留各弹窗自己的按钮与状态守卫。

### Minor

- **M1 · 跨框架暗色主按钮与图片证据。** `platform-theme.ts:24–34`、`App.vue:82–85`。真实 Ant/Naive Button 和当前 provider 配置在浅色都显示 #4566c6 白字，暗色都显示 #13151e 文字，但 Ant 背景为 #798edc，Naive 为合同的 #8ba4ff。Ant darkAlgorithm 会再次派生种子色。保留算法，在需要精确合同色的控件层调整相应 token。Task 1 要求的实际 owner 浅/深色截图及计算色尚未随报告提供；请在真实页面各保留一份带计算值的截图，重复检查公共壳/控件即可，无须添加常量单测。
- **M2 · settings 返回保留选中目标的验收仍缺一段。** `tests/e2e/platform-shared-ui.spec.ts:59–64` 从设置 `goto('/')`，这只验证进入设置。可复用已有 `tests/e2e/startup-draft-identity.spec.ts:162–173` 或 `management-workspace.spec.ts:60–87` 的实际返回动作和笔记身份/选区断言，在修正后的隔离 fixture 运行并记录，避免增写重复测试。

### Declined to judge

- 390 图设计本身的逐图批准及其生成过程，沿用已通过的设计门禁。
- Task 2 其余 workspace/editor/Graph 展示、Task 3–4 模块、SSR/导出主题和公开博客定制，本次仅检查共享层是否引入越界路径。
- 全平台运行截图索引、完整 desktop/mobile/diagram 套件、构建、集成、发行及安装回滚，属于后续阶段；本次没有合并或发布判定。
- 硬件级 coarse pointer 和原生系统面板，所交证据来自浏览器环境，desktop 项的既有跳过已记录。

### Assessment

**Spec verdict — 需修正。** Graph 80 边界、ToDoo 排除及 “更多” 契约通过。共享侧栏隔离、长弹窗滚动与键盘收尾尚未满足 Task 1，浅/深色和 settings 返回的整页证据有缺口。

**Quality verdict — With fixes。** 当前不宜冻结这版共享接口给模块工作依赖。先完成 I1–I4 并用聚焦回归及实际窗口验证，按 M1、M2 补共享层证据。无需因此重跑无关模块的全部套件。
