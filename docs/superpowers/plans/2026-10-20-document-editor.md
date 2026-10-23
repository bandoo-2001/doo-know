# 文档编辑与 Markdown 源码双模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划已获用户授权，按 executing-plans 在当前会话内实施；独立审查和自动回归的证据见验收记录。

**Goal:** 提供无需 Markdown 知识的默认文档编辑方式，同时保留源码编辑、原文可恢复性及现有保存可靠性。

**Architecture:** 普通笔记由统一的 Markdown 编辑会话管理，Tiptap/ProseMirror 与 CodeMirror 是两种投影。原文保全转换层只改写实际编辑的安全单元，未知内容保留或回退源码；Workspace 继续持有唯一的服务器保存和冲突流程。大文件继续使用原有分段编辑器。

**Tech Stack:** Vue 3、TypeScript、CodeMirror 6、固定为 3.32.0 的 Tiptap 核心及扩展/ProseMirror 封装、现有 markdown-it/样式解析、DOMPurify、Vitest、Playwright；不采用外部云转换。

**Spec:** [文档编辑与源码双模式设计](../specs/2026-10-20-document-editor-design.md)。执行前同时阅读设计和本计划；技术验证结果不得降低设计中的数据保护要求。

## Global Constraints

- 文件仍以 Markdown 保存，已有知识库、Git、MCP、搜索、历史、分享和备份继续使用相同原文。
- 切换不触发服务器保存，不新增历史版本；保存仍由按钮或 Ctrl/Cmd+S 明确触发。
- 没有实际内容编辑时，返回读入的同一 Markdown 字符串；打开、浏览、切换模式均不产生写请求。
- 本地草稿继续存 Markdown、原文基准版本、账号/知识库身份；不以第三方编辑器 JSON 替代可恢复正文。
- 不改服务器保存协议和笔记身份；大文件继续使用原有分段编辑器。
- 文档编辑初始上限：262144 字节、5000 个语法单元、嵌套深度 32，并要求服务端 `editorMode === 'full'`。
- 历史最多 200 组且补丁/逆补丁文本合计不超过 4 MiB；不跨刷新持久化。
- 保留 `EditorPreferences.mode: 'edit' | 'preview' | 'split'`，新增 `editorKind: 'document' | 'source'`。
- `VITE_DOCUMENT_EDITOR_ENABLED` 初始为 `0`；本地开发预览与正式发布分别验收。
- 测试使用可丢弃语料和独立账号，不修改真实笔记。现有开发版为前端 5180/API 3011，正式版 5173 不作为修改目标。
- 当前工作树已有其他任务的未提交变更；实现时只纳入本功能相关修改，不覆盖、回退或合并提交无关工作。计划文件本轮不自动提交。

## Review Focus

1. 未知语法和跨单元引用被转换器误识别为普通正文：任务 1、2 验证无修改保全、依赖分析及拒绝不安全操作。
2. 中文组合输入遇到保存/切换/退出：任务 3、7 验证组合提交顺序和保留后续输入；任务 9 另做真实设备验收。
3. 旧投影或异步上传在切换笔记后回写：任务 3、5、7 验证代次和书签失效处理。
4. 保存实际成功但响应丢失，同时用户继续输入或切换编辑方式：任务 7 验证请求幂等和正确的未保存状态。
5. 外部 Git/MCP 修改、超出文档编辑上限或回退开关关闭：任务 7、8、10 验证可恢复草稿及源码通道。

## 里程碑与依赖

| 里程碑 | 任务 | 可交付结果 | 通过条件 |
| --- | --- | --- | --- |
| M0 可行性 | 0 | 兼容语料、候选引擎验证、依赖决定 | 不依赖默认全篇转换来声称原文保全 |
| M1 内容基础 | 1–3 | 原文保全、保留块、共享会话和历史 | 无编辑不变化，过期事件不生效 |
| M2 编辑体验 | 4–6 | 基础排版、表格/附件/粘贴、工作区接入 | 用户可通过按钮完成常用写作 |
| M3 可靠性 | 7–9 | 保存、恢复、迁移、大文件、输入法、安全和性能 | 数据完整性和兼容回归通过 |
| M4 发布准备 | 10 | 验收记录、开关、回退文档和待发布构建 | 明确的发布证据与剩余限制 |

