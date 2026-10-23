import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { configurePlugin } from '../support/settings-navigation';
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
