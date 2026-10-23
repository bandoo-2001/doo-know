# DooKnow 编辑器整体改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 分批增强代码块、SVG、常用编辑与相关界面，同时保持 Markdown 原文、可携带附件及外部阅读能力。

**Architecture:** 沿用 Tiptap/ProseMirror 文档层、CodeMirror 源码层与 EditorSession 权威状态。图形预览是可再生附件，使用标准 Markdown 回退；定位与差异展示库只替换对应界面能力。

**Tech Stack:** Vue 3、TypeScript、Tiptap 3、CodeMirror 6、现有 Markdown/附件/白板服务；候选 Floating UI Vue、diff2html，现有 Ant Design Vue/Naive UI。

**Spec:** [整体设计](../specs/2026-10-23-editor-improvement-design.md)。实施者先读该设计及[需求记录](../../界面组件与开发预览.md)。状态：用户于 2026-10-23 确认全部实施；任务中的新文件与接口为拟新增，完成状态见本计划台账。

## Global Constraints

- Markdown 继续作为唯一正文存储格式。
- 通用正文以 CommonMark 为基础；表格、任务列表和删除线属于 GFM 扩展，不承诺所有基础阅读器同样渲染。
- 未编辑的段落、围栏、语言标记、换行与保留块不能因切换模式、主题或预览而改写。
- EditorSession 是正文与撤销的权威；嵌套控件不得产生第二套互不相通的正文或撤销历史。
- 展示增强不触发隐式保存；保存冲突、重试、笔记代次与草稿归属保护必须保留。
- 外部阅读不依赖登录态、站内 API、笔记 UUID 查询或 DooKnow 前端脚本。
- 现有附件上限 10 MiB、Git 差异上限 256 KiB、普通/大文件/元数据模式边界继续生效；不能为接入控件绕过它们。
- 不批量迁移既有笔记，不自动改写已有白板引用，不清理用户设计源文件或真实数据。

## Review Focus

- 含代码围栏、CRLF、中文和 emoji 的嵌套编辑：未改动单元原样保留，跨编辑器只撤销对应操作。归属 Task 2。
- 图形预览失败、写入冲突、外部修改和快速切换笔记：源文保留，预览不冒充新版本，父笔记不隐式保存。归属 Task 4。
- SVG 外链、损坏 XML、脚本、超限和旧分享：不执行、不自动联网、不绕过已有附件授权。归属 Task 3。
- 批量上传期间的插入位置变化或重新登录：逐项结果可恢复，不能插入后来打开的笔记或重复创建。归属 Task 6。
- 离线复制、目录移动、重命名与导出重导入：相对资源仍有效，不依赖站内 API 或只有站内可解释的 ID。归属 Task 1、4、10。

---

## 文件职责

- 现有 `apps/web/editor/session.ts`、`source-codec.ts`、`rich-adapter.ts` 保持权威，不在 Workspace 内另造编辑历史。
- 代码块桥接放在 `apps/web/editor/code-block-view.ts`，节点扩展继续由 `extensions/code-block.ts` 注册；语言加载放在 `code-languages.ts`。
- 跨端图形表示放在 `shared/portable-figure.ts`；服务端 SVG 规则放在 `packages/core/svg.ts`；浏览器渲染及 PNG 生成放在 `apps/web/diagrams/`。
- 查找与替换纯逻辑放在 `apps/web/editor/search.ts`；附件队列放在 `apps/web/editor/upload-queue.ts`。Workspace 只接入生命周期、保存与界面，不继续堆完整算法。
- 浮动定位用 `apps/web/editor/floating-tools.ts` 适配；Git 差异封装在 `plugins/git/web/diff-view.ts`，不跨进 Git 执行层。

## Task 1（A）：兼容样本与可携带图形表示

**Files:** Create `shared/portable-figure.ts`、`tests/editor-portability.test.ts`（兼容样本内联在测试中）；必要时仅新增测试用 CommonMark/GFM 渲染依赖到 `package.json`/lock。

