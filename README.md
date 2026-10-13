# DooKnow Web

个人 Markdown 笔记应用。Vue 3 / Naive UI / CodeMirror 6 界面，Fastify / Better Auth / SQLite 服务端。笔记正文以真实 `.md` 文件为准，网页手动保存，分享每次读取最新已保存文件。

源码：`/home/bandoo/workspace/projects/doo-know-web/`。真实知识库尚未接入，未启用常驻服务或公网发布。

## 本机预览

当前预览：[http://127.0.0.1:5173/](http://127.0.0.1:5173/)。仅绑定回环地址。

独立示例库：`/home/bandoo/.local/share/doo-know-web-demo/knowledge/`；数据库和历史在同级 `data/`，密钥在同级 `secrets/`。示例账号的登录信息保存在 `secrets/demo-login.txt`（600 权限），不写入源码或本文。可以用交互命令重新设置密码：

```bash
cd /home/bandoo/workspace/projects/doo-know-web
npm run account -- reset
```

重新启动或在另一台主机运行：

```bash
npm ci
npm run demo
npm run account -- init   # 仅首次；在本机终端输入用户名与密码
npm run dev
```

`npm run demo` 只初始化默认独立示例库，不覆盖已有文件，不允许对自定义 KNOWLEDGE_ROOT 执行。`npm run dev` 启动 API（127.0.0.1:3010）与 Vite（127.0.0.1:5173）。生产部署不要运行 Vite。

## 使用

- 搜索位于新建笔记上方。左侧展开目录即可直接选文件；点击文件夹在同一主区浏览目录。
- 编辑、预览和分屏；保存按钮或 Ctrl/Cmd+S 写回文件。未保存正文不自动写入文件或浏览器持久存储。
- 原文件修改时间变化时返回冲突。取消保留编辑；确认使用最新时间再次检查。外部再次变化会再次提示。
- 分享窗口支持生成、复制、重置、取消。已分享笔记会持续提示保存后同步公开。未保存输入不会公开。
- 插入图片/PDF 后仍需手动保存。文件保存在该笔记目录的 assets 下；链接使用相对路径。只允许 PNG、JPEG、GIF、WebP、PDF，最多 10 MiB，并验证实际文件签名。
- 历史版本可查看和恢复；恢复同样检查版本。删除移入 `90-Archive/.trash/<note-id>/`，分享停用；恢复保持私有，同名占用不覆盖。
- 手机使用导航抽屉，选择文件后收起；分屏在窄屏上下排列。
- 设置中修改密码、退出。忘记密码通过本机 `npm run account -- reset` 重置并撤销所有会话。无注册入口。

## 配置与生产构建

Node.js ≥22.12（本机 22.22.1）。依赖由 package-lock.json 固定。复制 `.env.example` 为未提交的 `.env`，或使用受控 EnvironmentFile；按实际路径填入：

| 配置 | 用途 |
| --- | --- |
| KNOWLEDGE_ROOT | 明确授权的原文目录，服务有受限读写权限 |
| DATA_ROOT | SQLite 与 history 独立数据目录 |
| AUTH_SECRET_FILE | 至少 32 字符的密钥文件，权限 600 |
| APP_ORIGIN | 精确来源，如 https://notes.example.invalid，不含路径 |
| HOST / PORT | 默认 127.0.0.1 / 3010 |
| NODE_ENV | 生产设为 production，强制明确上述四项配置 |

```bash
npm run typecheck
npm run build
npm start
```

构建输出 `dist/web` 与 `dist/server`，其中不包含笔记正文、运行数据库或密钥。生产通过 Fastify 提供界面和 API。私人 API 逐次验证数据库会话；会话 24 小时，不使用 Cookie 会话缓存。业务写操作检查精确 Origin 与 CSRF。认证入口只开放用户名登录、会话查询、退出和修改密码，并保留 Better Auth 的来源防护。登录限流持久化在数据库。

文件扫描仅管理八个分类下的 Markdown 与根 README，排除 AGENTS、隐藏目录、assets、软链接和共享硬链接。浏览器预览禁用原始 HTML 并用 DOMPurify 清理；公开 HTML 经 sanitize-html 清理。分享只读，无私人树、搜索或历史；附件逐次检查是否被当前原文引用。内容响应 no-store；公开阅读 noindex、no-referrer。远程图片不直接加载，避免第三方追踪私人笔记。

## 验证

```bash
npm run test
npm run test:e2e
npm run typecheck
npm run build
```

接口测试使用临时库与临时 SQLite，浏览器测试按桌面/手机分别启动独立隔离库与 4179/4180 端口，不作用于真实知识库。Chromium 使用 Playwright；本机缺失的测试库仅解包在忽略的 `.local/browser-deps/`，由测试启动器加载。其他主机若浏览器库齐全，直接 `npx playwright install chromium` 后运行即可；需要系统库时按主机已有管理方式补齐。

测试证据与实际截图见 [验收记录](docs/验收记录.md)。测试运行输出与 trace 在忽略的 test-results 中；不将会话、分享令牌或私人正文放入交付文档。

## 自托管与恢复

[部署与恢复说明](docs/部署与恢复.md)；模板在 [deploy](deploy/)。提供 systemd、Docker/Compose、Caddy HTTPS 模板，尚未在主机上启用。部署配置以本项目模板为来源，发布到 `/srv/stacks/knowledge/doo-know-web/` 后通过明确版本维护，不把开发工作目录作为常驻发布目录。

生产产物还提供 `account:prod`、`backup:prod`、`restore:prod`，可直接由 Node 运行，容器用法见部署说明。

第一版不包含自动保存、批量移动/重命名、多账号、注册、会员或广告。外部编辑器不参与应用写入锁；应用写入使用 mtimeNs、快照哈希与版本核对，完整哈希周期检测保留 mtime/size 的修改，不能保证不合作的外部编辑器与提交之间实时互斥。

## MCP 与本地检索扩展

功能分支 `codex/doo-know-mcp` 提供中文全文、本地 BGE CPU embedding、`flat_file` 向量与混合检索，持久任务/文件和 Git 核对，以及最大 20 MiB Markdown 的片段编辑、分页分享和恢复。普通查询复用索引；向量服务离线时全文仍可用。独立 [doo-know-bridge](https://github.com/bandoo-2001/doo-know-bridge) 只调用受保护的机器 API，提供 MCP、等价 REST、OpenAPI 与外部 OAuth/Bearer 授权。

入口：[接口契约](docs/机器API.md)、[运维与恢复](docs/MCP与索引运维.md)、[开发验证](docs/MCP与索引开发记录.md)、[实测性能与质量限制](docs/MCP性能评测.md)。模型需要显式准备，运行时纯本地；权重、索引、数据库和真实凭据不提交。完整 CPU 检索采用 native 模板，现有 Node Docker 模板只提供 Web，容器构建尚未验证。当前任务未连接真实知识库、安装常驻服务或接入真实远程客户端。
