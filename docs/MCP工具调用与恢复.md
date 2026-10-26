# MCP 工具调用与恢复

适用于 MCP 插件 **1.1.1**，需要宿主 API **^1.1.0**。保留现有 18 项工具，无新增同义工具。连接初始化会给 agent 返回调用指南；`tools/list` 和 `/openapi.json` 为参数契约来源。工具可见不代表当前身份有权调用，默认仍为只读。

## 找资料与读取

| 需求 | 调用方式 |
| --- | --- |
| 查找并逐篇读取 | `search_notes` → `get_note_info`／`get_note_outline` → `read_note` |
| 列出授权范围 | `list_notes`；没有目录参数时只列当前授权资料 |
| 研究／引用对象 | `search` → 将其签名 `id` 原样交给 `fetch` |

`fetch.id` 不是笔记 `noteId`，不能互换；签名对象绑定版本、授权及 15 分钟有效期。失效后重新搜索，不猜 URL。检索要检查 `degraded`／`reasons`；向量未配置的文本降级不能当成语义检索完成或严格最新结果。

`read_note({noteId})` 默认读取 8 KiB／100 行，返回 `ready` 或 `accepted`。`accepted` 时按操作标识查询 `operation_status`，建议间隔至少 1 秒；接受任务不等于完成。读取成功后，正文页位于 `data.data`，附带 snapshotId、版本、哈希与范围。

需要下一页时显式使用 nextCursor。列表／搜索保持原目录、查询、过滤和 limit；游标过期后从第一页重开。读取 cursor 不与 snapshotId／range 混用，不自动翻完所有页。行号从 1 开始且包含终点；字节偏移从 0 开始、终点排他，按原始 UTF-8 字节而非 JavaScript 字符位置。

## 写入与结果确认

1. 读取并保留当前正文和版本；每次新操作生成一次 requestId，它不同于 JSON-RPC 消息 id。
2. 普通小笔记用 `create_note`／`update_note`，整篇最多 32 KiB UTF-8。局部修改用 `patch_note`，绑定读取得到的 snapshotId、expectedModifiedAt、expectedContentHash，最多 20 项、旧文本与插入合计 32 KiB。
3. `replace_text` 需要唯一旧文本；重复匹配时读取更准确的上下文，或使用正确字节范围与 expectedRangeHash，不自动替换全部匹配。
4. 接受后台任务后查询终态。未知写入结果保留原 requestId 与原参数，用 `operation_status` 或原请求重试；不能换 ID 再写一次。
5. 明确 VERSION_CONFLICT 时先读取最新正文、合并草稿，再用新 requestId 发起新操作。`currentModifiedAt` 是核对提示，不能直接换上新版本覆盖他人修改。

`operation_status` 的 operationId 与 requestId 必须且只能提供一个。`cancel_operation` 仅请求提交前取消；committing 后不能宣称回滚，需查询终态。`archive_note` 使用可恢复流程，不永久删除。

## agent 可读错误

MCP 结构化错误位于 `error`，同时提供相同内容的文本结果；SDK 在发现工具后也能正常接收错误。成功结果的严格验证保持不变。OpenAPI 的默认参数如 maxBytes、limit、mode、freshness 已正确声明为可选。

安全错误字段包括 code、message、retryable、requestId，以及可选 requiredScope、currentModifiedAt、最多 8 条字段 issues 和 recovery。不会回传正文、未知参数值或任意后端 details。

| 情况 | agent 的下一步 |
| --- | --- |
| INVALID_INPUT | 根据 issues 的字段路径与安全提示修正输入 |
| INSUFFICIENT_SCOPE／FORBIDDEN | 核对 requiredScope、授权目录与插件只读配置，交主人确认，不自动扩权 |
| OPERATION_OUTCOME_UNKNOWN | 按 recovery 查询原 requestId，保留草稿和原请求 |
| 笔记 VERSION_CONFLICT | 读取新正文、合并后以新 ID 发起新操作 |
| 博客 VERSION_CONFLICT | `get_blog_status` 核对最新发布／原稿状态及操作意图，发布前检查新正文，再用新 ID 发起操作 |
| 游标／快照失效 | 使用原 noteId／查询显式重开，丢弃失效游标 |
| 读取频率／并发超限 | 停止新增并发，根据恢复提示等待，不密集重试 |

公开博客仍需用户明确要求、插件允许、独立 blog:publish 及读写授权。`get_blog_status` 核对源与发布版本后才能 `publish_blog_post`；`unpublish_blog_post` 显式撤下。状态／发布收据省略的元数据在 omittedMetadata 中声明，不能把省略字段当成空值覆盖。

## 接入与版本边界

2026-10-26 实际连接的只读尝试在 SSE 探测层返回 429，未到达业务工具。SSH 核对的 Mini 正式宿主 rc.49 为 API1.0.0，官方 MCP1.0.3 当前 disabled；不能把需要 API1.1 的新插件直接装入该宿主。外部入口的429与本机插件停用是两项独立观察，不能仅凭工具列表认定远端身份或因果。

本轮不自动启用正式插件、调整授权、更新宿主或改真实资料。后续需先发布／更新兼容宿主，再更新插件并刷新客户端工具发现；外部连接可用性必须单独实测。旧独立 doo-know-bridge 项目未修改，后台 QA timer 维持停用。
