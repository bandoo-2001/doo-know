# 2026-11-17 MCP 发布前审查

此记录区分源码、实际打包插件的 HTTP 验证，以及独立原生安装实例的验证。后者由发布主流程执行；不能由源码测试推断真实账号的 ChatGPT/Codex 云端连接已经成功。所有自动化数据使用临时测试库，不包含个人资料或凭据。

## 版本与协议核对

核对日为 2026-11-17。官方 TypeScript SDK 最新稳定大版本为 2.4.0，维护中的 v1 为 1.32.2。本次将服务端依赖 `@modelcontextprotocol/sdk` 从 1.32.1 更新到 1.32.2，将 MCP 插件从 2.0.1 更新到 2.0.2，并固定开发验证客户端 `@modelcontextprotocol/client@2.4.0`。官方 v1 补丁说明列出类型与注册行为修复，没有将本次补丁标记为安全公告；本记录不会把普通维护更新描述为已证实的安全漏洞修复。[v1 发布说明](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.2)、[v2 发布说明](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0)。

新版 2026-07-28 改为每次请求自带能力协商，并修改传输和发现流程。升级服务端到新版需要迁移这些接口，不能只改依赖号然后宣称完整兼容。本次保留已验证的 2025-11-25 服务协议，补充新版官方客户端的自动回退验证；原生 2026 协议暂不支持。此取舍基于当前业务只使用工具调用、分页、结构化结果和现有授权，不依赖新版订阅或 Skills 扩展；将来要求仅支持现代协议的客户端接入时，应独立迁移并重新验证授权与取消语义。[官方规范](https://modelcontextprotocol.io/specification/2026-07-28)、[迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)。

| 客户端 | OAuth `/mcp` | API Key `/mcp/api-key` | 实际边界 |
| --- | --- | --- | --- |
| 官方 SDK v1.32.2 | 已验证 | 已验证 | 初始化后执行真实业务 |
| 官方 v2.4.0，legacy 模式 | 已验证 | 已验证 | 协商到 2025-11-25 |
| 官方 v2.4.0，auto 模式 | 已验证 | 已验证 | 自动回退到 2025-11-25，结构化结果正常 |
| 官方 v2.4.0，固定 2026-07-28 | 不支持 | 已验证明确拒绝 | 没有把失败连接标为兼容成功 |

浏览器预检允许新版客户端探测使用的 `Mcp-Method`、`Mcp-Name` 请求头；主机名、来源、身份和方法校验保持生效。新版规范仍要求校验来源与保护本地连接，这不是允许任意来源连接的理由。[Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。

OpenAI 当前官方认证文档仍支持 DCR 与 PKCE 的公共客户端流程，不要求所有服务立即改为 CIMD。现有 Better Auth 提供 S256、DCR 和 RFC 9207 issuer 声明；新增测试会核对资源发现的 issuer 一致性，以及授权成功与用户拒绝回调的 `iss`。ChatGPT 原生连接应使用 OAuth，不能将通用客户端的自定义 API Key 验收等同于 ChatGPT 登录验收。外网来源、产品租户策略和真实账号连接仍需部署后实际接入确认。[OpenAI 官方认证文档](https://developers.openai.com/plugins/build/auth)、[自定义 MCP 连接说明](https://developers.openai.com/api/docs/guides/custom-mcp-server)。

## 修正与一致性

- **纪念日图片闭环**：新增开始上传、完成图片、读取图片三个工具，复用通用分块传输和原生图片验证。支持 PNG/JPEG/WebP，最多 10 MiB，核对字节数及 SHA-256；保存中保留取景位置与缩放。读取绑定纪念日 ID、当前版本和实际图片引用。绑定替换和新建草稿分别检查资源修改和全域新建授权。
- **图片来源授权**：通用保存、完整保存与紧凑旧入口统一拒绝把已知的私有附件 hash 冒充纪念日图片。新的引用必须来自当前调用者、当前授权策略已完成的上传，或当前确实可以读取的非删除纪念日。绑定某个纪念日的上传证明不能在保存前移用于另一个新对象。
- **安全重试**：上传证明保存在调用者绑定的操作回执中。完成后的同请求重放保留原结果；所有读取与重试继续核对授权、所有者、删除状态和需要的实体版本。错误图片返回结构化 `INVALID_INPUT`，不会误报为结果未知。
- **习惯写入**：新增可选 `expectedHabitRevision`，在事务内检查规则版本，避免旧表单按新规则写入；按生效规则时区拒绝未来日期，并拒绝未来记录时间。正数记录与跳过互斥，重复跳过复用既有记录。保留已有导入历史兼容性。
- **数量精度**：与习惯页共同使用十进制求和，后端统计也复用该实现；0.1 + 0.7 达到 0.8 时不再显示未达标，不修改原始分笔值。
- **专注计时**：运行或暂停时拒绝直接修正时长，暂停/恢复/接管不能夹带新修正值。已人工修正的中断记录保留原修正，不能重新继续计时，避免计时冻结或丢失已确认修正；可以另开新专注。
- **发现与字段**：清单层级、图标、颜色、纪念日主题/图片缩放与习惯规则均继续通过完整 schema 发现，写入使用相同业务引擎。当前 selected-resource 权限对象是清单；没有新增“单个纪念日授权”这一原系统不支持的权限类型。

## 验证范围

`tests/mcp-transport.test.ts` 构建并实际安装 MCP 插件压缩包，在真实 HTTP 监听端口上用三种标准客户端模式及两种凭据完成下列业务，调用平台真实权限服务：

1. 创建目标和子清单，读取并核对父级、图标、颜色，创建高优先级任务。
2. 专注项目、开始、暂停、恢复、结束、修正，读回完成状态和时长。
3. 带规则版本的习惯打卡和专注来源关联，核对小数统计为 0.8。
4. 图片分块上传、保存取景、读取元数据及原始字节比对。
5. 创建并读回复盘；额外覆盖精确 ID 的软删除清理，不触碰预存实体。

`tests/mcp-anniversary-images.test.ts` 覆盖真实 SDK 调用、结构化错误、已知 hash 注入、绑定目标、版本变化、删除、授权变化、其他客户端、普通写权限、格式/大小和回执重放。`tests/to-doo-habit-write-guards.test.ts` 与 `tests/to-doo-domains.test.ts` 覆盖事务、可信时间、数量、跳过和计时边界。

MCP 其余回归包含 OAuth/API Key 权限交集及撤销、来源和 Host 校验、令牌轮换、分页、帧预算、输入输出 schema、取消、导入/导出、附件与结果回执。最终命令与结果见本节收尾记录；不把正在进行的测试提前计为通过。

2026-11-17 最终源码与插件包回归结果：

| 检查 | 结果 |
| --- | --- |
| `npx vitest run tests/mcp*.test.ts tests/to-doo-agent-port.test.ts tests/to-doo-domains.test.ts tests/to-doo-habit-write-guards.test.ts tests/to-doo-focus-history.test.ts --maxWorkers=2` | 49 文件、361 测试通过；包含最终六组合 HTTP 业务及清理验收 |
| `npx vitest run tests/oauth-routes.test.ts tests/oauth-provider.test.ts tests/oauth-grants.test.ts --maxWorkers=2` | 3 文件、7 测试通过；包括 DCR、PKCE、刷新、撤销与成功/拒绝回调 issuer |
| `npx vue-tsc --noEmit` | 通过 |
| `git diff --check` | 通过 |

以上并非真正原生安装实例的完成声明。真实包复查应保存下节脚本的独立报告，并与发布主流程的版本、安装、重启记录关联。

## 独立原生安装实例复查入口

`scripts/verify-mcp-live.ts` 默认只读，使用权限为 0600 的 token 文件，不将令牌放入命令参数、文档或报告。会运行 v1、v2 legacy、v2 auto 三种客户端，检查服务身份/版本、工具分页与帧大小、清单/图片/习惯 schema 及真实读取。

显式增加 `--exercise-to-doo` 才会在 v2 auto 客户端运行同一套可复用写入闭环，创建唯一前缀的临时目标、任务、专注、习惯、图片和复盘，并按精确 ID 软删除。其他两种模式仍做发现与读取；报告分别记录，避免把单一模式写验收冒充三种模式写验收。每种凭据各执行一次。该选项仅供独立验收数据集；不可变测试图片与操作回执由最终移除测试实例清理，脚本不做底层物理删除。

```sh
npx tsx scripts/verify-mcp-live.ts --url http://127.0.0.1:5273/mcp/api-key --token-file /path/to/private-token --expect-server-version 2.0.2 --to-doo --exercise-to-doo --report /path/to/private-report.json
```

OAuth 使用 `/mcp` 和对应的私有 token 文件。报告只含端点、版本、协议、数量与检查名称；不含令牌、图片内容或文档正文。v1 SDK 没有公开已协商版本读取接口，脚本不硬编码推测它的协商结果。真实原生包的安装、重启和 GitHub 库绑定另由发布主流程记录。
