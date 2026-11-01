# 阶段 1 验证记录

实施方案：`docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`。
实施计划：`docs/superpowers/plans/2026-10-31-markdown-diagram-documents.md`。

状态：格式、适配和共享契约已实现；正在收集全量回归结果。尚未接入新图创建/保存、迁移或部署。

## 已锁定选择

- Mind Elixir 5.15.1（稳定的 5.x 版本，未使用 npm latest 指向的 6.x 预发布）、SnapDOM 3.7.0；精确版本写入 package/lock。
- 大纲上限：含根最多 500 节点、最大子节点深度 64、源码 256 KiB、每节点 2000 字符。单行纯文本，规范化输出用 `- `、两空格缩进；单独根节点合法。拒绝富文本、HTML、块级语法、多行续写和控制字符，避免图形保存丢失原文。
- 主图 schema 区分主文档、源格式、角色及公开资源能力；只读公开预览可返回摘要元数据，不含源内容/路径/读取句柄。
- PNG 使用临时完整展开树及本地系统中文字体，白背景，最长边 8192、最多 16,777,216 像素、10 MiB。当前折叠、视口、选择及撤销历史不参与临时实例。
- 发布许可证沿用既有 `scripts/third-party-notices.mjs`，实际运行确认包含两项新增包及其 MIT LICENSE。

## 独立审阅及修复

阶段审阅由独立只读 reviewer 执行，发现三类问题：

1. P1：Mind Elixir 原生剪贴板 magic 分支在自定义 pasteHandler 之前处理图片/HTML。浏览器用例先复现新增危险节点，随后使用 capture 事件校验原生载荷；拒绝图片/HTML/不支持字段和超限内容，输入框只插入纯文本；正常文本节点复制粘贴保留。
2. P2：未知 HTML/注释等受管内容可能被图形替换删除。新增失败用例，严格拒绝未知块及额外正文，回退源码恢复；非受管说明原字节保持。
3. P2：仅行内解析会接受列表内标题/引用/额外列表/fence，并将 NUL 规范化为替代符。新增失败用例，增加完整块 token 校验和规范化前控制字符检查；已转义的同字符仍为普通文本。

自审补测并修复：等待字体期间输入树被调用者修改会改变 PNG；现于首次 await 前固定序列化快照，浏览器输出摘要比较用例先失败后通过。另补齐根节点无子项的合法主文档、文档类型/主图格式一致性和公开源能力载荷校验。以上均执行过失败→通过验证。初建模块的测试首先因模块不存在失败；审阅回归用例均在真实实现上观察到断言失败。

审阅排除项：真实保存/CAS、迁移、分享授权、历史资源保留、导出闭包及旧 MCP 新资源接入属于后续阶段，不能据阶段 1 已通过宣称这些能力完成。PNG 浏览器验证由主执行者运行并查看实际截图，reviewer 未重复运行。

## 命令及证据

- 相关单元回归：`npm test -- tests/diagram-document.test.ts tests/diagram-resource.test.ts tests/mindmap-outline.test.ts tests/diagram-document-binding.test.ts tests/portable-resource-limits.test.ts tests/diagram-save-plan.test.ts tests/whiteboard-format.test.ts`：103/103 通过。
- 适配浏览器：`npm run test:e2e -- --config playwright.diagrams.config.ts --project=desktop`：6/6 通过；中文输入法组合 Enter、Tab、撤销、折叠/离屏整图、500 节点、不安全粘贴和文本复制粘贴。500 节点用例约 0.60 秒（单次本机 Chromium 数据，不是跨设备保证）。
- `npm run typecheck`：通过。
- `npm run build`：首次通过；修复后最终构建亦通过。第三方包现有 `use client` 构建提示未影响退出状态。
- `npm test`：全量运行中。隔离目录缺少已有分词 venv/model 导致 `tests/indexing/chunks-large.test.ts` 的 TOKENIZER_UNAVAILABLE；复用原机离线 venv/model 后该测试单独通过（43 秒），未修改分词产品代码。另一个 `tests/benchmarks/search-cli.test.ts` 要求模型必须在隔离目录内，改用本地模型副本后也单独通过（20 秒）。最终全量结果待追加。

原始源码工作目录 427 份兼容基线文件 SHA-256 重新核对一致；用户已有 ToDoo 改动未被修改。首次依赖副本切换与校验竞争造成短暂缺包的那轮结果已作废，并完成重新验证。


全量结果补记：该次运行耗时 1154 秒，392 文件，2838 通过、16 跳过、8 失败（3 文件）。`diagram-document.test.ts` 六项失败来自长跑期间缓存的审阅前实现，对应根节点/未知受管内容/富文本用例已在最终代码单独 103 项回归中通过。另两项为上述运行环境缺失，均已重测通过。该次混合版本运行不作为最终全量通过证据；阶段 2 代码稳定后运行冻结状态的全量回归。