**Interfaces:** 新增 `PortableFigure = { alt: string; previewPath: string; source: { type: 'file'; path: string } | { type: 'fence'; language: 'svg' | 'mermaid'; code: string } }`；`renderPortableFigure(input: PortableFigure): string`。它生成普通 Markdown，不做文件写入、图形渲染或权限判断；实际文件解析仍走知识库路径校验。

- [x] 建立基础/GFM/图形回退三组样本及失败断言：图片与源码链接保留，围栏内含反引号仍完整，渲染结果无必需的 `/api/` 路径；源图为空、路径为站内接口时拒绝生成“可携带”组。
- [x] 运行 `npx vitest run tests/editor-portability.test.ts`，先观察缺少新接口的失败，再实现普通 Markdown 序列化；复用现有转义和路径工具，不能手写全套 Markdown 解析器。
- [x] 同一命令通过；CommonMark 检查基础内容，GFM 额外检查表格/任务，不要求基础 CommonMark 能画任务勾选框。
- [x] 提交该独立样本及表示层。它不改变现有笔记。进入 Task 4 前补齐图形源/预览一致性方案与失败恢复用例。

## Task 2（B）：CodeMirror 6 内嵌代码块

**Files:** Create `apps/web/editor/code-block-view.ts`、`apps/web/editor/code-languages.ts`、`tests/editor-code-block-view.test.ts`、`tests/e2e/code-block-editor.spec.ts`；Modify `apps/web/editor/extensions/code-block.ts`、`DocumentEditor.vue`、`document-editor.css`，按需调整 `rich-adapter.ts`、`session.ts` 和依赖清单。

**Interfaces:** `createCodeBlockView(...)` 采用现有 ProseMirror NodeView 签名，由代码块扩展调用；`loadCodeLanguage(name: string): Promise<Extension>` 提供语言扩展，未知语言回到纯文本。修改先映射为 ProseMirror 事务，再沿已有投影进入 `EditorSession.apply`；Ctrl/Cmd+Z/Y 和组合输入走同一权威，不启用第二套独立历史。Mermaid/Excalidraw 专用 NodeView 保持现状。

