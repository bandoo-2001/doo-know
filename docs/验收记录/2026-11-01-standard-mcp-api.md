# 标准 MCP API 实施与验收记录

日期：2026-11-01。方案：`../superpowers/specs/2026-11-01-standard-mcp-api-design.md`。

## 实施范围

- 已移除产品内的 Tunnel 专用监听、认证配置、引导界面、REST/OpenAPI 适配及 Bridge adoption 脚本。域名、TLS、反向代理及外网连通由部署方外部对接。
- 复用主 HTTP 服务与标准 Streamable HTTP 协议：`/mcp` 仅接受 OAuth；`/mcp/api-key` 仅接受独立 Bearer API Key，两者不互相回退。
- MCP 插件版本 `2.0.0`，宿主插件 API `1.4.0`；插件声明 `^1.4.0`，防止在不支持新认证的宿主上加载。
- 独立客户端拥有稳定身份与授权，可命名、调整业务与资源权限、轮换密钥、撤销。支持默认 90 天、自定义时区明确的到期时间、永不过期。
- 完整密钥仅在签发或轮换后显示一次，数据库保存随机密钥的 SHA-256 摘要，列表只返回尾号；完整密钥不进入持久草稿和审计日志；含密钥的验收用例关闭 trace、截图及视频。
- 轮换立即使旧密钥失效；过期、撤销、全局认证失效及权限变化均经过实时校验。全局失效后需要明确重新授权，手动撤销的客户端不能复活。
- 管理接口复用所有者会话及 CSRF。保留 Host/Origin 检查、请求大小限制及有界限流；调用记录可区分认证方式及密钥 ID。
- 构建前清理 `dist/server`，避免被删除模块的旧编译文件留在发布产物中。

按用户要求，**不迁移旧凭据、配置或数据**。未部署、重启常驻服务或改动生产数据。本次实现留在工作区；仓库含大量其他任务的未提交改动，未将混合改动整体提交。

## 主要代码位置

| 位置 | 内容 |
| --- | --- |
| `apps/server/platform/mcp-api-keys.ts` | 客户端与密钥生命周期、管理接口、摘要认证 |
| `packages/core/auth/mcp-api-credentials.ts` | 凭据表与实时有效性校验 |
| `packages/core/auth/grants.ts` | 统一权限上限及每次调用的授权判断 |
| `apps/server/plugins/mcp-transport.ts` | 两个标准 MCP 入口、认证隔离与限流 |
| `apps/web/components/MCPApiClients.vue` | 创建、轮换、撤销及重新授权界面 |
| `apps/web/components/MCPConnectionGuide.vue` | OAuth / API Key 连接说明 |
| `plugins/mcp/manifest.json` | 新版本、认证开关及配置 |
| `tests/mcp-api-keys.test.ts`、`tests/e2e/mcp-api-clients.spec.ts` | 凭据安全与实际浏览器生命周期覆盖 |

## 验证环境与证据边界

完整单元测试及桌面、手机浏览器套件均实际执行到结束。为避免其他任务修改前端引起 Vite 整页刷新，使用当前源码的固定副本；原始工作区未被替换。浏览器明确启用 `VITE_DOCUMENT_EDITOR_ENABLED=1`，使用现有 Python 环境、本地 BGE 模型和浏览器依赖，测试数据库均为临时数据。

第一次临时副本中的缺失环境、模型路径以及后续 `.local` 路径被 Vite 正确拒绝等无效运行均单独归档，不计入下面的正式结果。恢复后的副本清单与源码摘要在 `.local/standard-mcp-api/resumed-snapshot.json`。模型文件使用已有副本，没有安装新组件或下载模型。

独立代码审查指出的资源身份绑定与新增业务权限编辑问题已经修正并复验。SQLite 并发写入导致可选使用时间更新阻塞认证的问题已有真实双连接回归；只容忍可选遥测的 `SQLITE_BUSY/LOCKED`，不放松凭据与授权判断。

## 验证结果

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 完整 Vitest | 457 个文件：453 通过、2 失败、2 跳过；3,568 项通过、2 项失败、17 项跳过 | `.local/standard-mcp-api/snapshot-unit.log` |
| 上述两处失败修正后复测 | 2 个文件、6 项全部通过：脚本相对依赖路径、基准模型必须位于副本内部 | `.local/standard-mcp-api/unit-final-rerun.log` |
| 后续版本与插件兼容检查 | 15 个文件、65 项通过 | `.local/standard-mcp-api/version-and-plugins.log` |
| 恢复后的核心单元复测 | 8 个文件、97 项通过，包含认证、授权、真实 SDK 传输、界面及构建清理 | `.local/standard-mcp-api/resumed-unit.log` |
| 实际模型及 MCP 工作流 | 4 个文件、12 项通过 | `.local/standard-mcp-api/runtime-smoke.log` |
| 完整 Playwright 桌面 | 521 通过、45 失败、5 跳过，共 571 项 | `.local/standard-mcp-api/snapshot-e2e.log` |
| 完整 Playwright 手机 | 520 通过、42 失败、9 跳过，共 571 项 | 同上 |

完整单元运行中失败的两项已定点复验成功，覆盖原套件全部 3,570 个非跳过用例；这不代表重新执行了一次全绿的完整命令。完整浏览器原始结果合计 **1,041 通过、87 失败、14 跳过**。后续定点复测单独记录，不改写该次全量结果。

