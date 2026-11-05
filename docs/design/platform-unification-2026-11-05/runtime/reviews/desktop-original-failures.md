# Final full E2E 1 — desktop 51 项失败矩阵

原始桌面全量结果：**51 failed / 580 passed / 5 skipped，共636项，1.1h**。来源 `final-e2e-1.log` 与 `test-results/desktop`，运行应用源码冻结于 `12b779809d3ed122742a15ff8605a78b21bdca5e`，对比基线 `933d63d942b6499fee964f8a060c7b22b9d299d1`，rich editor flag=1。本文只归类这次原始 desktop 失败，不等待或评价 mobile；之后的 isolated 修复/定向通过不改写本次结果。

本轮归类只读日志、已生成 trace/error-context、源码和 Git 对比；未启动浏览器/测试/服务，未更改应用、测试、Git或fixture。只更新本报告。51个失败各对应一个已读取的trace最终单个error；没有依赖重复poll错误推断失败数量。源码比较说明旧行为已存在，不代表本次运行了旧基线套件。

8项提醒卡拦截是**实际交互阻塞**；搜索有明确 INDEX_PENDING/GIT_CONFLICT 降级；这两类不能记作旧定位器。当前未确证它们由本轮改造新增，亦未以独立复现排除产品风险。12项原生独立note失效路径保留失败/未迁移状态，不恢复API、不skip/delete。所有失败之后未执行的断言仍属于覆盖边界。

## 分组统计

| 分组 | 原因 | 失败数 |
| --- | --- | ---: |
| A | 既有 ToDoo 二级导航与旧无侧栏断言 | 2 |
| B | 已批准的 rail 60→64 几何变化 | 4 |
| C | 新 owner header 隐藏重复品牌后的旧探针 | 5 |
| D | 原有已移除的独立原生笔记夹具/API 路径 | 12 |
| E | 平台暗色调色板与旧硬编码色值 | 1 |
| F | 搜索服务明确降级，未进入分页 UI | 1 |
| G | 底部更多导航固定文案的旧断言 | 2 |
| H | 只改 DOM 主题、未改框架 provider 的混合主题夹具 | 1 |
| I | 既有二级目录 h2 与页面 h1 同名导致严格定位歧义 | 7 |
| J | 数量打卡显示数值与勾号的旧文本断言 | 1 |
| K | 空清单状态存在两个同名新建清单入口 | 1 |
| L | 提醒 scheduler 与测试夹具创建同一实体竞争 | 1 |
| M | 实际 reminder-stack 拦截用户点击 | 8 |
| N | 期望的实时提醒卡未出现，存在其他遗留提醒 | 1 |
| O | 共享数据集总完成数被当成单项 fixture 数量 | 1 |
| P | 既有上下文导航/页面标题与旧控件假设 | 3 |
| 合计 | 与原始 desktop 失败数一致 | 51 |

## A. 既有 ToDoo 二级导航与旧无侧栏断言（2项）

**旧基线与本轮变化：** `ToDooWorkspace.vue` 在 933d63d 和 12b7798 都将 `hasSecondaryNavigation` 固定为 true；相关组件没有本轮 diff。旧断言与既有二级导航不符。

**处理范围：** 测试断言；保留原全量失败，待确认布局的 test-only 更新和完整命名用例复跑。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #1 [desktop] tests/e2e/app-main-menu.spec.ts:12:1 › app rail owns main functions and settings while only contextual pages have a secondary directory | aside.todo-sidebar 实际 visible；测试 :24 要求 hidden。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/app-main-menu-app-rail-own-b6774--have-a-secondary-directory-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 后续 desktop 邻接、设置/返回流程尚需修正断言后执行。 |
| #570 [desktop] tests/e2e/to-doo-visible-workspace.spec.ts:66:1 › matrix uses four distinguishable surfaces and explains each action without wasting the viewport | 测试 :72 期望 aside.todo-sidebar 数量0，实际1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-visible-workspace-m-c9206-ithout-wasting-the-viewport-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 四象限配色/动作和空间利用检查被前置无侧栏断言截断。 |

## B. 已批准的 rail 60→64 几何变化（4项）

**旧基线与本轮变化：** 12b7798 的 `platform-ui.css:20` 明确使用 64px rail，原测试 helper 仍期望 60。属于本轮有意布局变化后的旧断言。

