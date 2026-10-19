import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { configurePlugin, returnToNotes } from '../support/settings-navigation';

test('guides a new MCP user before enablement and keeps local readiness separate from external verification', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'MCP 服务');
  const disable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '停用插件', exact: true });
  if (await disable.isVisible()) await disable.click();
  await expect(
    page.getByRole('heading', { name: '连接 ChatGPT：按步骤完成', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('配置已保存，插件尚未启用', { exact: true })).toBeVisible();
  await expect(page.getByText('外部连接尚未验证', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tunnel 本地端口', { exact: true })).toBeHidden();
  await expect(page.getByLabel('允许访问的目录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看本地隧道教程', exact: true }).click();
  await expect(page.getByText('运行在 DooKnow 所在主机', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAI 隧道设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看网页授权教程', exact: true }).click();
  await expect(
    page.getByText('localhost 不能直接填到 ChatGPT 的公网连接地址中。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: '连接方式', exact: true }).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({ hasText: '本地隧道（Tunnel）' }).click();
  await expect(page.getByLabel('Tunnel 本地端口', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成连接密钥', exact: true }).click();
  await expect(page.getByLabel('Tunnel Bearer 密钥', { exact: true })).toHaveValue(
    /^[a-f0-9]{64}$/,
  );
  await page.getByLabel('允许访问的目录', { exact: true }).fill('00-Inbox');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '插件配置已保存' })).toBeVisible();
  await page.getByRole('combobox', { name: '连接方式', exact: true }).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({ hasText: '网页授权（OAuth）' }).click();
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  await page.reload();
  await configurePlugin(page, 'MCP 服务');
  await expect(page.getByLabel('允许访问的目录', { exact: true })).toHaveValue('00-Inbox');
  await expect(page.getByLabel('Tunnel Bearer 密钥', { exact: true })).toBeHidden();
  await returnToNotes(page);
});

test('uninstalling MCP keeps a visible authorization revocation path without re-enabling it', async ({
  page,
  context,
}) => {
  const { openDatabase } = await import('../../packages/core/db.js');
  const { oauthGrantStore } = await import('../../apps/server/platform/oauth-grants.js');
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const db = openDatabase(config.dataRoot);
  const ownerId = (db.prepare('SELECT id FROM user').get() as any).id;
  const clientId = 'browser-grant-' + crypto.randomUUID();
  oauthGrantStore(db).approve(ownerId, clientId, ['knowledge:read'], ['00-Inbox']);
  try {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.goto('/');
    await configurePlugin(page, 'MCP 服务');
    await page.getByRole('button', { name: '卸载插件', exact: true }).click();
    await page.getByRole('button', { name: '确认卸载', exact: true }).click();
    const manager = page.getByRole('region', { name: '停用或卸载后的连接授权', exact: true });
    await expect(manager).toBeVisible();
    const row = manager.locator('.authorization-row').filter({ hasText: clientId });
    await row.getByRole('button', { name: '撤销连接授权', exact: true }).click();
    await row.getByRole('button', { name: '确认撤销授权', exact: true }).click();
    await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
    expect(
      oauthGrantStore(db)
        .list(ownerId)
        .find((client) => client.clientId === clientId)?.active,
    ).toBe(false);
  } finally {
    oauthGrantStore(db).revoke(ownerId, clientId);
    db.close();
  }
});
