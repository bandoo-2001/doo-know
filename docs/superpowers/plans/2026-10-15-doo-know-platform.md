# DooKnow 平台全量开发与交付

用户于 2026-10-15 批准的全量方案；顺序实施，最终独立审查。知识库保持原文独立；源码沿用 Web 历史；生产迁移与升级分开。完整产品规格同时参考知识库 `10-Projects/DooKnow/需求与架构设计.md`、`第一阶段安装与初始化设计.md`、`命名与目录迁移准备.md`，本计划覆盖其中旧的逐阶段重新审批约定。

## Task 0: 继承与一致性

承接原工作区未提交 P1 修复及夹具，隔离 worktree `txj/doo-know-platform`，原工作区不改。重新验证 W01/W02/W03；修复 W04 固定回执、S01 strict 刷新后游标 epoch 检查、U01 搜索/历史分页、I01 UTF-8 文件名字节限制。Bridge 仅迁源码白名单，排除 .local/密钥/旧 Git 历史。

## Task 1: 安装与控制面

HostConfig 不要求知识库；保留非空 AppConfig 用于业务运行时。唯一主人、无 Web 注册、密码>=12、TTY 隐藏输入。初始 install 幂等；缺认证密钥或已有业务无账号进入恢复错误，不重建身份。

GET /api/platform/status；POST /api/platform/setup/validate；POST /api/platform/setup/complete。phase: owner_required/setup_required/initializing/ready/source_unavailable/configuration_error。默认 Asia/Shanghai；服务器目录必须存在且在允许范围的严格子目录内，非隐藏/非软链接，不重叠源码/发布/数据/秘密。

validationId 绑定主人、realpath/dev/ino，5分钟、最多16份，重启失效；complete 同步事务保存 platform_settings+root_identity+operations 固定回执。先核对原回执，再验证凭据；同请求同语义可在重启后重放。重复新绑定拒绝。已有环境配置兼容；冲突不覆盖；已有业务缺根不重开向导。

固定注册路由，通过运行时 accessor 分发，禁止监听后加路由或内部 HTTP 代理。单一 activation promise；失败释放部分资源；DB 最后关闭。登录与控制面独立就绪，healthz=存活，readyz=原文可用；缺模型不阻塞编辑。私有接口先认证后503，机器接口保留认证，分享不可用统一404。

首个 curl/wget 私有包包括固定 Node、原生依赖和构建产物；不要求现场 npm/编译。默认127.0.0.1:5173，普通用户systemd，不自动sudo/apt。管道交互读/dev/tty。

## Task 2: 插件宿主

单仓库独立预构建官方插件包。清单含 id/version/API range/entrypoints/capabilities/config schema/contributions。配置服务端校验、版本比较，秘密外存引用。installedVersion/activeVersion/desiredEnabled/configVersion 独立记录；disabled/starting/enabled/stopping/failed/restartRequired/dependency_missing。

固定 POST /api/plugins/:id/call：command/provider+id+input+requestId，登录、Origin/CSRF、输入、能力与对象范围逐次检查。SDK不暴露core私有实现或DB。可信官方后端同进程，无第三方沙箱承诺。

navigation/settingsPage/fileDecoration/noteAction/notePanel/libraryAction；简单交互声明，复杂Vue ESM按需加载，共享Vue及UI SDK，样式命名空间，资源版本/hash。停用拒绝新调用、撤销贡献、等待提交、清理资源；升级后端受控重启。官方目录MCP/Git；卸载默认保留数据；包检查来源/兼容/hash/路径，无安装脚本。

## Task 3: MCP

保留SDK1.32.1和现有协议，独立@better-auth/oauth-provider1.7.7；主人登录/同意，PKCE S256+DCR+发现+audience，默认只读和目录授权，JWT之外核对连接撤销状态。固定OAuth基础设施归宿主；MCP插件提供协议、工具、设置、观察。旧Tunnel静态Bearer独立入口/凭据，不能在OAuth入口接受或自动降级。缺HTTPS/外部授权站点明确未就绪。