关键顺序：`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`。可并行的是人工语料准备和设备验收安排，不在本计划内预先授权创建子代理。

工作量参考：按一名熟悉项目的开发者估算约 15–25 个有效开发日，不含等待验收或发布窗口；M0 完成后重新估算。原文保全和真实输入法是主要不确定项，不能通过压缩验证换取日期承诺。

## 文件职责

| 文件/目录 | 职责 |
| --- | --- |
| `apps/web/editor/contracts.ts` | 模式、补丁、选区、资格、快照及编辑器句柄合同 |
| `apps/web/editor/source-codec.ts` | 原文单元、源码位置、依赖分析、解析和局部序列化 |
| `apps/web/editor/compatibility.ts` | 内容准入、语法能力和整篇回退原因 |
| `apps/web/editor/history.ts` | 有界可逆补丁历史，跨编辑方式撤销重做 |
| `apps/web/editor/session.ts` | 笔记/代次、事务提交、模式切换、IME 和快照 |
| `apps/web/editor/rich-adapter.ts` | 候选引擎节点与项目合同、原文补丁的连接 |
| `apps/web/editor/extensions/` | 原文保留块、已有颜色/对齐、表格/代码等必要扩展 |
| `shared/markdown-tasks.ts` | 编辑预览、阅读、分享共同使用的非交互任务列表渲染 |
| `apps/web/editor/clipboard.ts`、`asset-bookmark.ts` | 安全粘贴转换和异步附件插入位置 |
| `apps/web/components/DocumentEditor.vue` | 文档编辑器视图及生命周期，禁止直接请求正文保存接口 |
| `apps/web/components/NoteEditorHost.vue` | 编辑器选择、延迟加载、共享命令、错误回退 |
| `apps/web/components/MarkdownEditor.vue` | 保留源码能力，普通笔记适配共享历史，大文件保持原行为 |
| `apps/web/components/Workspace.vue` | 接入 Host，继续保存、导航、草稿、插件及冲突管理 |
| `apps/web/components/EditorToolbar.vue` | 根据能力展示命令与状态，补充表格与代码操作 |
| `apps/web/components/settings/EditorSettings.vue`、`apps/web/preferences.ts`、`shared/settings-contracts.ts` | 双模式偏好与旧设置迁移 |
| `apps/web/document-editor.css` | 文档编辑、选区、表格及保留块的主题和响应式样式 |
| `tests/fixtures/editor-compatibility/` | 合成兼容语料与独立的预期结果，不复制私人知识库 |

实现文件已按职责落地，实际验证以验收记录为准。当前工作区含其他未提交工作，保留原始快照和本功能差异；本计划勾选不表示已经逐任务提交 Git，未混合自动提交。

## 共享接口

以下合同在任务 1 固定；后续任务不能自行改名。`RichProjection` 在 `rich-adapter.ts` 内定义，不向 Workspace 暴露第三方 JSON 类型。

```ts
type EditorKind = 'document' | 'source';
type NoteView = 'edit' | 'read';
type SelectionBookmark = { anchor: number; head: number; affinity: 'before' | 'after' };
type SourceEdit = { from: number; to: number; insert: string }; // UTF-16，基于同一版本，不重叠
type SourceUnit = { id: string; from: number; to: number; raw: string; kind: string; opaque: boolean; dependencies: string[] };
type Eligibility = { allowed: boolean; reason?: 'large-file' | 'size' | 'units' | 'depth' | 'syntax' | 'disabled'; message?: string };
type SourceDocument = { markdown: string; revision: number; units: SourceUnit[]; eligibility: Eligibility };
type CommitResult = { ok: true; markdown: string; revision: number; selection: SelectionBookmark } | { ok: false; code: 'stale' | 'unsupported' | 'invalid'; message: string };
type EditorSnapshot = { noteId: string; generation: number; revision: number; markdown: string; selection: SelectionBookmark };
type EditorHandle = {
  flush(): Promise<EditorSnapshot>;
  execute(action: MarkdownAction): boolean;
  focus(bookmark?: SelectionBookmark): void;
  goToLine(line: number): void;
};
```

