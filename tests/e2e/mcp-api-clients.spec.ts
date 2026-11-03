import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { invalidateRemoteAuth } from '../../packages/core/auth/remote-auth.js';
import type { Page } from '@playwright/test';
import type { McpApiClientView } from '../../shared/mcp-api-contracts';
import { test, expect } from '../support/browser-test';
import { configurePlugin, returnToNotes } from '../support/settings-navigation';

// Complete credentials must never enter traces, videos or screenshots.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.afterEach(async ({ page }) => {
  const close = page.getByRole('button', { name: '已保存，关闭密钥', exact: true });
  if (await close.isVisible()) await close.click();
  await page.getByLabel('新 API Key', { exact: true }).evaluateAll(elements => {
    for (const element of elements) {
      (element as HTMLTextAreaElement).value = '';
      element.textContent = '';
    }
  }).catch(() => undefined);
});
const base = '/api/platform/mcp/api-clients';
async function mutate(page: Page, path: string, method: string, body: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const csrf = await (await fetch('/api/security/csrf')).json();
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error('Fixture API request failed: ' + response.status);
      return response.json();
    },
    { path, method, body },
  );
}
async function items(page: Page): Promise<McpApiClientView[]> {
  return (await (await page.request.get(base)).json()).items;
}
async function expiry(page: Page, label: string) {
  await page.getByRole('combobox', { name: '密钥有效期', exact: true }).press('ArrowDown');
  await page
    .locator('.ant-select-item-option')
    .filter({ hasText: new RegExp('^' + label.replace(/[()]/g, '\\$&') + '$') })
    .click();
}
async function closeSecret(page: Page) {
  const secret = page.getByLabel('新 API Key', { exact: true });
  const raw = await secret.inputValue();
  expect(/^dk_mcp_[a-f0-9-]+\.[A-Za-z0-9_-]+$/.test(raw)).toBe(true);
  const stored = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(stored.includes(raw)).toBe(false);
  expect(JSON.stringify(await items(page)).includes(raw)).toBe(false);
  await page.getByRole('button', { name: '已保存，关闭密钥', exact: true }).click();
  await expect(secret).toHaveCount(0);
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: '创建 API 客户端', exact: true }).click();
  await page.getByRole('textbox', { name: '客户端名称', exact: true }).fill(name);
  await page.getByRole('button', { name: '创建并签发密钥', exact: true }).click();
  await expect(page.getByRole('region', { name: '一次性 API Key', exact: true })).toBeVisible();
  return (await items(page)).find((client) => client.name === name)!;
}
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'MCP 服务');
  const registry = await (await page.request.get('/api/platform/plugins')).json();
  const plugin = registry.installed.find((entry: any) => entry.id === 'mcp');
  if (plugin.config.apiKeyEnabled === false) {
    await mutate(page, '/api/platform/plugins/mcp/config', 'PUT', {
      values: { apiKeyEnabled: true },
      configVersion: plugin.configVersion,
    });
    await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  }
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await expect(page.getByRole('button', { name: '创建 API 客户端', exact: true })).toBeEnabled();
});

