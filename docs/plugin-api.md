# DooKnow 官方插件 API 1.3

本文件描述已经实现的宿主合同。MCP、Git 的具体实现和发布按全量计划继续交付。

## 包与信任边界

插件包是普通文件与目录组成的 ustar gzip 归档；拒绝软/硬链接、越界路径、重复成员、超出预算及校验和不符的内容。安装只能从部署管理的官方目录选择 ID，不提供任意代码上传或任意 URL 安装接口。

清单包含 id、version、apiVersion（semver范围）、title、capabilities、server、可选web/styles、configSchema、contributions。server是服务端ESM，web是浏览器ESM，styles必须位于web目录。部署机不编译、不运行包安装脚本。

后端为可信同进程代码；合同不提供安全沙箱。插件调用核心能力必须通过 `packages/plugin-sdk`，不得导入宿主私有服务或打开业务数据库。

## 配置

服务端JSON Schema校验、默认值及configVersion比较更新。普通对象保留其JSON语义，包括名为`$secretRef`的业务字段。

首版敏感控制声明为顶层`type: string, writeOnly: true`，不允许默认密钥。敏感值单独保存为600权限文件，数据库只保存受控引用，浏览器只收到已配置字段名称。嵌套writeOnly声明安装时明确拒绝，避免默默以普通数据保存；复杂配置页可使用独立顶层密钥字段。

需要随知识库迁移的普通偏好，须在对应顶层属性声明 `"x-dooknow-portable": true`。宿主将这些值保存到知识库 `_data/plugins/<id>/state.json`，已有本机配置在首次接入时按此声明迁移；`writeOnly` 始终优先，敏感值与密钥引用不会进入此文件。未声明的配置继续保存在本机。官方 Git 旧版清单中的字符串类型提交作者与邮箱由宿主按固定名单迁移；MCP 的端口、外部地址与连接凭据属于本机连接设置。

同步后再次读取插件状态时会载入便携偏好，并递增发生变化的配置版本，旧浏览器草稿不能覆盖它。已运行插件遇到同步配置变更时提示重启，避免静默改变运行中的配置。

## 插件用户资料

API 1.2 新增 `context.userData: PluginStorage`，提供与 `storage` 相同的同步 `get/set/delete/entries` 方法。插件须声明兼容 `^1.2.0` 或更新的宿主 API。`userData` 用于收藏、用户选择、持久业务状态等需要随知识库一起保存的数据；每个值上限 1 MiB，单插件资料文件上限 16 MiB。宿主管理原子写入、同步冲突检测和文件安全检查，插件通过此接口保存资料，无需依赖本机绝对路径。

原有 `context.storage` 与 `context.dataRoot` 继续用于本机状态、临时文件、游标和运行恢复。旧存储可能同时包含用户资料与临时路径，因此不会整表自动迁移。已有插件若需迁移旧业务数据，应明确挑选对应字段，写入 `userData`；凭据使用 `context.secrets` 或顶层 `writeOnly` 配置，不得放入 `userData`。Git 的 private index、预览与历史游标，以及 MCP 的调用观察和授权会话均保留在本机。

资料文件只包含插件 ID、保存时版本、宿主 API 范围、已声明的普通偏好和用户资料。同步知识库可携带这些数据，但不携带插件包、安装任务、启用状态、凭据或会话。缺失插件、安装源不可用、版本不符、停用及资料异常通过 `GET /api/platform/plugins` 的独立 `dataDependencies` 返回；这些状态仅用于界面提示。扫描或导入资料不会下载、安装、启动插件，安装和启用仍须主人显式操作。卸载保留便携资料。

## 生命周期

服务端模块导出`activate(context)`。context提供配置快照、插件私有storage、registerCommand/registerProvider/registerProtocol及onDispose/onConfigure。注册返回清理句柄。只有官方MCP可登记机器协议处理器。

