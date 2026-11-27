import { test, expect, type Page } from '@playwright/test';
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

test('preserves an MCP settings draft through onboarding and enables the configured service', async ({ page }) => {
  await startFeatures(page);
  const open = page.getByRole('button', { name: '设置 MCP 连接', exact: true });
  await open.click();
  const enabled = page.getByRole('switch', { name: '启用 MCP 服务', exact: true });
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('tab', { name: '权限设置', exact: true }).click();
  const oauth = page.getByRole('switch', { name: '启用 OAuth 连接', exact: true });
  await oauth.click();
  await expect(oauth).not.toBeChecked();
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await open.click();
  await expect(oauth).not.toBeChecked();
  await page.getByRole('button', { name: '保存 MCP 配置', exact: true }).click();
  await expect(page.getByText('MCP 配置已保存。', { exact: true })).toBeVisible();
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  const settings = await (await page.request.get('/api/platform/features')).json();
  expect(settings.mcp).toMatchObject({ state: 'enabled', config: { oauthEnabled: false } });
  expect(settings.git.state).toBe('disabled');
});
