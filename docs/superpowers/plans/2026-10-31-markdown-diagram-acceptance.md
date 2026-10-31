# Markdown 图形文档验收与稳定性收尾 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the parent and superpowers:dispatching-parallel-agents for independent audit/fix domains. Existing approved design remains authoritative. No repeated design approval is required by the user's current instruction.

**Goal:** 对九项验收给出真实证据，补齐当前桌面入口及修复数据/权限/生命周期缺陷，明确仍未实现的发布阻断项，保存项目报告。

**Architecture:** 复用已有共享解析器、prepare/commit、资源解析和完整发布策略；桌面三类图形共用保存会话。原目录 ToDoo 工作为保护基线，功能差异以隔离树 `5cd82ce..HEAD` 为准，最终仅回集此差异，不发布用户工作快照提交。

**Tech Stack:** 现有 Vue/Excalidraw/Mind Elixir/Mermaid/CodeMirror、SQLite、Vitest、Playwright desktop。

**Spec:** `docs/superpowers/specs/2026-10-31-markdown-diagram-documents-design.md`；本轮范围以用户最新九项验收为准。

## Global Constraints

- 本轮不开展手机端、App、PWA、桌面小组件。浏览器只运行 `--project=desktop`；已有其他平台测试不删减。
- 临时测试知识库及脱敏数据；不迁移真实知识库、不部署、不重启常驻服务。
- 先复现并定位再修复；未知结果、原件缺失、渲染失败均保留原文/草稿，禁止空白替换。
- 普通 Markdown 编辑和旧原文下载协议保持兼容；未实施项不得用文档或旧 bundle 测试冒充完成。
- 每个专项保留命令、退出码、具体断言和限制；全套检查在代码冻结后运行。

## Review Focus

1. 已有格式/后端完成，但前端仍按后缀和 JSON 打开新 Markdown；必须用真实桌面创建/刷新证明。
2. 目录操作移动了资源却没有更新固定证明，单篇授权会失效；需要实际选中文档权限回归。
3. 旧 JSON 历史禁止直接写回 `.md`；无法受控转换时明确拒绝。
4. 无资源单文件、有资源/批量包、完整回导分别验收；不将旧始终 TAR.GZ 的 bundle 当作新默认导出。
5. 只改源/PNG和索引引用的真实范围独立验证，不能只凭 resource.resolve 的读时检测宣称索引传播完成。

## Task 1: 基线、清单和独立证据

- [x] 核对全局 AGENTS、总体设计/接手说明、四个实施子计划、SDD进度、Git/用户工作。
- [x] 原目录427份已知保护文件摘要一致，图形 task-only patch `git apply --check`通过；尚未覆盖用户目录。
- [ ] 三个领域独立审计：桌面入口/故障、生命周期/恢复、便携/索引/集成。
- [ ] 在 `docs/markdown-diagram-acceptance-2026-10-31.md` 持续更新通过/缺陷/未完成/无法验证；不预填最终通过。

## Task 2: 桌面真实入口修复和遗漏接入

**Files:** `apps/web/components/{Workspace,DiagramPreview,MarkdownEditor}.vue`，新 `DiagramDocumentWorkspace.vue`，`apps/web/diagrams/{document-session,primary-api}.ts`，必要 `drafts.ts/useNoteDraft.ts`，桌面专项和真实会话测试。
**Interfaces:** 复用 reserve/prepare/commit owner HTTP 及 `/api/notes/:id/diagram`；新 .md 画布读取 `resource.source.content`，原文仍是Markdown。全部图形共用队列、双基线、v2草稿和 pending exact Markdown。白板/脑图/流程图的原生编辑、源码、PNG只读视图切换处理未保存快照；保留说明/未知字段。

- [ ] RED：菜单三类创建均 .md，固定PNG后才活动；编辑保存重开，说明保留，原生/源码切换。
- [ ] 实际接入既有 Excalidraw/Mind Elixir/Mermaid，原始文件兼容；请求重试/冲突/渲染失败/草稿恢复保持数据。
- [ ] 桌面浏览器/队列回归 GREEN；普通编辑不回退。旧JSON全页保持独立，来源解析统一资源DTO。
- [ ] 未发布意图本地恢复和单会话唯一写者；不能两个视图写同一草稿键。

## Task 3: 生命周期和安全稳定性

**Files:** 依证据修改 `organization` journal/plan、diagram manifests/proofs、folder/recovery、backup helpers；新增临时库回归。桌面任务不修改这些文件。

- [ ] 先复现目录移动后的单文档授权/证明失效，修复已提交资源的路径上下文。
- [ ] 涉及原生链接改写但没有最终PNG的操作在提交前拒绝，不悄悄改绑；外部活动/历史/租约引用阻止不安全目录回收。
- [ ] 历史恢复、备份状态与保留根实际回归；未实现的专用迁移/回滚列为阻断项。
- [ ] 公开原件/编辑权限、HTML/打印实际复验，修复当前链路已存在的泄漏或不一致。

## Task 4: 便携与检索集成验收

**Files:** 根据独立审计证据选择现有 export/import、reading-export、MCP、indexing/graph/Git、backup和ToDoo相关最小改动；不修改无关ToDoo功能。

- [ ] 区分旧能力与新默认交付未实施项；对可运行路径做资源缺失/越权/外部目录阅读取证。
- [ ] 修复已实现图形资源/命名/源码暴露等明确缺陷并添加价值回归。
- [ ] 单篇无依赖 .md、依赖包、整体回导、媒体预算、真实引用/外部资源变化各自标明实际实现状态和阻断影响。

## Task 5: 冻结验证、回集及报告

- [ ] 适用单元/桌面浏览器、typecheck/build；全套在冻结树跑，失败与基线区分，不为过关删验收。
- [ ] 独立审阅实际修复与其测试，复验所有重要问题。
- [ ] task-only patch 再核对用户文件，回集到原项目，保留用户原有改动和所有文件，不stage其工作。
- [ ] 验收报告包含已修复文件、九项清单/命令/结果、未解决项和真实迁移/发布准备结论；仅实际达标才给绿灯。