`MarkdownAction`、`MarkdownToolbarState` 继续从 `apps/web/markdown-format.ts` 引入。新增表格动作定义为 `TableAction = 'addRowBefore' | 'addRowAfter' | 'deleteRow' | 'addColumnBefore' | 'addColumnAfter' | 'deleteColumn' | 'alignLeft' | 'alignCenter' | 'alignRight' | 'deleteTable'`，由文档编辑器独立的表格上下文工具发送，避免混入现有段落对齐命令。

### Task 0 技术验证和兼容语料

**Files:** 新建 `tests/fixtures/editor-compatibility/`、`docs/design/document-editor-feasibility.md`；试验保留在被忽略的 `.local/document-editor-probe/`，需要保留的代码须由后续任务重做并测试。

**Interfaces:** 消费当前 Markdown 读取/渲染合同；产出兼容矩阵、候选依赖精确版本与许可证、失败样例和是否继续 Tiptap 路线的决定。

- [x] 准备至少 30 份合成语料：普通排版、任务列表/嵌套、表格、相对图片/链接、CRLF/BOM、尾部空白、空文档、混合中英文/emoji、代码围栏、引用定义、Frontmatter、HTML/注释、已有颜色/对齐、未知指令、长行和深层嵌套。
- [x] 在项目环境隔离试验候选引擎，逐份记录 `parse → serialize` 的原文及语义差异；试验命令不访问真实资料，不安装全局依赖。
- [x] 验证 Vue 3 挂载/销毁、中文组合事件、节点原文元数据、表格和粘贴接入；确认依赖按需打包和许可可用。
- [x] 写出每份语料的预期分类 `editable / opaque / source-only`，并记录整篇默认序列化为何能/不能接受。
- [x] 准入评审：能够实现已批准的局部保全和回退才继续。否则输出可复现失败证据，修订技术选择；不把失败内容直接排除出既有知识库兼容范围。

**交付检查:** 可通过同一脚本重现矩阵；无真实资料写入；后续依赖组合和版本已有明确决定。此任务只产出验证结果，不启用新编辑器。

### Task 1 原文单元和局部序列化

**Files:** 新建 `apps/web/editor/contracts.ts`、`source-codec.ts`、`compatibility.ts`、`tests/editor-source-codec.test.ts`、`tests/editor-compatibility.test.ts`；必要时修改 `package.json`、`package-lock.json`。

**Interfaces:** `parseSource(markdown: string, revision?: number): SourceDocument`；`serializeEdits(base: SourceDocument, edits: readonly SourceEdit[]): CommitResult`；`evaluateDocumentEligibility(input: { editorMode: string; markdown: string; units: number; depth: number; enabled: boolean }): Eligibility`。

- [x] RED：对 Task 0 所有语料断言 `parseSource(md).markdown === md`，`serializeEdits(base, []).markdown === md`；中文/emoji 补丁位置正确，重叠/越界补丁拒绝。
- [x] RED：对 CRLF、尾部空白、引用定义、代码围栏及未编辑表格断言局部修改后其原文切片完全不变；深度、单元数和字节上限边界按设计拒绝。
- [x] 实现含原文位置与依赖的安全单元分解、版本化补丁及资格判断。现有 markdown-it 和扩展用于语义核对；引入新的语法分析包时只采用 Task 0 已验证组合。
- [x] GREEN：`npm test -- tests/editor-source-codec.test.ts tests/editor-compatibility.test.ts`；要求全部通过，并逐份比对预期分类。
- [x] 独立审阅补丁偏移与未编辑内容保全；实现阶段仅提交本任务涉及的文件。