**处理范围：** 本轮相关测试断言；不改应用几何以迎合旧值。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #10 [desktop] tests/e2e/apps-layout.spec.ts:47:3 › 应用首页 uses the application area without a notebook column, including after reload | apps-layout helper :36：main x 期望60，实际64。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/apps-layout-应用首页-uses-the--44bae-lumn-including-after-reload-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 保留无笔记列、reload、overflow 检查。 |
| #11 [desktop] tests/e2e/apps-layout.spec.ts:47:3 › 博客概览 uses the application area without a notebook column, including after reload | 同 helper :36：60 vs64。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/apps-layout-博客概览-uses-the--2c918-lumn-including-after-reload-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 博客概览的 reload/可用性后续未完成。 |
| #12 [desktop] tests/e2e/apps-layout.spec.ts:47:3 › 博客文章 uses the application area without a notebook column, including after reload | 同 helper :36：60 vs64。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/apps-layout-博客文章-uses-the--c89a2-lumn-including-after-reload-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 博客文章的 reload/可用性后续未完成。 |
| #13 [desktop] tests/e2e/apps-layout.spec.ts:68:1 › application navigation retains the mounted note, expanded directories and search context | helper :36 从测试 :85 调用：60 vs64。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/apps-layout-application-na-3338b-ectories-and-search-context-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 后续 mounted note、expanded directories、search context 断言未完成。 |

## C. 新 owner header 隐藏重复品牌后的旧探针（5项）

**旧基线与本轮变化：** 本轮平台 header 成为可见品牌，`platform-ui.css:62` 隐藏 `#notebook-navigation > .brand`。前四项以旧品牌作 readiness；最后一项以其 boundingBox 作固定控件位置探针。

**处理范围：** 本轮相关探针；改用实际 `#notebook-navigation[aria-label="笔记导航"]` 可见性，以及仍可见的搜索/新建控件几何，保留原业务检查。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #44 [desktop] tests/e2e/create-readiness.spec.ts:7:1 › new-note creation waits for the initial folder list before choosing its destination | 测试 :27 等待 .sidebar .brand visible，实际 hidden。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/create-readiness-new-note--6dea0-re-choosing-its-destination-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 延迟目录加载/新建按钮就绪的业务断言未完成。 |
| #89 [desktop] tests/e2e/document-breadcrumb.spec.ts:6:1 › short paths stay direct on wide screens and remain reachable on narrow screens | 测试 :12 同一旧品牌 readiness 失败。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/document-breadcrumb-short--f15f8-reachable-on-narrow-screens-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 尚未创建本项 note，短路径宽窄屏与菜单导航未执行。 |
| #90 [desktop] tests/e2e/document-breadcrumb.spec.ts:43:1 › deep paths collapse into an accessible menu while preserving folder navigation and drafts | 测试 :49 同一旧品牌 readiness 失败。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/document-breadcrumb-deep-p-8f800-older-navigation-and-drafts-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 尚未创建深目录夹具，focus/草稿/菜单与743/390px检查未执行。 |
| #167 [desktop] tests/e2e/editor-selection.spec.ts:31:1 › text selections remain visibly blue on the active line and after focusing the toolbar | 测试 :37 同一旧品牌 readiness 失败。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/editor-selection-text-sele-3a90f--after-focusing-the-toolbar-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 选区像素、toolbar focus 和格式/undo 不变量未执行。 |
| #304 [desktop] tests/e2e/scroll-containment.spec.ts:46:3 › normal windows keep long directory scrolling below the sidebar controls | 测试 :84 读取 hidden .sidebar>.brand 的 null boundingBox，TypeError reading y。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/scroll-containment-normal--f3688--below-the-sidebar-controls-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 此前长树滚动、sidebar不滚动检查已过；固定搜索/新建/footer与最终overflow仍需完整复验。 |

## D. 原有已移除的独立原生笔记夹具/API 路径（12项）

**旧基线与本轮变化：** 相关测试及拒绝链从 933d63d 到 12b7798 未变。`POST /api/notes` → `notes.createNote` → mutation core `core.ts:326` 的 `isDocument` 仅接受 `.md`（`shared/whiteboard.ts:5`）。`.excalidraw` 是 primary Markdown 的原件资产，不再是独立 note。