命令与provider接收宿主构造的真实主体上下文和services。普通Web调用带主人会话、Origin、CSRF；机器调用由宿主独立认证。知识能力再次核对插件声明、当前授权、目录与版本，插件不能选择读取通道来扩大预算。

停用先撤销入口和新调用，再等待在途操作并清理；清理失败要求重启。安装版本和活动版本分开，已加载服务端版本升级必须重启。卸载保留配置和数据。

## 界面

扩展点为navigation、settingsPage、fileDecoration、noteAction、notePanel、libraryAction。when是有限的key/equals规则，不执行表达式代码。

浏览器模块导出`activate(api)`；api提供registerComponent、绑定当前插件的call、openPanel、notifyChanged、notify。组件接收context，不能访问根应用或内部store。Vue与`@dooknow/plugin-ui`通过宿主import map提供。样式应使用插件自己的命名空间。

浏览器资源URL包含插件ID、版本及整包文件清单hash，各文件另行验证。相对ESM引用与CSS沿用该版本命名空间。停用移除组件、面板、资源引用；不保证清除浏览器或Node的模块缓存。

## MCP 官方插件

`plugins/mcp` 1.3 独立构建与安装，110 个有界工具覆盖知识库、博客、To Doo 及共享传输。旧工具保持兼容；新增业务服务通过可选 `PluginServices.knowledgeTools/blogTools/toDooTools/transfers.call` 暴露，参数和结果以 `shared/mcp-*-tools.ts` 的严格契约为准。读取预算在插件激活期间共享，单次研究候选以最多两个并发读取，过期候选被略过并标明降级原因。研究引用绑定客户端授权版本，只有明确的 HTTPS 网页地址才返回网页链接。

公开 `/mcp` 只接受标准 OAuth 的短期令牌。宿主提供 DCR、Authorization Code、PKCE S256、资源发现、主人同意及本地授权版本检查。`oauth / tunnel / both` 三种模式显式选择；没有可达的 HTTPS 授权站点时，界面显示条件未满足。

Tunnel 使用独立的 loopback 监听端口、Bearer 密钥和本地授权记录，保留 `/mcp`、`/api/v1/tools/*`、`/openapi.json`、`/health`。浏览器只知道密钥是否已配置。凭据引用的发行代数持久保存，主人修改或重置密码后，未曾使用过的旧密钥也无法建立新连接；必须真正轮换密钥才能重新授权。

调用观察最多保留 500 条元数据，分页 50 条，不记录工具参数、查询、正文或令牌。撤销先禁用本地授权版本，再清理 provider 的令牌记录；清理失败会返回 `cleanupPending`，旧授权仍立即失效。Web 主人的连接管理能力只在 Web 通道提供，外部工具调用不能管理授权。

构建单独插件：`node scripts/build-plugins.mjs <产物目录>`；制品包括预构建服务端、共享宿主 Vue 的浏览器 ESM 和清单。发行构建时用真实私有制品源生成目录地址。

## 分域权限与整理端口（API 1.2）

MCP 1.3.0 要求宿主 API `^1.3.0`；宿主继续兼容声明兼容范围的旧插件。API 1.2 已提供 `knowledge:organize`、`knowledge:archive` 和 `blog:read`，原有 KnowledgePort 保持兼容。业务权限由宿主注册表定义；To Doo 使用独立的 `to-doo` 域及 `to-doo:read` / `to-doo:write`，不会由知识库或博客授权隐式授予。待办可限制到指定清单，原有内容类别限制继续生效。博客发布依赖 `knowledge:read` 和 `blog:publish`，不需要知识库写入；发布状态另需 `blog:read`。旧连接的历史归档、博客查看语义由宿主持久化 v1 标记适配，插件不根据客户端输入猜测版本。