### Task 2 原文保留块与项目样式兼容

**Files:** 新建 `apps/web/editor/extensions/opaque-source.ts`、`project-styles.ts`、`tests/editor-opaque-source.test.ts`；必要时扩展 `source-codec.ts`，不放开 `shared/markdown-styles.ts` 的白名单。

**Interfaces:** `classifySourceUnits(doc: SourceDocument): SourceDocument`；`validateUnitOperation(doc: SourceDocument, edits: readonly SourceEdit[], intent: 'edit' | 'deleteOpaque'): CommitResult`。保留块视图通过受信任侧表查原文，不从 DOM 接受原文或 ID。

- [x] RED：修改普通段落后，Frontmatter、注释、未知语法、相邻原文保留块逐字符不变；不明确的内联未知语法把包含它的安全单元整体保留。
- [x] RED：跨保留块删除、拆分跨块样式容器、改变引用依赖时默认拒绝且原草稿不变；明确删除保留块后撤销可恢复同一字符串。
- [x] 实现保留块能力、依赖边界和源码跳转位置；已有颜色/段落对齐只接收现有合法语法，通用 HTML 归保留或源码。
- [x] GREEN：`npm test -- tests/editor-source-codec.test.ts tests/editor-opaque-source.test.ts tests/markdown-style-render.test.ts`。
- [x] 审查未知内容复制、删除与撤销；不把解析成功当作可编辑证明，提交本任务修改。

### Task 3 共享会话、历史和模式切换

**Files:** 新建 `apps/web/editor/session.ts`、`history.ts`、`tests/editor-session.test.ts`、`tests/editor-history.test.ts`。

**Interfaces:** `createEditorSession(input: { noteId: string; generation: number; markdown: string }): EditorSession`，其方法固定为 `apply(input: { noteId: string; generation: number; baseRevision: number; origin: EditorKind; edits: readonly SourceEdit[]; selection: SelectionBookmark }): CommitResult`、`snapshot(): EditorSnapshot`、`flush(): Promise<EditorSnapshot>`、`setComposing(value: boolean): void`、`undo(): CommitResult`、`redo(): CommitResult`、`dispose(): void`。`prepareSwitch(target: EditorKind): Promise<EditorSnapshot>` 在目标投影建立前提供同一快照。

- [x] RED：文档输入 A → 源码输入 B → 切回文档，撤销顺序 B、A；模式切换本身不进入历史；历史裁剪不改变正文。
- [x] RED：不同 `noteId`、代次或基础版本的补丁失败且不会污染当前笔记；输入法组合期间保存/切换排队，组合完成后仅提交最终内容一次。
- [x] 实现事务接纳前验证、统一历史、选区书签和 flush 队列；撤销/重做产生新的会话版本，不能复用旧版本号。
- [x] GREEN：`npm test -- tests/editor-session.test.ts tests/editor-history.test.ts`，包括 200 组/4 MiB 限制、空编辑及 dispose 后事件。
- [x] 审查模式失败回退和输入事件先后顺序，提交本任务修改。

### Task 4 基础文档编辑器

**Files:** 新建 `apps/web/components/DocumentEditor.vue`、`apps/web/editor/rich-adapter.ts`、必要的基础扩展及 `tests/e2e/document-editor-basic.spec.ts`；添加 Task 0 确定的依赖。

**Interfaces:** 组件消费 `session: EditorSession`、`readOnly: boolean`，向 Host 发出 `state-change: MarkdownToolbarState`、`line-change: number`、`error: { code: string; message: string }`；暴露 `EditorHandle`，额外提供 `executeTable(action: TableAction): boolean` 供任务 5 使用。