**处理范围：** 原有失效覆盖，保留逐项失败/未迁移记录；不扩充 API、不恢复 WhiteboardWorkspace、不跳过/删除测试。迁移需用当前 primary 生命周期保留原不变量，并重新验证。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #75 [desktop] tests/e2e/diagram-portability.spec.ts:103:1 › 独立白板生成普通Markdown预览副本，原白板内容和保存状态不被改写 | 测试 :124：创建 portable-*.excalidraw 期望201，实际400 INVALID_INPUT。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/diagram-portability-独立白板生成普通Markdown预览副本，原白板内容和保存状态不被改写-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 之后还依赖不存在的 whiteboard-workspace 与生成 Markdown 预览笔记；无 locator-only 等价迁移。 |
| #76 [desktop] tests/e2e/diagram-portability.spec.ts:145:1 › 白板在PNG上传期间更新时保留父笔记草稿，重新生成后绑定新版本 | 测试 :164：创建 changing-*.excalidraw 期望201，实际400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/diagram-portability-白板在PNG上传期间更新时保留父笔记草稿，重新生成后绑定新版本-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | PNG上传竞争/parent draft/新source binding从未执行；primary .md可作未来迁移夹具，源码更新需prepare/commit。 |
| #93 [desktop] tests/e2e/document-copy.spec.ts:9:3 › 桌面创建旧白板的 Markdown副本，保留原件并分配新身份 | 测试 :29：旧白板源夹具POST 201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/document-copy-桌面创建旧白板的-Markdown副本，保留原件并分配新身份-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 创建副本UI未执行；可未来用primary .md保留fresh UUID、未知原件字段与原件不变断言。 |
| #146 [desktop] tests/e2e/document-organization.spec.ts:25:1 › 批量整理为关联原生白板准备预览，刷新记录后可撤销并保留原身份 | 终止于 :91 preview.state TypeError；更早未检查的 *.excalidraw POST为400，后续 GET /notes/undefined/diagram为404。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/document-organization-批量整理为关联原生白板准备预览，刷新记录后可撤销并保留原身份-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 合法target move已完成，但board link/PNG及reload undo不能以不存在的board验证。 |
| #172 [desktop] tests/e2e/folder-native-restore.spec.ts:4:1 › renamed trash folder renders all archived and live native final snapshots before activation | fixture note() :24 /调用 :37：board.excalidraw POST400 INVALID_INPUT。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/folder-native-restore-rena-22ec6-snapshots-before-activation-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 归档/活动原件最终快照和恢复激活未进入；primary恢复覆盖只能说明现有路径，非本项通过。 |
| #234 [desktop] tests/e2e/note-native-restore.spec.ts:7:1 › 回收站单篇原生笔记恢复前准备最终链接与PNG并保留原身份 | fixture create() :17 /调用 :22：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/note-native-restore-回收站单篇原生笔记恢复前准备最终链接与PNG并保留原身份-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 回收站单篇恢复、最终链接/PNG和原身份不变量未执行。 |
| #281 [desktop] tests/e2e/portable-native-preview.spec.ts:18:1 › owner resumes a persisted native portable preview, reads it offline without DooKnow, and reimports the complete directory | post() :30 /调用 :78：临时 *-render.excalidraw POST400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/portable-native-preview-ow-cac77-orts-the-complete-directory-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 本项已为最终primary保留creation intent，但旧渲染辅助夹具失效；后续导出恢复/离线阅读/重导入未执行。 |
| #605 [desktop] tests/e2e/whiteboards.spec.ts:81:1 › 笔记图块进入设计页后返回，保留未保存正文并更新白板预览 | whiteboards create() :15 /调用 :82：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/whiteboards-笔记图块进入设计页后返回，保留未保存正文并更新白板预览-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 嵌入设计返回、未保存父正文与预览更新未执行。 |
| #607 [desktop] tests/e2e/whiteboards.spec.ts:118:1 › 保存已落盘但响应中断时保留草稿，重试使用相同请求编号且不产生重复版本 | create() :15 /调用 :119：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/whiteboards-保存已落盘但响应中断时保留草稿，重试使用相同请求编号且不产生重复版本-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 已落盘响应丢失/相同request重试/不重复版本未执行。 |
| #608 [desktop] tests/e2e/whiteboards.spec.ts:148:1 › 外部修改与自动保存冲突时保留磁盘版本，下载草稿后可重新读取 | create() :15 /调用 :149：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/whiteboards-外部修改与自动保存冲突时保留磁盘版本，下载草稿后可重新读取-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 外部修改与autosave冲突、下载草稿/重读未执行。 |
| #609 [desktop] tests/e2e/whiteboards.spec.ts:195:1 › 分享白板和笔记内引用只读展示且取消分享后无法再读取 | create() :15 /调用 :202：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/whiteboards-分享白板和笔记内引用只读展示且取消分享后无法再读取-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 匿名只读分享、笔记引用及撤销后拒读未执行。 |
| #610 [desktop] tests/e2e/whiteboards.spec.ts:239:1 › 浏览器返回先退出嵌入设计页，保留原笔记与未保存正文 | create() :15 /调用 :240：*.excalidraw POST201→400。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/whiteboards-浏览器返回先退出嵌入设计页，保留原笔记与未保存正文-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 嵌入设计browser back和父note草稿保留未执行。 |

