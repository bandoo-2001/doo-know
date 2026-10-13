# MCP 与索引开发记录

日期：2026-10-14（Asia/Shanghai）。本文件记录源码开发及隔离验证；正式部署和目标客户端接入尚未执行。分支为 `codex/doo-know-mcp`；[接口契约](机器API.md)、[运维与恢复](MCP与索引运维.md)、[性能与质量实测](MCP性能评测.md) 分别维护。

## 已实现的行为

- 独立机器身份/短期签名、scope/目录授权交集，浏览器保留实时会话、Origin 和 CSRF。增量表保持既有 notes/shares/revisions 关系。
- Web 与机器写入复用持久意图、版本检查、历史和原子替换；客户端可带原 requestId，后台 patch/历史恢复、取消、丢失响应及租约恢复均返回有界摘要。重启不干扰另一活跃 worker，过期意图补偿只执行一次。
- 20 MiB 原文上限、64 KiB 流式快照/复制、原字节 UTF-8/CRLF/BOM、单调 sourceRevision、正文/outline/metadata/历史分页与完整 JSON 预算。机器身份不能选择 Web 限额，配额包含排队预留及活动引用；内部索引快照完成后释放。
- Web 先取 metadata、大文件只加载当前片段，CodeMirror 片段增量和无长行换行；失联保留原 ID/草稿并核对。引用可打开指定行。公开正文和附件检查当前分享/原文权限，大文件附件通过两遍有界引用证明；复杂 Markdown 明确拒绝，代码伪引用不授权。下载每 64 KiB 验证会话、版本和速率。
- 监听/启动/60 秒快核对/300 秒全文哈希核对，根不可用不误删，外部重命名为新私有身份。显式 ff-only Git 同步固定 argv/禁用 hooks/过滤器，不 stash/reset，同步后补偿核对再释放写锁。
- 原文字节/行/token 有界切片，独立 jieba/BGE tokenizer、FTS/短词/标识符/目录/标签/日期过滤；真实离线 BGE CPU 512 维、不可变 Float32 generation、checksum/空间、预加载/CAS、并发重合并、pin/retire/物理压实。
- 持久索引 lease/checkpoint/失败重试及模型目标 fencing，迟到旧 worker 不发布；大任务 checkpoint 让出小笔记。text/semantic/hybrid、RRF 聚合、普通 5 秒/strict 10 秒、向量离线全文降级、完整研究 note/chunk fetch、Web 索引状态。
- SQLite 一致性备份/空目标恢复，原文/历史保留，派生数据重建；撤销旧浏览器会话、分享和原始机器令牌。独立网关已提供 MCP、REST、OpenAPI/Swagger、外部 OAuth/Bearer，真实 SDK HTTP 联调与标准发行者 PKCE/introspection/撤销在隔离环境验证。

## 提交和验证记录

