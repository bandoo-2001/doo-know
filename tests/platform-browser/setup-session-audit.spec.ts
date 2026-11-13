import { test, expect } from '@playwright/test';
import { testPassword } from '../support/credentials.js';

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/setup/reset')).ok()).toBe(true);
});

test('session expiry during first binding preserves the draft and created directory through reauthentication', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__setupExpiryEvents = 0;
    window.addEventListener('dooknow-session-expired', () => {
      ++(window as any).__setupExpiryEvents;
    });
  });
  let creates = 0;
  let bindingRequests = 0;
  await page.route('**/api/platform/setup/create', async (route) => {
    ++creates;
    await route.continue();
  });
  await page.route('**/api/platform/setup/complete', async (route) => {
    if (++bindingRequests === 1) {
      await route.fulfill({ status: 401, json: { error: 'Session expired during setup' } });
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
  const libraryName = '重新登录后保留的知识库';
  await page.getByLabel('知识库名称', { exact: true }).fill(libraryName);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();

  const login = page.locator('form.login-card').filter({
    has: page.getByRole('heading', { name: '登录已失效', exact: true }),
  });
  await expect(login).toBeVisible();
  await expect.poll(() => creates).toBe(1);
  expect(await page.evaluate(() => (window as any).__setupExpiryEvents)).toBe(1);
  await login.getByLabel('用户名', { exact: true }).fill('owner');
  await login.getByLabel('密码', { exact: true }).fill(testPassword);
  await login.getByRole('button', { name: '登录', exact: true }).click();
  await expect(login).toBeHidden();
  await expect(page.getByLabel('知识库名称', { exact: true })).toHaveValue(libraryName);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  expect(creates).toBe(1);
  expect(bindingRequests).toBe(2);
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库准备好了', exact: true })).toBeVisible();
  await expect(page.locator('.ready-summary')).toContainText(libraryName);
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await page.reload();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toHaveCount(0);
});
