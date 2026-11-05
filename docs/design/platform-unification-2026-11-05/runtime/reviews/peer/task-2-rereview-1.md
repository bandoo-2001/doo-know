# Task 2 修复第一轮独立复核

审查对象为 task-2-fix-1.patch，相对 12b7798 的五个文件。逐项核对隔离工作树最终文件及基线 Git 对象，五组 SHA256 均与 manifest 相符。以下行号使用修复包版本。

## 原三项结论

| 原项 | 复核 | 证据 |
| --- | --- | --- |
| 1. 下载后放弃可能遗漏未保存的内容 | **NOT ADDRESSED（部分修正）** | 原始 320/390 白板正文复现已修正。普通正文得完整 .md，单独的原生对象改动保留现有原件扩展和字节。当前 pending 和带 pending 的 held v2 会输出完整 envelope。下述两个分支仍会遗漏独立值。 |
| 2. 关闭决策不隔离背景或键盘焦点 | **ADDRESSED** | DiagramDocumentWorkspace.vue:63–81,580–589,884–888,1029–1031 使用 showModal、浏览器背景隔离、初始 autofocus、双向按可用按钮循环、继续后回焦；已有捕获阶段的 Ctrl/Cmd+S 在决策期被消费。隔离浏览器覆盖了真实背景按钮命中、Esc、Tab、快捷键发送请求计数，以及继续后恢复保存快捷键。 |
| 3. 文件夹路径仍被 nowrap 截断 | **ADDRESSED** | workbench.css:346–352 仅对文件夹 header 的直接 breadcrumb 子节点恢复正常换行。320px 的实际文本 Range 矩形与新建/取消操作均有隔离运行证据。 |

## 仍需修正

### Critical — 当前脑图的改动正文与独立的仅根标题改动并存

- **apps/web/diagrams/document-draft.ts:22–34**。如果 Markdown 正文已修改、原生子树 source 与基线相同，但用户另改了脑图根标题，辅助函数会直接返回 Markdown。此 Markdown 仍含旧根标题，下载后放弃会丢掉新标题。
- 可达路径为在 Markdown 模式修改说明文字、未能保存、重开并恢复。DiagramDocumentWorkspace.vue:55,425–434 对有效恢复文档进入默认设计模式。此时改原生根节点，238–246 会将子树去掉首行后存为 source，将根标签单独存为 state.title；可选择标准格式的既有子树以保证 source 没有变化。再遇保存失败并下载；已有 helper 的 markdownChanged=true、sourceChanged=false 会跳过 parsed.title 核对。原 JSON envelope 本身能保存这项，错误发生在格式选择。
- 回归只需一个有效 mindmap fixture，给 saved Markdown 增加主块外文字，保留原 H1 和相同 source，把 state.title 改为独立新标题，断言下载包含新标题、精确 Markdown 和 source。若 Markdown 已表达当前新标题，则原单文件 Markdown 仍可直接使用。需要核对独立标题是否已在当前导出中表达，勿仅依赖 sourceChanged。
- 已独立核对基线标题。packages/core/notes.ts:97–103 → shared/whiteboard.ts:13–18 对合法主图返回解析得到的标题，与 DiagramDocumentWorkspace.vue:302–310 的初始化一致，doc.title 在该路径成立。571 行为作此比较而重新解析基线文档可简化，当前缺失的比较发生在导出分支。

### Important — 已支持的 held v2 输入含独立 Markdown 字段时仍有遗漏

- **apps/web/diagrams/document-draft.ts:10–14**。held.payloadFormat 为 markdown、有区别于 held.payload 的 documentMarkdown、且无 pending 时，仅导出 record.content。apps/web/drafts.ts:83–94 接受这种 v2 记录，没有约束两个字符串相等。相比当前原生编辑器生成的 v2，此项属于兼容输入，但旧记录同样经真实 recovery 下载路径。
- 回归可沿用现有 held helper 用例，令 payloadFormat=markdown、payload/record.content='第一份正文'、documentMarkdown='第二份正文' 且无 pending，检查完整 JSON 同时保留两份值。在区分纯原始载荷与额外独立内容时应覆盖此分支；无额外数据的旧 Markdown/原件保持原字节及格式。

## 证据和边界

已检查隔离 final 日志，浏览器 6/6 及五个单元文件 36/36 通过；首次 RED、测试调整过程及快捷键 RED 继续保留在 fix 报告所列日志中。新增九个 helper 样例未覆盖上述两个组合。原菜单下载、pending/CAS 和放弃守卫未改。实际选择 JSON 的分支会序列化既有 envelope 的所有已定义字段，能人工取出原始值；代码没有新增自动导入、重试或恢复请求的功能。

未重跑测试、服务或浏览器，未更改产品、测试或 Git 状态。最终集成、冻结源码截图、全量回归由 root 负责。此复核只覆盖本轮修复与其影响的路径。

**结论：With fixes。** 可保留模态控制与文件夹路径两项，下载格式选择还需补齐上述组合。