三个已推送 Web checkpoint 为 `b0ca1a3`（机器与大文件）、`fd73356`（任务/Git/恢复）、`00ae87e`（本地全文/向量/混合检索）。网关最新已推送 checkpoint 为 `d89fea4`，远端 [doo-know-bridge](https://github.com/bandoo-2001/doo-know-bridge)。用户授权按验证节点推送源码；知识库原有未提交资料不随源码提交。

第三批完整验证曾为 Web 87 项/44 文件、浏览器 14 项、Python runtime 12 项。补充修复后新增 20 MiB 真实切片、模型空间、内部快照、大文件附件、实时下载撤销、metadata/outline 预算、普通 Web nonce、无效 UTF-8、活跃 worker 恢复和引用行号用例。最终全套结果及独立审查在收尾时追加，不能沿用第三批数量。

日志在 Git 忽略的 `.local/mcp-validation/` 和 `.local/benchmarks/`；测试仅使用临时知识库、SQLite、Git 双副本、假身份、回环服务与明确固定模型。没有在真实库上写入、部署常驻服务、改实际 `/etc`、创建定时任务或公开发布。

## 当前边界

普通检索性能未全部达标，准确结果和测试口径见性能报告。72 条 AI 合成标签不是人工金标准；10 万规模为重复真实 embedding 的夹具，不是 10 万独立正文的生产重建。浏览器输入延迟/公开分享并发尚未专项计时。

目标 ChatGPT/其他远程客户端、生产 OAuth 账号和 HTTPS 证书尚未接入验证。完整 CPU 检索使用 native 模板；Node Docker 模板不含 Python/model，当前未构建容器。代码提供可审查部署/恢复说明，不把配置模板当成已运行服务。

## 收尾统一验证（独立审查前）

2026-10-14 新运行：Web `npm test` 55 文件/126 项通过，typecheck/build 通过；全部桌面/手机 `npm run test:e2e` 16 项通过；Python runtime 与基准数值合计 15 项通过（无模型 skip）。网关全套 9 文件/31 项、typecheck/build/openapi 通过。新增公开标题回归曾因元数据未知时使用文件名盖住当前 H1 失败，按 readState 区分后全浏览器回归通过。依赖弃用、NO_COLOR 和 Vite bundle 提示保留，没有功能失败。

实施裁决：既有设计直接执行，干净原源码分支开发；中文阶段用手工 ledger；后续用户授权验证节点提交推送源码；小 patch 统一异步；网关先客户端 checkpoint 后全部工具；固定 MCP SDK 1.32.1/2025-11-25；分词与向量分进程；独立网关/基准明确所有权并行。未确定的复杂大文件附件语法保守拒绝；按已授权范围保留并推送功能分支，不额外合并或创建 PR。审查裁决与暂缓项在最终收尾追加。

## 独立审查修复后的最终验证

一次独立全分支审查确认 8 项 Important，根节点逐项用失败用例复现并修复，未列 Minor。详见 [审查与实施裁决](审查与实施裁决.md)。审查后的新完整运行：Web `npm test` 58 文件/137 项通过；typecheck/build 通过；`npm run test:e2e` 桌面 9/9、手机 9/9，合计 18 项通过。网关 9 文件/32 项与 typecheck/build/openapi 通过；Python 实际本地模型/数值 15 项通过（Python 实现未在修复轮改动）。当前两个源码工作树再次执行真实 Web+BGE HTTP MCP SDK 联调，退出0，包含已准备正文页、版本冲突、原 ID 重试、后台大文件 patch、权限、混合 search/fetch 和归档。

浏览器初次统一回归曾触发共享夹具 `get-session` 的真实20次/分钟认证限流429；e2e启动器现在按桌面/手机分别创建隔离服务器、账号与数据，再运行全部测试。显式 `--project` 和原筛选参数继续透传。真实认证策略保持既有设置，不以限流失败当作会话失效或直接关闭保护来给测试通过。

默认嵌入运行每秒串行维护文件租约/意图、快照恢复与清理，退出等待维护结束；旧preparing引用在fenced恢复后释放。确定未提交的同步失败持久终态并原样重放，真正进入提交后仍以意图核对。同hash的归档恢复/冲突解除提升版本并重建两路；空替换根的所有普通入口返回SOURCE_UNAVAILABLE而保留ID/分享；严格混合在向量离线时报错。

首次运行、全部修复和最终验证均仅作用隔离夹具。知识库计划保留全组合故障、人工标签、正式部署、客户端与专项性能未完成项；大文件显式预览仅渲染已加载的128KiB当前片段，默认关闭；桌面/手机失败→通过覆盖未加载尾部不会进入预览。源码主要实现交付完成，不将其表述为所有生产验收已经满足。

首次从全文模式启用BGE的补充失败→通过验证：修复SQLite遍历中的嵌套enqueue事务，以及两路chunker身份变化的同时重建。真实模型worker/vector/hybrid共7项通过；新完整测试58文件/137项通过，typecheck/build通过，包含片段预览的desktop9+mobile9=18项通过。原始两次失败日志与通过日志保留在 `.local/mcp-validation/enable-vector-*.log`。
