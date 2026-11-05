# Task 2 独立代码审查

范围为 ba09a45..12b7798 的 31 个文件。已逐文件核对提供的完整差异，并沿源文件追踪目录样式层叠、关闭浮层、会话草稿写入/导出/丢弃路径。结论为 **With fixes**。

## 符合需求的部分

- 平面纸面、语义前景和强调色复用已有共享变量。虚拟卡片测量仍按实际容器内宽计算；252px 高度和 16px 间距仍相互匹配。MarkdownEditor 的运行时代码差异局限于原有主题规则，编辑器实例、选区、撤销与输入监听均保留。
- 使用已有 Graph inspector/overlay、历史 DiffView、分享、恢复与回收站组件。差异没有新增业务 API、角色、虚构数据或权限路径；原有 Graph 80、短屏原生图形编辑区 360px、保存中禁止放弃及 pending 提交核对代码均保留。
- DiagramDocumentWorkspace.vue:973–1009 的关闭提示有明确宽高边界与内部滚动。新增 E2E 在真实白板、父笔记和源编辑器上触发失败的 prepare，并测量三个恢复按钮中心命中与边界。隔离日志显示同一宽度断言在旧版 320/390 分别得到 128/156px；修正后两例通过。以下问题超出仅测量几何和点击“继续编辑”可证明的范围。

## Critical

1. **在当前用例的失败保存场景，下载后放弃会使用户失去刚输入的正文。** `apps/web/components/DiagramDocumentWorkspace.vue:541–544` 在尚无恢复 offer 时无条件调用 `download()`；同文件 525–537 默认取 `session.state.source`。白板的 Markdown 正文与 Excalidraw 原件是两份独立数据，`apps/web/diagrams/document-session.ts:96–103` 中对白板 Markdown 的编辑只更新 markdown/title。新用例在主块外输入的“尚未保存的关闭提示草稿。”只存在于 markdown。此时“下载草稿”会给出旧白板 JSON，用户随后按“放弃修改并返回”会经过 428–434 删除本地草稿、还原会话。prepare 正在失败，服务器也没有这段文字。**导出行为源自基线；本次重做的恢复流程与新增验收用例恰好触发它。** 实施提案第 88 行要求实际下载、留在编辑器、最后放弃返回；`tests/e2e/platform-workspace-unification.spec.ts:79–88` 当前仅执行继续编辑。WS-077 的“Export held recovery payload”是设计意图，无法证明下载字节包含当前工作。
   - 修复范围应限定在现有导出动作的载荷选择。现有 `download(true)` 可以导出当前完整 Markdown。原生设计编辑必须继续能导出原件。要区分有改动的表示，尤其考虑 Markdown 与原件都有独立改动时如何完整保留两者；仅按文件类型或一律改为 Markdown 均会遗漏一种情况。恢复记录另走 `heldDraftDownload`，该函数按 record.content/payloadFormat 返回原始载荷（`apps/web/diagrams/document-draft.ts:5–21`）；v2 记录还保留 documentMarkdown。应保留历史记录格式、既有 native 下载能力和 pending/CAS 守卫。
   - 最小真实回归可直接延续该 E2E：继续编辑后再次点“返回笔记”，监听 download，点击提示内“下载草稿”，读取下载内容并断言完整 primary 标记与主块外唯一新增文字都在；断言下载后仍在图形编辑器，再明确点“放弃修改并返回”，确认父笔记可见、其原文相同、未提交的图形修改没有写入服务端。原生导出另复用既有用例或增加已有 fixture 的聚焦断言，防止丢失 native 修改。

## Important

1. **关闭决策期间仍可操作被遮暗的编辑器与错误栏。** `apps/web/components/DiagramDocumentWorkspace.vue:850–853,991` 的 role=dialog 与巨大 box-shadow 提供视觉遮罩；阴影不会参与点击命中。打开提示时焦点不转移，源编辑器的 inert 仅依赖 recovered（804 行），header/“重试”“重新读取”（792–795 行）同样能被点击或用 Tab 聚焦。按键触发返回后再按 Enter 仍可能作用于旧按钮；Tab 经过背景控件可在三项关闭决策以外执行加载或保存。此行为源自原提示；呈现此次重新设计的恢复选择时会实际遇到。沿用现有组件，为提示提供模态焦点和真实的背景交互隔离，继续编辑后还原焦点。通过键盘激活“返回”，检查首焦点，Tab/Shift+Tab 范围，及关闭后的焦点；用提示外的错误栏中心验证命中不会落在操作按钮上。无需改变保存/放弃分支或重建编辑器。

2. **长目录 breadcrumb 的换行声明实际上无效。** `apps/web/workbench.css:346–351` 设置 overflow-wrap，但基础 `apps/web/style.css:453–456` 在同一元素上保留 white-space:nowrap 与 ellipsis。文件夹视图用普通 span 输出全路径（`apps/web/components/Workspace.vue:3434–3437`），没有可展开的路径入口。窄屏遇到长同名前缀或长连续路径时，只能看到被截断的前段。提案要求此处允许换行或保留路径 popup。给当前文件夹局部声明加 white-space:normal，保留原有笔记 breadcrumb 的行为；在 320px 的长路径真实目录确认完整路径和现有操作可达。

## Minor

无独立的低优先级问题。

## 验证边界及交还事项

- 未启动浏览器、服务器或重跑测试，未修改产品源码、测试或 Git 状态。仅查阅已有隔离 RED/GREEN、任务报告与静态代码。因此上述结果只为隔离几何的已执行证据，全量 unit/type/build、最终源码的 E2E 与 1440/390/320、深色、短屏及 reminder 叠层的截图/实测仍归 root 调度。设计图没有被计作运行时画面。
- Graph 80 的真实输入/持久化与短屏原生功能已有独立提交及审查，已核对当前范围保留原约束；本审查未重复评价这些提交的实施质量。后端协议、公共导出、设置及共享壳自身的实现归各自任务；这里只核对本差异对其既有调用和状态的影响。
- 对 39 个初次 mount 失败和 ba09a45 修复采用 root 与任务报告的执行记录，14 文件/90 通过与随后 39 个重跑通过分别保留；本审查没有将其混合为一次新运行。

**判定**：可保留主要展示改动；应先解决下载载荷、关闭提示交互隔离与路径显示，再由 root 按最终源码验证。
