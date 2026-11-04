# 2026-11-04 Tailscale 预览启动记录

已将 `txj/todoo-audit-fixes` 全部分支提交推送至 origin。预览应用当前使用登录错误提示修复提交 `5099e9f4d47b29e35ef89f819cb5d3c220462b9a` 的已验证构建。最初从 `9babad6` 启动，旧应用副本保留以便回退。

- 访问地址：`http://100.93.35.65:5180/`，仅绑定本机 Tailscale IPv4。
- ToDoo：`http://100.93.35.65:5180/?view=apps&app=to-doo&appSection=tasks`。
- 运行用户：`bandoo`；运行时：`/usr/bin/node`，v22.22.1。
- 临时用户服务：`doo-know-tailscale-preview.service`；未设置开机自启。
- 固定应用副本：`/srv/stacks/knowledge/doo-know-preview/releases/5099e9f/`，包含 dist、runtime、包声明、预览版本信息及官方 MCP/Git 插件目录。
- 配置权威来源：`/srv/stacks/knowledge/doo-know-preview/profile.json`，权限600。没有绑定正式安装目录。
- 示例原文：`/home/bandoo/.local/share/doo-know-web-demo/knowledge`。
- 示例数据：`/home/bandoo/.local/share/doo-know-web-demo/data`；插件数据在同级 `plugins`。
- 沿用示例库既有账号和认证密钥，未创建账号、未重置密码，凭据未复制到代码或本记录。

运行副本的 `node_modules` 链接到本项目现有依赖环境，未重复安装2.5GB依赖。后续更新或移除项目依赖前应先停此预览；修改源码或重新构建项目 dist 不会覆盖固定应用副本。这是临时预览，未替换正式发行版。

启动前使用 SQLite backup API 创建一致性备份，并通过 quick_check：

`/srv/backups/doo-know-preview/2026-11-04-before-preview/app.sqlite`

备份位于受限管理员目录，数据库文件权限600；未另存明文认证密钥。启动仅对闲置示例库运行应用既有迁移。正式服务及两个 QA 服务的 PID 和运行状态保持不变，正式实例仍监听 `127.0.0.1:5173`。

## 验证

- Tailscale 在线；监听地址为 `100.93.35.65:5180`。
- `/healthz`：alive、phase ready、预览版本 `1.1.0-preview.login.5099e9f`。
- `/readyz`、首页：HTTP 200。
- 独立浏览器上下文正常加载 JS/CSS，沿用原凭据登录并只读进入 ToDoo。
- HTTP 非安全上下文下 UUID 兼容功能正常；JS错误、API 5xx、失败请求均0。
- 未通过验证过程创建任务、修改笔记或导出应用内容。

## 启停与恢复

```sh
systemctl --user status doo-know-tailscale-preview.service
systemctl --user stop doo-know-tailscale-preview.service
```

临时单元停止后会被回收；需要重新启动时使用：

```sh
systemd-run --user --unit=doo-know-tailscale-preview --collect \
  --property=WorkingDirectory=/srv/stacks/knowledge/doo-know-preview/releases/5099e9f \
  --property=UMask=0077 --property=Restart=on-failure --property=RestartSec=3 \
  --setenv=NODE_ENV=production \
  /usr/bin/node /srv/stacks/knowledge/doo-know-preview/releases/5099e9f/dist/server/scripts/manage.js \
  serve --profile /srv/stacks/knowledge/doo-know-preview/profile.json
```

如需回退示例库数据库，先停止预览并确认没有进程使用该数据目录，将当前完整数据库及旁文件另存，再用上面的 SQLite 一致性备份恢复。此操作会撤销备份之后的数据库编辑；原文与认证密钥仍分别保留在原位置，需要独立核对。此次没有执行恢复或改动正式服务数据。

## 登录问题复验与修正

预览绑定独立示例库，账号与正式实例分开。截图中的账号不属于该示例库；内部使用原私有示例凭据登录及读取session均为200。随机错误凭据返回401及`INVALID_USERNAME_OR_PASSWORD`，不是当前HTTP来源或CSRF阻断。没有使用、记录或复述截图中的密码，没有重置任何账号。

原前端只读取`error`，漏读认证接口的顶层`code/message`，因此把明确的认证失败展示成“请求失败”。现统一显示“用户名或密码不正确，请核对后重试”，并保留旧error优先级、嵌套错误、密码长度策略及status/data。真实用户名是否存在仍使用相同错误提示。

新增回归先出现2项预期失败；修复后相关API/请求超时/CSRF/认证4文件18项通过，类型检查和构建通过，窄审查规格/质量均PASS。本次未重跑整仓测试；前轮全量搜索基准失败及单项复跑边界见上一份ToDoo验收记录。

更新后的真实浏览器复验：随机不存在身份提交401，错误区精确显示新中文提示且不再显示“请求失败”；原私有示例凭据正常UI登录200，随后只读进入ToDoo200，工作区可见。仅两次登录提交，ToDoo写请求及页面异常均0；未截图或导出凭据/会话。

示例账号仅在Mini本机私有文件`/home/bandoo/.local/share/doo-know-web-demo/secrets/demo-login.txt`中查看，本记录不保存账号值或密码。配置更新前的副本在`/srv/stacks/knowledge/doo-know-preview/profile-before-5099e9f.json`；原数据库与密钥位置不变。