API 1.3 新增 `knowledge:share/manage`、`blog:write/manage`、`to-doo:share/integrations`，旧连接不会自动获得。分享编辑链接还需资料写权限；站点管理与公开发布分开；任务导出、订阅和外部连接保留清单及内容类别限制。完整功能、权限与恢复说明见 [MCP 完整功能与权限](MCP完整功能与权限.md)，逐项覆盖见 [知识库](mcp-knowledge-coverage.md)、[博客](mcp-blog-coverage.md)、[待办](mcp-to-doo-coverage.md)。

大文件采用绑定主人、主体、客户端、当前知识库和资源版本的临时传输。通过公共传输工具追加/读取受限字节页，领域提交前原子占用最终请求身份；同一上传不能由另一请求或另一种提交用途消费。业务回执持久化，临时字节过期后仍通过对应操作查询恢复结果。需要主人登录的下载链接不含访问令牌。取消释放活动配额，过期会话定期清理；创建、读取和删除都会检查受控目录及链接。

可选 `PluginServices.permissions.context(options?)` 只返回调用者的 `{policy,organization?}`；`policy` 是绑定 owner 和域实例的 v2 策略，`organization` 包含 libraryId、结构版本及预算。选定资源使用稳定目录/笔记/文章 ID，`all` 仅表示同一业务实例的全部资源。

可选 `PluginServices.knowledgeOrganization` 提供 `context/list/submit/history/undo/operation/cancel`。方法接收 `shared/organization-contracts.ts` 的类型及 deadline/signal，主体由宿主绑定。MCP 工具为 `get_mcp_context`、`list_directories`、`organize_library`、`list_organization_history`、`undo_organization`。普通状态及取消工具也支持整理收据。缺少新服务明确返回 `CAPABILITY_UNAVAILABLE`，不会退回原始文件操作。

`create_note` 可使用 `directoryId`；null 明确表示业务根目录，省略时保留旧 directory 路径输入，同时提供二者时宿主校验当前路径一致。整理每次最多50个显式动作，目录列表默认20/最多50项；完整请求128KiB，完整工具发现及JSON-RPC响应64KiB。accepted仅表示有后台任务；成功须查询succeeded，索引状态单独报告。

插件策略保存为 `permissionPolicy`，主设置页按域提供能力预设及全部/指定资源范围。未升级配置保留折叠的旧版兼容表单，查看页面不把旧选区变成all。缩小上限立即生效；扩大上限不改变已有客户端授权。OAuth重新发起授权，Tunnel通过设置页明确检查并保存新授权。连接详情显示已授予/当前生效策略并允许收窄或撤销。

## Git 官方插件与写入协调

`plugins/git` 的按钮、状态标记、配置页和历史面板都随插件包安装。插件使用系统 Git ≥ 2.39，未建立仓库时须显式初始化 `main`。提交作者仅通过本次 Git 命令的环境变量设置。仓库顶层必须等于知识库根目录；外部过滤器、冲突、子模块、稀疏或特殊索引会阻止写操作。没有 push、整库 reset 或自动解冲突。

预览使用 private index，5 分钟内绑定主人、知识库绑定版本、分支、HEAD、真实索引摘要、候选树及说明。暂存、未暂存及未忽略新增/删除全部纳入；部分暂存文件提交当前工作树的完整版本。预览和取消不会修改真实暂存区。