## E. 平台暗色调色板与旧硬编码色值（1项）

**旧基线与本轮变化：** 本轮 `platform-theme.ts` 的 dark.paper 为 #1b1e29，trace 收到 rgb(27,30,41)；测试仍硬编码旧 #172033。此前字号、换行、宽度、行号、data-theme 检查已经通过。

**处理范围：** 本轮有意视觉变化后的旧精确色值断言；以批准 token 和实际暗色状态核对。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #201 [desktop] tests/e2e/management-features.spec.ts:190:1 › saved display preferences change the actual editor and survive reload without changing source | 测试 :216 期望cm-editor背景rgb(23,32,51)，实际rgb(27,30,41)。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/management-features-saved--4fa73-oad-without-changing-source-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 需继续验证reload、原文不变与恢复默认；不能因前半偏好生效便记整项通过。 |

## F. 搜索服务明确降级，未进入分页 UI（1项）

**旧基线与本轮变化：** 搜索/索引服务与本测试没有本轮相关源码 diff。Trace 给出实际服务降级证据；本次不能确证是哪一个前置测试留下 Git conflict，也未独立复现或读取运行 DB。

**处理范围：** 共享 fixture/索引服务未决失败；不是 locator 失败，也不证明新 UI 回归。需要隔离 Git conflict、索引队列后重跑原完整用例。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #252 [desktop] tests/e2e/platform-pagination.spec.ts:6:1 › search and history expose their remaining pages | 测试 :45 在30秒内始终0/12；最后 /api/search/advanced HTTP200：results=[], degraded=true, reasons=[INDEX_PENDING,GIT_CONFLICT], index.pending=333。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/platform-pagination-search-fbced-xpose-their-remaining-pages-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 搜索10→12和history50→51 UI均未执行；具体conflict来源/索引完成需隔离检查。 |

## G. 底部更多导航固定文案的旧断言（2项）

**旧基线与本轮变化：** `WorkspaceMainMenu.vue` 的按钮在基线和当前均为 `<span>更多</span>`；本轮该文件只提取既有 compact media query。测试要求当前页面名出现在固定按钮文案中。

**处理范围：** 原有断言不符；实际 URL、目标页控件、overflow 关闭状态已经通过到失败点。可检查 aria-current/当前页面，而不新增文案能力。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #295 [desktop] tests/e2e/responsive-tabbar.spec.ts:166:1 › tablet rotation switches between bottom tabs and the left rail and closes overflow | 测试 :202：更多按钮期望包含习惯，实际更多。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/responsive-tabbar-tablet-r-09949-ft-rail-and-closes-overflow-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 旋转、rail64与目标habits URL已通过；固定更多文案断言需更新后跑完。 |
| #298 [desktop] tests/e2e/responsive-tabbar.spec.ts:240:1 › blog labels fit the phone tabbar and site settings remain reachable | 测试 :271：更多按钮期望包含站点设置，实际更多。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/responsive-tabbar-blog-lab-dea13-e-settings-remain-reachable-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 站点settings URL与站点名称输入可见已过；后续短横屏选稿器未执行。 |

## H. 只改 DOM 主题、未改框架 provider 的混合主题夹具（1项）

**旧基线与本轮变化：** 测试在载入后直接设置 html data-theme=dark；App.vue 的 Ant/Naive provider 来自 `resolvedTheme`，不会被该 DOM 写入更新。CSS 深色 muted 与仍处于浅色 provider 的密码图标混合。

**处理范围：** 主题夹具不一致；需通过真实外观偏好切换后再核对图标、对比度和滚动，不以此人为混合状态直接判产品暗色回归。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #350 [desktop] tests/e2e/settings-overlays.spec.ts:319:1 › 窄且低的深色视窗保留弹窗边界、可滚动内容与清晰文字 | 测试 :338：密码图标实际rgba(0,0,0,.45)，与CSS暗色muted rgb(161,169,187)不等；用page.evaluate仅写DOM主题。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/settings-overlays-窄且低的深色视窗保留弹窗边界、可滚动内容与清晰文字-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 弹窗边界与更新按钮可见已过；真实主题provider同步和后续scroll/contrast未验证。 |