- [x] 写用例：````ts`/`~~~` 围栏、CRLF、代码内反引号、未知语言和未编辑相邻保留块在切换后原样保留；编辑代码→编辑正文→连续撤销得到原文；只读不写入；焦点进出代码块不丢选区；旧语言加载完成不能覆盖新语言或后来打开的笔记。用 `expect(afterUntouched).toBe(before)` 固定保全结果。
- [x] 先跑 `npx vitest run tests/editor-code-block-view.test.ts tests/editor-history.test.ts tests/editor-opaque-source.test.ts` 观察新能力缺失，再实现 NodeView、按需语言加载及精简头部控件。
- [x] 针对同一命令和 `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/code-block-editor.spec.ts` 验证；真实中文输入法另做人工记录，合成 composition 不能替代。
- [x] 确认代码块编辑和展示都不隐式保存、不读取完整大文件；提交。未通过原文与历史测试前不进入图形源码编辑。

## Task 3（C1）：SVG 受限附件与预览

**Files:** Create `packages/core/svg.ts`、`shared/svg-policy.ts`、`apps/web/diagrams/svg-preview.ts`、`tests/svg-assets.test.ts`、`tests/e2e/svg-preview.spec.ts`；Modify `packages/core/assets.ts`、`apps/server/app.ts`、`apps/web/image-requests.ts`、`Workspace.vue`，复用既有分享/附件访问检查。

**Interfaces:** `validateSvgSource(bytes: Uint8Array): SvgValidationResult` 返回可展示的自包含 SVG 或结构化拒绝原因；`SvgValidationResult` 不把“原始源文”与“可展示产物”混为一份。展示入口与源文件下载入口分别指定响应类型；源文件按下载方式提供。第一步明确解析/净化依赖、允许列表和资源限额并写入 `svg-policy.ts`，不用单纯正则替代 XML 解析。

- [x] 写最小安全与授权样本：普通路径/文字/渐变可预览；DOCTYPE/实体、脚本、事件、foreignObject、外部图片/字体/链接加载、损坏 XML 和超限拒绝；SVG 名称伪装位图拒绝；匿名与失效分享不能读取私有源文或预览。保留当前 10 MiB 附件总上限。
- [x] 先运行 `npx vitest run tests/svg-assets.test.ts tests/knowledge/asset-references.test.ts` 观察失败，再增加 SVG 类型规则、受限产物及前端授权图片显示。首批只支持自包含 SVG；不自动联网补资源。
- [x] 单元通过后跑 `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/svg-preview.spec.ts tests/e2e/image-surfaces.spec.ts`；记录有意不支持的 SVG 特性及清楚的用户提示。
- [x] 提交。未完成净化和权限检查前不把 SVG 直接放开为普通内联图片。

## Task 4（C2）：图形源码、PNG 回退与可携带保存

**Files:** Create `apps/web/diagrams/preview-artifact.ts`、`packages/core/knowledge/diagram-artifacts.ts`、`tests/diagram-artifacts.test.ts`、`tests/e2e/diagram-portability.spec.ts`；Modify `shared/diagram-fences.ts`、`DiagramPreview.vue`、`extensions/code-block.ts`、`WhiteboardWorkspace.vue`、`Workspace.vue`，以及实际承载导入/导出任务的服务代码与 `tests/whiteboard-transfers.test.ts`。

**Interfaces:** 复用 Task 1 的 `PortableFigure`。新增 `PreparedPreview = { kind: 'svg' | 'mermaid' | 'excalidraw'; sourceHash: string; preview: Blob }` 与 `preparePreview(...): Promise<PreparedPreview>`；服务端附件组契约绑定源摘要、预览摘要及关联的笔记版本/请求 ID。对象字段、持久化收据和恢复策略先在本任务的失败测试中固定，再接入保存界面。

- [x] 先写失败用例：源版本 S1 预览未完成时切到 S2，S1 不得覆盖；预览上传失败保留原文；源已保存但父笔记未保存时不显示“全部已保存”；父笔记冲突不覆盖磁盘；取消编辑不自动插入兼容图片。
- [x] 用 `npx vitest run tests/diagram-artifacts.test.ts tests/whiteboard-transfers.test.ts` 固定源、预览和笔记的发布边界；沿现有版本检查、写入意图和重试机制实现，不用“依次写多个文件即认为成功”代替一致性处理。
- [x] 接入 SVG 代码/图形切换、PNG 回退及新建 Mermaid/白板图块的兼容形式；已有引用继续可读，兼容生成是显式编辑操作。设计源保留，旧图块不批量迁移。
- [x] 跑上述单元及 `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/diagram-portability.spec.ts tests/e2e/whiteboards.spec.ts`；把 `.md`/附件复制到独立目录，断网或停用 DooKnow 后验证图片和源链接；移动重命名、导出重导入结果仍须一致。通过后提交。

## Task 5（D1）：统一文内查找替换

**Files:** Create `apps/web/editor/search.ts`、`apps/web/components/EditorSearch.vue`、`tests/editor-search.test.ts`、`tests/e2e/editor-search.spec.ts`；Modify `DocumentEditor.vue`、`MarkdownEditor.vue`、`NoteEditorHost.vue` 与现有工具栏。

**Interfaces:** `findText(text: string, query: string, options: { caseSensitive: boolean }): { from: number; to: number }[]` 返回 UTF-16 偏移以匹配现有 SourceEdit；文档模式匹配可编辑可见文本并映射到现有事务，不能拿可见偏移直接替换 Markdown 原文。源码模式继续复用 CodeMirror search。

- [x] 写断言：中文、emoji、跨格式文本、无匹配、空查询、当前匹配替换与全部替换；文档查找不命中隐藏 HTML、白板 JSON、保留块或 Markdown 链接地址；只读不替换，替换可撤销。
- [x] `npx vitest run tests/editor-search.test.ts` 先红后绿，实现同一搜索栏入口、匹配计数和前后跳转；文档显示“当前笔记”，大文件片段显示“当前片段”。
- [x] `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/editor-search.spec.ts` 检查快捷键、焦点、快速切换笔记和源码模式回归；通过后提交。

## Task 6（D2）：Markdown 粘贴与多附件队列

**Files:** Create `apps/web/editor/upload-queue.ts`、`tests/editor-upload-queue.test.ts`、`tests/e2e/editor-paste-drop.spec.ts`；Modify `clipboard.ts`、`asset-bookmark.ts`、`DocumentEditor.vue`、`Workspace.vue`、`tests/editor-clipboard.test.ts`。

**Interfaces:** 保留已有 `captureAssetTarget`/`resolveAssetTarget`。队列项携带文件、原笔记/代次/插入目标、独立请求 ID 和成功/失败状态；成功结果按用户文件顺序归并，不按网络完成顺序插入。Markdown 粘贴是明确操作，普通粘贴继续保留文字原意。

- [x] 写用例：三文件中第二项失败，重试不重复第一项；第三项先完成也不乱序；上传时移动光标/切换笔记/重新登录不误插入；Markdown 与纯文本粘贴对同一输入产生明确不同结果，未知语法保留原文。
- [x] `npx vitest run tests/editor-upload-queue.test.ts tests/editor-clipboard.test.ts tests/editor-asset-bookmark.test.ts` 先红后绿；初版串行上传，统一文件选择、粘贴和外部拖放入口，保留每项显式重试及插入入口。
- [x] `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/editor-paste-drop.spec.ts tests/e2e/document-editor-controls.spec.ts` 覆盖失败、离开、重试及原图片替换行为；通过后提交。

## Task 7（D3）：H6、清除格式和基础统计

**Files:** Modify `HeadingPicker.vue`、`EditorToolbar.vue`、`DocumentEditor.vue`、`apps/web/editor/toolbar-state.ts`、`apps/web/markdown-format.ts`；Create `apps/web/editor/document-stats.ts`、`tests/editor-common-actions.test.ts`，扩展相应浏览器控件用例。

**Interfaces:** `MarkdownAction` 扩展 `heading6` 与 `clearFormatting`，源码/文档模式均实现；清除文字样式不删除正文、附件、图块或保留块。`countCharacters(text: string): number` 以 Unicode 码点计数，统计界面明确全文/选区及当前模式口径。

- [x] 写断言：H6 的 Markdown 前缀是六个 `#`；清除选区粗斜体/颜色等后文本不变、一次撤销能恢复；`countCharacters("A😀中") === 3`，统计不创建编辑事务；只读禁用修改。
- [x] `npx vitest run tests/editor-common-actions.test.ts tests/markdown-format.test.ts` 先红后绿实现；受影响控件浏览器回归通过后提交。暂不加入无法兼容保存的字号、列宽或合并单元格按钮。

