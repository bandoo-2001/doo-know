/** Additional settings runtime recipes. No recipe edits DOM or application CSS.
 * Stateful fixtures belong only to the harness's guarded /tmp fixture. Successful
 * receipts/counts/keys/previews are always produced by real APIs, never fulfilled.
 * Synthetic non-success response models are explicitly marked in `fault`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { showSidebar, closeSidebar } from '../../tests/support/settings-navigation';
import type { Scene, SceneEnv } from './model';
import { holdRouteUntilCleanup } from './lifecycle';
import type { TransferTask } from '../../shared/transfer-contracts';

const data = new WeakMap<Page, Record<string, any>>();
const store = (page: Page) => {
  let value = data.get(page);
  if (!value) {
    value = {};
    data.set(page, value);
  }
  return value;
};
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const dlg = (name: string) => (page: Page) => page.getByRole('dialog', { name, exact: true });
const tests = ['tests/e2e/settings-overlays.spec.ts', 'tests/e2e/status-settings.spec.ts'];
const scene = (
  id: string,
  sourceIds: string[],
  section: string,
  state: string,
  target: Scene['target'],
  open?: Scene['open'],
  rest: Partial<Scene> = {},
): Scene => ({
  id: 'settings-extra-' + id,
  sourceIds,
  title: state,
  state,
  role: 'owner',
  path: '/?view=settings&section=' + section,
  target,
  open,
  tests,
  ...rest,
});
const failed =
  (code: string, status = 503) =>
  async (route: Route) =>
    route.fulfill({ status, json: { error: code, code } });
const held = holdRouteUntilCleanup;
async function select(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).press('ArrowDown');
  await page.locator('.ant-select-dropdown:visible').getByText(value, { exact: true }).click();
}
async function onlyTemporary(env: SceneEnv) {
  const parent = await realpath(dirname(env.fixture.dataRoot));
  if (
    dirname(parent) !== (await realpath(tmpdir())) ||
    !basename(parent).startsWith('dooknow-browser-')
  )
    throw Error('Refusing non-isolated settings fixture');
}
async function plugin(env: SceneEnv, id: 'mcp' | 'git') {
  let registry = await env.fixture.api('/api/platform/plugins');
  let entry = registry.installed.find((p: any) => p.id === id);
  if (!entry) {
    const job = await env.fixture.api('/api/platform/plugin-installations', 'POST', {
      id,
      requestId: randomUUID(),
    });
    await expect
      .poll(
        async () => (await env.fixture.api('/api/platform/plugin-installations/' + job.id)).status,
        { timeout: 90_000, intervals: [250, 500, 1000] },
      )
      .toBe('succeeded');
    registry = await env.fixture.api('/api/platform/plugins');
    entry = registry.installed.find((p: any) => p.id === id);
  }
  if (!entry) throw Error('Isolated plugin installation did not expose plugin');
  const values =
    id === 'mcp'
      ? { oauthEnabled: true, apiKeyEnabled: true }
      : { authorName: 'Capture Fixture', authorEmail: 'capture@example.invalid' };
  await env.fixture.api('/api/platform/plugins/' + id + '/config', 'PUT', {
    configVersion: entry.configVersion,
    values,
  });
  if (entry.state !== 'enabled')
    await env.fixture.api('/api/platform/plugins/' + id + '/enable', 'POST', {});
}
async function config(page: Page, id: 'mcp' | 'git') {
  await page
    .locator('.plugin-card')
    .filter({ hasText: id === 'mcp' ? 'MCP 服务' : 'Git 版本管理' })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect(page.locator('.plugin-settings')).toBeVisible();
  await closeSidebar(page);
}
async function mcp(env: SceneEnv) {
  await config(env.page, 'mcp');
}
async function apiGuide(env: SceneEnv) {
  await mcp(env);
  await btn(env.page, 'API Key 接入').click();
}
async function apiClient(env: SceneEnv) {
  await plugin(env, 'mcp');
  const inventory = await env.fixture.api('/api/platform/mcp/permissions');
  const name = '隔离客户端-' + randomUUID();
  const result = await env.fixture.api('/api/platform/mcp/api-clients', 'POST', {
    name,
    permissionPolicy: inventory.policy,
    expiresAt: null,
  });
  // The real one-time credential is deliberately discarded, never logged/stored.
  store(env.page).client = result.client;
}
const clientRow = (page: Page) =>
  page.getByRole('article', { name: store(page).client.name, exact: true });
async function editClient(env: SceneEnv, label: string) {
  await apiGuide(env);
  await clientRow(env.page).getByRole('button', { name: label, exact: true }).click();
}
async function importStep(env: SceneEnv, review = false) {
  const page = env.page;
  await btn(page, '批量导入').click();
  const window = dlg('批量导入')(page);
  await window.getByLabel('选择文件', { exact: true }).setInputFiles({
    name: 'capture-' + randomUUID() + '.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 隔离导入\n'),
  });
  await window.getByRole('button', { name: '预览导入', exact: true }).click();
  await expect(window.getByRole('heading', { name: '检查导入预览', exact: true })).toBeVisible();
  if (review) await window.getByRole('button', { name: '下一步：确认导入', exact: true }).click();
}
async function uploadReview(env: SceneEnv) {
  await btn(env.page, '从备份恢复').click();
  const window = dlg('从备份恢复')(env.page);
  const key = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  await window.getByLabel('加密备份（最多 128 MiB）', { exact: true }).setInputFiles({
    name: 'invalid-' + randomUUID() + '.dkb',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('invalid disposable fixture backup'),
  });
  await window.getByLabel('恢复私钥（最多 16 KiB）', { exact: true }).setInputFiles({
    name: 'disposable-' + randomUUID() + '.pem',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(key),
  });
  await window.getByRole('button', { name: '下一步：确认恢复', exact: true }).click();
}
async function settled(env: SceneEnv, id: string) {
  let task: any;
  await expect
    .poll(
      async () => {
        task = await env.fixture.api('/api/manage/tasks/' + id);
        return task.state;
      },
      { timeout: 90_000, intervals: [100, 250, 500, 1000] },
    )
    .toBe('succeeded');
  return task;
}
async function backup(env: SceneEnv) {
  const task = await settled(
    env,
    (await env.fixture.api('/api/manage/backups', 'POST', { requestId: randomUUID() })).id,
  );
  store(env.page).backupId = task.result.backupId;
}
async function openBackup(env: SceneEnv) {
  const card = env.page
    .locator('.settings-card')
    .filter({ has: env.page.getByRole('heading', { name: '加密备份', exact: true }) });
  const row = card.locator('li').filter({ hasText: store(env.page).backupId });
  await row.getByRole('button', { name: '恢复到独立副本', exact: true }).click();
}
async function connection(env: SceneEnv) {
  await env.page
    .getByRole('region', { name: '云端同步面板', exact: true })
    .getByRole('button', { name: /^(管理同步|关联云端仓库)$/ })
    .click();
}
async function credential(env: SceneEnv) {
  await connection(env);
  await btn(env.page, '添加凭据').click();
}
async function gitReady(env: SceneEnv) {
  await plugin(env, 'git');
  const call = async (kind: string, id: string, input: unknown = {}) => {
    let result: any;
    // Retry only the backend's explicit, definite workspace-gate refusal.
    // Initialization input (including requestId) stays unchanged across retries.
    await expect
      .poll(
        async () => {
          try {
            result = await env.fixture.api('/api/plugins/git/call', 'POST', { kind, id, input });
            return 'readable';
          } catch (error) {
            if (/returned 503 code=WORKSPACE_BUSY$/.test(String((error as Error).message)))
              return 'busy';
            throw error;
          }
        },
        { timeout: 30000, intervals: [250, 500, 1000] },
      )
      .toBe('readable');
    return result;
  };
  if ((await call('provider', 'git.status')).repository === 'missing')
    await call('command', 'git.initialize', { requestId: randomUUID() });
  await env.fixture.api('/api/notes', 'POST', {
    folderPath: '00-Inbox',
    fileName: 'git-capture-' + randomUUID() + '.md',
    content: '# Synthetic capture change\n',
    requestId: randomUUID(),
  });
  await call('provider', 'git.status');
}
async function commitPanel(env: SceneEnv) {
  await showSidebar(env.page);
  await btn(env.page, '提交全部变更').click();
  await expect(env.page.getByRole('textbox', { name: 'Git 提交说明', exact: true })).toBeVisible();
}
async function previewPanel(env: SceneEnv) {
  await commitPanel(env);
  await env.page
    .getByRole('textbox', { name: 'Git 提交说明', exact: true })
    .fill('隔离预览-' + randomUUID());
  await btn(env.page, '预览全部变更').click();
  await expect(env.page.locator('.git-preview')).toBeVisible();
}
async function nativeReview(env: SceneEnv) {
  await btn(env.page, '预览提交并推送').click();
  await env.page
    .getByRole('textbox', { name: '云端同步提交说明', exact: true })
    .fill('隔离同步预览-' + randomUUID());
  const response = env.page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === '/api/plugins/git/call' &&
      reply.request().method() === 'POST' &&
      reply.request().postDataJSON()?.id === 'git.preview',
    { timeout: 20000 },
  );
  await btn(env.page, '预览本次提交').click();
  const reply = await response;
  if (!reply.ok()) {
    const error = await reply.json();
    throw Error(
      `Real Git preview rejected: ${reply.status()} code=${error.code ?? error.error ?? 'unknown'}`,
    );
  }
  await expect(env.page.locator('.commit-preview')).toBeVisible();
}
// Native cloud review requires a connection, but never contacts the fake remote.
async function fakeRemote(env: SceneEnv) {
  await gitReady(env);
  const status = await env.fixture.api('/api/platform/git/status');
  await env.page.route('**/api/platform/git/status', (route) =>
    route.fulfill({
      json: {
        ...status,
        connection: {
          url: 'https://github.com/example/capture-' + randomUUID() + '.git',
          host: 'github.com',
          branch: status.branch || 'main',
          remoteName: 'capture',
          credentialId: null,
          credentialAvailable: true,
          lastCheckedAt: null,
          remoteHead: null,
          remoteExists: false,
          ahead: null,
          behind: null,
          writeVerified: false,
        },
      },
    }),
  );
}
async function conflictModel(env: SceneEnv) {
  const item = {
    id: randomUUID(),
    noteId: env.fixture.noteId,
    kind: 'save',
    status: 'needs_reconciliation',
    relativePath: '00-Inbox/capture-' + randomUUID() + '.md',
    resolvable: true,
    disk: {
      modifiedAt: String(Date.now()),
      contentHash: createHash('sha256').update(env.fixture.noteContent).digest('hex'),
      sizeBytes: Buffer.byteLength(env.fixture.noteContent),
    },
  };
  store(env.page).conflict = item;
  await env.page.route('**/api/maintenance/conflicts', (route) =>
    route.fulfill({ json: { items: [item], syncConflicts: [], organizationConflicts: [] } }),
  );
}
async function openMaintenance(page: Page) {
  const summary = page
    .locator('details.settings-card > summary')
    .filter({ hasText: /^异常写入恢复$/ });
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click();
  await expect(page.locator('.maintenance-settings')).toBeVisible();
}
async function inspectConflict(env: SceneEnv) {
  await openMaintenance(env.page);
  await btn(env.page, '核对磁盘版本').click();
  await expect(env.page.getByText('采用当前磁盘版本？', { exact: true })).toBeVisible();
}
async function oauthModel(env: SceneEnv) {
  await plugin(env, 'mcp');
  const policy = (await env.fixture.api('/api/platform/mcp/permissions')).policy;
  const current = await env.fixture.api('/api/platform/mcp/connection');
  const client = {
    clientId: randomUUID(),
    active: true,
    permissionPolicy: policy,
    effectivePolicy: policy,
    grantVersion: 1,
    scopes: ['knowledge:read'],
    allowedPrefixes: ['00-Inbox'],
    effectiveScopes: ['knowledge:read'],
    effectivePrefixes: ['00-Inbox'],
  };
  store(env.page).oauthClient = client;
  await env.page.route('**/api/platform/mcp/connection', (route) =>
    route.fulfill({ json: { ...current, clients: [client] } }),
  );
}
async function oauthRow(env: SceneEnv) {
  await mcp(env);
  return env.page
    .locator('.guide-client')
    .filter({ hasText: store(env.page).oauthClient.clientId });
}
async function failedTasks(env: SceneEnv) {
  const id = randomUUID();
  store(env.page).taskId = id;
  const task: TransferTask = {
    id,
    kind: 'import',
    state: 'failed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancellable: false,
    progress: { completed: 0, total: 1, phase: 'failed' },
    downloadAvailable: false,
    error: '隔离故障：目标已变化，尚未导入。',
    items: [
      {
        path: 'failure-' + randomUUID() + '.md',
        targetPath: '00-Inbox/failure.md',
        kind: 'note',
        state: 'failed',
        error: '隔离故障：不覆盖竞争写入。',
      },
    ],
  };
  await env.page.route('**/api/manage/tasks', (route) =>
    route.fulfill({ json: { items: [task] } }),
  );
}

