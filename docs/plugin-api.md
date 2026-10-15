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
