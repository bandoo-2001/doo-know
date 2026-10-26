# Reliability and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkboxes for tracking.

**Goal:** 修复整体扫描的九项问题，完成综合验证并发布rc49。
**Architecture:** 复用写入租约、工作区停写与发行恢复机制，修复原有边界而不重写平台。独立文件分工并行实施，根代理顺序集成、审查和发布。
**Tech Stack:** Vue3/TypeScript/Fastify/SQLite/Vitest/Playwright/native Linux release.
**Spec:** docs/superpowers/specs/2026-10-26-reliability-performance.md

## Global Constraints

- 保留用户原有未提交的 docs/验收记录/2026-10-21-platform-full-audit.md（SHA c1113b1a6dc5d8e730b7db991c5aeef9ad933f349a425aef858d000da4f56edc）。
- 不修改正式知识库、账号、配置或服务；测试只用独立fixture，避免5173、5199。
- 保持手动保存、CAS冲突、历史、幂等、权限、过期/撤销分享；不将真实凭据写入输出、文档或提交。
- 兼容代次3保留；同版本插件字节不可改变，必须比较rc48正式包。
- 跨任务不得改对方文件，公共db.ts/全局配置修改先协调。实现者不提交；根代理管理Git与发布。
- 先补能复现问题的有意义测试并确认RED，再修复并确认GREEN；文档和纯配置使用适当静态/构建验证。

## Review Focus

- 活写入超过租约、进程中断和同笔记双写：不得偷租约，不得均成功后静默覆盖（Task1）。
- 回滚中断发生于停写后、切换后或健康确认后：恢复可重复且不退回覆盖已开放的新写入（Task2）。
- 成功导入与失败重试的保留差异：移除正文不能破坏幂等与只重试失败项（Task2）。
- 外链同路径、脚注、编码片段、相对笔记：保持外链身份和锚点定位（Task3）。
- 构建依赖裁剪：真实包无开发环境仍能安装、运行、编辑和加载设计器（Task4/6）。

### Task 1: Atomic per-note write ownership

**Files:** packages/core/knowledge/core.ts, packages/core/knowledge/file-jobs.ts, a focused shared write-lease helper if needed; tests/knowledge/note-write-concurrency.test.ts plus adjacent race/recovery tests.
**Interfaces:** 保持公开mutationCore及fileJobService接口；内部同步和异步写入共用原子note_write_leases，持有至rename和record结束。沿用已有operation/process存活判断；不需要增加对外API。
- [ ] 将 `.local/overall-audit-20261026/backend/web-worker-update.ts` 的真实双进程屏障缩成长期回归，断言竞争只允许一个成功或明确冲突，成功内容和历史完整；验证反向次序、崩溃恢复与长活租约。
- [ ] 运行确认旧实现RED；实现统一取得/释放、意图登记前原子竞争检查；不以单次非原子assert替代互斥。
- [ ] 聚焦跑mutation/file-jobs/WAL/lease/workspace gate/分享安全回归GREEN，报告文件与精确日志。

### Task 2: Platform interruption recovery and bounded tasks

**Files:** apps/server/platform/updates.ts, apps/server/platform/service.ts（按需）, packages/core/indexing/jobs.ts, apps/server/platform/transfers.ts; focused tests for rollback interruption, index attempts and transfer payloads.
**Interfaces:** 现有CLI/API与分页返回结构不变，复用更新事务校验，恢复不得丢失已开放写入；成功任务保留指纹和公共回执，不长期持有正文，失败项仍可重试。
- [ ] 基于 `.local/overall-audit-20261026/platform/` 三个真实最小复现各写失败测试并记录RED。
- [ ] 为回滚保存持久恢复阶段，覆盖停写后与切换后SIGKILL，重复恢复与无效/陈旧事务，保留代次拒绝。
- [ ] 索引达到10次的过期leased转为可见failed，显式重试可重新领取；活worker不被误判，保留epoch fencing。
- [ ] 任务列表/详情只读取公开字段；成功/取消任务按正确边界释放payload，失败重试只保留必要材料；旧成功记录按安全渐进策略处理，保留幂等指纹。
- [ ] 相关平台/索引/导入/恢复回归GREEN，报告各项证据。

