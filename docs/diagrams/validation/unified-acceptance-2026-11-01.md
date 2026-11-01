# 统一验收命令与证据（2026-11-01 UTC）

最终结论见[验收报告](../../markdown-diagram-acceptance-2026-10-31.md)。这里记录实际执行，不包含生产迁移或部署。

## 冻结点和结果

| 范围 | 冻结运行时代码 | 结果 |
| --- | --- | --- |
| 完整 Vitest 1/2 | `091a5a3` | 225文件通过/1跳过，1683测试通过/15跳过；1115.59秒，退出0 |
| 完整 Vitest 2/2 | `091a5a3` | 224文件通过/1跳过，1774测试通过/1跳过；670.56秒，退出0 |
| 两分片并集 | 同上，无重复文件 | 451文件覆盖，3457通过/16环境跳过，0失败 |
| 最后两Vue组件修复后的相关单元 | `72781e2` | 14文件166/166，24.94秒，退出0 |
| 完整桌面应用21个spec | `72781e2` | 72/72，5.1分钟，退出0 |
| 独立Mind Elixir / PNG隐私 | 相关运行时文件未再变更 | 8/8与1/1，退出0 |
| 最终typecheck / build | `72781e2` | 均退出0 |
| 原目录回集后typecheck | 与冻结运行时字节一致 | 退出0；未构建原目录dist |

完整单元结束后追加的运行时修改只涉及 `DiagramDocumentWorkspace.vue`、`Workspace.vue`。其后的定向单元、全桌面、类型和构建均按最终源码重跑；后台核心文件未再变化。

## 工作目录和完整单元

下面命令在隔离工作树 `/home/bandoo/.codex/worktrees/markdown-diagram-documents/doo-know` 执行。两个分片使用相同文件集合；按 Vitest 确定路径哈希划分226/225个文件，交集为空、并集451。

```bash
npm test -- --shard=1/2
npm test -- --shard=2/2
npm run typecheck
npm run build
```

## 最后相关单元

```bash
npx vitest run \
  tests/diagram-document-session.test.ts \
  tests/diagram-document-read.test.ts \
  tests/diagram-history-client.test.ts \
  tests/diagram-draft-envelope.test.ts \
  tests/workspace-save-recovery.test.ts \
  tests/workspace-error-preservation.test.ts \
  tests/workspace-gate.test.ts \
  tests/web-note-drafts.test.ts \
  tests/legacy-draft-client.test.ts \
  tests/workspace-markdown-navigation.test.ts \
  tests/app-logout-session.test.ts \
  tests/trash-workspace.test.ts \
  tests/diagram-preview-artifact.test.ts \
  tests/settings-transfer-regressions.test.ts
```

## 最后桌面应用

默认应用测试共用临时 cookie 文件，同一时间只运行一个此类测试服务。所有数据均由临时 e2e-server 创建。显式只选 desktop；富文档开关仅用于本次测试环境，生产默认值未变。

```bash
VITE_DOCUMENT_EDITOR_ENABLED=1 npx tsx scripts/e2e.ts \
  tests/e2e/diagram-autosave-decision.spec.ts \
  tests/e2e/diagram-desktop-session.spec.ts \
  tests/e2e/diagram-desktop-review.spec.ts \
  tests/e2e/diagram-public-reader.spec.ts \
  tests/e2e/diagram-portability.spec.ts \
  tests/e2e/diagram-editor-offline-export.spec.ts \
  tests/e2e/diagram-history-restore.spec.ts \
  tests/e2e/whiteboard-migration.spec.ts \
  tests/e2e/legacy-draft-migration.spec.ts \
  tests/e2e/document-copy.spec.ts \
  tests/e2e/document-organization.spec.ts \
  tests/e2e/portable-owner-directory.spec.ts \
  tests/e2e/portable-native-preview.spec.ts \
  tests/e2e/folder-native-restore.spec.ts \
  tests/e2e/note-native-restore.spec.ts \
  tests/e2e/folder-trash.spec.ts \
  tests/e2e/note-history.spec.ts \
  tests/e2e/save-recovery.spec.ts \
  tests/e2e/tree-actions.spec.ts \
  tests/e2e/management-workspace.spec.ts \
  tests/e2e/whiteboards.spec.ts \
  --project desktop --output .local/markdown-diagrams/stability-delivery-desktop
```

独立适配器使用不同的 Vite cacheDir，避免优化缓存互相失效：

```bash
npx tsx scripts/e2e.ts --config playwright.diagrams.config.ts --project desktop
npx tsx scripts/e2e.ts --config playwright.png-privacy.config.ts --project desktop
```

## 日志索引

原始日志在隔离工作树 `.local/markdown-diagrams/`，不包含生产知识库副本，也未作为产品文件回集：

- `stability-final-unit-shard-{1,2}.log`：完整分片。
- `stability-delivery-unit-related.log`：最后14文件166项。
- `stability-delivery-desktop.log`：最终72项，trace只在失败时保留。
- `stability-final-mindmap-isolated.log`、`stability-final-png-retry.log`：独立8项/1项。
- `stability-delivery-{typecheck,build}.log`：最后类型与构建。
- `stability-delivery-original-typecheck.log`：原目录类型检查。
- `stability-final-verification.json`：冻结版本、分片并集和最终结果。
- `stability-source-integration.json`：增量回集历史、任务文件集合、原HEAD/暂存区摘要及保护文件核验。

## 暂时无法执行的发行门禁

15项旧平台恢复测试缺少 rc48/rc49 发行物，1项搜索运行时安装测试缺少搜索发行物。对应实际变量：

- `DOOKNOW_RECOVERY_LEGACY_ARCHIVE`：rc48原生归档。
- `DOOKNOW_RECOVERY_CANDIDATE_ARCHIVE`：候选原生归档；可配 `DOOKNOW_RECOVERY_CANDIDATE_VERSION`。
- `DOOKNOW_SEARCH_ARTIFACT`：搜索运行时发行物。

在正式发行构建环境提供真实对应材料后，运行 `tests/native-rollback-entrypoint.test.ts` 和 `tests/search-runtime-install.test.ts`。本轮未将16项跳过记作通过，未使用伪发行物替代真实跨版本验证。
