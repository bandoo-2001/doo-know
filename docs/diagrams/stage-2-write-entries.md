# 阶段 2 写入入口核查

状态：Task 4D 写入闸门已接入，阶段 2 尚未验收完成。开发只使用临时测试库。

| 入口 | 实际落盘路径 | 当前校验 |
| --- | --- | --- |
| 主图完整提交 | `primary-diagrams.commit → core.createDiagram/update` | 指定准备回执、主体/客户端、主文件/源基线、固定源/PNG/渲染指纹 |
| 普通创建/全量更新 | `mutationCore.create/update` | 不能无创建意图冒充专用主图，不能删除已知类型或用旧 PNG 提交新源 |
| 分段 patch | `fileJobService → rename → core.record` | 从固定 snapshot 识别原文类型，完整候选主图走相同策略；提交前再核对实际主文件版本 |
| MCP 原文上传完成 | `complete_note_document_upload → core.create/update` | 复用同一策略，UTF-8 解码保留 BOM；原文下载仍返回 `.md` 原始快照 |
| 小文件历史恢复 | `recovery.restoreRevision → notes.saveNote → core.update` | 相同图形策略，完整历史资源可复用 |
| 后台/大文件历史恢复 | `fileJobService.restore → patch worker` | 和分段 patch 相同的完整校验，不将不匹配历史写为完成版本 |
| 回收站恢复 | `core.restore → finishRestore → core.record` | 搬回前检查历史主图及固定资源；恢复重试再次验证 pending manifest |
| 中断后 record | `core.recover → recordDiagramPublication` | 激活前逐份复核资源摘要；不存在或变化不报告发布成功 |

普通大笔记通过有界首部扫描快速排除图形，无需整篇 token 化。扫描保留有限前缀和 frontmatter 分隔状态，支持 BOM、CRLF、单字节跨块、超长 frontmatter；只有保留格式声明的候选文件才完整读取到既有 20 MiB 上限并校验原始摘要。纯文本示例、引用和缩进代码不升级为图形类型。

后台 `DIAGRAM_PREVIEW_REQUIRED` 不再只保存字符串：完整待准备文档列表存于 operations.error，operation 响应返回结构化 details；每次读取仍通过原有当前主体/文档授权。

## 运行验证

- `npm test -- tests/diagram-write-entrances.test.ts tests/diagram-declaration-stream.test.ts tests/primary-diagram-publication.test.ts tests/knowledge/file-jobs.test.ts tests/knowledge/patch.test.ts tests/knowledge/file-recovery.test.ts tests/knowledge/file-job-wal.test.ts`：51/51 通过。
- `npm test -- tests/mcp-knowledge-full.test.ts tests/knowledge/live-recovery.test.ts tests/recovery.test.ts tests/diagram-write-entrances.test.ts`：30/30 通过（与上一组有重叠，不能简单相加）。
- `npm test -- tests/indexing/chunks-large.test.ts`：现有真实 20 MiB UTF-8 长行测试通过，约 41 秒；未修改该测试的内存预算。
- 原文上传保留 BOM、原文 opaque transfer 下载逐字节相同；普通嵌入 Mermaid 仅保存源码仍通过。
- 新声明扫描测试先因功能缺失失败，实际写入入口测试先复现绕过和 BOM 丢失，再通过；回收站缺失 PNG 先复现恢复成功，再验证不会搬回/激活。

## 继续工作必须处理

- Task 4E：受管资源解析及 Web/MCP 新协议、超过 1 MiB 的合法白板主文档、待提交/冲突状态读取。更新在文件 rename 后、数据库 record 前中断时，读者应得到最后完整发布版本或明确状态，不能把未经确认的工作版本当成已完成文档；原文 GET 与分段读取仍为 Markdown。
- 主图提交的 operation 结果不能把大型全文塞进通用状态响应；应保持可验证的幂等原文响应，同时让状态结果适合 MCP 有界消息。
- Task 5：新 UI、版本化草稿、公开正文/附件/分段读取的统一投影，原件必须独立显式授权。
- Task 6：历史原类型、逻辑路径、固定资源与主文件摘要；移动/目录改名/恢复重定位和原生链接改写。相同 Markdown 字节摘要在不同逻辑路径下仍可能有不同资源清单，版本登记不能因主文件 hash 相同丢掉路径版本。
- Task 6/14：所有保留根、备份恢复、外部源/PNG/Git 状态传播。pending publication 与 committing 创建意图也属于保留根，不能因准备租约到期而丢失恢复材料。

这些仍是实现范围，不能以当前专项测试通过代替阶段 2 或整个目标完成。