test('creates, renames, edits permissions, rotates with every expiry choice and revokes an API client', async ({
  page,
}) => {
  const name = 'Lifecycle ' + crypto.randomUUID();
  const started = Date.now();
  const created = await create(page, name);
  expect(Date.parse(created.key!.expiresAt!) - started).toBeGreaterThan(89 * 86400000);
  expect(Date.parse(created.key!.expiresAt!) - started).toBeLessThan(91 * 86400000);
  await closeSecret(page);
  let row = page.getByRole('article', { name, exact: true });
  await row.getByRole('button', { name: '修改名称', exact: true }).click();
  const renamed = name + ' renamed';
  await page.getByRole('textbox', { name: '客户端名称', exact: true }).fill(renamed);
  await page.getByRole('button', { name: '保存客户端名称', exact: true }).click();
  row = page.getByRole('article', { name: renamed, exact: true });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '编辑权限', exact: true }).click();
  const permissionForm = page.getByRole('form', { name: '编辑客户端权限', exact: true });
  await expect(permissionForm.getByRole('region', { name: '分域权限', exact: true })).toBeVisible();
  await permissionForm.getByRole('button', { name: '保存客户端权限', exact: true }).click();
  await expect(permissionForm).toHaveCount(0);
  expect(
    (await items(page)).find((client) => client.clientId === created.clientId)!.grantVersion,
  ).toBeGreaterThan(created.grantVersion);
  for (const [label, days] of [
    ['7 天', 7],
    ['30 天', 30],
    ['自定义时间', 12],
    ['永不过期', null],
  ] as const) {
    const before = (await items(page)).find((client) => client.clientId === created.clientId)!;
    await row.getByRole('button', { name: '轮换密钥', exact: true }).click();
    await expiry(page, label);
    const custom = new Date(Date.now() + 12 * 86400000);
    if (label === '自定义时间') {
      const local = new Date(custom.getTime() - custom.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      await page.getByLabel('自定义到期时间', { exact: true }).fill(local);
    }
    await page.getByRole('button', { name: '确认轮换 API Key', exact: true }).click();
    await expect(page.getByRole('region', { name: '一次性 API Key', exact: true })).toBeVisible();
    const current = (await items(page)).find((client) => client.clientId === created.clientId)!;
    expect(current.key!.id === before.key!.id).toBe(false);
    expect(current.permissionPolicy).toEqual(before.permissionPolicy);
    if (days === null) expect(current.key!.expiresAt).toBeNull();
    else
      expect(
        Math.abs(Date.parse(current.key!.expiresAt!) - Date.now() - days * 86400000),
      ).toBeLessThan(120000);
    await closeSecret(page);
  }
  await row.getByRole('button', { name: '撤销 API 连接', exact: true }).click();
  await row.getByRole('button', { name: '确认撤销 API 连接', exact: true }).click();
  await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '重新授权并签发', exact: true })).toHaveCount(0);
  expect((await items(page)).find((client) => client.clientId === created.clientId)!.status).toBe(
    'revoked',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeps one-time credentials out of persistent plugin drafts and clears the display on navigation', async ({
  page,
}) => {
  const created = await create(page, 'Transient ' + crypto.randomUUID());
  await expect(page.getByLabel('新 API Key', { exact: true })).toBeVisible();
  await returnToNotes(page);
  await configurePlugin(page, 'MCP 服务');
  await expect(page.getByLabel('新 API Key', { exact: true })).toHaveCount(0);
  const row = page.getByRole('article', { name: created.name, exact: true });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '撤销 API 连接', exact: true }).click();
  await row.getByRole('button', { name: '确认撤销 API 连接', exact: true }).click();
  await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
});

test('rejects a stale permission save without discarding the reviewed draft', async ({ page }) => {
  const created = await create(page, 'Stale ' + crypto.randomUUID());
  await closeSecret(page);
  const row = page.getByRole('article', { name: created.name, exact: true });
  await row.getByRole('button', { name: '编辑权限', exact: true }).click();
  const form = page.getByRole('form', { name: '编辑客户端权限', exact: true });
  await expect(form).toBeVisible();
  await mutate(page, base + '/' + encodeURIComponent(created.clientId) + '/permissions', 'PUT', {
    permissionPolicy: created.permissionPolicy,
    expectedGrantVersion: created.grantVersion,
  });
  const response = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname.endsWith('/permissions') && reply.request().method() === 'PUT',
  );
  await form.getByRole('button', { name: '保存客户端权限', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(form).toBeVisible();
  await expect(form.getByRole('button', { name: '保存客户端权限', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: '重新载入客户端', exact: true }).click();
  await expect(form.getByRole('button', { name: '保存客户端权限', exact: true })).toBeEnabled();
  await form.getByRole('button', { name: '保存客户端权限', exact: true }).click();
  await expect(form).toHaveCount(0);
  await row.getByRole('button', { name: '撤销 API 连接', exact: true }).click();
  await row.getByRole('button', { name: '确认撤销 API 连接', exact: true }).click();
  await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
});

test('explicitly reauthorizes invalidated identities while leaving manually revoked clients revoked', async ({
  page,
}) => {
  const created = await create(page, 'Reauthorize ' + crypto.randomUUID());
  await closeSecret(page);
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const db = new Database(join(config.dataRoot, 'app.sqlite'), { fileMustExist: true });
  try {
    db.transaction(() => invalidateRemoteAuth(db))();
  } finally {
    db.close();
  }
  await page.getByRole('button', { name: '刷新 API 客户端', exact: true }).click();
  const row = page.getByRole('article', { name: created.name, exact: true });
  await expect(row.getByText('需要重新授权', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: '重新授权并签发', exact: true }).click();
  await expiry(page, '永不过期');
  await page.getByRole('button', { name: '确认重新授权并签发', exact: true }).click();
  await expect(page.getByRole('region', { name: '一次性 API Key', exact: true })).toBeVisible();
  await closeSecret(page);
  expect((await items(page)).find((client) => client.clientId === created.clientId)!.status).toBe(
    'active',
  );
  await row.getByRole('button', { name: '撤销 API 连接', exact: true }).click();
  await row.getByRole('button', { name: '确认撤销 API 连接', exact: true }).click();
  await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '重新授权并签发', exact: true })).toHaveCount(0);
});