- [x] RED：直接输入、选中加粗、标题、列表/任务、引用、代码块等操作可通过工具栏完成；保存前由会话快照得到相应 Markdown。
- [x] RED：初始化/外部投影更新不产生内容事件；危险事务被拒绝后仍有原草稿；只读状态、组合输入、快速销毁不漏出迟到更新。
- [x] 实现基础 schema、保留块、已有样式和选区映射；默认不启用 Markdown 输入规则；普通笔记的撤销快捷键指向共享历史。
- [x] GREEN：通过隔离 Host 测试页运行 `npm run test:e2e -- tests/e2e/document-editor-basic.spec.ts --output .local/document-editor-validation/basic`；桌面和手机均通过。
- [x] 验证卸载销毁编辑器及所有监听器；提交本任务修改，不改 Workspace 保存接口。

### Task 5 表格、链接、上传和粘贴

**Files:** 新建 `apps/web/editor/clipboard.ts`、`asset-bookmark.ts`、`components/DocumentTableTools.vue`、必要扩展、`tests/editor-clipboard.test.ts`、`tests/editor-asset-bookmark.test.ts`、`tests/e2e/document-editor-content.spec.ts`。

**Interfaces:** `convertClipboard(input: { text: string; html?: string }): { kind: 'supported'; markdown: string } | { kind: 'plain-text-choice'; text: string; reason: string }`；`captureAssetTarget(snapshot: EditorSnapshot): AssetTarget`，`AssetTarget` 在该文件导出并包含笔记、代次、版本和选区；`resolveAssetTarget(target: AssetTarget, current: EditorSnapshot): SelectionBookmark | undefined`。`TableAction` 见共享接口。

- [x] RED：表格增删行列/对齐、管道符转义、表头、Tab 导航及整表撤销；复杂表格不产生不能持久化的结构。
- [x] RED：Word/网页粘贴保留支持的标题/列表/表格语义；多块单元格、危险 HTML、伪造节点 ID 和危险链接按合同处理；取消粘贴后内容不变。
- [x] RED：上传完成前切换笔记、目标被删、书签版本落后，不能插入当前其他笔记；正常相对图片路径、标题、替代文字往返保留。
- [x] 实现能力受控的表格/链接面板及剪贴板转换；附件上传复用现有 API，业务回调使用 `AssetTarget`，不从图片地址推断写入目标。
- [x] GREEN：运行上述两个单测文件与 `document-editor-content.spec.ts`；验证一次失败上传和纯文本粘贴选择；提交本任务修改。

### Task 6 工作区统一编辑入口

**Files:** 新建 `apps/web/components/NoteEditorHost.vue`、`apps/web/document-editor.css`、`shared/markdown-tasks.ts`；修改 `Workspace.vue`、`MarkdownEditor.vue`、`EditorToolbar.vue`、`ShareReader.vue`、`LargeFileWorkspace.vue`、`main.ts` 和 `packages/core/render.ts` 的渲染接入；新建 `tests/e2e/editor-mode-switch.spec.ts`、`tests/markdown-task-render.test.ts`。

**Interfaces:** Host 消费 `noteId`、`generation`、`modelValue`、`kind`、`readOnly`、`initialLine`；发出 `update:modelValue`、`state-change`、`line-change`、`error`；暴露 `EditorHandle` 及 `executeTable`。Host 内建立共享会话，仅将已验证内容同步给 Workspace。

- [x] RED：顶部“文档编辑 / Markdown 源码 / 阅读”切换；文档模式不显示 `#`、`>`、表格竖线；源码开启“同时预览”后仍保留原有分屏能力。
- [x] RED：切换 20 次不造成写请求、脏状态、额外字符或历史版本；源码改标题再切回后章节目录更新；搜索命中定位到对应文本或保留块边界。
- [x] 实现延迟加载与同一会话连接；普通笔记快捷键/撤销按钮不再分叉调用原生历史；大文件使用 MarkdownEditor 的现有路径和默认行为。
- [x] 将工具栏标签改为“正文格式”，依模式隐藏不适用操作；未支持的动作有具体禁用原因，保留选区、主题和章节折叠状态。
- [x] RED → GREEN：普通阅读、源码分屏、分享和大文件片段渲染中的任务列表状态一致；阅读态标记不可修改，代码块中的 `[ ]` 保持字面内容。以纯渲染扩展接入现有清洗流程，不增加服务器写接口。
- [x] GREEN：运行 `editor-mode-switch.spec.ts`、`editor-selection.spec.ts`、`toolbar-controls.spec.ts`、`document-outline-folding.spec.ts`、`search-location.spec.ts`；确认无保存 API 调用后提交。

