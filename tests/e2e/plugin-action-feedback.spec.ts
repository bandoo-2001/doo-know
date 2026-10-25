import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { configurePlugin, returnToNotes } from '../support/settings-navigation';
test.use({ actionTimeout: 10_000 });

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'MCP 服务');
});

test('a completed plugin action with an unreadable refresh tells the user to verify its existing result', async ({
  page,
}) => {
  let stale = false;
  let posts = 0;
  await page.route('**/api/platform/plugins', (route) =>
    stale
      ? route.fulfill({ status: 503, json: { error: 'fixture unavailable' } })
      : route.continue(),
  );
  await page.route('**/api/platform/plugins/mcp/uninstall', async (route) => {
    posts++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    stale = true;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '卸载插件', exact: true }).click();
    await page.getByRole('button', { name: '确认卸载', exact: true }).click();
    await expect(page.locator('.plugin-feedback[role="alert"]')).toContainText(
      '操作已完成，但未能读取最新状态，请刷新核对。',
    );
    const actual = await (await page.request.get('/api/platform/plugins')).json();
    expect(actual.installed.some((plugin: any) => plugin.id === 'mcp')).toBe(false);
    expect(posts).toBe(1);
    const dialog = page.getByRole('dialog', { name: '卸载插件', exact: true });
    await expect(dialog.locator('.ant-alert-error')).toContainText(
      '操作已完成，但未能读取最新状态，请刷新核对。',
    );
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    stale = false;
    await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
    await expect(page.locator('.plugin-feedback[role="alert"]')).toHaveCount(0);
    await expect(page.locator('.plugin-card').filter({ hasText: 'MCP 服务' })).toHaveCount(0);
    expect(posts).toBe(1);
  } finally {
    const dialog = page.getByRole('dialog', { name: '卸载插件', exact: true });
    if (await dialog.isVisible())
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    stale = false;
    const actual = await (await page.request.get('/api/platform/plugins')).json();
    if (!actual.installed.some((plugin: any) => plugin.id === 'mcp')) {
      await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
      await page.getByRole('tab', { name: '添加插件', exact: true }).click();
      await page.getByRole('button', { name: '安装MCP 服务', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
    }
  }
});

test('a network interruption during a plugin action asks for a status check without claiming failure', async ({
  page,
}) => {
  await page.route(
    '**/api/platform/plugins/mcp/uninstall',
    (route) => route.abort('connectionfailed'),
    { times: 1 },
  );
  await page.getByRole('button', { name: '卸载插件', exact: true }).click();
  await page.getByRole('button', { name: '确认卸载', exact: true }).click();
  await expect(page.locator('.plugin-feedback[role="alert"]')).toContainText(
    '操作结果尚未确认，请先刷新状态核对。',
  );
  const actual = await (await page.request.get('/api/platform/plugins')).json();
  expect(actual.installed.some((plugin: any) => plugin.id === 'mcp')).toBe(true);
  const dialog = page.getByRole('dialog', { name: '卸载插件', exact: true });
  await expect(dialog.locator('.ant-alert-error')).toContainText(
    '操作结果尚未确认，请先刷新状态核对。',
  );
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  await expect(page.locator('.plugin-feedback[role="alert"]')).toHaveCount(0);
});

test('cancelling plugin uninstall keeps the installed plugin and sends no uninstall request', async ({
  page,
}) => {
  const before = await (await page.request.get('/api/platform/plugins')).json();
  const original = before.installed.find((plugin: any) => plugin.id === 'mcp');
  expect(original).toBeTruthy();
  let uninstalls = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/platform/plugins/mcp/uninstall'
    )
      uninstalls++;
  });
  const trigger = page.getByRole('button', { name: '卸载插件', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '卸载插件', exact: true });
  await expect(dialog).toContainText('卸载后保留插件配置与数据');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const after = await (await page.request.get('/api/platform/plugins')).json();
  expect(after.installed.find((plugin: any) => plugin.id === 'mcp')).toEqual(original);
  expect(uninstalls).toBe(0);
});

test('refreshing plugin status clears an old failed receipt after a real installation succeeds', async ({
  page,
}) => {
  await page.getByRole('button', { name: '卸载插件', exact: true }).click();
  await page.getByRole('button', { name: '确认卸载', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '添加插件', exact: true }).click();
  await page.route('**/api/platform/plugin-installations', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const { requestId } = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      json: {
        id: 'old-mcp-version-conflict',
        requestId,
        pluginId: 'mcp',
        version: '1.0.2',
        status: 'failed',
        phase: 'installing',
        error: 'PLUGIN_VERSION_CONTENT_CONFLICT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });
  await page.getByRole('button', { name: '安装MCP 服务', exact: true }).click();
  const receipt = page.locator('.plugin-feedback[role="status"]');
  await expect(receipt).toContainText('安装未完成');

  // The browser keeps its failed receipt while another real host request installs the package.
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const external = await page.request.post('/api/platform/plugins/mcp/install', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: {},
  });
  expect(external.ok()).toBe(true);
  const actual = await external.json();
  expect(actual.id).toBe('mcp');
  expect(actual.state).toBe('disabled');
  await expect(receipt).toContainText('安装未完成');

  let unreadable = true;
  await page.route('**/api/platform/plugins', (route) =>
    unreadable
      ? route.fulfill({ status: 503, json: { error: 'fixture unavailable' } })
      : route.continue(),
  );
  const refresh = page.getByRole('button', { name: '刷新插件状态', exact: true });
  await refresh.click();
  await expect(page.locator('.plugin-feedback[role="alert"]')).toContainText('暂时无法读取插件状态');
  await expect(receipt).toContainText('安装未完成');

  unreadable = false;
  await refresh.click();
  await expect(page.locator('.plugin-feedback[role="alert"]')).toHaveCount(0);
  await page.getByRole('tab', { name: '已安装', exact: true }).click();
  const installed = page.locator('.plugin-card').filter({ hasText: 'MCP 服务' });
  await expect(installed.locator('small')).toHaveText('v' + actual.installedVersion);
  await expect(installed.locator('.plugin-state')).toHaveText('已停用');
  await expect(receipt).toHaveCount(0);
});

test('refreshing plugin status keeps an installation whose result still needs reconciliation', async ({
  page,
}) => {
  await page.route('**/api/platform/plugin-installations', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      json: {
        items: [{
          id: 'interrupted-mcp-installation',
          requestId: 'interrupted-mcp-installation',
          pluginId: 'mcp',
          version: '1.0.2',
          status: 'needs_reconciliation',
          phase: 'installing',
          error: 'PLUGIN_INSTALL_INTERRUPTED',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
      },
    });
  });
  await returnToNotes(page);
  await configurePlugin(page, 'MCP 服务');
  const receipt = page.locator('.plugin-feedback[role="status"]');
  await expect(receipt).toContainText('结果待核对');
  await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  await expect(page.locator('.plugin-feedback[role="alert"]')).toHaveCount(0);
  await expect(receipt).toContainText('结果待核对');
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
});

test('refreshing plugin status dismisses a completed installation receipt', async ({ page }) => {
  await page.getByRole('button', { name: '卸载插件', exact: true }).click();
  await page.getByRole('button', { name: '确认卸载', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '添加插件', exact: true }).click();
  await page.getByRole('button', { name: '安装MCP 服务', exact: true }).click();
  const receipt = page.locator('.plugin-feedback[role="status"]');
  await expect(receipt).toContainText('安装完成');
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  await expect(receipt).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
});