## I. 既有二级目录 h2 与页面 h1 同名导致严格定位歧义（7项）

**旧基线与本轮变化：** ToDoo 组件/模板在 933d63d 和 12b7798 无 diff，目录 h2 与页面 h1 同名是既有结构。Trace 每项明确 strict mode 两元素；泛 heading 定位不唯一。

**处理范围：** 原有 locator 范围；页面标题应按 level:1 或页面 toolbar 定位，保持后续动作/持久化断言。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #417 [desktop] tests/e2e/to-doo-antdv.spec.ts:85:1 › period statistics and progress follow real seven-day, thirty-day and custom date requests | 测试 :113：统计与复盘匹配目录h2+页面h1，strict mode violation。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-antdv-period-statis-514b3-ay-and-custom-date-requests-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 七天/30天/custom请求与进度统计后续未完成。 |
| #418 [desktop] tests/e2e/to-doo-antdv.spec.ts:172:1 › Ant review modal preserves a canceled discard and saves a fresh local-date review once | 测试 :223：返回统计与复盘时同名h2/h1定位歧义。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-antdv-Ant-review-mo-0d6e3-resh-local-date-review-once-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 此前modal cancel流程部分执行；fresh review保存/计数最终断言未完成。 |
| #454 [desktop] tests/e2e/to-doo-focus-space.spec.ts:86:1 › compact focus overview leaves the first history record above the timer | 测试 :96 click heading专注匹配h2+h1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-focus-space-compact-2932e-tory-record-above-the-timer-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | compact focus首历史项与timer几何尚未完成。 |
| #459 [desktop] tests/e2e/to-doo-focus-trend.spec.ts:88:1 › project duration curves support week, month and year without changing the history range | 测试 :146 click heading专注匹配h2+h1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-focus-trend-project-5d390--changing-the-history-range-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | project week/month/year曲线及range不变后续未完成。 |
| #522 [desktop] tests/e2e/to-doo-reminders.spec.ts:336:1 › closing a cold notification card prevents that generation from reopening on refresh | 测试 :345：通知中心匹配h2+h1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-reminders-closing-a-0c5ef-n-from-reopening-on-refresh-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 冷通知关闭/刷新不重开意图被标题等待阻断。 |
| #569 [desktop] tests/e2e/to-doo-visible-workspace.spec.ts:29:1 › primary tools and contextual task directories are discoverable without expanding hidden groups | 测试 :53：习惯匹配目录h2+页面h1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-visible-workspace-p-54d26-out-expanding-hidden-groups-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 前面tasks目录动作部分已过，后续全部section discoverability未完成。 |
| #576 [desktop] tests/e2e/to-doo.spec.ts:176:1 › focus, habit check-ins, anniversary and real CSV import/export use durable server data | 测试 :184：专注匹配目录h2+页面h1。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-focus-habit-check-i-995e0-ort-use-durable-server-data-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | focus/habit/anniversary与CSV durable data流程未执行到结束。 |

## J. 数量打卡显示数值与勾号的旧文本断言（1项）

**旧基线与本轮变化：** ToDoo 数量 cell 组件本轮无 diff。Trace accessible name 已包含当前 2.5 页，按钮内容为 `2.5✓`，测试仍期望精确 `✓`。

**处理范围：** 原有过严显示断言；核对实际数值、完成状态和持久化回执，不删数值以迎合断言。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #419 [desktop] tests/e2e/to-doo-antdv.spec.ts:237:1 › focus and habit quantity modals cancel without writes and persist explicit numeric receipts | 测试 :334：数量cell accessible name已为当前2.5页；内容期望✓，实际2.5✓。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-antdv-focus-and-hab-9d74a-t-explicit-numeric-receipts-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 数字回执/此前模态动作已执行到此；精确勾号断言不是最终持久化全通过证据。 |

## K. 空清单状态存在两个同名新建清单入口（1项）

**旧基线与本轮变化：** ToDoo 任务目录组件本轮无 diff；trace 匹配到目录标题处图标按钮和空状态 CTA 两个既有入口。

