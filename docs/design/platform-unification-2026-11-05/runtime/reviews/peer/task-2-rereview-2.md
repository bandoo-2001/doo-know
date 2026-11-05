# Task 2 第二轮修复复核

审查对象是相对 fix1 的两文件增量。两份基线 SHA256 均与 fix1 manifest 的终态相符，隔离工作树中的两个文件也与 fix2 manifest 的终态相符。

| 上轮发现 | 本轮判定 | 源码及用例 |
| --- | --- | --- |
| 已改说明正文、子树未变、原生脑图另有新根题，下载遗漏新标题 | **ADDRESSED** | `apps/web/diagrams/document-draft.ts:22–37` 现在对相对基线有变的标题单独解析当前 Markdown。若文档未表达新标题，下载包含 title、完整 documentMarkdown 及原生 payload 的 envelope；文档已表达新标题时可保留直接 .md。`tests/diagram-recovery-download.test.ts:66–80,90–97` 使用仓库的有效脑图文件、精确子树及主块外的实际文字，对两个结果分别作了内容断言。 |
| 无 pending 的合法 held v2 同时有 payloadFormat=markdown 和另一份独立 documentMarkdown | **ADDRESSED** | `apps/web/diagrams/document-draft.ts:10–14` 按两个字符串是否不同选择 envelope；即使额外值是空字符串也参与比较。pending 仍优先完整导出。额外 Markdown 字节相同的常规旧输入保留原 .md。`tests/diagram-recovery-download.test.ts:82–88,99–103` 分别断言完整 envelope 以及原始字节和扩展名。 |

**本轮引入问题：** 未发现需要阻止该增量集成的问题。JSON 提供人工提取的完整值，未增加自动恢复、导入或请求回放能力。本轮没有修改关闭弹窗、焦点、保存控制器或文件夹布局，其 fix1 结论沿用。

**判断边界：** 第一项核对的是上轮提出的“相对基线有独立新根标题”的情形。另一个既有边界是用户在 Markdown 把标题从 A 改成 B，恢复后又在原生设计把标题明确改回基线 A，且子树未变。此时 `state.title === baseline.title`，只要 Markdown 仍保留 B，helper 可能直接给出含 B 的 .md。fix1 在同一输入也返回 B；服务端仍保有标题 A。该项不是本轮新增回归，不计入本轮两个修复项，也不据此声称所有可能的标题往返都经验证。若需保证下载表达这类独立选择，输出 .md 前可核对当前 Markdown 标题与 state.title，而不限于与基线不同的新标题。

已核读 RED 日志，聚焦运行中两例均因得到 .md 而非 .draft.json 失败，另九例被过滤；GREEN 日志为相关五文件 40/40 通过。fix1 的 6/6 浏览器证据与本轮单元结果分列；本轮未重跑测试、服务器或浏览器。仅写入本报告。主工作树尚未集成该补丁，最终运行与冻结截图由 root 负责。

**结论：本轮两项修复可集成。**