### Task 7 接入草稿和保存可靠性

**Files:** 修改 `Workspace.vue`、`useNoteDraft.ts`，仅在必要时调整 `drafts.ts`；新增 `tests/e2e/document-editor-recovery.spec.ts`，扩展 `tests/workspace-save-recovery.test.ts`。

**Interfaces:** 使用 `EditorHandle.flush()` 获得不可变快照，交给既有保存函数。草稿 `DraftInput` 保持 Markdown 合同，新增非必要元数据不得作为恢复正文的前提。

- [x] RED：在两个编辑方式下分别覆盖刷新恢复、切到设置/应用再返回、导航取消、存储配额失败、退出后旧标签页不得恢复写入。
- [x] RED：保存实际成功但响应丢失；等待期间继续输入并切换模式；重试复用原请求和原提交快照，后续输入仍显示未保存。
- [x] RED：外部 Git/MCP 修改、原文版本冲突、上传迟到、服务暂时不可用，都不会用服务器回执覆盖当前草稿；跨笔记保存回执只作用于原目标。
- [x] 将保存/导航/恢复接到同一个 flush 入口；组合输入未结束时记录待执行动作，完成后再生成保存快照；旧大文件片段基准检查保持原样。
- [x] GREEN：`npm test -- tests/workspace-save-recovery.test.ts tests/web-note-drafts.test.ts tests/web-drafts.test.ts`；浏览器运行 `document-editor-recovery.spec.ts`、`save-recovery.spec.ts`、`local-drafts.spec.ts`、`plugin-draft-navigation.spec.ts`。
- [x] 审阅故障恢复回执及实际磁盘内容，确认没有自动保存行为后提交。

### Task 8 设置迁移、资格回退和手机交互

**Files:** 修改 `shared/settings-contracts.ts`、`preferences.ts`、`components/settings/EditorSettings.vue`、`NoteEditorHost.vue`、`document-editor.css`；新增 `tests/e2e/document-editor-compatibility.spec.ts`，扩展 `tests/editor-preferences.test.ts`。

**Interfaces:** `editorKind` 与旧 `mode` 组合规则按设计固定；`evaluateDocumentEligibility` 产出可显示的原因。组件中的暂时回退不能写回全局默认偏好。

- [x] RED：新账号默认文档；旧 edit/preview/split 分别保持源码编辑/阅读/源码分屏；非法新配置规范化；不同账号浏览器偏好隔离。
- [x] RED：边界文件、超长行、超深嵌套、大文件、普通文件编辑后超过上限，均保留完整内容并提供可用源码入口；不将大文件下载到富文本编辑器。
- [x] 实现设置页和兼容性提示；保留字体大小、阅读宽度和主题；行号与自动换行明确属于源码设置。
- [x] 验证 1238×1315、1440×900、390×844、320×568 及深色/减少动态效果；手机软键盘下保存、选区和表格操作可达。
- [x] GREEN：偏好单测和 `document-editor-compatibility.spec.ts`、`large-files.spec.ts`、`text-style.spec.ts`；提交前确认草稿基准仍有效。

### Task 9 安全、真实输入法与性能

**Files:** 新建 `tests/editor-content-security.test.ts`、`tests/e2e/document-editor-input.spec.ts`、`scripts/benchmark-document-editor.ts`、`docs/验收记录/2026-10-20-document-editor.md`；按发现最小调整转换层和组件。

**Interfaces:** 基准脚本输出设备/浏览器、语料、预热 5 次/采样 30 次、p95 耗时和资源大小，不输出正文。合成语料来自 fixtures。