**处理范围：** 原有严格 locator 歧义；明确选标题区或空状态入口，然后验证取消后清单保留。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #505 [desktop] tests/e2e/to-doo-mobile-lists.spec.ts:100:1 › closing mobile new-list creation keeps the current list selected | 测试 :107：任务目录内新建清单匹配标题区按钮+empty-state按钮两项。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-mobile-lists-closin-a3608-s-the-current-list-selected-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 新建/取消动作未发生，所选清单保持不变量尚未验证。 |

## L. 提醒 scheduler 与测试夹具创建同一实体竞争（1项）

**旧基线与本轮变化：** 测试 reminder() 以确定 ID save_entity，但没有 expectedRevision；scheduler 已创建同一事件后，服务按既有并发规则返回400 TO_DOO_CONFLICT。ToDoo/reminder 服务和测试本轮无 diff。

**处理范围：** 真实 fixture 创建竞争。失败发生在 UI snooze 前，创建成功后才登记 cleanup 的代码也未执行；与之后泄漏提醒相符。需隔离复验并修正夹具并发处理后验证菜单与30分钟持久化，不能记作功能通过。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #509 [desktop] tests/e2e/to-doo-notification-statistics-audit.spec.ts:146:1 › notification snooze offers 5/15/30/60 minutes and stores the selected 30-minute delay | reminder() :93→command() :20：save_entity reminderEvent返回400，修改既有实体需要预期版本；scheduled title=审核提醒-task-3e2c6ccc。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-notification-statis-5c6e1-he-selected-30-minute-delay-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | Snooze菜单5/15/30/60与30分钟回执均未执行；同title事件随后成为遮挡源，需修复隔离夹具后复验。 |

## M. 实际 reminder-stack 拦截用户点击（8项）

**旧基线与本轮变化：** 8 项 terminal click 的 trace action log 明确由 `.reminder-stack` 子树拦截；不是旧定位器。ToDoo/reminder 组件及其 CSS 本轮无 diff。多个 blocker 标题与 #509 失败夹具的 `审核提醒-task-3e2c6ccc` 相同，支持共享状态泄漏链，但没有独立复现证明产品绝无风险。

**处理范围：** 原全量中的真实交互阻塞，8 项原意图均未完成。必须保留失败；优先在无遗留提醒和受控活动提醒两种状态分别复验，检查提醒卡与背景/模态交互策略。不能用 force click、自动隐藏真实提醒或归为 locator 来掩盖。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #513 [desktop] tests/e2e/to-doo-outcome-preview.spec.ts:9:1 › outcome preview renders Markdown safely and keeps the editable draft after closing | 45s timeout；terminal click任务详情 更多详情，reminder-stack h2 审核提醒-task-3e2c6ccc intercepts pointer events。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-outcome-preview-out-73225-ditable-draft-after-closing-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | Markdown安全预览、关闭保留editable draft未完成。 |
| #530 [desktop] tests/e2e/to-doo-task-audit.spec.ts:24:1 › board scope remains visible and column creation saves initial status and creation fields together | 45s timeout；terminal click任务详情 更多选项，被reminder-card拦截。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-task-audit-board-sc-fbe98-nd-creation-fields-together-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 列创建的初始状态/字段原子保存后续未完成。 |
| #540 [desktop] tests/e2e/to-doo-task-simplification.spec.ts:182:1 › group creation and view switching preserve the group, list and selected task | 测试 :186 terminal click 添加任务到分组 基础，被reminder-card拦截直到45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-task-simplification-7e698-roup-list-and-selected-task-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 分组/清单/选中任务跨视图保留未完成。 |
| #542 [desktop] tests/e2e/to-doo-task-simplification.spec.ts:241:1 › switching a new task to another list clears its original group | terminal click 添加任务到分组 基础，reminder-card拦截直到45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-task-simplification-cd8ba-t-clears-its-original-group-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 尚未切换新任务所属清单，清空原group不变量未执行。 |
| #553 [desktop] tests/e2e/to-doo-two-level-windows.spec.ts:98:3 › long import preview keeps navigation and confirmation reachable at 320px | expandToDooGroup :55 /测试 :104：导入选项click被reminder-card拦截，45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-two-level-windows-l-bf19b-irmation-reachable-at-320px-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 320px长导入预览与确认可达性未进入。 |
| #555 [desktop] tests/e2e/to-doo-unified-shell.spec.ts:32:1 › the shared header keeps save visible while a long settings form scrolls | terminal click任务规则 disclosure，reminder-stack内15分钟select标签拦截直到45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-unified-shell-the-s-96731--long-settings-form-scrolls-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 长设置页scroll及shared-header Save可见性未完成。 |
| #563 [desktop] tests/e2e/to-doo-ux.spec.ts:194:1 › wide task details continue the quick draft and submit exactly one real task | terminal click任务详情 创建任务，reminder-actions拦截直到45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-ux-wide-task-detail-e340e-ubmit-exactly-one-real-task-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 没有完成明确创建；不能对exactly-one任务写入作通过结论。 |
| #574 [desktop] tests/e2e/to-doo.spec.ts:24:1 › To Doo creates a real goal and task, preserves edits, completes and survives refresh | terminal click任务详情 更多选项，审核提醒-task-3e2c6ccc卡片拦截直到45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-To-Doo-creates-a-re-52489-pletes-and-survives-refresh-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | goal/task complete与reload durable流程未完成。 |