## Task 8（E1）：浮动定位与基础控件收敛

**Files:** Create `apps/web/editor/floating-tools.ts`；Modify `DocumentEditor.vue`、`HeadingPicker.vue`、`TablePicker.vue`、`TreeContextMenu.vue`，选择器逐个复用现有 Ant 组件；扩展 `tests/e2e/document-editor-controls.spec.ts`、`tests/e2e/tree-actions.spec.ts`。

**Interfaces:** 用 `@floating-ui/vue` 封装真实或虚拟锚点，提供样式与停止监听句柄；它不负责选区、焦点和“哪个对象被操作”的判断。只逐个替换定位层，不同时改动保存逻辑或全局换皮。

- [x] 保留并补充可见行为断言：对象靠近视口边缘、正文滚动、目录调宽、短窗口、浏览器缩放及手机键盘时工具条可操作；鼠标和键盘打开菜单后选区仍指向原对象。
- [x] 先复现相关缺口，再逐个组件替换定位；已有成熟弹层足够时直接复用，不嵌套两套定位器。若原有交互已经满足断言，不为替换本身虚构失败或新增镜像单测。
- [x] `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/document-editor-controls.spec.ts tests/e2e/tree-actions.spec.ts` 通过，`npm run typecheck` 通过后提交。设置的未保存关闭守卫保持现有实现。