### Task 3: Markdown navigation and visible-only preview

**Files:** apps/web/components/Workspace.vue, focused helper in apps/web if needed, shared/note-links.ts only without breaking backend consumers; tests/editor/workspace linkage tests and tests/e2e/markdown-navigation.spec.ts if needed.
**Interfaces:** 先分fragment/external/relative file，保留片段，外链与本地同路径不得改身份；阅读与文档编辑共用准确判断。原有图片安全和分享编辑上下文不变。
- [ ] 将 `.local/overall-audit-20261026/frontend/workspace-audit.test.ts` 的实code测试转成长期有意义回归：真实脚注锚点、外链同路径、跨笔记章节保留；旧实现RED。
- [ ] 修复解析次序，支持同文档与跨笔记片段，目录路径建立Map避免逐链接扫描。
- [ ] 编辑模式无预览ref时不parse/sanitize隐藏预览；阅读/分屏可见时仍更新，切换立即呈现当前草稿，图表/目录/清理不倒退；RED/GREEN计数证明。
- [ ] 桌面与手机真实浏览器验证链接、模式切换、未保存草稿、代码/图片/图表，使用独立默认4179测试服务；不要与根代理并发使用该端口。

### Task 4: Trim native production dependency closure

**Files:** package.json, package-lock.json, scripts/release.mjs/build-plugins.mjs only if needed; release artifact verification.
**Interfaces:** 浏览器依赖保持原固定版本、功能和许可证；只改变运行依赖分类；避免不必要全局安装。rc48包为比对基线。
- [ ] 查明编译服务端的实际runtime imports，将Excalidraw/Mermaid/React/CodeMirror等仅浏览器依赖归入devDependencies，离线更新锁文件。
- [ ] 使用真实production-only安装/发行包启动验证，而非依赖开发node_modules；记录包大小及解压占用实测。
- [ ] 核对设计器、Mermaid、SVG和代码块网页功能；比对两插件字节，变化则独立递增版本并说明原因。

### Task 5: CI, release gates and accurate operations docs

**Files:** .github/workflows/ci.yml, scripts/verify-release.ts, README.md, docs/原生安装与恢复.md, new durable browser/support fixtures only as needed.
**Interfaces:** 新分享/修复回归为正式可重复检查，不依赖私有.local脚本；CI与release使用相同真实页面测试入口。
- [ ] 增加分享权限/有效期/匿名保存/撤销与新bug回归，修复默认fixture兼容问题；保留故障注入与真实后端的边界。
- [ ] 更新README兼容代次3及期限/编辑行为，说明回滚恢复和保留策略；不写真实凭据。
- [ ] 仅根代理顺序修改全局清单，读取其他任务产出的准确测试文件名，避免实现者争用。

### Task 6: Integrate, independently review, test and publish

**Files:** new task evidence under .local/optimization-fixes-20261026, deploy/github-install.sh after publish, concise release record.
- [ ] 审查每任务diff与RED/GREEN日志，对高风险写入和回滚进行独立审查，修复Critical/Important；全分支再审一次。
- [ ] 全量unit含离线search artifact、类型检查、build、桌面/手机关键流程及新增回归；发现新问题先复现修复再验证。
- [ ] 干净默认分支构建rc49，正式release gate（新增回归含入）与真实包安装、独立数据迁移/保存、公开插件安装检查通过。
- [ ] 发布9个制品，校验远端SHA和公开下载；更新默认与原公开安装分支bootstrap，保留用户未提交文件。
- [ ] 交付新版链接、准确测试/体积结果、压缩步骤图与更新命令；正式实例不在此次发布中更新。
