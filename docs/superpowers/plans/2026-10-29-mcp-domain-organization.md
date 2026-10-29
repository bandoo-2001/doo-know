# MCP 分域权限与全库自主整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 提供分业务域授权及可恢复的全库目录发现、创建、移动、改名和撤销，保持博客和未来待办权限独立。

**Architecture:** 宿主维护版本化权限注册表，交集判定插件上限与客户端授权。目录有稳定 ID，结构变更由有界持久化整理服务统一执行；MCP 只暴露服务接口，引用改写由独立模块承担。权限、目录引擎、MCP 展示分别实施，最终由真实宿主和 SDK 流程集成验证。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、Vue、Zod、Vitest、MCP SDK；沿用现有进程与依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-mcp-domain-permissions-and-organization-design.md`

## Global Constraints

- 从设计提交 4e683b5 在 `/home/bandoo/.codex/worktrees/mcp-domain-organization/doo-know`、`txj/mcp-domain-organization` 开发；不覆盖原检出的未提交改动，不部署、不运行真实知识库整理。
- 权限默认拒绝；all 仅覆盖同一业务实例；新 scope、新域、新顶层目录不自动扩大旧连接授权。
- HOST_PLUGIN_API 1.2.0，新 MCP 插件要求 ^1.2.0；旧 KnowledgePort 方法继续兼容。
- 最多 50 actions、1,000 文件、2,000 目录、128 MiB 正文、512 MiB 附件；请求 128 KiB、响应及发现帧 64 KiB。
- 目录 ID/noteId/assetId 保持稳定；根、90-Archive、99-System 容器和隐藏运行存储不可移动。
- 30 天撤销材料保留，未终结材料不自动清理；不把索引接受状态报告为完成。
- 本期不启用待办、不自动公开发布、不隐含归档或目录合并；常规授权操作不逐次确认。

## Review Focus

- 原目录改名后旧路径被其他目录复用：选区授权不得转移给替代对象（Task 2/5）。
- Tunnel 插件上限扩大后：旧客户端权限不得自动扩大（Task 1/5）。
- 新入链在准备后出现：提交必须重查正文覆盖及修订，不能遗漏（Task 3/5）。
- committing 进程退出后：重启不得先扫目录制造新笔记 ID 或泄漏混合树（Task 2/5）。
- 新业务域或未经授权的引用依赖：不隐含跨域权限，不泄漏受限路径（Task 1/4/5）。

---

### Task 1: 分域权限与连接授权

**Files:** Create `shared/permissions.ts`, `packages/core/auth/permissions.ts`, `tests/domain-permissions.test.ts`; modify `shared/authorization-scopes.ts`, `shared/knowledge-contracts.ts`, `packages/core/auth/grants.ts`, `packages/core/agent/auth.ts`, `packages/core/agent/config.ts`, `apps/server/platform/oauth.ts`, `oauth-grants.ts`, `tunnel-identity.ts`, `apps/server/plugins/mcp-transport.ts`, `packages/core/indexing/text.ts`, `packages/core/search/filters.ts`, affected SQL authorization consumers.

**Interfaces:** Define `PermissionPolicy`, `DomainGrant`, `ResourceRef`, `ResourceSet` in shared/permissions. Principal gains optional permissionPolicy/policyVersion and normalized `knowledgeAll` for SQL ACL consumers; legacy allowedPrefixes remains. `normalizePermissionPolicy`, `intersectPermissionPolicies`, `effectivePermissionPolicy` enforce domain actions, resource identity and instance. `canAccessPath(p,path)` is shared by authorizePath and post-filter checks; identity selectors resolve to current directory/note paths at live host boundary. Directory lookup consumes Task 2 exports.

- [x] Write tests named `does not infer blog or todo from knowledge organize`, `intersects all with selected without widening`, `rejects unimplemented todo`, `legacy write retains archive but never organize`, `tunnel policy expansion preserves old grant` and `v2 blog publishing does not require source write`.
- [x] Run `npx vitest run tests/domain-permissions.test.ts` and record failures before implementation.
- [x] Implement registry, validation and v1 adapter; persist policy version and domain resources with grants; apply same runtime ceiling across OAuth/Tunnel. Replace Tunnel mismatch auto-expansion with preserved grant and explicit reauthorization path. Return effective domain policy in consent/client metadata.
- [x] Update every legacy allowedPrefixes ACL use to respect normalized all and fresh selected IDs; filtered search must still obey caller directory filters even for all.
- [x] Run new tests plus `tests/mcp-authorization-ui.test.ts`, `tests/mcp-blog-authorization.test.ts`, `tests/collection-observation-permissions.test.ts`; document intentional compatibility expectation changes.
- [x] Commit only Task 1 files.

### Task 2: 动态目录、身份与整理事务

**Files:** Create `shared/organization-contracts.ts`, `packages/core/organization/catalog.ts`, `service.ts` and focused journal/plan helpers, `tests/organization-catalog.test.ts`, `tests/organization-service.test.ts`; modify `packages/core/files.ts`, `collections/service.ts`, `workspace/gate.ts`, `knowledge/core.ts` only where necessary; core bootstrap/gate integration coordinated in Task 5.

**Interfaces:** `syncDirectoryCatalog(config,db): {libraryId:string;structureRevision:string}`; `resolveDirectory(db,id)` and `directoryByPath(db,path)` return `{id,path,parentId,subtreeRevision}` or undefined. `organizationService(config,db,notes)` returns context/list/submit/history/undo/operation/cancel/recover/cleanup; methods accept Principal first, submit/undo receive `recheck?:()=>Principal`. Input action names/fields follow spec section 6 verbatim. Task 3 provides reference rewrite function; Task 5 provides startup and PluginServices adapters.

- [x] Write real temporary-library tests for empty/new top-level discovery, stable directory IDs after rename, old-path replacement isolation, ID retention, no-op, name collision and protected paths; observe RED.
- [x] Implement dynamic root discovery with safe names/types, directory identity and version reconciliation; remove category hardcodes from scanning/listening/filter validation while retaining bootstrap defaults and protected runtime containers.
- [x] Write failing task tests for create-directory, move-note, move-directory with shared assets, old requestId replay, stale versions, overlap/cycles, limits and permission denial before any write.
- [x] Implement immutable bounded plan, exclusive gate commit, persistent object journal/staging, database publication and source/asset/index updates; call Task 3 rewrite and authorize all source dependencies. Queue ownership survives HTTP disconnect. Add pending-journal reader/writer gate and recovery before catalog scans.
- [x] Write failing crash-boundary, cancel, revocation, undo-conflict and retention tests; implement recover/undo/cleanup with 30-day default, no overwrite of later changes, never clean unfinished journals.
- [x] Run `npx vitest run tests/organization-catalog.test.ts tests/organization-service.test.ts` and affected workspace/file tests; commit only Task 2 files.

### Task 3: 精确引用改写

**Files:** Create `packages/core/organization/references.ts`, `tests/organization-references.test.ts`.

**Interfaces:** Export `rewriteLibraryReferences(content:string,sourcePath:string,targetPath:string,moves:Array<{from:string;to:string}>,whiteboard?:boolean): {content:string;changed:boolean}`. `from/to` may be directory prefixes (longest exact-or-descendant match); output leaves non-reference bytes intact; unsupported ambiguous syntax fails closed with knowledge error. The organization service builds authoritative source/version coverage and calls this once per affected Markdown/whiteboard.

- [x] Write hand-checked tests for moved outgoing/incoming Markdown/image/reference links, encoded paths+query+fragment, relative attachment, code fences/inline code, external and stable IDs, whiteboard path links; observe RED.
- [x] Use existing parser/available dependency source positions and a lossless destination-span parser; preserve formatting and modify destinations only, never whole-document string replacement.
- [x] Add malformed/ambiguous reference tests that require explicit refusal, not silent success; exercise move-directory prefix boundaries and longest-match mapping.
- [x] Run `npx vitest run tests/organization-references.test.ts`; commit only Task 3 files.

### Task 4: MCP 工具、分域设置与版本

**Files:** Modify `packages/plugin-sdk/index.ts`, `packages/plugin-contracts/index.ts`, `plugins/mcp/manifest.json`, `plugins/mcp/server/contracts.ts`, `operations.ts`, `service.ts`, `agent-guidance.ts`, `index.ts`, `plugins/mcp/web/index.ts`, `apps/web` consent/authorization components as needed, `tests/mcp-agent-protocol.test.ts`, new `tests/mcp-organization.test.ts`, domain UI tests.

**Interfaces:** Add optional `PluginServices.knowledgeOrganization` with context/list/submit/history/undo/operation/cancel methods (service calls omit Principal; host supplies it), optional `permissions.context()` for caller-only effective context. New tools `get_mcp_context`, `list_directories`, `organize_library`, `list_organization_history`, `undo_organization` use these services; existing operation_status/cancel_operation dispatch new operation kinds. create_note adds optional directoryId (null means root) without breaking path-only legacy input.

- [x] Write SDK registry/schema tests for new tool discovery, all action validation, own-context only, capability refusal and unchanged read-only behavior; run RED.
- [x] Add bounded schemas/operations, recovery messages and new workflow instructions. Keep output schemas concise enough for full discovery <=65536 bytes.
- [x] Version host API to 1.2.0 and MCP to 1.2.0 with ^1.2.0 floor. Add version-2 permission config and per-domain cards/presets; todo remains unavailable; display effective client rights and one-time reauthorization on expansion.
- [x] Write real component/consent tests for independent knowledge/blog, no implicit archive/index/publish, all vs selected and old config migration. Preserve original UI work by editing only isolated checkout.
- [x] Run MCP protocol, workflow, authorization, packaged-plugin and new MCP organization tests; commit only Task 4 files.

### Task 5: 宿主接入、恢复和完整工作流

**Files:** Modify `apps/server/plugins/services.ts`, `host.ts`, `apps/server/platform/runtime.ts` and runtime creation modules, `packages/core/knowledge` bootstrap/mutations, worker startup, backup/restore identities, reads/assets/share/search integration as discovered; create `tests/mcp-organization-integration.test.ts`, `tests/organization-recovery.test.ts`.

**Interfaces:** Adapt Task 1 effective policies and Task 2 service into Task 4 ports. Live authorization callback runs at queued start and precommit. Scope and resource instance checks run on every call; source-write is required for mechanical link patches, not public blog operations. Organization pending journals block old scan/read pipelines before recovery.

- [x] Build real host+MCP SDK fixture from existing plugin-runtime support. Assert full workflow: context→empty/new directory→create note via directoryId→move/rename note and directory→read/search same IDs and corrected links→history→undo, without confirmation API.
- [x] Observe RED, integrate services and dynamic root use across indexing/catalog/collection/transfer/share, preserve index freshness and versioned snapshots. Add directoryId resolution before create_note core mutation under gate.
- [x] Add restart tests with persisted journal checkpoints and new backlink during preparation; enforce recovery and fresh graph coverage, update backup/restore to preserve or explicitly invalidate identity-bound grants.
- [x] Add end-to-end domain denial tests for knowledge-only client, v2 blog reader/publisher, unknown todo, selected grants and mixed-reference dependencies. Verify error metadata does not leak unauthorized paths or counts.
- [x] Run integration/recovery and affected auth/backup/share/worker suites; commit integration changes.

### Task 6: 回归、审阅与交付

**Files:** plan progress/evidence and necessary regression fixes only.

- [x] Run `npm run typecheck`, `npm test`, `npm run build`; isolate baseline/environment failures and fix regressions with RED→GREEN evidence.
- [x] Run relevant Playwright authorization/directory workflows using temporary data and the project e2e launcher; verify packaged MCP discovery and actual HTTP authorization.
- [x] Obtain independent whole-branch security/recovery review against spec and Review Focus; fix material findings with regression tests.
- [x] Mark plan checkboxes from real evidence; scoped commits and clean branch status; report isolated worktree path, functionality, validations and material unresolved limits. Keep original working copy intact; no merge/push/deploy without separate authorization.

## Execution decision and tracking

用户已明确授权“制定实现计划并推进开发”，不再重复要求批准同一方向。采用独立任务并行实施、父代理集成，任务共享接口以本计划为准；写入重叠文件前由父代理分配所有权。持久进展记录在此计划对应的 `.superpowers` 工作目录中，模型或上下文恢复后先读记录，不重新分配已完成工作。

## 完成验证

最终完整命令：`npm test -- --reporter=verbose --fileParallelism --maxWorkers=2`。结果：286 个套件通过、2 个按条件跳过；1,866 项测试通过、16 项跳过、零失败。`npm run typecheck` 与 `npm run build` 均退出 0。桌面和移动端分别通过 5 项 MCP 配置/授权检查及 1 项保留期持久化检查。详细边界与验收见 `docs/验收记录/2026-10-29-mcp-domain-organization.md`。