## N. 期望的实时提醒卡未出现，存在其他遗留提醒（1项）

**旧基线与本轮变化：** 原 ToDoo/reminder 代码与测试无 diff。最后 pending feed 只有 #509 的审核提醒，missedCount=2；测试直接等待本项 live.title，尚未到模态层级断言。未证明是轮播选择、feed 刷新时序还是更深的投递问题。

**处理范围：** 共享状态相关、根因边界尚未闭合；单项隔离与多提醒受控复验，确认本项 event 是否在 feed、选中哪张卡，再检验模态层级。不能宣称单纯旧断言或无产品风险。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #518 [desktop] tests/e2e/to-doo-reminders.spec.ts:193:1 › older reminder summaries use the app badge and live cards stay below edit dialogs | 测试 :218 等待本项live.title卡片超时；最后pending feed只含其他审核提醒，missedCount=2。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-reminders-older-rem-693b8-rds-stay-below-edit-dialogs-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 尚未打开habit编辑dialog，不能据此判断卡片/模态z-index断言通过或失败。 |

## O. 共享数据集总完成数被当成单项 fixture 数量（1项）

**旧基线与本轮变化：** 测试只新增并完成一个 task，却断言 server-captured 全局 metrics.completed=1。实际 snapshot 是 completed=6，另有970.34专注分钟和2成果，符合共享数据集中既有记录；统计源和本测试本轮无 diff。

**处理范围：** 原有共享状态假设。应以捕获前后的范围/基线作验证；此失败不说明快照未保存，但也不等于已通过其指标正确性验收。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #551 [desktop] tests/e2e/to-doo-two-level-windows.spec.ts:69:1 › review creation displays actual metrics and saves a server-captured snapshot | 测试 :93：保存review.metrics.completed期望1，实际6；返回快照另含focusMinutes970.34、outcomes2。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-two-level-windows-r-68a4b--a-server-captured-snapshot-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | Review已保存且带服务端指标；全局指标正确性需按受控基线验证。 |

## P. 既有上下文导航/页面标题与旧控件假设（3项）

**旧基线与本轮变化：** ToDoo 当前上下文导航、任务展示选项与偏好设置标题在基线已存在，本轮 ToDoo 模板/逻辑无 diff。失败目标对应已不在该位置/名称的旧控件或旧页面名。

**处理范围：** 原有导航/文本断言；需通过当前目录/菜单路线迁移并完整复验保留任务、过滤和窄屏可用性，不为测试新增旧入口。

| 原日志编号与精确测试名 | 已观察错误/证据 | 旧/新与范围 | 未覆盖边界/最具体下一步 |
| --- | --- | --- | --- |
| #560 [desktop] tests/e2e/to-doo-ux.spec.ts:81:1 › quick add inherits the selected list and clearing filters restores tasks across views | 测试 :120 等待.todo-view-switch内四象限直到45s；当前contextual tasks/board segmented不含该旧选项。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-ux-quick-add-inheri-d0b74-restores-tasks-across-views-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 前面搜索/看板部分已过；四象限与clear filters跨视图结果未验证。 |
| #565 [desktop] tests/e2e/to-doo-ux.spec.ts:276:1 › quick entry stays usable in a 320px dark workspace | 测试 :282 等待app内button今天直到45s；当前任务上下文在目录导航，非页面内该旧button。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-ux-quick-entry-stays-usable-in-a-320px-dark-workspace-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 320px dark quick-entry创建、布局与详细添加均未执行。 |
| #575 [desktop] tests/e2e/to-doo.spec.ts:103:1 › all To Doo sections are reachable on narrow and dark workspaces without overflow | 测试 :164：.todo-page h1期望设置，实际偏好设置，最终45s。 [trace](/home/bandoo/.codex/worktrees/60c5/doo-know/test-results/desktop/to-doo-all-To-Doo-sections-ace91-workspaces-without-overflow-desktop/trace.zip) | 见本组基线证据与范围；本项保留原始失败。 | 前面多个section导航已过；窄屏/暗色全部section无overflow不能宣称完成。 |

