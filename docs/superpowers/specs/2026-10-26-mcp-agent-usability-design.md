# MCP agent 易用性与功能验收

用户要求测试 MCP 具体功能，并优化 AI agent 的使用体验。使用现有正式插件的 18 项工具，不增加同义工具或自动读取／改写行为。选择修复已证实的契约和恢复提示问题；新增大批高级工具会增加发现成本，不采用。

现场边界：连接侧两次只读调用均在 SSE 探测层返回 429，未进入业务。SSH 确认 Mini 正式宿主为 rc.49／Host API1.0.0，MCP1.0.3 已安装但 disabled。当前源码为 Host API1.1.0／MCP1.1.0，不能把新插件直接装进旧宿主。此次保持正式插件停用、授权和知识库不变；所有写入、归档、发布与索引操作仅用临时实例。旧独立 bridge 项目不改。

核心改进：

1. registry 和真实 SDK tools/call 统一生成有界结构化参数错误；继续声明原严格 schema，不以宽松 schema 或 SDK 私有成员绕过验证。可用 SDK 公共 server.setRequestHandler 在注册后处理原始工具参数，registry 仍严格校验输入、输出、权限和预算。JSON-RPC 外壳畸形保留协议级错误。
2. 错误只传递白名单元数据：requiredScope、合法 currentModifiedAt、最多 8 条安全字段问题与有界 recovery。未知写入只允许原 requestId 查询／原请求重试；版本冲突要求读取新正文合并草稿，再用新的请求 ID。不得透传后端 message／任意 details、正文、查询或未知参数值。
3. initialize 提供简洁调用指南，关键输入字段描述说明 noteId／研究 fetch.id、分页与字节范围、快照、后台任务、权限及手动发布。可见工具不等于有权调用；权限仍由每次调用实时检查。保留 18 个名称与输入语义，不扩权。
4. OpenAPI 使用输入模式转换 Zod，默认参数不再错误地列为 required；错误 schema 与真实结构一致。

MCP 插件补丁版本为 1.1.1，仍要求 Host API^1.1.0；宿主 API 不变。工具发现的完整 JSON-RPC 帧（含最大转义 ID）必须 <=65536 字节，instructions 控制在约 3 KiB，输入说明避免反复扩张输出 schema。成功 DTO、CAS、幂等收据、游标、快照与取消语义保持原样。

SDK 客户端发现工具后会按 outputSchema 校验结构化错误。保留严格成功验证，同时通过公共 tools/list handler 声明成功／错误两种分支；错误分支只重复精简核心字段，允许 errorBody 已有的安全扩展，完整错误 schema 仍在 OpenAPI。不得用 client.request 绕开正常 callTool 校验来冒充通过。

功能验收还确认合法 Markdown 缺少父级标题时，chunk headingPath 会生成空洞。追加最小生成修复，以及搜索／研究对象两处对旧索引 null 占位的读取兼容；不重建或迁移真实索引，非占位的非法类型仍严格拒绝。

共享接口（errors.ts 权威）：`invalidInput(tool, issues): BridgeError`；issues 为只读 `{code:string,path:readonly PropertyKey[],message?:string}` 列表。`annotateError(error, tool, input): BridgeError` 只附加安全恢复上下文；`errorBody(error)` 保持原签名并输出兼容扩展；`bridgeErrorSchema` 为 OpenAPI 可复用 JSON Schema。协议实现统一调用这些入口，未知异常不泄漏 message。恢复字段由错误实现者定义在该 schema 并测试，调用方不自行扩写。

验证：错误单元先观察 RED，真实 SDK 内存传输验证缺字段、互斥、范围、权限、冲突恢复和隐私；真实宿主临时资料覆盖全部 18 项工具、写入重放／冲突、分页和索引降级，另以实际打包安装、OAuth／HTTP 验证制品。保持每次验证有界、按需，不启动已停用的后台 QA timer。不以本地通过宣称外部 ChatGPT 连接可用。

原工作区 8 项未提交内容按哈希保护，代码在干净 linked checkout 的独立分支实现；测试和文档稳定后同步默认分支，不发行或升级正式程序。