## Task 9（E2）：Git 只读差异展示

**Files:** Create `plugins/git/web/diff-view.ts`、`tests/e2e/git-diff-view.spec.ts`；Modify `plugins/git/web/index.ts` 及依赖清单。

**Interfaces:** 封装 diff2html 的展示接口，输入是现有 `git.diff` provider 返回的 patch 和截断状态，输出可释放的展示节点。支持逐行/左右两种视图，短窗口回到逐行；不新增 Git 执行接口或自动合并行为。

- [x] 准备包含中文、长行、重命名、空 diff、二进制提示和 HTML 字符的真实隔离仓库样本；断言增删内容/行号可区分、文本不被解释成用户 HTML，超过现有 256 KiB 上限仍明确提示且不绕过截断。
- [x] 先运行 `VITE_DOCUMENT_EDITOR_ENABLED=1 npm run test:e2e -- tests/e2e/git-diff-view.spec.ts` 观察新界面缺失，再接入按需加载的展示层。
- [x] 同一命令及受影响 Git 历史/恢复用例通过，确认恢复仍作用于已选择并核对的提交；提交。可编辑合并、三方冲突和原生 Git 全功能测试另立任务，不借此替换后端。

## Task 10：外部阅读与每批交付检查

**Files:** 向 `docs/验收记录/2026-10-23-editor-improvements.md` 记录实际验证，更新 `docs/界面组件与开发预览.md` 的已实现状态；不更改历史审计结论。

**Interfaces:** 收集每批对应源码提交、测试结果、外部阅读器版本/插件、截图与兼容差异；没有执行的环境写“未验收”。本任务按每批重复执行，不要求攒到所有任务结束。

- [x] `npm run typecheck`、`npm run build` 及该批受影响单元/桌面与手机用例通过；新增变更或未解决失败才扩大或重复检查。
- [ ] 外部 GUI 手工抽查仍未验收：VS Code Markdown 预览、GitHub 和第三方本地阅读器。独立 CommonMark/GFM 样本、无请求的离线 HTML、移动及导出重导入已自动验证，不替代这些人工环境。
- [x] 记录首次打开与长文档资源情况，确认语言按需加载、大文件限制与异步请求释放仍有效；兼容转换不会自动改写现有文档。
- [x] 只有用户要求发布时才构建带版本号的正式制品，走已有 `verify:release`、隔离安装和远端校验；发布不自动更新当前实例。本计划不预定新版本号。

## 顺序与完成边界

A = Task 1；B = Task 2；C = Task 3–4；D = Task 5–7；E = Task 8–9。推荐按此顺序，每批配 Task 10 验收；Task 8/9 可以作为独立界面批次，但不能绕过保全测试。用户已确认 F 批也实施：公式、脚注、提示块、双链、YAML 表单、快捷插入和阅读导出均纳入本轮。

本方案没有授权删除真实数据、重装服务、发布全部候选功能或更新生产实例。用户已确认实施；当前不包含发布、安装或服务变更授权。

## 最终交付状态（2026-10-23）

A–F 实现完成。F 包含公式、完整脚注保留、提示块、相对 Wiki 链接及反向引用查询、YAML 表单、斜杠/快捷插入、独立 HTML 与浏览器打印。表格行列移动也已接入，限制为可往返的 GFM 结构。

全量 1,416 项通过、1 项条件跳过；桌面和手机各 74 项应用回归通过；类型检查、构建与隔离插件制品验证通过。具体范围、SVG/嵌套图块限制及人工验收缺口见[验收记录](../../验收记录/2026-10-23-editor-improvements.md)。真实中文输入法尚未人工验收。

各领域先分别实现及复核，再统一提交整合代码，避免共享编辑器接口的中间状态。本轮没有发布、安装、生产服务或真实资料变更。
