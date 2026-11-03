import { openLegacyMcpSettings } from '../support/settings-navigation';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { testPassword } from '../support/credentials.js';
import { configurePlugin, returnToNotes, showSidebar } from '../support/settings-navigation';

// Keep login credentials out of captured artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.afterEach(async ({ page }) => {
  await page
    .locator('input[type="password"]')
    .evaluateAll((inputs) => {
      for (const input of inputs) (input as HTMLInputElement).value = '';
    })
    .catch(() => undefined);
});

async function configureCurrentMcp(page: Page) {
  await expect(page.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
  const card = page.locator('.plugin-card').filter({ hasText: 'MCP 服务' });
  if (await card.isVisible()) await card.getByRole('button', { name: '配置', exact: true }).click();
  else {
    await page.getByRole('tab', { name: '添加插件', exact: true }).click();
    await page.getByRole('button', { name: '安装MCP 服务', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  await openLegacyMcpSettings(page);
}

async function section(page: Page, label: string) {
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

test('plugin inputs and authentication switches survive other settings and a return to notes', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=settings&section=plugins');
  await configureCurrentMcp(page);
  const externalUrl = page.getByLabel('外部网页地址', { exact: true });
  await externalUrl.fill('https://draft.example.invalid/session');
  const apiKey = page.getByRole('switch', { name: '启用 API Key 连接', exact: true });
  const initial = await apiKey.getAttribute('aria-checked');
  await apiKey.click();
  const changed = initial === 'true' ? 'false' : 'true';
  await section(page, '通用与编辑');
  await expect(page.getByRole('heading', { name: '编辑与阅读', exact: true })).toBeVisible();
  await section(page, '插件与连接');
  await configureCurrentMcp(page);
  await expect(externalUrl).toHaveValue('https://draft.example.invalid/session');
  await expect(apiKey).toHaveAttribute('aria-checked', changed);
  await returnToNotes(page);
  await configurePlugin(page, 'MCP 服务');
  await expect(externalUrl).toHaveValue('https://draft.example.invalid/session');
  await expect(apiKey).toHaveAttribute('aria-checked', changed);
});

test('cancelling refresh keeps an unsaved plugin input even after its settings page is hidden', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=settings&section=plugins');
  await configureCurrentMcp(page);
  const externalUrl = page.getByLabel('外部网页地址', { exact: true });
  await externalUrl.click();
  await externalUrl.fill('https://draft.example.invalid/refresh');
  await returnToNotes(page);
  let warned = false;
  page.once('dialog', async (dialog) => {
    warned = dialog.type() === 'beforeunload';
    await dialog.dismiss();
  });
  await page.reload({ timeout: 5000 }).catch(() => undefined);
  expect(warned).toBe(true);
  await configurePlugin(page, 'MCP 服务');
  await expect(externalUrl).toHaveValue('https://draft.example.invalid/refresh');
});

test('explicit logout clears plugin drafts before the next authenticated workspace opens', async ({
  page,
}) => {
  const externalUrl = page.getByLabel('外部网页地址', { exact: true });
  let saved = '';
  await test.step('登录并打开 MCP 设置', async () => {
    await page.goto('/');
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.workspace-empty')).toBeVisible();
    await configurePlugin(page, 'MCP 服务');
    saved = await externalUrl.inputValue();
  });
  await test.step('留下插件草稿并退出当前设备', async () => {
    await externalUrl.fill('https://draft.example.invalid/logout');
    await page.getByRole('switch', { name: '启用 API Key 连接', exact: true }).click();
    await section(page, '账号与安全');
    await page.getByRole('button', { name: '退出当前设备', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录 DooKnow', exact: true })).toBeVisible();
  });
  await test.step('重新登录并返回 MCP 设置', async () => {
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.workspace')).toBeVisible();
    await configurePlugin(page, 'MCP 服务');
  });
  await test.step('核对插件草稿已清理', async () => {
    expect((await externalUrl.inputValue()) === saved).toBe(true);
  });
});

test('a save response from an unmounted plugin view cannot replace newer inputs after returning', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  const initialRegistry = await (await page.request.get('/api/platform/plugins')).json();
  const initial = initialRegistry.installed.find((plugin: any) => plugin.id === 'git');
  let release!: () => void;
  let committed!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reachedServer = new Promise<void>((resolve) => {
    committed = resolve;
  });
  await page.route(
    '**/api/platform/plugins/git/config',
    async (route) => {
      const response = await route.fetch();
      committed();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    const author = page.getByLabel('提交作者', { exact: true });
    await author.fill('Submitted author');
    await page.getByLabel('作者邮箱', { exact: true }).fill('draft-regression@example.invalid');
    const response = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'PUT' &&
        new URL(reply.url()).pathname === '/api/platform/plugins/git/config',
    );
    await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
    await reachedServer;
    await section(page, '通用与编辑');
    await section(page, '插件与连接');
    await page
      .locator('.plugin-card')
      .filter({ hasText: 'Git 版本管理' })
      .getByRole('button', { name: '配置', exact: true })
      .click();
    await author.fill('New input after returning');
    release();
    await (await response).finished();
    await section(page, '通用与编辑');
    await section(page, '插件与连接');
    await page
      .locator('.plugin-card')
      .filter({ hasText: 'Git 版本管理' })
      .getByRole('button', { name: '配置', exact: true })
      .click();
    await expect(author).toHaveValue('New input after returning');
    await expect(page.getByText('已保存配置在其他位置发生变化', { exact: true })).toBeVisible();
    const actual = await (await page.request.get('/api/platform/plugins')).json();
    expect(actual.installed.find((plugin: any) => plugin.id === 'git').config.authorName).toBe(
      'Submitted author',
    );
  } finally {
    release();
    const registry = await (await page.request.get('/api/platform/plugins')).json();
    const current = registry.installed.find((plugin: any) => plugin.id === 'git');
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const restored = await page.request.put('/api/platform/plugins/git/config', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
      data: { values: initial.config, configVersion: current.configVersion },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('first-use plugin settings also warn before a refresh and retain input when it is cancelled', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.route('**/api/platform/status', async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ json: { ...status, onboardingRequired: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^(添加|查看)连接设置$/ }).click();
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
  await openLegacyMcpSettings(page);
  const externalUrl = page.getByLabel('外部网页地址', { exact: true });
  await externalUrl.click();
  await externalUrl.fill('https://draft.example.invalid/onboarding');
  let warned = false;
  page.once('dialog', async (dialog) => {
    warned = dialog.type() === 'beforeunload';
    await dialog.dismiss();
  });
  await page.reload({ timeout: 5000 }).catch(() => undefined);
  expect(warned).toBe(true);
  await expect(externalUrl).toHaveValue('https://draft.example.invalid/onboarding');
});
