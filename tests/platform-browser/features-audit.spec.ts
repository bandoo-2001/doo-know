import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { testPassword } from '../support/credentials.js';

async function startFeatures(page: Page) {
  expect((await page.request.post('/__test/setup/reset')).status()).toBe(200);
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
}

test('optional search recovers after status failure, reopens a running task, cancels, retries and becomes ready', async ({
  page,
}) => {
  let statusFails = true,
    preparations = 0,
    cancellations = 0;
  const state: any = {
    externallyManaged: false,
    distributionAvailable: true,
    downloadBytes: 2 * 1024 * 1024,
    components: { tokenizerReady: false, vectorReady: false },
  };
  await page.route('**/api/platform/search-runtime', (route) =>
    statusFails
      ? route.fulfill({ status: 503, json: { error: 'fixture-status-unavailable' } })
      : route.fulfill({ json: state }),
  );
  await page.route('**/api/platform/search-runtime/prepare', (route) => {
    preparations++;
    expect(route.request().postDataJSON().requestId).toEqual(expect.any(String));
    state.task =
      preparations === 1
        ? {
            id: 'search-task',
            state: 'running',
            phase: 'downloading',
            completedBytes: 1024 * 1024,
            totalBytes: 2 * 1024 * 1024,
          }
        : { id: 'search-task-2', state: 'failed', phase: 'failed', error: 'fixture-invalid-model' };
    return route.fulfill({ json: { taskId: state.task.id } });
  });
  await page.route('**/api/platform/search-runtime/tasks/search-task/cancel', (route) => {
    cancellations++;
    state.task = {
      id: 'search-task',
      state: 'cancelled',
      phase: 'cancelled',
      error: 'PREPARATION_CANCELLED',
    };
    return route.fulfill({ json: { taskId: 'search-task', state: 'cancelled' } });
  });
  await startFeatures(page);
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await expect(page.getByText('暂时无法获取检索状态', { exact: true })).toBeVisible();
  expect(preparations).toBe(0);
  statusFails = false;
  await page.getByRole('button', { name: '检查检索状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载并准备搜索', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下载并准备搜索', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检索准备', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '下载检索包' })).toContainText(
    '1 / 2 MiB',
  );
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检索准备', exact: true })).toBeVisible();
  expect(preparations).toBe(1);
  await page.getByRole('button', { name: '取消检索准备', exact: true }).click();
  await expect(
    page.getByText('已停止准备，之后可继续。已校验的下载会保留。', { exact: true }),
  ).toBeVisible();
  expect(cancellations).toBe(1);
  await page.getByRole('button', { name: '重新准备', exact: true }).click();
  await expect(
    page.getByText('搜索组件暂时没有准备好，可以重试。已校验的下载会保留。', { exact: true }),
  ).toBeVisible();
  state.task = { id: 'search-task-2', state: 'succeeded', phase: 'ready' };
  state.components = { tokenizerReady: true, vectorReady: true };
  await page.getByRole('button', { name: '检查检索状态', exact: true }).click();
  await expect(page.getByText('内容搜索已就绪。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新准备', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库准备好了', exact: true })).toBeVisible();
});

test('MCP resumes an existing install, reports failure, retries once, preserves draft and saves before enabling', async ({
  page,
}) => {
  const manifest = JSON.parse(readFileSync('plugins/mcp/manifest.json', 'utf8'));
  const catalog = [
    {
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      description: manifest.description,
      capabilities: manifest.capabilities,
    },
  ];
  let plugin: any;
  const jobs = new Map<string, any>([
    [
      'old-install',
      {
        id: 'old-install',
        pluginId: 'mcp',
        version: manifest.version,
        status: 'running',
        phase: 'downloading',
      },
    ],
  ]);
  let posts = 0,
    configSaves = 0;
  const baseConfig = Object.fromEntries(
    Object.entries(manifest.configSchema.properties)
      .filter(([, f]: any) => f.default !== undefined)
      .map(([key, f]: any) => [key, f.default]),
  );
  baseConfig.allowedPrefixes = ['00-Inbox'];
  await page.route('**/api/platform/plugins', (route) =>
    route.fulfill({ json: { catalog, installed: plugin ? [plugin] : [], contributions: [] } }),
  );
  await page.route('**/api/platform/plugin-installations', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { items: [...jobs.values()] } });
    posts++;
    const input = route.request().postDataJSON();
    expect(input.id).toBe('mcp');
    const job = {
      id: 'new-install',
      pluginId: 'mcp',
      version: manifest.version,
      requestId: input.requestId,
      status: 'running',
      phase: 'downloading',
    };
    jobs.set(job.id, job);
    return route.fulfill({ status: 202, json: job });
  });
  await page.route('**/api/platform/plugin-installations/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const job = jobs.get(id);
    if (id === 'old-install')
      Object.assign(job, { status: 'failed', phase: 'verifying', error: 'PLUGIN_INSTALL_FAILED' });
    else {
      Object.assign(job, { status: 'succeeded', phase: 'complete' });
      plugin = {
        id: 'mcp',
        installedVersion: manifest.version,
        state: 'disabled',
        configVersion: 1,
        config: structuredClone(baseConfig),
        configuredSecrets: [],
        manifest,
      };
    }
    return route.fulfill({ json: job });
  });
  await page.route('**/api/platform/plugins/mcp/config', (route) => {
    const input = route.request().postDataJSON();
    expect(input.configVersion).toBe(plugin.configVersion);
    configSaves++;
    plugin = { ...plugin, configVersion: plugin.configVersion + 1, config: input.values };
    return route.fulfill({ json: plugin });
  });
  await page.route('**/api/platform/plugins/mcp/enable', (route) => {
    plugin = { ...plugin, state: 'enabled' };
    return route.fulfill({ json: plugin });
  });
  await page.route('**/api/platform/mcp/connection', (route) =>
    route.fulfill({
      json: {
        origin: 'http://127.0.0.1:4178',
        plugin: {
          installed: !!plugin,
          enabled: plugin?.state === 'enabled',
          state: plugin?.state || 'missing',
          configVersion: plugin?.configVersion || null,
        },
        connection: {
          oauth: { ready: false, address: 'http://127.0.0.1:4178/mcp' },
          apiKey: {
            ready: plugin?.state === 'enabled',
            address: 'http://127.0.0.1:4178/mcp/api-key',
          },
        },
        externalVerification: 'unknown',
        latestConnectionAttempt: null,
        latestSuccessfulCall: null,
        clients: [],
      },
    }),
  );
  await page.route('**/api/platform/mcp/api-clients', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await startFeatures(page);
  await expect(page.getByRole('alert')).toContainText('功能添加失败');
  expect(posts).toBe(0);
  await page.getByRole('button', { name: '添加连接设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 连接', exact: true })).toBeVisible();
  expect(posts).toBe(1);
  await expect(page.getByText('外部连接尚未验证', { exact: true })).toBeVisible();
  await expect(
    page.getByText('OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。', { exact: true }),
  ).toBeVisible();
  const oauth = page.getByRole('switch', { name: '启用 OAuth 连接', exact: true });
  await oauth.click();
  await expect(oauth).not.toBeChecked();
  await expect(page.getByRole('button', { name: '启用插件', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await page.getByRole('button', { name: '查看连接设置', exact: true }).click();
  await expect(oauth).not.toBeChecked();
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '插件配置已保存' })).toBeVisible();
  expect(configSaves).toBe(1);
  await page.getByRole('button', { name: '启用插件', exact: true }).click();
  await expect(page.getByRole('button', { name: '停用插件', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'API Key 接入', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建 API 客户端', exact: true })).toBeEnabled();
});