- [x] RED：粘贴脚本/事件属性、危险协议、伪造内部元数据、原文保留块内 HTML 不会执行或越过附件权限；编辑/阅读路径均覆盖。
- [x] 验证组合事件逻辑；用户已确认电脑、手机两端输入、保存、切换、重开及软键盘操作正常，不以 Playwright 事件代替真实设备结论。
- [ ] 补录真机操作系统、设备及输入法版本；当前只记录用户双端验收，未声称覆盖特定版本组合。
- [x] 执行 10 KiB、200 KiB/100×10 表格边界语料基准及至少 200 个输入样本；按设计的 p95 300 ms、1500 ms、50 ms 门槛判断。
- [x] 测量阅读入口和两个编辑入口的资源请求/gzip 大小；阅读不得请求文档编辑器 chunk，反复切换不重复创建编辑器或泄漏监听器。
- [x] 未达标时定位受影响结构并优化或降低文档准入范围；不丢弃内容、不提高服务端限制、不用性能失败替代大文件回退。
- [x] GREEN：安全单测、输入浏览器测试及基准通过；验收记录写明真实结果、未覆盖环境和剩余限制，提交本任务修改。

### Task 10 完整回归和渐进启用

**Files:** 修改 `README.md`、`docs/界面组件与开发预览.md`，完善本计划与验收记录；开关读取集中在 `compatibility.ts`，必要时补充构建配置类型。

**Interfaces:** `documentEditorEnabled(): boolean` 读取构建变量 `VITE_DOCUMENT_EDITOR_ENABLED`，缺省返回 false；关闭时所有新偏好仍能映射为源码/阅读，不删除草稿。

- [x] 新增开关开/关回归：开启可见文档编辑，关闭仍能打开新模式保存过的 Markdown 和本地草稿；无需知识库或数据库迁移。
- [x] 最终执行 `npm test`、`npm run typecheck`、`npm run build`。浏览器测试使用独立输出目录，包含新双模式套件及既有源码、保存、草稿、分享、Git/插件导航、大文件和目录操作场景；全量失败必须记录名称和证据。
- [x] 浏览器测试串行使用 4179/4180，先确认端口及环境；每组重建隔离账号，不通过清空开发实例限流或修改正式服务来让测试通过。
- [x] 在隔离开发实例构建启用开关的版本，完成“不懂 Markdown 的用户通过工具栏新建、排版、保存、重开”的完整验收。
- [x] 整理待发布构建、依赖许可、体积、兼容语料结果、回退步骤和已知边界；检查变更不包含私人资料及无关工作。
- [x] 已收到独立发布授权并完成正式构建/切换；先保留可恢复版本和既有一致性备份，发布后核对实际版本、登录、保存和分享读取。
- [x] 发布准入和正式验证通过后启用正式文档编辑；存在内容丢失、误保存或静默改写时保持开关关闭。

## 最终验收清单

- [x] 不懂 Markdown 的使用者能够仅通过界面完成标题、列表、表格、图片和链接的编辑、保存与重开。
- [x] 源码、分屏及阅读仍可用；切换不写原文，不污染撤销、选区及未保存状态。
- [x] 兼容语料全部符合 editable / opaque / source-only 分类；无编辑往返全部保持输入字符串，未编辑安全单元不变。
- [x] 普通笔记的草稿、保存幂等、冲突、后续输入、迟到事件和跨笔记保护均有验证。
- [x] 搜索命中、章节目录、Git/MCP、分享/历史/下载及大文件流程正常。
- [x] 手机、主题、键盘、减少动态效果和真实中文输入法具备验收记录。
- [x] 性能、体积、依赖许可和异常回退已记录；关闭开关可恢复源码使用而不改资料。
- [x] 所有实际失败及未覆盖环境已明确记录；计划完成勾选与真实交付范围一致。

## 本轮实施交付边界

实现与验证见[验收记录](../../验收记录/2026-10-20-document-editor.md)。用户已确认电脑与手机两端使用正常；具体平台/输入法版本仍待补录。用户后续已明确授权正式发布，rc.26 已上线；证据见[正式发布记录](../../部署记录/2026-10-21-文档编辑正式版发布.md)。