迁入15工具契约、预算与幂等，持久任务重放也核对OAuth授权；不使用webPrincipal绕过。M01过期候选跳过并说明，M02保留降级，批量有界读取减N+1；D01外部链接显式配置，没有地址不伪造localhost。日志不记录正文/查询/令牌。真实ChatGPT Tunnel与OAuth分别验收。

## Task 4: Git

系统Git>=2.39，缺少时依赖未就绪。仓库顶层等于知识库；显式git init main，作者配置不改全局。状态标记、分页历史、受限diff、单文件恢复经core.update(expectedModifiedAt,requestId)。不支持对象明确拒绝。

提交全部包含暂存/未暂存/非忽略新增删除，部分暂存以完整当前文件为准。private index生成预览，5分钟令牌绑定owner/root/repo/branch/HEAD/index/tree/message；发布前失败不改真index。确认取得共享原文写入闸门和仓库独占事务，等待在途写入后重建tree核对，变化PREVIEW_STALE。

commit-tree生成确定commit，先持久意图，再update-ref CAS，read-tree安全对齐index。相同requestId固定commit；崩溃核对ref/index/持久阶段，不重复提交。对齐失败保留提交和用户index、needsReconciliation。关闭hooks/fsmonitor/pager/prompt/signing/external diff/textconv，外部filters/冲突/子模块/特殊索引拒绝写。无push/reset/自动解冲突；不承诺锁住外部CLI/编辑器。

## Task 5: 按需检索

Web后台下载/校验/准备/启动，进度、取消、重试。独立CPython3.14+哈希锁定CPU wheelhouse，最终路径建venv；固定bge-small-zh-v1.5 revision/文件hash，运行离线。缺tokenizer暂停文本/向量领取，缺向量不静默放松strict/semantic；暂时不可用保持embeddingSpaceId。编辑/历史/回收站不依赖模型。

## Task 6: 发行管理

Linux x86_64 glibc/systemd，Ubuntu22.04+/Debian12+验收；私有受控制品源，外网HTTPS，loopback开发源可HTTP。XDG config/secret,data/releases/plugins/models/backups,cache分别保存；~/.local/bin/dooknow；journald。

安装检测系统/空间/权限/端口/用户服务/linger，固定清单SHA256，原生模块与Node匹配，无现场npm，安装锁、可重试、不覆盖账号/密钥/数据，无TTY不建空密码。服务入口serve；install/start/stop/restart/status/doctor/update/rollback/backup/restore/reset-password/uninstall。卸载留数据。

升级：下载校验→自检→停写→一致性备份→迁移→版本指针切换→健康检查→恢复写入。备份原文含隐藏回收站、SQLite backup API、历史、必要配置；秘密受控加密。数据库兼容可回退代码，不兼容迁移只在未接受新写入的失败窗口自动恢复。恢复沿用会话/分享失效策略。

## Task 7: 命名与生产切换

knowledge仓库/目录→knowledge-base；web仓库/源码→doo-know，私有属性、仓库身份/历史/分支不变。先协调开发会话/worktree引用。原文改名沿用原固定发布版本，与应用升级分开。停写排空意图/任务，完整备份，同盘整体移动，原identity字符串CAS恰好一行且dev/ino相同，不删身份保护/不普通restore。保持原DATA_ROOT/模型/秘密位置。禁止两版共写。新平台MCP真实替代验收后停旧Bridge，旧版保留。回滚不覆盖期间新写入。

## Task 8: 集成验收与独立审查

干净无全局Node/Python/sudo用户curl/wget，TTY/无TTY/冲突/中断/损坏/重试；初始化认证/CSRF/软链接/替换/并发/丢响应/重启；核心P1和分页/大文件；插件动态安装/启停/配置/故障/升级；MCP真实授权/刷新/撤销/错误audience/范围；Git首提交/部分暂存/新增删除/忽略/特殊文件名/状态变化/崩溃/index对齐；检索离线/失败恢复；旧部署接管/升级回退/备份恢复/身份关系。运行npm test/typecheck/build、Python检查、桌面/移动端浏览器，记录实际证据。独立审查后修复重要问题。

不含定期总结、第三方任意插件、多用户、完全热卸载、自动push、其他OS、公开仓库/下载域名/插件市场发布。
