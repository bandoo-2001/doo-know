# 机器 API 契约

机器路由统一位于 `/api/agent/v1`，定义在 `server/agent/routes.ts`；字段类型在 `shared/knowledge-contracts.ts`。外部客户端通过独立 [MCP 网关](https://github.com/bandoo-2001/doo-know-bridge) 使用相同操作；网关的 OpenAPI/Swagger 由操作注册生成，不向客户端开放内部服务凭据。

## 认证和版本

每次请求验证内部服务 Bearer 与最长 60 秒的签名身份声明。发行者、audience、客户端、scope、目录策略与当前后端策略取交集；不信任裸 principal 头。声明包含已验证原始令牌的 `tokenIssuedAt`，恢复/密码重置后的持久截止会拒绝旧令牌。配置模板为根目录 `config.agent.example.json`，真实配置及引用密钥在 Git 外，权限 600。

写入以字符串 `expectedModifiedAt`（mtime 纳秒）检查冲突；快照/检索引用进一步绑定 `contentHash` 和递增 `sourceRevision`，检测已观察的 A→B→A。创建、更新、归档和 patch 必须保留客户端原 `requestId`，同身份同操作同参数返回原结果；同 ID 不同参数冲突。超过普通模式范围不得整篇 update。

## 路由

下表路径均相对上述前缀。成功返回 `{ "data": ... }`；写入和任务状态只返回摘要。错误返回稳定的 `code`、`message` 与 `retryable`，不返回正文或凭据。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /notes` | 授权范围元数据列表，支持目录和 cursor |
| `GET /notes/:id` | `NoteInfo`，不先读取全文 |
| `GET /notes/:id/outline` | 版本目录页；未准备时返回 operation |
| `POST /notes/:id/read` | 有界 `ReadPage` 或 accepted operation |
| `POST /notes` | 创建小笔记，`directory/fileName/content/requestId` |
| `PUT /notes/:id` | 小笔记更新，`content/expectedModifiedAt/requestId` |
| `POST /notes/:id/archive` | 可恢复归档，版本与 requestId 必填 |
| `POST /notes/:id/patch` | 快照版本和精确文本/range 局部修改，后台提交 |
| `GET /operations/:id` | 检查操作归属、当前目录权限与状态 |
| `GET /operations?requestId=...` | 原 ID 核对，结果未知时使用 |
| `POST /operations/:id/cancel` | 提交前取消；提交后核对结果 |
| `POST /search` | `text/semantic/hybrid`，过滤、分页和 `indexed/strict` |
| `GET /notes/:id/research` | 完整且有界的小笔记研究对象，含版本校验 |
| `GET /notes/:id/chunks/:chunkId` | 完整的版本片段对象，大笔记引用使用此接口 |
| `GET /index/status` | 授权范围及可选单笔记索引状态 |
| `POST /index/refresh` | 显式核对/刷新，返回持久任务 ID |

读取输入可用 cursor，或 `range.startLine/endLine/lineByteOffset`；startLine-only 仍按当前页预算限制，并可继续到 EOF。返回包含 snapshotId、哈希、mtime、sourceRevision、起止行/字节、lineByteOffset 和 nextCursor。不能换身份、扩大通道或将不同版本拼接。研究对象由网关签名 ID 封装上述版本字段，fetch 不截断 whole-note。

## 预算与错误处理

Markdown 最大 20 MiB，>1 MiB 或单行 >32 KiB 使用大文件模式。机器正文默认 8 KiB/100 行、最多 16 KiB/200 行；完整请求最高 128 KiB、完整 MCP JSON-RPC 双份结果最高 64 KiB。正文密集转义时缩小页与结果项并保留正确 cursor。patch 最多 20 项，旧文本与插入文本合计最多 32 KiB。

机器会话最多 32 页/256 KiB/15 分钟，每身份/客户端 2 个并发、每分钟 2 MiB；cursor 重放不重复扣会话预算，但计传输速率。Web 与公开路由由已认证路由固定单独预算，不能通过机器输入 `channel=web` 绕过。

读取/状态/普通搜索 5 秒，strict 10 秒；网关等待 12 秒，调用整体 15 秒。快照准备与 patch 先返回 operation，queued/running 各最多 300 秒。超时或连接丢失不能推断保存失败，保留草稿与原 requestId 核对；不生成新 ID 盲重试。常见状态包括 `VERSION_CONFLICT`、`STALE_CURSOR`、`CURSOR_EXPIRED`、`READ_BUDGET_EXCEEDED`、`LARGE_FILE_MODE_REQUIRED`、`FILE_TOO_LARGE`、`INVALID_UTF8`、`INDEX_NOT_READY`、`SYNC_IN_PROGRESS`、`GIT_CONFLICT` 和 `OPERATION_OUTCOME_UNKNOWN`。

正文/版本/权限测试与运维入口见 [开发记录](MCP与索引开发记录.md) 和 [运维说明](MCP与索引运维.md)。公开分享和浏览器接口继续使用各自的授权规则，不接受机器服务令牌作为浏览器会话。