## 已移除路径、5项 dormant 与当前 primary 覆盖边界

独立 `.excalidraw`、`.mindmap` 和 `WhiteboardWorkspace` **不属于**本轮目录的5项 dormant。覆盖索引和 `reviews/settings-inventory.md` 明确列出的5项是 ST-042（未挂载 IndexStatus）与 ST-085–ST-088（仅注册的旧Git history/diff/restore贡献）。不能把12项旧原生路径失败移入这5项，也不能凭旧覆盖文案恢复已移除的生产能力。

933d63d和12b7798的 `Workspace.vue` 均挂载 `DiagramDocumentWorkspace`，没有 WhiteboardWorkspace；当前原件以primary Markdown声明中的资产存在。第三方 Excalidraw 原生控件仍在该当前编辑器中活动，其运行覆盖与旧独立note不同。

已在这次desktop原日志观察通过的当前路径，可说明替代覆盖而不改写上述失败：

- #52–#54：`diagram-desktop-session.spec.ts:14`，白板/脑图/流程图真实创建Markdown、编辑保存、reload与说明保留。
- #59：`diagram-desktop-session.spec.ts:270`，primary白板UUID与.md路径引用打开原生设计、返回并保留父正文，明确断言legacy whiteboard-workspace数量0。它不覆盖#76的上传竞争。
- #63：`diagram-desktop-session.spec.ts:384`，真实完整便携包下载与重新导入后新ID。它不覆盖旧生成Markdown预览笔记按钮。
- #68–#70：`diagram-editor-offline-export.spec.ts:148`，三类图形真实编辑、换目录离线Markdown/PNG阅读。这不是#281同一恢复任务的通过证据。
- #81–#83：`diagram-sharing-visual.spec.ts:16`，三类当前primary真实保存后匿名分享，撤销后不能再读取；与#609原旧夹具测试分别记录。

其他现有源码覆盖指针（本次triage未执行，不推断其结果）：

- `tests/document-copy.test.ts:37`：当前primary副本的新UUID、有效共享原件/PNG及副本后续变更不影响原件；:109覆盖重定位inline primary需要最终source/PNG准备。没有证明#93浏览器未知原件字段检查已完成。
- `tests/organization-retained-move.test.ts`：当前primary共享原件/PNG在move、undo和最终source重写下的服务端约束。没有证明#146完整浏览器batch/reload/undo路径已通过。
- `tests/diagram-artifacts.test.ts:248`：源/PNG共享隐私与离线目录复制，不是实时source-change-during-upload浏览器测试。

未来可迁移而未实施的具体边界：#76可用真实primary.md创建与prepare/commit源码更新，保留parent draft、held upload和source binding；#93可用primary.md保留副本原件不变、新UUID、preview ready、未知字段断言；#146可用当前primary含链接夹具保留move/reload/undo与原身份。#75的已移除独立生成预览笔记动作没有locator-only等价替换，需要明确重新定义验收，而非静默替换或删除。

覆盖文案审计遗留：`coverage/workspace.json` WS-017 仍称legacy.excalidraw会保留/自动追加扩展名，与基线仅.md的validator不符；它不证明存在生产入口。

## 后续与结论边界

Root已有ignored `confirmed-layout-test-update.patch`，本报告未应用。它只应纠正确认的布局/readiness断言；任何focused rerun的通过都只能归于该命名集合，不得写成原全量零失败。其余旧断言、obsolete夹具、索引降级、scheduler竞争、遗留提醒真实遮挡与全局指标假设仍按上表诚实列出。

提醒泄漏的证据链：#509 fixture在save_entity前被scheduler抢先创建同一确定ID，400后未走成功登记cleanup；后续trace的同名审核提醒拦截8项点击。服务/组件/CSS无本轮diff，但只有隔离与受控多提醒复验才能区分共享测试污染与需要产品处理的活动卡片行为。#518自己的live event未出现在最终feed，投递/刷新/轮播边界仍需独立验证。

本报告已覆盖原51项desktop失败；没有把失败改写为通过，没有判mobile结果，也没有宣称所有活动交互都无风险。
