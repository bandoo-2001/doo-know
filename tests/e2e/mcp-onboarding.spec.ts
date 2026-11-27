import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openMcpTab, openSettingsSection, openFeatureSettings, openLegacyMcpSettings, setFeatureSwitch, returnToNotes } from '../support/settings-navigation';

test('guides a new MCP user before enablement and keeps local readiness separate from external verification', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await openSettingsSection(page, 'MCP 连接');
  await setFeatureSwitch(page, 'MCP 服务', false);
  await expect(
    page.getByRole('region', { name: 'MCP 连接指南', exact: true }),
  ).toBeVisible();
  await page.locator('summary').filter({ hasText: '连接与验证步骤' }).click();
  await expect(page.getByText('配置已保存，MCP 尚未启用', { exact: true })).toBeVisible();
  await expect(page.getByText('外部连接尚未验证', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'API Key 接入', exact: true }).click();
  await expect(page.getByText('Authorization: Bearer <API Key>', { exact: true })).toBeVisible();
  await expect(page.locator('.guide-value code')).toHaveText(/\/mcp\/api-key$/);
  await page.getByRole('button', { name: '管理 API Key', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建 API 客户端', exact: true })).toBeDisabled();
  await openMcpTab(page, '接入指南');
  await page.getByRole('button', { name: 'OAuth 接入', exact: true }).click();
  await expect(page.getByText('OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。', { exact: true })).toBeVisible();
  await openLegacyMcpSettings(page);
  await expect(page.getByRole('switch', { name: '启用 OAuth 连接', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '启用 API Key 连接', exact: true })).toBeVisible();
  await page.getByLabel('允许访问的目录', { exact: true }).fill('00-Inbox');
  await page.getByRole('button', { name: '保存 MCP 配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'MCP 配置已保存' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await openFeatureSettings(page, 'MCP 服务');
  await expect(page.getByLabel('允许访问的目录', { exact: true })).toHaveValue('00-Inbox');
  await returnToNotes(page);
});

test('switching MCP off keeps a visible authorization revocation path without re-enabling it', async ({
  page,
  context,
}) => {
  const { oauthGrantStore } = await import('../../apps/server/platform/oauth-grants.js');
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const db = new Database(join(config.dataRoot, 'app.sqlite'), { fileMustExist: true });
  const ownerId = (db.prepare('SELECT id FROM user').get() as any).id;
  const clientId = 'browser-grant-' + crypto.randomUUID();
  oauthGrantStore(db).approve(ownerId, clientId, ['knowledge:read'], ['00-Inbox']);
  try {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.goto('/');
    await openFeatureSettings(page, 'MCP 服务');
    await setFeatureSwitch(page, 'MCP 服务', false);
    await openMcpTab(page, '客户端');
    await page.getByRole('button', { name: 'OAuth 授权', exact: true }).click();
    const clients = page.getByRole('tabpanel', { name: '客户端', exact: true });
    const row = clients.locator('.guide-client').filter({ hasText: clientId });
    await row.getByRole('button', { name: '撤销此连接授权', exact: true }).click();
    await clients.getByRole('button', { name: '确认撤销授权', exact: true }).click();
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
