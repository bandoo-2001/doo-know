# MCP Agent Usability Implementation Plan

> **For agentic workers:** Use subagent-driven-development with disjoint error/protocol/workflow tasks; root owns package version and integrated verification.

**Goal:** 让 agent 根据清楚的契约与安全恢复提示完成已有 MCP 功能。
**Architecture:** 保留 18 项工具，统一 registry/SDK 错误、修正发现与 OpenAPI，真实宿主隔离验收；不变更知识核心语义。
**Tech Stack:** TypeScript、现有 MCP SDK/Zod、Vitest、临时 HTTP/OAuth 宿主。
**Spec:** docs/superpowers/specs/2026-10-26-mcp-agent-usability-design.md

## Global Constraints

- MCP1.1.1/^Host1.1，18 个工具，完整请求128KiB／完整响应64KiB，写入32KiB、显式分页边界不变。
- 正式rc49/API1.0与MCP1.0.3停用状态不动，不扩权、不修改真实资料、不激活QA timer。
- errors.ts 共享导出按 spec，变更前告知根；各任务仅改所属文件，不提交或派子代理。
- 所有新错误只允许安全字段与固定提示，不能回传原始 args、正文、私有路径或后端任意 details。

## Review Focus

- SDK 必须真的返回 structuredContent，不能仅让 registry 单元通过而 SDK 仍提前产生文本错误。
- 缺权限与字段错误不能反映未知参数值；冲突不能鼓励盲换版本，未知写入不能鼓励新 ID 重写。
- 请求取消、后台 accepted 与操作查询不得被新 handler 改成假成功或假回滚。
- tools/list 和 initialize 的真实帧有界，默认字段在 MCP/OpenAPI 保持一致。
- 18 工具只在隔离资料测试；索引降级如实报告，不能把本地测试当成外部连接打通。

### Task 1: Safe error recovery

**Files:** plugins/mcp/server/errors.ts、service.ts；tests/mcp-agent-errors.test.ts。
- [x] requiredScope／currentModifiedAt 丢失、字段问题、未知写入恢复的行为 RED。
- [x] 实现 spec 共享工厂、白名单上下文和 recovery schema；安全元数据转换。
- [x] 有界错误、不泄漏输入／后端内容、原请求 ID 与新操作规则 GREEN。

### Task 2: Protocol discovery and validation

**Files:** plugins/mcp/server/operations.ts、contracts.ts、index.ts、openapi.ts，可新增 agent-guidance.ts；tests/mcp-agent-protocol.test.ts。
- [x] 真实 MCP SDK 内存连接观察参数错误缺结构化内容、OpenAPI required 错误的 RED。
- [x] 使用公共 handler 与 registry 工厂统一错误，保留 schema、取消与预算；initialize 和字段说明有界。
- [x] OpenAPI 输入转换、共享错误 schema、协议／OpenAPI 版本1.1.1一致，真实帧 GREEN。

### Task 3: Functional workflows

**Files:** tests/mcp-agent-workflows.test.ts；验收发现的最小标题修复另含 indexing/chunks.ts、search/service.ts、search/research.ts、tests/indexing/chunks.test.ts。
- [x] 验收发现的标题层级空洞最小修复：indexing/chunks.ts、search/service.ts、search/research.ts 和 tests/indexing/chunks.test.ts；新旧索引严格合法化，不做实际数据重建。
- [x] 用临时真实宿主／知识库和 SDK 调用注册路径验证全部18工具，断言具体业务结果。
- [x] 覆盖搜索读取、写入／patch／归档／重放／冲突、索引进度／降级、操作查询／取消、博客显式发布／撤下。
- [x] 不用真实向量模型或正式资料，不用脆弱 sleep／放宽行为断言冒充通过；如能力需其他夹具明确报告。

### Task 4: Integration and delivery

- [x] manifest1.1.1及真实打包测试期望同步；新增回归纳入 CI／发行检查。
- [x] 声明精简错误结果分支，保持严格成功分支，确认正常 SDK 在 listTools 后的 callTool 也能接收错误。
- [x] 独立审查并修复重要问题；源码冻结后统一类型／构建／相关回归、实际插件包 HTTP 测试。
- [x] 记录外部429与正式停用／版本边界、agent操作手册、准确测试清单及未验证项。
- [x] 仅提交任务文件同步默认分支，保持原8项修改；不发布或部署新程序。
