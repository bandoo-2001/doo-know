# 2026-11-04 Tailscale 预览启动记录

已将 `txj/todoo-audit-fixes` 全部分支提交推送至 origin。预览应用使用代码提交 `9babad6e1a457751f2782921527bae2592c4dc33` 的已验证构建；后续仅增加本运行记录。

- 访问地址：`http://100.93.35.65:5180/`，仅绑定本机 Tailscale IPv4。
- ToDoo：`http://100.93.35.65:5180/?view=apps&app=to-doo&appSection=tasks`。
- 运行用户：`bandoo`；运行时：`/usr/bin/node`，v22.22.1。
- 临时用户服务：`doo-know-tailscale-preview.service`；未设置开机自启。
- 固定应用副本：`/srv/stacks/knowledge/doo-know-preview/releases/9babad6/`，包含 dist、runtime、包声明、预览版本信息及官方 MCP/Git 插件目录。
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
- `/healthz`：alive、phase ready、预览版本 `1.1.0-preview.todoo.9babad6`。
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
  --property=WorkingDirectory=/srv/stacks/knowledge/doo-know-preview/releases/9babad6 \
  --property=UMask=0077 --property=Restart=on-failure --property=RestartSec=3 \
  --setenv=NODE_ENV=production \
  /usr/bin/node /srv/stacks/knowledge/doo-know-preview/releases/9babad6/dist/server/scripts/manage.js \
  serve --profile /srv/stacks/knowledge/doo-know-preview/profile.json
```

如需回退示例库数据库，先停止预览并确认没有进程使用该数据目录，将当前完整数据库及旁文件另存，再用上面的 SQLite 一致性备份恢复。此操作会撤销备份之后的数据库编辑；原文与认证密钥仍分别保留在原位置，需要独立核对。此次没有执行恢复或改动正式服务数据。
