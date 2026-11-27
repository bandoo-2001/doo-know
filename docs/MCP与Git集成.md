# MCP 与 Git 集成

主程序编译并直接注册 Git 和 MCP 的服务端模块。前端通过功能设置和各自的工作区入口访问。配置保存检查配置版本，Git 操作继续使用工作区许可和提交回执。

旧实例的启停状态、提交署名、客户端授权和 MCP 对象标识密钥随升级沿用。Git 署名仍随知识库的 `_doo-data/plugins/git/state.json` 同步，以兼容已经在仓库中保存的数据。

## MCP 连接

公开 `/mcp` 只接受标准 OAuth 的短期令牌。宿主提供 DCR、Authorization Code、PKCE S256、资源发现、主人同意及本地授权版本检查。`oauthEnabled`、`apiKeyEnabled` 分别控制两种认证；没有可达的 HTTPS 授权站点时，界面显示条件未满足。

API Key 使用主服务的 `/mcp/api-key`，凭据格式为 `Authorization: Bearer <API_KEY>`；与 OAuth 共用 `mcp.oauth` 协议处理器和业务工具。每个客户端独立授权，Token 只在创建或轮换时显示，数据库仅保存校验摘要。有效期默认 90 天，可指定 UTC 到期时刻或选择永不过期。轮换立即撤销旧密钥并保留客户端身份；全局授权失效后需明确重新授权并签发。管理接口沿用主人会话、Origin、CSRF 和版本校验，API Key 无权管理凭据。网络接入由外部负责；没有专用监听端口、REST/OpenAPI 兼容入口或旧凭据迁移。

调用观察最多保留 500 条元数据，分页 50 条，不记录工具参数、查询、正文或令牌。撤销先禁用本地授权版本，再清理 provider 的令牌记录；清理失败会返回 `cleanupPending`，旧授权仍立即失效。Web 主人的连接管理能力只在 Web 通道提供，外部工具调用不能管理授权。

## 分域权限与整理端口

业务权限由宿主注册表定义；To Doo 使用独立的 `to-doo` 域及 `to-doo:read` / `to-doo:write`，不会由知识库或博客授权隐式授予。待办可限制到指定清单，原有内容类别限制继续生效。博客发布依赖 `knowledge:read` 和 `blog:publish`，不需要知识库写入；发布状态另需 `blog:read`。旧连接的历史归档、博客查看语义由宿主持久化 v1 标记适配。

MCP 支持独立的 `knowledge:share/manage`、`blog:write/manage`、`to-doo:share/integrations`，旧连接不会自动获得。分享编辑链接还需资料写权限；站点管理与公开发布分开；任务导出、订阅和外部连接保留清单及内容类别限制。完整功能、权限与恢复说明见 [MCP 完整功能与权限](MCP完整功能与权限.md)，逐项覆盖见 [知识库](mcp-knowledge-coverage.md)、[博客](mcp-blog-coverage.md)、[待办](mcp-to-doo-coverage.md)。

大文件采用绑定主人、主体、客户端、当前知识库和资源版本的临时传输。通过公共传输工具追加/读取受限字节页，领域提交前原子占用最终请求身份；同一上传不能由另一请求或另一种提交用途消费。业务回执持久化，临时字节过期后仍通过对应操作查询恢复结果。需要主人登录的下载链接不含访问令牌。取消释放活动配额，过期会话定期清理；创建、读取和删除都会检查受控目录及链接。

可选 `IntegrationServices.permissions.context(options?)` 只返回调用者的 `{policy,organization?}`；`policy` 是绑定 owner 和域实例的 v2 策略，`organization` 包含 libraryId、结构版本及预算。选定资源使用稳定目录/笔记/文章 ID，`all` 仅表示同一业务实例的全部资源。

可选 `IntegrationServices.knowledgeOrganization` 提供 `context/list/submit/history/undo/operation/cancel`。方法接收 `shared/organization-contracts.ts` 的类型及 deadline/signal，主体由宿主绑定。MCP 工具为 `get_mcp_context`、`list_directories`、`organize_library`、`list_organization_history`、`undo_organization`。普通状态及取消工具也支持整理收据。缺少新服务明确返回 `CAPABILITY_UNAVAILABLE`，不会退回原始文件操作。

`create_note` 可使用 `directoryId`；null 明确表示业务根目录，省略时保留旧 directory 路径输入，同时提供二者时宿主校验当前路径一致。整理每次最多50个显式动作，目录列表默认20/最多50项；完整请求128KiB，完整工具发现及JSON-RPC响应64KiB。accepted仅表示有后台任务；成功须查询succeeded，索引状态单独报告。

MCP 策略保存为 `permissionPolicy`，主设置页按域提供能力预设及全部/指定资源范围。未升级配置保留折叠的旧版兼容表单，查看页面不把旧选区变成all。缩小上限立即生效；扩大上限不改变已有客户端授权。OAuth 重新发起授权，API Key 通过客户端权限管理明确检查并保存新授权。连接详情显示已授予/当前生效策略并允许收窄或撤销。

## Git 版本管理与写入协调

