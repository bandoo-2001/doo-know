# DooKnow 官方插件 API 1.0

本文件描述已经实现的宿主合同。MCP、Git 的具体实现和发布按全量计划继续交付。

## 包与信任边界

插件包是普通文件与目录组成的 ustar gzip 归档；拒绝软/硬链接、越界路径、重复成员、超出预算及校验和不符的内容。安装只能从部署管理的官方目录选择 ID，不提供任意代码上传或任意 URL 安装接口。

清单包含 id、version、apiVersion（semver范围）、title、capabilities、server、可选web/styles、configSchema、contributions。server是服务端ESM，web是浏览器ESM，styles必须位于web目录。部署机不编译、不运行包安装脚本。

后端为可信同进程代码；合同不提供安全沙箱。插件调用核心能力必须通过 `packages/plugin-sdk`，不得导入宿主私有服务或打开业务数据库。

## 配置

服务端JSON Schema校验、默认值及configVersion比较更新。普通对象保留其JSON语义，包括名为`$secretRef`的业务字段。

首版敏感控制声明为顶层`type: string, writeOnly: true`，不允许默认密钥。敏感值单独保存为600权限文件，数据库只保存受控引用，浏览器只收到已配置字段名称。嵌套writeOnly声明安装时明确拒绝，避免默默以普通数据保存；复杂配置页可使用独立顶层密钥字段。

## 生命周期

服务端模块导出`activate(context)`。context提供配置快照、插件私有storage、registerCommand/registerProvider/registerProtocol及onDispose/onConfigure。注册返回清理句柄。只有官方MCP可登记机器协议处理器。

命令与provider接收宿主构造的真实主体上下文和services。普通Web调用带主人会话、Origin、CSRF；机器调用由宿主独立认证。知识能力再次核对插件声明、当前授权、目录与版本，插件不能选择读取通道来扩大预算。

停用先撤销入口和新调用，再等待在途操作并清理；清理失败要求重启。安装版本和活动版本分开，已加载服务端版本升级必须重启。卸载保留配置和数据。

## 界面

扩展点为navigation、settingsPage、fileDecoration、noteAction、notePanel、libraryAction。when是有限的key/equals规则，不执行表达式代码。

浏览器模块导出`activate(api)`；api提供registerComponent、绑定当前插件的call、openPanel、notifyChanged、notify。组件接收context，不能访问根应用或内部store。Vue与`@dooknow/plugin-ui`通过宿主import map提供。样式应使用插件自己的命名空间。

浏览器资源URL包含插件ID、版本及整包文件清单hash，各文件另行验证。相对ESM引用与CSS沿用该版本命名空间。停用移除组件、面板、资源引用；不保证清除浏览器或Node的模块缓存。

## MCP 官方插件

`plugins/mcp` 独立构建与安装，15 个原有工具通过宿主知识端口执行；读取预算在插件激活期间共享，单次研究候选以最多两个并发读取，过期候选被略过并标明降级原因。研究引用绑定客户端授权版本，只有明确的 HTTPS 网页地址才返回网页链接。

公开 `/mcp` 只接受标准 OAuth 的短期令牌。宿主提供 DCR、Authorization Code、PKCE S256、资源发现、主人同意及本地授权版本检查。`oauth / tunnel / both` 三种模式显式选择；没有可达的 HTTPS 授权站点时，界面显示条件未满足。

Tunnel 使用独立的 loopback 监听端口、Bearer 密钥和本地授权记录，保留 `/mcp`、`/api/v1/tools/*`、`/openapi.json`、`/health`。浏览器只知道密钥是否已配置。凭据引用的发行代数持久保存，主人修改或重置密码后，未曾使用过的旧密钥也无法建立新连接；必须真正轮换密钥才能重新授权。

调用观察最多保留 500 条元数据，分页 50 条，不记录工具参数、查询、正文或令牌。撤销先禁用本地授权版本，再清理 provider 的令牌记录；清理失败会返回 `cleanupPending`，旧授权仍立即失效。Web 主人的连接管理能力只在 Web 通道提供，外部工具调用不能管理授权。

构建单独插件：`node scripts/build-plugins.mjs <产物目录>`；制品包括预构建服务端、共享宿主 Vue 的浏览器 ESM 和清单。发行构建时用真实私有制品源生成目录地址。

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