最终版本复测结果：

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| MCP 浏览器复测 | 桌面 23/23、手机 23/23，通过；含独立客户端、全部有效期、权限冲突、重新授权、一次性密钥清理及草稿回归 | `.local/standard-mcp-api/resumed-mcp-e2e.log` |
| 类型检查 | `npm run typecheck` 退出 0 | `.local/standard-mcp-api/resumed-typecheck.log` |
| 构建 | `npm run build` 退出 0；删除的 Tunnel/Bridge/OpenAPI 模块未留在服务端产物中 | `.local/standard-mcp-api/resumed-build.log` |
| 活跃源码清理 | 应用、核心认证、插件、脚本和部署文档未检出旧 Tunnel 配置及专用入口；`git diff --check` 通过 | 本轮命令输出 |

本轮修正的文件操作与界面测试，桌面定点复测 **13/13** 通过（`.local/standard-mcp-api/repaired-e2e.log`）；手机整理撤销与完整下载补验 **2/2** 通过（`repaired-mobile.log`）。

原始 87 处失败中，**18 处**对应的修正已经定点复验成功，另 **69 处未关闭**。未关闭表示尚未由定点复测消除，并非在新源码上重新执行后仍失败的统计；修正后没有再次运行完整浏览器套件。机器可读清单：`.local/standard-mcp-api/final-validation-status.json`。

## 全量浏览器失败与后续处理

MCP 草稿相关的 8 处失败定位为旧测试依赖：其他用例保存新版分域权限后，旧版“允许访问的目录”输入框按设计隐藏。草稿测试改用始终可见的外部网页地址，继续检验草稿保留、刷新警告、迟到响应和退出清理。

验收过程中还修正了部分旧测试对折叠分组、规范资源路径、精确错误提示及后台任务完成时机的假设；业务断言保留，未以放宽产品行为消除失败。

其余失败涉及文档编辑器表格工具条、原生恢复、导出预览、搜索/历史、导航及 To Doo 等模块。已确认的例子包括表格工具条覆盖相邻标题、恢复返回 `WORKSPACE_BUSY` 后没有重试、搜索受 `INDEX_PENDING/GIT_CONFLICT` 影响。没有对应证据的失败仍待归因；不能断言它们全部早已存在，也不能宣称全项目验收通过。本任务没有扩展修改这些其他模块的产品代码。

以下是正式全量运行的原始失败分布，含后续可能已经定点复测成功的用例。完整名称、错误及 trace 位于 `.local/standard-mcp-api/snapshot-e2e-status.json`、`global-failure-excerpts.txt` 和 `snapshot-e2e-results/`。

| 用例文件 | 桌面失败 | 手机失败 |
| --- | ---: | ---: |
| `tests/e2e/diagram-desktop-review.spec.ts` | 0 | 1 |
| `tests/e2e/directory-picker-forms.spec.ts` | 1 | 0 |
| `tests/e2e/directory-select.spec.ts` | 0 | 1 |
| `tests/e2e/document-editor-controls.spec.ts` | 1 | 1 |
| `tests/e2e/document-organization.spec.ts` | 1 | 1 |
| `tests/e2e/large-files.spec.ts` | 2 | 0 |
| `tests/e2e/legacy-draft-migration.spec.ts` | 1 | 1 |
| `tests/e2e/local-drafts.spec.ts` | 1 | 0 |
| `tests/e2e/note-native-restore.spec.ts` | 1 | 1 |
| `tests/e2e/platform-pagination.spec.ts` | 1 | 1 |
| `tests/e2e/platform-workflow.spec.ts` | 2 | 0 |
| `tests/e2e/plugin-draft-navigation.spec.ts` | 4 | 4 |
| `tests/e2e/plugins.spec.ts` | 1 | 0 |
| `tests/e2e/portable-data.spec.ts` | 1 | 0 |
| `tests/e2e/portable-native-preview.spec.ts` | 1 | 1 |
| `tests/e2e/responsive-tabbar.spec.ts` | 2 | 2 |
| `tests/e2e/scroll-containment.spec.ts` | 1 | 1 |
| `tests/e2e/search-filenames.spec.ts` | 0 | 1 |
| `tests/e2e/startup-draft-identity.spec.ts` | 3 | 2 |
| `tests/e2e/startup-latency.spec.ts` | 2 | 1 |
| `tests/e2e/subpage-scroll.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-antdv.spec.ts` | 2 | 3 |
| `tests/e2e/to-doo-calendar-range.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-focus-history.spec.ts` | 2 | 1 |
| `tests/e2e/to-doo-lazy-pages.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-light-sidebar.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-notification-history.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-reminders.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-unified-shell.spec.ts` | 1 | 1 |
| `tests/e2e/to-doo-ux.spec.ts` | 0 | 1 |
| `tests/e2e/to-doo-visible-workspace.spec.ts` | 0 | 1 |
| `tests/e2e/tree-actions.spec.ts` | 2 | 2 |
| `tests/e2e/whiteboard-migration.spec.ts` | 2 | 2 |
| `tests/e2e/whiteboards.spec.ts` | 1 | 3 |
| `tests/e2e/workspace-lifecycle.spec.ts` | 1 | 1 |
| `tests/e2e/workspace.spec.ts` | 1 | 1 |
| `tests/e2e/z-git-remote.spec.ts` | 1 | 1 |
