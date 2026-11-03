# 图形编辑会话与白板界面实施计划

父计划 Task5B–D；依据已批准设计。公开与 legacy 资源适配由另一个独立任务实现。这里不改服务器和分享 schema。

## Task 1: 保留机器标记与受管区

修改 `shared/knowledge-markdown.ts`、`apps/web/editor/source-codec.ts`，新增聚焦测试。标准阅读渲染隐藏经过验证的 document/primary 边界/binding 注释，HTML 仍关闭，代码示例原样展示。原文账本保持字节保留；有效受管区作为单个保护原文节点，普通可视化编辑（包括普通 opaque 删除操作）不能删改其边界，必须切换源码/明确转换。未知内容仍原样回退，不重写既有原文账本。

## Task 2: 版本化草稿与共享协调者

新增 `apps/web/diagrams/session.ts` 和测试；扩展 `drafts.ts`/`useNoteDraft.ts` 的明确 v2 图形封装，兼容无封装旧记录。封装保存 `{version:2,documentType,payloadFormat,documentHash,sourceHash,intentId?,payload}`，不根据后缀猜载荷。旧 JSON 草稿被识别保留，不能套用 Markdown 恢复。单会话唯一 save queue 固定 source/Markdown 快照和双基线，画布/源码/只读预览切换交接后重置专用撤销边界；异步 PNG/派生标记不作为用户撤销。IndexedDB 继续原有跨标签页版本 CAS。恢复未发布意图验证原 actor/路径/状态。

## Task 3: 新 Markdown 白板界面

复用既有 `WhiteboardWorkspace.vue` 的画布、键盘/主题、恢复/返回保护。旧文件仍以旧载荷读写；新 Markdown 白板 GET 主文档和 diagram resource 分离，不解析 Markdown 为 JSON。新图：reserve → 同快照PNG → prepare →完整 Markdown commit →激活，失败保留未发布意图/本地草稿，不能先创建空活动 JSON。

`Workspace.vue` 创建白板统一 `.md`，文件树/菜单/选择器基于服务器语义类型，导出原文为 Markdown，原件下载独立。专用画布、Markdown 源码、只读 PNG 视图共用会话；源编辑失败保留原文，缺失/冲突源显示已有PNG及明确状态，不能塞入空场景。编辑更新仅替换受管源/PNG/binding/必要标题和render字段，保留frontmatter、未知元数据和说明区。共享 `applyPreparedDiagramDocument` helper 按 parser范围更新，并测试不变字节和精确sourceHash。

公开 `DiagramPreview.vue` 适配安全资源 DTO，仅有预览时取 PNG，不再尝试读取源或浏览器渲染 JSON。owner legacy/new 同一资源 endpoint。`ShareDialog.vue` 增加明确原件下载授权选项 `allowDiagramSource`，默认关闭；没有能力不显示下载/源码动作。

## 验证与边界

TDD 覆盖真实草稿存储/会话重试与异步PNG期间继续编辑、两视图/两标签页、旧JSON恢复、说明/未知字段保留、源缺失不覆盖，以及新建/reopen/share的浏览器操作。运行现有白板桌面与移动E2E及受影响编辑器/草稿单测，typecheck/build，独立审阅。Task6 生命周期、迁移、索引、脑图/流程图完整编辑器及便携导出继续后续阶段，不能因白板UI通过宣称全目标完成。

## 会话接入的执行约定（实现仍待继续）

- `DraftInput.diagram` 已落地 v2 封装；`sourceHash:null` 表示当前 Markdown 未成功解析或尚不能证明原生源，不代表已保存。`baselineSourceHash` 单独记录服务端基线。普通/旧记录不强制升级，恢复须由匹配载荷格式的视图接受。
- 预览准备尚未发起主文件提交时，重开可放弃未知准备请求并用同一创建意图准备当前草稿；旧附件按租约保留。主提交开始前则必须持久化准确的 `pending:{requestId,preparedId,markdown}`，未知结果重试使用完全相同正文和请求，不因当前又有新输入而换版本。当前新输入与旧pending提交证据同时保留。
- 单个协调者拥有保存队列和服务器双基线；当前canvas/source载荷可继续变化，异步PG只绑定固定快照。旧快照成功后仍有新输入则保持dirty，CAS冲突保留草稿。切换视图先完成固定快照交接；失败保持当前视图，不把不合法源码转换为空白画布。
- Workspace 普通 Markdown 草稿钩子必须按语义类型停止写主图键；全页/嵌入同一文档也不得并行占有独立写队列。跨标签页继续使用既有 IndexedDB CAS 和服务端双基线。
- MarkdownEditor 采用 CodeMirror 无历史事务更新派生PG/绑定，保留用户源码撤销；明确视图交接再设新边界。可复用已安装 diff 库细分变更，无需全局安装。
- 未发布意图保存在同scope本地记录中并提供恢复/取消入口；恢复查服务端相同意图，published/committing/expired分别处理。新建不先创建活动JSON笔记。