export const settingsScenes: Scene[] = [
  scene(
    'library-read-error',
    ['ST-012', 'ST-002'],
    'library',
    'Library overview real error renderer',
    page => page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: '当前知识库', exact: true }) }).locator('.ant-alert-error'),
    async ({ page }) => {
      const error = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: '当前知识库', exact: true }) }).locator('.ant-alert-error');
      await expect(error).toContainText('SOURCE_UNAVAILABLE'); await expect(error).toBeVisible(); await error.scrollIntoViewIfNeeded();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/overview', failed('SOURCE_UNAVAILABLE'));
      },
      fault: 'Overview 503 only; other library sections retain real API results.',
      importantStates: { 'ST-012': ['错误alert'], 'ST-002': ['分区独立读取失败'] },
    },
  ),
  scene(
    'library-reading',
    ['ST-012'],
    'library',
    'Library overview request pending',
    '.settings-workspace',
    async ({ page }) => {
      await expect(page.getByText('正在读取知识库信息…', { exact: true })).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/overview', held);
      },
      readiness: 'target',
      fault: 'Overview read held pending.',
      importantStates: { 'ST-012': ['正在读取'] },
    },
  ),
  scene(
    'share-revoke-confirm',
    ['ST-017'],
    'library',
    'Real fixture share revoke confirmation',
    '.ant-popconfirm:visible',
    async ({ page }) => {
      await page
        .locator('.settings-card')
        .filter({ has: page.getByRole('heading', { name: '共享链接', exact: true }) })
        .getByRole('button', { name: '撤销', exact: true })
        .first()
        .click();
    },
    { window: true, tests: ['tests/e2e/management-features.spec.ts'] },
  ),
  scene(
    'share-revoke-error',
    ['ST-017', 'ST-016'],
    'library',
    'Revoke fails without removing fixture share',
    '.settings-workspace',
    async ({ page }) => {
      await page.getByRole('button', { name: '撤销', exact: true }).first().click();
      await page
        .locator('.ant-popconfirm:visible')
        .getByRole('button', { name: '撤销链接', exact: true })
        .click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'CAPTURE_REVOKE_FAILURE' }),
      ).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/shares/revoke', failed('CAPTURE_REVOKE_FAILURE', 503));
      },
      fault: 'Share revoke rejected before mutation.',
      importantStates: { 'ST-017': ['逐项失败/请求错误'] },
    },
  ),
  scene(
    'import-preview-error',
    ['ST-021'],
    'library',
    'Real import preview rejected with files retained',
    dlg('批量导入'),
    async (env) => {
      await btn(env.page, '批量导入').click();
      const w = dlg('批量导入')(env.page);
      await w.getByLabel('选择文件', { exact: true }).setInputFiles({
        name: 'fixture-' + randomUUID() + '.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Fixture\n'),
      });
      await w.getByRole('button', { name: '预览导入', exact: true }).click();
      await expect(w.getByRole('alert')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/import/preview', failed('IMPORT_PREVIEW_STALE', 409));
      },
      window: true,
      fault: 'Preview endpoint returns409, no import POST.',
      importantStates: { 'ST-021': ['文件验证/路径验证/目录读取/提交错误'] },
    },
  ),
  scene(
    'import-submit-busy',
    ['ST-020', 'ST-089'],
    'library',
    'Import submission held and close guarded',
    dlg('批量导入'),
    async (env) => {
      await importStep(env, true);
      await dlg('批量导入')(env.page)
        .getByRole('button', { name: '确认导入 1 个文件', exact: true })
        .click();
      await expect(dlg('批量导入')(env.page)).toHaveAttribute('aria-busy', 'true');
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/import', held);
      },
      window: true,
      fault: 'Import POST held before write.',
      importantStates: { 'ST-020': ['提交中锁输入及关闭'], 'ST-089': ['busy禁止关闭与确认'] },
      representative: true,
    },
  ),
  scene(
    'portable-real-result',
    ['ST-023', 'ST-028'],
    'library',
    'Actual isolated portable directory import result',
    dlg('导入便携包'),
    async (env) => {
      await onlyTemporary(env);
      const directory = resolve(env.fixture.dataRoot, 'capture-package-' + randomUUID());
      await mkdir(resolve(directory, 'notes'), { recursive: true });
      const content = '# 隔离便携导入\n';
      await writeFile(resolve(directory, 'notes/capture.md'), content);
      await writeFile(
        resolve(directory, 'dooknow-portable.json'),
        JSON.stringify({
          format: 'dooknow-portable',
          version: 1,
          files: [
            {
              path: 'notes/capture.md',
              kind: 'document',
              sizeBytes: Buffer.byteLength(content),
              sha256: createHash('sha256').update(content).digest('hex'),
            },
          ],
          selected: ['notes/capture.md'],
        }),
      );
      await btn(env.page, '导入便携包').click();
      await env.page.locator('#portable-directory').setInputFiles(directory);
      await env.page.locator('#portable-archive-folder').fill('00-Inbox/capture-' + randomUUID());
      await btn(env.page, '导入整包').click();
      await expect(
        dlg('导入便携包')(env.page).getByRole('status').filter({ hasText: '导入完成' }),
      ).toBeVisible();
      await expect(btn(env.page, '导入整包')).toBeDisabled();
    },
    {
      window: true,
      importantStates: { 'ST-023': ['完成笔记数/附件数/路径列表', '导入完成后禁用再次提交'] },
      tests: ['tests/e2e/portable-owner-directory.spec.ts'],
    },
  ),
  scene(
    'portable-source-resume',
    ['ST-023', 'ST-028'],
    'library',
    'Interrupted source-resume form',
    dlg('导入便携包'),
    async ({ page }) => {
      await page.getByRole('button', { name: '选择原资料继续', exact: true }).click();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/portable-jobs', (route) =>
          route.fulfill({
            json: [
              {
                id: randomUUID(),
                requestId: randomUUID(),
                kind: 'import-directory',
                state: 'interrupted',
                updatedAt: Date.now(),
                needsSource: true,
                folderPath: '00-Inbox/capture-' + randomUUID(),
                error: '隔离中断：请选择原始完整资料。',
              },
            ],
          }),
        );
      },
      window: true,
      fault: 'Synthetic interrupted portable job, no successful counts/results.',
      importantStates: { 'ST-023': ['缺原资料需重选'], 'ST-028': ['需要原资料'] },
    },
  ),
  scene(
    'task-failed-items',
    ['ST-026', 'ST-025'],
    'status',
    'Failed task and real item error renderer',
    '.transfer-tasks',
    async ({ page }) => {
      await page.getByText('逐项结果（1）', { exact: true }).click();
      await page.getByText('此项目失败的详细原因', { exact: true }).click();
    },
    {
      before: failedTasks,
      fault: 'Synthetic failed task response, completed=0; no business success fabricated.',
      importantStates: { 'ST-026': ['任务级失败', '错误详情'] },
    },
  ),
  scene(
    'task-retry-busy',
    ['ST-026'],
    'status',
    'Failed task retry pending',
    '.transfer-tasks',
    async ({ page }) => {
      await page.getByRole('button', { name: '重试未完成项目', exact: true }).click();
    },
    {
      before: async (env) => {
        await failedTasks(env);
        await env.page.route('**/api/manage/tasks/*/retry', held);
      },
      fault: 'Failed task model; retry held before mutation.',
      importantStates: { 'ST-026': ['重试请求busy'] },
    },
  ),
  scene(
    'restore-record-review',
    ['ST-031'],
    'backup',
    'Actual encrypted backup independent-restore review',
    dlg('恢复到独立副本'),
    openBackup,
    {
      before: backup,
      window: true,
      importantStates: { 'ST-031': ['恢复摘要', '新空目录与校验说明', '服务继续运行'] },
      tests: ['tests/e2e/management-features.spec.ts'],
    },
  ),
  scene(
    'restore-verified',
    ['ST-027', 'ST-004'],
    'backup',
    'Actual completed independent restore verification receipt',
    '.transfer-tasks',
    async (env) => {
      const task = await env.fixture.api('/api/manage/restores', 'POST', {
        backupId: store(env.page).backupId,
        requestId: randomUUID(),
      });
      const done = await settled(env, task.id);
      if (!done.result?.verification?.verified) throw Error('No real verification receipt');
      await env.page.reload();
      await closeSidebar(env.page);
      const row = env.page.locator('.transfer-tasks li').filter({ hasText: task.id }).first();
      await expect(row.getByText('独立副本已恢复并通过校验', { exact: true })).toBeVisible();
      await row.getByText('恢复副本位置与校验回执', { exact: true }).click();
    },
    {
      before: backup,
      importantStates: {
        'ST-027': [
          '校验成功alert',
          '笔记/附件数',
          '部署切换guidance',
          '副本已撤旧会话/共享及停用插件说明',
        ],
      },
      tests: ['tests/e2e/management-features.spec.ts'],
    },
  ),
  scene(
    'restore-upload-review',
    ['ST-033'],
    'backup',
    'Upload restore review with disposable files',
    dlg('从备份恢复'),
    uploadReview,
    { window: true, importantStates: { 'ST-033': ['摘要'] } },
  ),
  scene(
    'restore-upload-rejected',
    ['ST-033', 'ST-032'],
    'backup',
    'Actual invalid encrypted backup rejection retains selected files',
    dlg('从备份恢复'),
    async (env) => {
      await uploadReview(env);
      await btn(env.page, '上传并恢复独立副本').click();
      await expect(dlg('从备份恢复')(env.page).getByRole('alert')).toBeVisible();
    },
    {
      window: true,
      importantStates: { 'ST-033': ['摘要'], 'ST-032': ['保留文件选择以重试'] },
      verify: async ({ page }) => {
        const before = await page
          .locator('#restore-backup-file')
          .evaluate((el: HTMLInputElement) => el.files?.[0]?.name);
        await btn(page, '上一步').click();
        expect(
          await page
            .locator('#restore-backup-file')
            .evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
        ).toBe(before);
        return { selectedFileRetained: !!before, requestIdReuse: 'not-probed' };
      },
    },
  ),
  scene(
    'disk-confirm',
    ['ST-035'],
    'backup',
    'Disk conflict confirmation only',
    '.dialog-card:visible',
    inspectConflict,
    {
      before: conflictModel,
      window: true,
      fault:
        'Synthetic unresolved conflict read model bound to real fixture note; no resolution performed.',
      importantStates: { 'ST-035': ['确认当前磁盘快照'] },
    },
  ),
  scene(
    'disk-conflict-409',
    ['ST-036', 'ST-035'],
    'backup',
    'Disk snapshot changed rejection',
    '.dialog-card:visible',
    async (env) => {
      await inspectConflict(env);
      await btn(env.page, '采用磁盘版本').click();
      await expect(
        env.page.getByRole('alert').filter({ hasText: '磁盘版本或操作状态已变化' }),
      ).toBeVisible();
    },
    {
      before: async (env) => {
        await conflictModel(env);
        await env.page.route(
          '**/api/maintenance/conflicts/*/resolve',
          failed('VERSION_CONFLICT', 409),
        );
      },
      window: true,
      fault: 'Synthetic unresolved conflict; resolve409 before mutation.',
      importantStates: {
        'ST-036': ['磁盘版本/操作状态变化', '现场材料保持不变'],
        'ST-035': ['409现场已变ST-036'],
      },
    },
  ),
  ...(
    [
      'downloading',
      'verifying',
      'creating_venv',
      'installing',
      'validating_model',
      'starting',
    ] as const
  ).map((phase) =>
    scene(
      'search-' + phase,
      ['ST-039'],
      'search',
      'Injected unfinished search preparation: ' + phase,
      '.search-runtime-settings',
      async ({ page }) => {
        await expect(page.locator('.runtime-task')).toBeVisible();
      },
      {
        before: async ({ page }) => {
          await page.route('**/api/platform/search-runtime', (route) =>
            route.fulfill({
              json: {
                components: { tokenizerReady: false, vectorReady: false },
                distributionAvailable: true,
                externallyManaged: false,
                task: {
                  id: randomUUID(),
                  state: 'running',
                  phase,
                  completedBytes: 1048576,
                  totalBytes: 4194304,
                },
              },
            }),
          );
        },
        fault: 'Synthetic running search preparation model; no component success claimed.',
        importantStates: phase === 'downloading' ? { 'ST-039': ['下载MiB及progress'] } : undefined,
      },
    ),
  ),
  ...(['failed', 'interrupted', 'cancelled'] as const).map((phase) =>
    scene(
      'search-' + phase,
      ['ST-040'],
      'search',
      'Injected search preparation ' + phase,
      '.search-runtime-settings',
      async ({ page }) => {
        await expect(page.locator('.runtime-task')).toBeVisible();
      },
      {
        before: async ({ page }) => {
          await page.route('**/api/platform/search-runtime', (route) =>
            route.fulfill({
              json: {
                components: { tokenizerReady: false, vectorReady: false },
                distributionAvailable: true,
                externallyManaged: false,
                task: {
                  id: randomUUID(),
                  state: phase,
                  phase,
                  error:
                    phase === 'failed'
                      ? 'PROCESS_CONTAINMENT_UNAVAILABLE'
                      : phase === 'cancelled'
                        ? 'PREPARATION_CANCELLED'
                        : 'PREPARATION_INTERRUPTED',
                },
              },
            }),
          );
        },
        fault: 'Synthetic non-success search task; no download/installation performed.',
        importantStates:
          phase === 'failed' ? { 'ST-040': ['PROCESS_CONTAINMENT_UNAVAILABLE说明'] } : undefined,
      },
    ),
  ),
  ...(['single', 'others'] as const).map((kind) =>
    scene(
      'session-confirm-' + kind,
      [kind === 'single' ? 'ST-045' : 'ST-046'],
      'account',
      'Session revoke confirmation ' + kind,
      '.ant-popconfirm:visible',
      async ({ page }) => {
        await btn(page, kind === 'single' ? '退出设备' : '退出其他设备')
          .first()
          .click();
      },
      {
        before: async ({ page }) => {
          await page.route('**/api/manage/sessions', (route) =>
            route.fulfill({
              json: {
                items: [
                  {
                    id: randomUUID(),
                    device: 'Synthetic other device ' + randomUUID(),
                    current: false,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                  },
                ],
              },
            }),
          );
        },
        fault: 'Synthetic other-session read model; no session revoked.',
        window: true,
      },
    ),
  ),
  scene(
    'plugin-config-conflict',
    ['ST-051', 'ST-049'],
    'plugins',
    'Real CAS conflict preserves unsaved plugin draft',
    '.plugin-settings',
    async (env) => {
      await mcp(env);
      await env.page.getByRole('switch', { name: '启用 API Key 连接', exact: true }).click();
      const r = await env.fixture.api('/api/platform/plugins');
      const p = r.installed.find((x: any) => x.id === 'mcp');
      await env.fixture.api('/api/platform/plugins/mcp/config', 'PUT', {
        configVersion: p.configVersion,
        values: { oauthEnabled: !p.config.oauthEnabled },
      });
      await btn(env.page, '刷新插件状态').click();
      await expect(btn(env.page, '保存插件配置')).toBeDisabled();
      await expect(
        env.page.getByText('已保存配置在其他位置发生变化', { exact: true }),
      ).toBeVisible();
    },
    {
      before: (env) => plugin(env, 'mcp'),
      importantStates: { 'ST-051': ['输入保留但禁保存/启用'], 'ST-049': ['配置版本冲突'] },
      tests: ['tests/e2e/plugin-config.spec.ts'],
    },
  ),
  scene(
    'plugin-reload-confirm',
    ['ST-052', 'ST-051'],
    'plugins',
    'Plugin draft discard and reload popconfirm',
    '.ant-popconfirm:visible',
    async (env) => {
      await mcp(env);
      await env.page.getByRole('switch', { name: '启用 API Key 连接', exact: true }).click();
      const r = await env.fixture.api('/api/platform/plugins');
      const p = r.installed.find((x: any) => x.id === 'mcp');
      await env.fixture.api('/api/platform/plugins/mcp/config', 'PUT', {
        configVersion: p.configVersion,
        values: { oauthEnabled: !p.config.oauthEnabled },
      });
      await btn(env.page, '刷新插件状态').click();
      await btn(env.page, '重新载入已保存配置').click();
    },
    {
      before: (env) => plugin(env, 'mcp'),
      window: true,
      importantStates: { 'ST-052': ['远端冲突警告上下文'] },
      tests: ['tests/e2e/plugin-config.spec.ts'],
    },
  ),
  scene(
    'plugin-install-reconciliation',
    ['ST-054'],
    'plugins',
    'Interrupted installation receipt requiring reconciliation',
    '.plugin-manager',
    async ({ page }) => {
      await expect(page.getByText(/结果待核对，请刷新安装状态后重试/)).toBeVisible();
    },
    {
      before: async (env) => {
        await plugin(env, 'mcp');
        await env.page.route('**/api/platform/plugin-installations', (route) =>
          route.fulfill({
            json: {
              items: [
                {
                  id: randomUUID(),
                  pluginId: 'mcp',
                  version: '2.0.0',
                  requestId: randomUUID(),
                  status: 'needs_reconciliation',
                  phase: 'verifying',
                  error: 'PLUGIN_INSTALL_INTERRUPTED',
                },
              ],
            },
          }),
        );
      },
      fault: 'Synthetic unresolved installation receipt; no install success fabricated.',
    },
  ),
  scene(
    'plugin-ui-load-failed',
    ['ST-055'],
    'plugins',
    'Actual failed plugin resource load renderer',
    '.plugin-settings',
    async (env) => {
      await mcp(env);
      await expect(
        env.page.getByRole('alert').filter({ hasText: '插件界面暂时无法加载' }),
      ).toBeVisible();
    },
    {
      before: async (env) => {
        await plugin(env, 'mcp');
        const registry = await env.fixture.api('/api/platform/plugins');
        const webUrl = registry.installed.find((entry: any) => entry.id === 'mcp')?.webUrl;
        if (!webUrl) throw Error('Real enabled MCP plugin has no web entry URL');
        const entryURL = new URL(webUrl, env.fixture.origin);
        await env.page.route(
          (url) => url.origin === entryURL.origin && url.pathname === entryURL.pathname,
          (route) => route.abort('failed'),
        );
      },
      fault: 'Abort only real MCP plugin JavaScript resource; actual host error renderer.',
      importantStates: { 'ST-055': ['pluginUIErrors错误'] },
    },
  ),
  scene(
    'oauth-narrow-form',
    ['ST-060'],
    'plugins',
    'OAuth narrowing form under original grant ceiling',
    '.client-permissions',
    async (env) => {
      const row = await oauthRow(env);
      await row.getByRole('button', { name: '收窄连接权限', exact: true }).click();
    },
    {
      before: oauthModel,
      fault:
        'Synthetic active grant response using actual fixture permission inventory; no OAuth success claimed.',
      importantStates: { 'ST-060': ['域/操作/资源编辑'] },
      tests: ['tests/mcp-authorization-ui.test.ts'],
    },
  ),
  scene(
    'oauth-revoke-confirm',
    ['ST-061'],
    'plugins',
    'OAuth inline revoke confirmation',
    '.guide-client',
    async (env) => {
      const row = await oauthRow(env);
      await row.getByRole('button', { name: '撤销此连接授权', exact: true }).click();
    },
    {
      before: oauthModel,
      fault: 'Synthetic active grant response; no revoke submitted.',
      importantStates: { 'ST-061': ['不可继续原授权说明'] },
    },
  ),
  scene(
    'mcp-resource-tree',
    ['ST-063'],
    'plugins',
    'Actual permission resource-tree popup',
    '.knowledge-resource-tree-popup:visible',
    async (env) => {
      await mcp(env);
      await select(env.page, '知识库资源范围', '指定目录/笔记');
      await env.page.getByRole('combobox', { name: '选择知识库资源', exact: true }).click();
    },
    {
      before: (env) => plugin(env, 'mcp'),
      window: true,
      tests: ['tests/e2e/plugin-config.spec.ts'],
      representative: true,
    },
  ),
  ...(
    [
      ['rename', '修改名称', 'ST-066', '修改客户端名称'],
      ['permissions', '编辑权限', 'ST-067', '编辑客户端权限'],
      ['rotate', '轮换密钥', 'ST-068', '轮换 API Key'],
    ] as const
  ).map(([id, label, source, title]) =>
    scene(
      'client-' + id,
      [source],
      'plugins',
      'Actual API client ' + id + ' form',
      (page) => page.getByRole('form', { name: title, exact: true }),
      (env) => editClient(env, label),
      { before: apiClient, tests: ['tests/e2e/mcp-api-clients.spec.ts'] },
    ),
  ),
  scene(
    'client-reauthorize',
    ['ST-069'],
    'plugins',
    'Invalidated fixture identity reauthorization form',
    (page) => page.getByRole('form', { name: '重新授权并签发', exact: true }),
    async (env) => {
      await editClient(env, '重新授权并签发');
    },
    {
      before: async (env) => {
        await apiClient(env);
        const client = store(env.page).client;
        await env.page.route('**/api/platform/mcp/api-clients', async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          json.items = json.items.map((c: any) =>
            c.clientId === client.clientId ? { ...c, status: 'requires_reauthorization' } : c,
          );
          await route.fulfill({ response, json });
        });
      },
      fault:
        'Only selected real fixture client read status changed to requires_reauthorization; no successful reissue fabricated.',
      importantStates: undefined,
    },
  ),
  scene(
    'client-one-time-key',
    ['ST-070'],
    'plugins',
    'Real newly issued one-time key, shared screenshot mask applies',
    (page) => page.getByRole('region', { name: '一次性 API Key', exact: true }),
    async (env) => {
      await apiGuide(env);
      await btn(env.page, '创建 API 客户端').click();
      await env.page
        .getByRole('textbox', { name: '客户端名称', exact: true })
        .fill('capture-' + randomUUID());
      await btn(env.page, '创建并签发密钥').click();
      await expect(env.page.getByLabel('新 API Key', { exact: true })).toBeVisible();
      await expect(btn(env.page, '创建 API 客户端')).toBeDisabled();
    },
    {
      before: (env) => plugin(env, 'mcp'),
      importantStates: { 'ST-070': ['尚未关闭密钥时阻止新表单/签发'] },
      afterCapture: async ({ page }) => {
        await btn(page, '已保存，关闭密钥').click();
        await expect(page.getByLabel('新 API Key', { exact: true })).toHaveCount(0);
        return { secretDisplayCleared: true };
      },
      tests: ['tests/e2e/mcp-api-clients.spec.ts'],
    },
  ),
  scene(
    'client-cas-conflict',
    ['ST-071', 'ST-066'],
    'plugins',
    'Real API client rename CAS conflict retains draft',
    '.api-clients',
    async (env) => {
      await editClient(env, '修改名称');
      await env.page
        .getByRole('textbox', { name: '客户端名称', exact: true })
        .fill('保留草稿-' + randomUUID());
      const c = store(env.page).client;
      await env.fixture.api('/api/platform/mcp/api-clients/' + c.clientId, 'PATCH', {
        name: '远端改名-' + randomUUID(),
        expectedVersion: c.version,
      });
      await btn(env.page, '保存客户端名称').click();
      await expect(
        env.page.getByText('客户端或授权已经变化，当前输入已保留。请重新载入后检查并保存。', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(btn(env.page, '保存客户端名称')).toBeDisabled();
    },
    {
      before: apiClient,
      importantStates: {
        'ST-071': ['409客户端/授权变化，草稿保留并禁提交'],
        'ST-066': ['409版本冲突输入保留'],
      },
      tests: ['tests/e2e/mcp-api-clients.spec.ts'],
    },
  ),
  scene(
    'client-revoke-confirm',
    ['ST-072'],
    'plugins',
    'API connection inline revoke confirmation',
    '.api-clients',
    async (env) => {
      await apiGuide(env);
      await clientRow(env.page).getByRole('button', { name: '撤销 API 连接', exact: true }).click();
    },
    { before: apiClient, tests: ['tests/e2e/mcp-api-clients.spec.ts'] },
  ),
  scene(
    'ssh-trust',
    ['ST-077'],
    'library',
    'SSH credential trust must be explicit',
    dlg('添加凭据'),
    async (env) => {
      await credential(env);
      await env.page.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('ssh');
      await env.page
        .getByRole('textbox', { name: '凭据名称', exact: true })
        .fill('synthetic-' + randomUUID());
      await expect(btn(env.page, '保存仓库凭据')).toBeDisabled();
    },
    {
      window: true,
      importantStates: { 'ST-077': ['信任未勾选禁保存'] },
      tests: ['tests/git-remote-ui.test.ts'],
    },
  ),
  scene(
    'git-native-review',
    ['ST-078'],
    'library',
    'Native commit review using real Git preview without network',
    dlg('确认本次提交内容'),
    nativeReview,
    {
      before: fakeRemote,
      window: true,
      fault:
        'Cloud connection read model only; preview itself uses real isolated Git; no remote operation or success fabricated.',
      importantStates: { 'ST-078': ['预览文件列表/diff'] },
      tests: ['tests/git-remote-ui.test.ts'],
    },
  ),
  scene(
    'git-native-unknown',
    ['ST-079'],
    'library',
    'Native commit request lost before write locks review',
    dlg('确认本次提交内容'),
    async (env) => {
      await nativeReview(env);
      await env.page.route('**/api/plugins/git/call', async (route) => {
        if (route.request().postDataJSON()?.id === 'git.commit') await route.abort('failed');
        else await route.continue();
      });
      await btn(env.page, '确认提交并推送').click();
      await expect(btn(env.page, '核对提交结果')).toBeVisible();
      await expect(dlg('确认本次提交内容')(env.page)).toHaveAttribute('aria-busy', 'true');
    },
    {
      before: fakeRemote,
      window: true,
      fault: 'Connection read model + abort git.commit before server; no commit created.',
      importantStates: { 'ST-079': ['commitUnknown锁关闭与危险变更'] },
    },
  ),
  scene(
    'git-auth-failed-task',
    ['ST-080'],
    'library',
    'Git rejected authentication task and retry renderer',
    '.git-remote-panel',
    async ({ page }) => {
      await btn(page, '刷新任务状态').click();
      await expect(
        page.getByRole('alert').filter({ hasText: '认证失败，请检查令牌或 SSH 密钥。' }),
      ).toBeVisible();
    },
    {
      before: async (env) => {
        const status = await env.fixture.api('/api/platform/git/status');
        const job = {
          id: randomUUID(),
          requestId: randomUUID(),
          kind: 'test',
          status: 'failed',
          phase: 'testing_connection',
          error: 'GIT_AUTH_FAILED',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await env.page.route('**/api/platform/git/status', (route) =>
          route.fulfill({ json: { ...status, jobs: [job] } }),
        );
        await env.page.route('**/api/platform/git/jobs/' + job.id, (route) =>
          route.fulfill({ json: job }),
        );
      },
      fault: 'Synthetic failed auth task only; no remote request.',
      importantStates: { 'ST-080': ['连接认证失败/权限拒绝/受保护分支'] },
    },
  ),
  scene(
    'git-import-owner',
    ['ST-081'],
    'library',
    'Real GitRepositoryImport in owner setup host after guarded initial workspace',
    '.setup-page',
    async (env) => {
      const status = await env.fixture.api('/api/platform/status');
      await env.page.route('**/api/platform/status', (route) =>
        route.fulfill({
          json: {
            ...status,
            phase: 'setup_required',
            setupRequired: true,
            configurationSource: 'none',
            components: { ...status.components, knowledge: false },
          },
        }),
      );
      await env.page.reload();
      await btn(env.page, '从 GitHub／Gitee 导入').click();
      await expect(
        env.page.getByRole('textbox', { name: '导入后的知识库名称', exact: true }),
      ).toBeVisible();
    },
    {
      fault:
        'Only bootstrap status read changed to setup_required; actual owner setup/import components, no setup write or clone.',
      tests: ['tests/e2e/z-git-remote.spec.ts'],
    },
  ),
  scene(
    'git-plugin-commit',
    ['ST-083'],
    'plugins',
    'Actual Git commit contribution with no preview',
    '.plugin-dialog',
    commitPanel,
    {
      before: gitReady,
      path: '/',
      window: true,
      importantStates: { 'ST-083': ['无预览输入'] },
      tests: ['tests/e2e/git.spec.ts'],
    },
  ),
  scene(
    'git-plugin-preview',
    ['ST-084', 'ST-083'],
    'plugins',
    'Actual isolated Git plugin preview and cancel action',
    '.plugin-dialog',
    previewPanel,
    {
      before: gitReady,
      path: '/',
      window: true,
      importantStates: {
        'ST-084': ['文件数/状态代码/路径滚动列表', '预览到期时间'],
        'ST-083': ['预览ST-084'],
      },
      afterCapture: async ({ page }) => {
        await btn(page, '取消预览').click();
        await expect(page.locator('.git-preview')).toHaveCount(0);
        return { previewCancelled: true };
      },
      tests: ['tests/e2e/git.spec.ts'],
      representative: true,
    },
  ),
  scene(
    'management-503',
    ['ST-090'],
    'backup',
    'Maintenance rejection stays in existing management alerts',
    '.settings-workspace',
    async ({ page }) => {
      await expect(page.getByRole('alert').filter({ hasText: '维护中，请稍后重试' })).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/backups', failed('维护中，请稍后重试', 503));
      },
      fault: 'Backups read503 only, no global maintenance mutation.',
      importantStates: { 'ST-090': ['503维护', '业务错误仍由现有alert承接'] },
    },
  ),
  scene(
    'mcp-bridge',
    ['ST-091', 'ST-056'],
    'plugins',
    'Actual MCP navigation bridge before full panel',
    '.plugin-dialog',
    async (env) => {
      await showSidebar(env.page);
      await btn(env.page, 'MCP 连接').click();
      await expect(
        env.page.locator('.plugin-dialog').getByRole('button', { name: 'MCP 连接', exact: true }),
      ).toBeVisible();
    },
    {
      before: (env) => plugin(env, 'mcp'),
      path: '/',
      window: true,
      importantStates: { 'ST-091': ['宿主标题MCP连接，内容也只有MCP连接按钮'] },
      verify: async ({ page }) => {
        await page
          .locator('.plugin-dialog')
          .getByRole('button', { name: 'MCP 连接', exact: true })
          .click();
        await expect(page.locator('.dooknow-mcp-settings')).toBeVisible();
        return { bridgeOpenedActualSettings: true };
      },
      tests: ['tests/e2e/mcp.spec.ts'],
    },
  ),
  ...(['busy', 'api-error'] as const).map((kind) =>
    scene(
      'password-' + kind,
      ['ST-043', 'ST-044'],
      'account',
      'Password ' + kind + ' with synthetic unsaved credentials',
      dlg('修改密码'),
      async ({ page }) => {
        await btn(page, '修改密码').click();
        await page
          .getByLabel('当前密码', { exact: true })
          .fill('synthetic-current-' + randomUUID());
        await page.getByLabel('新密码', { exact: true }).fill('Synthetic-Password-123!');
        await page.getByLabel('确认新密码', { exact: true }).fill('Synthetic-Password-123!');
        await btn(page, '更新密码').click();
        if (kind === 'busy')
          await expect(dlg('修改密码')(page)).toHaveAttribute('aria-busy', 'true');
        else
          await expect(
            dlg('修改密码')(page)
              .locator('.ant-alert')
              .filter({ hasText: 'CAPTURE_PASSWORD_REJECTED' }),
          ).toBeVisible();
      },
      {
        before: async ({ page }) => {
          await page.route(
            '**/api/auth/change-password',
            kind === 'busy' ? held : failed('CAPTURE_PASSWORD_REJECTED', 403),
          );
        },
        window: true,
        fault:
          kind === 'busy'
            ? 'Password POST held; no password changed.'
            : 'Password POST403; no password changed.',
        importantStates:
          kind === 'busy'
            ? { 'ST-043': ['busy锁定关闭'], 'ST-044': ['busy所有输入禁用'] }
            : { 'ST-044': ['API失败弹窗内alert'] },
        representative: kind === 'busy',
      },
    ),
  ),
  scene(
    'key-error',
    ['ST-030'],
    'backup',
    'Recovery key password rejection clears the field',
    dlg('下载恢复密钥'),
    async ({ page }) => {
      await btn(page, '下载恢复密钥').click();
      await page.getByLabel('当前密码', { exact: true }).fill('incorrect-' + randomUUID());
      await btn(page, '验证密码并下载密钥').click();
      await expect(page.getByLabel('当前密码', { exact: true })).toHaveValue('');
      await expect(page.locator('#backup-key-error')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/backups/key', failed('密码错误', 403));
      },
      window: true,
      fault: 'Recovery key POST403 before any key export.',
      importantStates: { 'ST-030': ['403错误密码'] },
    },
  ),

  scene(
    'preferences-default-draft',
    ['ST-001', 'ST-011'],
    'editor',
    'Restore defaults affects preview until explicit save',
    '.settings-workspace',
    async ({ page }) => {
      await btn(page, '恢复默认设置').click();
      await expect(
        page.getByText('默认设置已载入预览，点击保存后生效。', { exact: true }),
      ).toBeVisible();
    },
    { importantStates: { 'ST-001': ['恢复默认待保存'], 'ST-011': ['默认设置只进入预览'] } },
  ),
  scene(
    'library-unbound-model',
    ['ST-012'],
    'library',
    'Unavailable library summary without hiding other sections',
    '.settings-workspace',
    undefined,
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/overview', async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          json.library = { ...json.library, name: null, path: null, ready: false };
          await route.fulfill({ response, json });
        });
      },
      fault: 'Only library summary models unbound/unavailable; backend binding never changed.',
      importantStates: { 'ST-012': ['尚未绑定知识库/目录', '暂时不可用'] },
    },
  ),
  scene(
    'storage-error',
    ['ST-013'],
    'library',
    'Storage statistics read failure',
    '.storage-settings',
    async ({ page }) => {
      await expect(page.locator('.storage-settings').getByRole('alert')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/storage', failed('CAPTURE_STORAGE_UNAVAILABLE'));
      },
      fault: 'Storage read503; no statistics fabricated.',
      importantStates: { 'ST-013': ['加载/读取失败'] },
    },
  ),
  scene(
    'diagnostics-error',
    ['ST-008'],
    'about',
    'Diagnostic download fails through real error renderer',
    '.settings-workspace',
    async ({ page }) => {
      await btn(page, '下载脱敏诊断').click();
      await expect(page.getByRole('alert')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/diagnostics', failed('CAPTURE_DIAGNOSTIC_UNAVAILABLE'));
      },
      fault: 'Diagnostic JSON request503; no fake download.',
      importantStates: undefined,
    },
  ),
  scene(
    'export-error',
    ['ST-024'],
    'library',
    'Export rejected before job is created',
    dlg('导出资料'),
    async ({ page }) => {
      await btn(page, '导出资料').click();
      await btn(page, '导出整个知识库').click();
      await expect(dlg('导出资料')(page).getByRole('alert')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/export', failed('CAPTURE_EXPORT_REJECTED', 503));
      },
      window: true,
      fault: 'Export POST503, no job/download created.',
      importantStates: { 'ST-024': ['exportError'] },
    },
  ),
  scene(
    'retention-read-error',
    ['ST-037'],
    'backup',
    'Retention read fails with retry available',
    '.retention-settings',
    async ({ page }) => {
      await openMaintenance(page);
      await page.getByText('整理撤销材料保留期限（高级）', { exact: true }).click();
      await expect(btn(page, '重新读取保留期限')).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route(
          '**/api/maintenance/organization-settings',
          failed('CAPTURE_RETENTION_UNAVAILABLE'),
        );
      },
      fault: 'Retention GET503; configuration unchanged.',
      importantStates: { 'ST-037': ['读取失败/重试', '不删除笔记/不缩短已有材料期限说明'] },
    },
  ),
  scene(
    'status-partition-error',
    ['ST-005', 'ST-041'],
    'status',
    'One status partition fails and auto-expands without hiding tasks',
    '.status-settings',
    async ({ page }) => {
      await expect(
        page.locator('details.status-row[open]').filter({ hasText: '索引更新' }),
      ).toBeVisible();
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/index/status', failed('CAPTURE_INDEX_UNAVAILABLE'));
      },
      fault: 'Index status GET503 only; tasks and search use real APIs.',
      importantStates: {
        'ST-005': ['各状态读取失败仍保留其他分区', '异常自动展开'],
        'ST-041': ['索引更新/冲突自动展开'],
      },
    },
  ),
  ...(['busy', 'error'] as const).map((kind) =>
    scene(
      'uninstall-' + kind,
      ['ST-053'],
      'plugins',
      'Uninstall ' + kind + ' preserves real overlay',
      dlg('卸载插件'),
      async (env) => {
        await mcp(env);
        await btn(env.page, '卸载插件').click();
        await btn(env.page, '确认卸载').click();
        if (kind === 'busy')
          await expect(dlg('卸载插件')(env.page)).toHaveAttribute('aria-busy', 'true');
        else await expect(dlg('卸载插件')(env.page).getByRole('alert')).toBeVisible();
      },
      {
        before: async (env) => {
          await plugin(env, 'mcp');
          await env.page.route(
            '**/api/platform/plugins/mcp/uninstall',
            kind === 'busy' ? held : failed('CAPTURE_UNINSTALL_REJECTED'),
          );
        },
        window: true,
        fault: 'Uninstall POST ' + (kind === 'busy' ? 'held' : 'rejected') + ' before mutation.',
        importantStates:
          kind === 'busy' ? { 'ST-053': ['busy锁关闭'] } : { 'ST-053': ['失败仍保留对话框'] },
      },
    ),
  ),
  scene(
    'plugin-restart-warning',
    ['ST-054', 'ST-049'],
    'plugins',
    'Restart-required warning from isolated registry model',
    '.plugin-settings',
    async env => { await mcp(env); const warning = env.page.locator('.plugin-settings .ant-alert-warning').filter({ hasText: '配置或版本需要重启生效' });
      await expect(warning).toBeVisible(); await expect(warning).toContainText('dooknow restart'); },
    {
      before: async (env) => {
        await plugin(env, 'mcp');
        await env.page.route('**/api/platform/plugins', async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          json.installed = json.installed.map((p: any) =>
            p.id === 'mcp' ? { ...p, restartRequired: true } : p,
          );
          await route.fulfill({ response, json });
        });
      },
      fault: 'Registry restartRequired read flag only; no service restart/config mutation.',
      importantStates: { 'ST-054': ['重启待生效'], 'ST-049': ['重启待生效'] },
    },
  ),
  scene(
    'mcp-resource-read-error',
    ['ST-062'],
    'plugins',
    'Permission resources read failure leaves retry in existing editor',
    '.domain-permissions',
    mcp,
    {
      before: async (env) => {
        await plugin(env, 'mcp');
        await env.page.route(
          '**/api/platform/mcp/permissions',
          failed('CAPTURE_PERMISSION_RESOURCES_UNAVAILABLE'),
        );
      },
      fault: 'Permission inventory GET503; no grant changed.',
      importantStates: { 'ST-062': ['资源读取失败'] },
    },
  ),
  ...(['busy', 'error'] as const).map((kind) =>
    scene(
      'oauth-narrow-' + kind,
      ['ST-060'],
      'plugins',
      'OAuth narrowing ' + kind,
      '.client-permissions',
      async (env) => {
        const row = await oauthRow(env);
        await row.getByRole('button', { name: '收窄连接权限', exact: true }).click();
        await row.getByRole('button', { name: '保存收窄权限', exact: true }).click();
        if (kind === 'error')
          await expect(
            row.getByText('未能确认权限更新，请刷新连接状态后核对。', { exact: true }),
          ).toBeVisible();
      },
      {
        before: async (env) => {
          await oauthModel(env);
          await env.page.route(
            '**/api/platform/mcp/clients/narrow',
            kind === 'busy' ? held : failed('CAPTURE_NARROW_REJECTED', 409),
          );
        },
        fault:
          'Synthetic grant model; narrow POST ' +
          (kind === 'busy' ? 'held' : 'rejected') +
          ' without mutation.',
        importantStates:
          kind === 'busy' ? { 'ST-060': ['busy'] } : { 'ST-060': ['保存未确认提示刷新核对'] },
      },
    ),
  ),
  ...(['busy', 'error'] as const).map((kind) =>
    scene(
      'oauth-revoke-' + kind,
      ['ST-061'],
      'plugins',
      'OAuth revoke ' + kind,
      '.guide-client',
      async (env) => {
        const row = await oauthRow(env);
        await row.getByRole('button', { name: '撤销此连接授权', exact: true }).click();
        await row.getByRole('button', { name: '确认撤销授权', exact: true }).click();
        if (kind === 'error')
          await expect(
            env.page.getByText('撤销未完成，请刷新状态后核对并重试。', { exact: true }),
          ).toBeVisible();
      },
      {
        before: async (env) => {
          await oauthModel(env);
          await env.page.route(
            '**/api/platform/mcp/clients/revoke',
            kind === 'busy' ? held : failed('CAPTURE_REVOKE_REJECTED', 503),
          );
        },
        fault:
          'Synthetic grant model; revoke POST ' +
          (kind === 'busy' ? 'held' : 'rejected') +
          ' before mutation.',
        importantStates:
          kind === 'busy' ? { 'ST-061': ['撤销busy'] } : { 'ST-061': ['结果未确认→刷新核对'] },
      },
    ),
  ),
  scene(
    'client-permission-conflict',
    ['ST-067', 'ST-071'],
    'plugins',
    'Real stale grant version preserves reviewed permission draft',
    '.api-clients',
    async (env) => {
      await editClient(env, '编辑权限');
      const c = store(env.page).client;
      await env.fixture.api('/api/platform/mcp/api-clients/' + c.clientId + '/permissions', 'PUT', {
        permissionPolicy: c.permissionPolicy,
        expectedGrantVersion: c.grantVersion,
      });
      await btn(env.page, '保存客户端权限').click();
      await expect(btn(env.page, '保存客户端权限')).toBeDisabled();
      await expect(
        env.page.getByText('客户端或授权已经变化，当前输入已保留。请重新载入后检查并保存。', {
          exact: true,
        }),
      ).toBeVisible();
    },
    {
      before: apiClient,
      importantStates: {
        'ST-067': ['版本冲突保留draft'],
        'ST-071': ['409客户端/授权变化，草稿保留并禁提交'],
      },
      tests: ['tests/e2e/mcp-api-clients.spec.ts'],
    },
  ),
  ...(['busy', 'unknown'] as const).map((kind) =>
    scene(
      'client-rotate-' + kind,
      ['ST-068', 'ST-071'],
      'plugins',
      'API key rotation ' + kind + ' with no key issued',
      '.api-clients',
      async (env) => {
        await editClient(env, '轮换密钥');
        await select(env.page, '密钥有效期', '永不过期');
        await btn(env.page, '确认轮换 API Key').click();
        if (kind === 'unknown')
          await expect(
            env.page.getByText(
              '操作结果尚未确认。请先刷新客户端列表核对；若密钥已签发但未显示，请轮换密钥。',
              { exact: true },
            ),
          ).toBeVisible();
      },
      {
        before: async (env) => {
          await apiClient(env);
          await env.page.route(
            '**/api/platform/mcp/api-clients/*/rotate-key',
            kind === 'busy' ? held : (route) => route.abort('failed'),
          );
        },
        fault:
          'Rotation ' + (kind === 'busy' ? 'held' : 'transport-aborted') + ' before key issuance.',
        importantStates:
          kind === 'busy'
            ? { 'ST-068': ['busy', '永不过期提示'] }
            : { 'ST-068': ['结果不确定须刷新并再轮换'], 'ST-071': ['其他失败提示先刷新核对'] },
      },
    ),
  ),
  scene(
    'client-revoke-busy',
    ['ST-072'],
    'plugins',
    'API client revoke request pending',
    '.api-clients',
    async (env) => {
      await apiGuide(env);
      await clientRow(env.page).getByRole('button', { name: '撤销 API 连接', exact: true }).click();
      await clientRow(env.page)
        .getByRole('button', { name: '确认撤销 API 连接', exact: true })
        .click();
    },
    {
      before: async (env) => {
        await apiClient(env);
        await env.page.route('**/api/platform/mcp/api-clients/*/revoke', held);
      },
      fault: 'Client revoke POST held before mutation.',
      importantStates: { 'ST-072': ['busy'] },
    },
  ),
  scene(
    'git-connection-discard',
    ['ST-075', 'ST-079', 'ST-089'],
    'library',
    'Git connection draft discard prompt retains editing path',
    dlg('管理云端同步'),
    async (env) => {
      await connection(env);
      await env.page
        .getByRole('textbox', { name: '仓库克隆地址', exact: true })
        .fill('https://github.com/example/capture-' + randomUUID() + '.git');
      await env.page.keyboard.press('Escape');
      await expect(env.page.locator('.settings-discard-prompt')).toBeVisible();
    },
    {
      window: true,
      importantStates: {
        'ST-075': ['dirty关闭ST-089'],
        'ST-079': ['放弃当前凭据/连接草稿确认'],
        'ST-089': ['footer替换为未保存更改提示'],
      },
      verify: async ({ page }) => {
        await btn(page, '继续编辑').click();
        await expect(
          page.getByRole('textbox', { name: '仓库克隆地址', exact: true }),
        ).not.toHaveValue('');
        return { draftPreservedOnContinue: true };
      },
      representative: true,
    },
  ),

  scene(
    'disk-resolve-busy',
    ['ST-035'],
    'backup',
    'Disk snapshot adoption held before mutation',
    '.dialog-card:visible',
    async (env) => {
      await inspectConflict(env);
      await btn(env.page, '采用磁盘版本').click();
      const action = env.page
        .locator('.dialog-card:visible')
        .getByRole('button')
        .filter({ hasText: '采用磁盘版本' });
      await expect(action).toHaveCount(1);
      await expect(action).toHaveText('采用磁盘版本');
      await expect(action).toBeDisabled();
    },
    {
      before: async (env) => {
        await conflictModel(env);
        await env.page.route('**/api/maintenance/conflicts/*/resolve', held);
      },
      window: true,
      fault: 'Synthetic unresolved conflict model; resolve POST held before mutation.',
      importantStates: { 'ST-035': ['提交中不能关闭'] },
    },
  ),
  scene(
    'restore-record-busy',
    ['ST-031'],
    'backup',
    'Independent restore request held before job creation',
    dlg('恢复到独立副本'),
    async (env) => {
      await openBackup(env);
      await btn(env.page, '开始独立恢复').click();
      await expect(dlg('恢复到独立副本')(env.page)).toHaveAttribute('aria-busy', 'true');
    },
    {
      before: async (env) => {
        await backup(env);
        await env.page.route('**/api/manage/restores', held);
      },
      window: true,
      fault: 'Real isolated backup; restore POST held before job creation.',
      importantStates: { 'ST-031': ['提交中'] },
    },
  ),
  scene(
    'key-busy',
    ['ST-030', 'ST-089'],
    'backup',
    'Recovery-key request held with close guard',
    dlg('下载恢复密钥'),
    async ({ page }) => {
      await btn(page, '下载恢复密钥').click();
      await page.getByLabel('当前密码', { exact: true }).fill('synthetic-' + randomUUID());
      await btn(page, '验证密码并下载密钥').click();
      await expect(dlg('下载恢复密钥')(page)).toHaveAttribute('aria-busy', 'true');
    },
    {
      before: async ({ page }) => {
        await page.route('**/api/manage/backups/key', held);
      },
      window: true,
      fault: 'Recovery-key POST held; no private key exported.',
      importantStates: { 'ST-030': ['下载中关闭锁定'], 'ST-089': ['busy禁止关闭与确认'] },
    },
  ),
  ...(['ascii', 'chinese'] as const).map((kind) =>
    scene(
      'git-long-credential-' + kind,
      ['ST-075', 'ST-076'],
      'library',
      'Real isolated credential with legal long ' + kind + ' name',
      dlg('管理云端同步'),
      connection,
      {
        before: async (env) => {
          const name = (
            kind === 'ascii'
              ? 'Capture-' + randomUUID() + 'X'.repeat(120)
              : randomUUID() + '凭据'.repeat(60)
          ).slice(0, 120);
          const saved = await env.fixture.api('/api/platform/git/credentials', 'POST', {
            name,
            host: 'github.com',
            kind: 'https',
            username: 'capture',
            token: 'disposable-' + randomUUID(),
            remember: false,
          });
          store(env.page).credentialId = saved.id;
        },
        window: true,
        afterCapture: async (env) => {
          await env.fixture.api(
            '/api/platform/git/credentials/' + store(env.page).credentialId,
            'DELETE',
          );
          return { temporaryCredentialRemoved: true };
        },
        tests: ['tests/git-remote-ui.test.ts'],
        representative: true,
      },
    ),
  ),
];

// After shared geometry/focus/hit sampling, verify real busy dismissal guards.
for (const id of [
  'settings-extra-import-submit-busy',
  'settings-extra-password-busy',
  'settings-extra-uninstall-busy',
  'settings-extra-key-busy',
  'settings-extra-restore-record-busy',
  'settings-extra-git-native-unknown',
]) {
  const entry = settingsScenes.find((value) => value.id === id);
  if (entry)
    entry.verify = async ({ page }) => {
      const surface = page.locator('.settings-overlay[aria-busy="true"]');
      await expect(surface).toBeVisible();
      await expect(surface.locator('.settings-overlay-close')).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(surface).toBeVisible();
      return { busyCloseButtonDisabled: true, busyEscapeBlocked: true };
    };
}
