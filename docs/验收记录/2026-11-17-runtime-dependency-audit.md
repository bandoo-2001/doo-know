# 2026-11-17 原生发行依赖审查与修补

本次只在独立 `todoo-release-fixes` 工作树安装和更新依赖，没有修改正在运行的原实例，也没有改变原始、旧 readiness 或其生产浏览器副本的依赖。旧 `.2` 生产浏览器回归继续保留为旧包基线。

## 发现与边界

旧 `.2` 原生包确实带有 `sanitize-html@2.18.0`、`glob@13.0.6`、`minimatch@10.2.6`、`fast-uri@3.1.8/4.2.2`，也实际带有 `vite@8.3.4`、`vitest@5.0.4` 和 `picomatch@4.0.7`，不能简单把后者称为未发布的开发依赖。原始 `npm audit --omit=dev` 为 5 high、5 moderate、0 critical。

原因是 Better Auth 1.7.7 将 Vitest 声明为可选 peer；Vitest 再引入 Vite 与文件匹配依赖。锁文件把它们标为 `devOptional`，仅 `--omit=dev` 的生产安装仍包含这条可选链。实际认证服务不调用 Better Auth 的 `test-utils`，后者才导入 Vitest；正常初始化、登录和 OAuth/MCP 服务不需要它。

## 兼容修补

| 项目 | 旧版本 | 新锁定版本 | 依据 |
| --- | --- | --- | --- |
| sanitize-html | 2.18.0 | 2.18.2 | 维护者确认 2.18.1 起修复丢弃 iframe 时的递归溢出及嵌套限制绕过。[公告](https://github.com/apostrophecms/apostrophe/security/advisories/GHSA-c9rx-x947-fp3h) |
| fast-uri，AJV 分支 | 3.1.8 | 3.1.9 | 同一维护分支的安全补丁，修复 URI scheme、主机和相对路径规范化问题。[维护者说明](https://github.com/fastify/fast-uri/releases/tag/v3.1.9) |
| fast-uri，Fastify 序列化分支 | 4.2.2 | 4.2.3 | 4.x 的对应安全补丁，没有用单一大版本 override 强行替换两个分支。[维护者说明](https://github.com/fastify/fast-uri/releases/tag/v4.2.3) |
| @fastify/static | 10.1.6 | 10.1.11 | 保留 Fastify 5 兼容的同一插件主版本，让插件自己的依赖范围升级 glob；不做跨父包范围的全局强制替换。[发行说明](https://github.com/fastify/fastify-static/releases/tag/v10.1.11) |
| glob | 13.0.6 | 14.0.6 | 维护者的取消遍历修复从 14.0.2 起提供。[公告](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4) |
| minimatch | 10.2.6 | 11.0.9 | 随新 glob 合法升级；修复 globparts 放大造成的资源消耗。[公告](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) |

版本还核对了官方 npm registry 的当前元数据，并以 lock 的实际版本与 integrity 固定重建。上述运行依赖支持打包时使用的 Node 22.22.1。没有降级 Vite 8、Vitest 5，也没有执行 `npm audit fix`。

截至核对时，picomatch 官方 registry 的最新版本仍为 4.0.7，公开公告没有修补版。降低 Vite/Vitest 主版本不能证明这项问题消失。[公告](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)。

## 生产依赖收敛

发行阶段改用 `npm ci --offline --omit=dev --omit=optional --ignore-scripts`，源代码开发环境仍按原有完整依赖安装。`omit` 只控制磁盘安装，不伪造或删除 lock 中的开发记录。[npm 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-ci/#omit)。

发行脚本另外检查 Vite、Vitest、picomatch、tinyglobby、fdir 没有进入实际运行目录，并保留使用随包 Node 打开 SQLite 的原有硬检查。这样不会用审计过滤参数替代真实包内容检查。

独立生产 stage 中这五个包均不存在，SQLite 内存读写通过。实际原生包也逐个检查 package.json 并留存前后清单；没有仅根据 `devDependencies` 标签推断包内容。Vue、React 等可选客户端 peer 不再作为服务器 Node 包携带，其已经编译进前端资产的代码及第三方声明仍正常发布。

## 已完成的验证

- 新工作树独立 `npm ci` 完成，`node_modules` 不是旧工作树的软链接，SQLite 正常。
- 生产 scope `npm audit --omit=dev --omit=optional` 为 **0 漏洞**；同一 scope 的独立 stage 结果也为 0。
- 保留可选 peer 的源码 scope `npm audit --omit=dev` 仍有 **5 high**，均来自尚无上游修补的 picomatch 链。它们留在开发工具环境，不进入本次原生运行包；不能把这个结果描述为整个源码依赖树已无告警。
- 依赖、静态缓存、Markdown/博客及真实打包 MCP HTTP 回归：7 文件、40 测试通过。
- 新增安全输入回归：3 测试通过，覆盖 iframe 递归/嵌套限制及两个 fast-uri 分支对百分号编码 scheme 的处理。
- 完整构建实际 `dependency-test` 原生 tar 成功。解包后仅用它自带的 Node 22.22.1 与实际生产依赖运行：前端静态响应、创建 owner、登录、CSRF、正常 owner API 安装/启用 MCP、真实 HTTP SDK、`taskScope` schema 与回收站查询均通过；随后撤销凭据、关闭进程并移除临时数据。

解包 smoke 的第一次失败来自私有验收脚本的 catalog 相对路径多退一级，发生在应用初始化前；只修正了被忽略目录内的脚本路径。原控制台失败回执及原因另存，成功结果没有被用于掩盖该次失败。

本次依赖测试 tar 的源树为 dirty，只作为运行依赖兼容性证据，不能作为正式新提交或正式安装验收。最终仍须由发布流程对干净提交重新构建并复查。

## MCP 版本说明

新 `filter.taskScope` 会进入 MCP 发现与校验，因此新源码将插件 manifest 和 serverInfo 同步到 **2.0.3**，相应打包/HTTP 测试也已更新。Git 插件保持 1.1.4，SDK 保持 1.32.2。此前真实 `.2` 原生安装的 MCP 2.0.2 报告原样保留为基线，没有改写成 2.0.3 成功。

原始及新增证据均位于该工作树 `.local/production-readiness/`：`runtime-package-inventory-before.json`、`runtime-package-inventory-after.json`、`runtime-stage-smoke.json`、`runtime-stage-audit.json`、`runtime-dependency-audit-after.json`、`dependency-audit-after-with-optional-peers.json`、`dependency-regressions.log`、`dependency-package/`、`dependency-native-smoke/runtime-dependency-smoke.json` 与该目录内的初次失败记录。资料不包含令牌或真实用户内容。