Git 版本管理使用系统 Git ≥ 2.39，未建立仓库时须显式初始化 `main`。提交作者仅通过本次 Git 命令的环境变量设置。仓库顶层必须等于知识库根目录；外部过滤器、冲突、子模块、稀疏或特殊索引会阻止写操作。没有 push、整库 reset 或自动解冲突。

预览使用 private index，5 分钟内绑定主人、知识库绑定版本、分支、HEAD、真实索引摘要、候选树及说明。暂存、未暂存及未忽略新增/删除全部纳入；部分暂存文件提交当前工作树的完整版本。预览和取消不会修改真实暂存区。

确认在跨进程独占闸门内重建候选树。`commit-tree` 的目标 OID 先持久化，再由 `update-ref` 比较原 HEAD 发布。暂存区以 private index 执行 [`read-tree -m -i`](https://git-scm.com/docs/git-read-tree)，持有真实 `index.lock`、重新检查后才发布索引文件，不改原文。外部锁或状态变化使对齐失败时，保留现状并返回已发布的提交及 `needsReconciliation`。相同 requestId 返回原提交和固定回执。主人核对后可确认待核对记录；确认本身不修改 Git 或原文。

单篇恢复读取指定提交的 blob，携带当前版本及 requestId 经核心保存，保留笔记 ID、历史和索引关系；只支持核心可编辑的 UTF-8 Markdown。历史分页绑定原始 HEAD，差异完整输出上限 256 KiB。

工作区许可 覆盖核心原文写入、附件、目录、后台文件任务及旧的显式同步。普通 Git 查询持共享许可，预览、提交和恢复持独占许可。租约时限不会授权抢占活进程。执行进程先登记 PID 与 Linux 启动身份，再 `execve` 为 Git；同一进程身份及独立进程组在 Web 退出后仍阻止新写入，直到真实退出。执行超时先终止并等待进程，不按 IPC 断开释放锁。已进入提交阶段的 Web 请求可在Git 正在停用时完成收尾，新请求被拒绝。

闸门协调应用和相关 worker。外部编辑器/Git CLI 仍使用各自的进程和锁；检测到变化会停止覆盖并要求重新预览或核对，不宣称可以同时锁定任意外部写入者。

## 可选本地检索

原文运行时、首次设置和模型准备分开。`GET /api/platform/search-runtime` 返回实际组件状态和持久准备任务；`POST /api/platform/search-runtime/prepare` 使用 requestId，取消通过 `/api/platform/search-runtime/tasks/:id/cancel`。接口要求主人会话、Origin 和 CSRF；下载地址取受控发行配置，不接受浏览器指定任意源。

独立检索包内含固定 CPython 3.14.4、53 个锁定版本与 SHA-256 的 CPU wheel、固定 revision 的 BGE 模型。安装在最终路径创建 venv，使用 `--no-index --require-hashes`，不复制开发环境。模型目录与运行时、原文分开。先校验整包、每个文件及固定模型 manifest，再运行真实模型空间/维度自检。准备任务在下载、校验、环境创建、安装、模型验证和启动阶段显示进度；已经校验的包可以复用。

缺少 tokenizer 时不领取文本或向量任务；只有向量服务不可用时继续处理文本任务。组件在任务途中失效会保留 checkpoint、暂停任务，不消耗失败重试次数。暂时未配置或不可用不会清除已有 embedding space 身份。strict/semantic 的要求继续由检索入口检查。

管理进程只替换 worker/search 句柄，不重复创建笔记 watcher、快照或文件 worker。已有显式部署配置优先，显示“服务器部署配置”，不会被可选下载流程覆盖。新安装由受管 loopback 进程提供向量服务，重启后根据已验证安装恢复组件；进程所有权使用启动身份和进程组检查，旧安装子进程未退出时不重装。临时解包和 pip 文件放在受管运行目录，确认安装进程退出后再清理。

构建入口：`python3 scripts/build-search-runtime.py --output <目录> --base-url <受控制品源>`。`runtime/vector-service/wheels-manifest.json` 记录 wheel 字节的固定摘要；首次建立锁需显式 `--record-lock`，后续构建不得悄悄接纳不同内容。

## To Doo 业务端口

宿主通过可选 `IntegrationServices.toDoo` 提供 `query`、`context` 和 `command`。需要分别声明 `to-doo:read` / `to-doo:write` capability；MCP 还须主人在配置与客户端授权中明确开启。旧知识库 token 不自动获得任务权限。

`query` 按实体、清单、日期和条件有界分页；长文本可以指定字段、版本和字节位置继续读取。返回的省略字段不能当作原数据为空，修改应只提交已核对字段。`context` 聚合获准目标/任务上下文，资料引用仍受知识库权限限制。

`command` 使用共享判别契约、稳定 `requestId` 与实体预期版本。结果未知时核对或重试原请求，不更换身份重复创建。对计划先调用纯预览，再在用户授权后应用；宿主可通过服务端可信上下文限制依赖扩张，客户端 JSON 不能自选此上下文。内部成果恢复操作不开放给普通 MCP 任务授权。

端口返回固定变更回执，不能依靠直接修改 SQLite 或 `_doo-data` 实现业务。UI 工作集、便携事务、重复实例和后台队列的详细约定见 [To Doo 全量设计](superpowers/specs/2026-10-29-to-doo-full-design.md)。