确认在跨进程独占闸门内重建候选树。`commit-tree` 的目标 OID 先持久化，再由 `update-ref` 比较原 HEAD 发布。暂存区以 private index 执行 [`read-tree -m -i`](https://git-scm.com/docs/git-read-tree)，持有真实 `index.lock`、重新检查后才发布索引文件，不改原文。外部锁或状态变化使对齐失败时，保留现状并返回已发布的提交及 `needsReconciliation`。相同 requestId 返回原提交和固定回执。主人核对后可确认待核对记录；确认本身不修改 Git 或原文。

单篇恢复读取指定提交的 blob，携带当前版本及 requestId 经核心保存，保留笔记 ID、历史和索引关系；只支持核心可编辑的 UTF-8 Markdown。历史分页绑定原始 HEAD，差异完整输出上限 256 KiB。

宿主 SDK 的 workspace permit 覆盖核心原文写入、附件、目录、后台文件任务及旧的显式同步。普通 Git 查询持共享许可，预览、提交和恢复持独占许可。租约时限不会授权抢占活进程。执行进程先登记 PID 与 Linux 启动身份，再 `execve` 为 Git；同一进程身份及独立进程组在 Web 退出后仍阻止新写入，直到真实退出。执行超时先终止并等待进程，不按 IPC 断开释放锁。已进入提交阶段的 Web 请求可在插件 stopping 状态完成收尾，新请求被拒绝。

闸门协调应用和相关 worker。外部编辑器/Git CLI 仍使用各自的进程和锁；检测到变化会停止覆盖并要求重新预览或核对，不宣称可以同时锁定任意外部写入者。

## 可选本地检索

原文运行时、首次设置和模型准备分开。`GET /api/platform/search-runtime` 返回实际组件状态和持久准备任务；`POST /api/platform/search-runtime/prepare` 使用 requestId，取消通过 `/api/platform/search-runtime/tasks/:id/cancel`。接口要求主人会话、Origin 和 CSRF；下载地址取受控发行配置，不接受浏览器指定任意源。

独立检索包内含固定 CPython 3.14.4、53 个锁定版本与 SHA-256 的 CPU wheel、固定 revision 的 BGE 模型。安装在最终路径创建 venv，使用 `--no-index --require-hashes`，不复制开发环境。模型目录与运行时、原文分开。先校验整包、每个文件及固定模型 manifest，再运行真实模型空间/维度自检。准备任务在下载、校验、环境创建、安装、模型验证和启动阶段显示进度；已经校验的包可以复用。

缺少 tokenizer 时不领取文本或向量任务；只有向量服务不可用时继续处理文本任务。组件在任务途中失效会保留 checkpoint、暂停任务，不消耗失败重试次数。暂时未配置或不可用不会清除已有 embedding space 身份。strict/semantic 的要求继续由检索入口检查。

管理进程只替换 worker/search 句柄，不重复创建笔记 watcher、快照或文件 worker。已有显式部署配置优先，显示“服务器部署配置”，不会被可选下载流程覆盖。新安装由受管 loopback 进程提供向量服务，重启后根据已验证安装恢复组件；进程所有权使用启动身份和进程组检查，旧安装子进程未退出时不重装。临时解包和 pip 文件放在受管运行目录，确认安装进程退出后再清理。

构建入口：`python3 scripts/build-search-runtime.py --output <目录> --base-url <受控制品源>`。`runtime/vector-service/wheels-manifest.json` 记录 wheel 字节的固定摘要；首次建立锁需显式 `--record-lock`，后续构建不得悄悄接纳不同内容。

## To Doo 业务端口

宿主通过可选 `PluginServices.toDoo` 提供 `query`、`context` 和 `command`。需要分别声明 `to-doo:read` / `to-doo:write` capability；MCP 还须主人在配置与客户端授权中明确开启。旧知识库 token 不自动获得任务权限。

`query` 按实体、清单、日期和条件有界分页；长文本可以指定字段、版本和字节位置继续读取。返回的省略字段不能当作原数据为空，修改应只提交已核对字段。`context` 聚合获准目标/任务上下文，资料引用仍受知识库权限限制。

`command` 使用共享判别契约、稳定 `requestId` 与实体预期版本。结果未知时核对或重试原请求，不更换身份重复创建。对计划先调用纯预览，再在用户授权后应用；宿主可通过服务端可信上下文限制依赖扩张，客户端 JSON 不能自选此上下文。内部成果恢复操作不开放给普通 MCP 任务授权。

端口返回固定变更回执，不能依靠直接修改 SQLite 或 `_data` 实现业务。UI 工作集、便携事务、重复实例和后台队列的详细约定见 [To Doo 全量设计](superpowers/specs/2026-10-29-to-doo-full-design.md)。
