import { test, expect } from '@playwright/test';
import { testPassword } from '../support/credentials.js';

test('first-install Git credentials accept real keyboard input and preserve the draft', async ({ page }) => {
  await page.route('**/api/platform/git/status', route => route.fulfill({ json: {
    branch: 'main', changes: 0, head: null, connection: null, discoveredRemotes: [], jobs: [],
  } }));
  let saved: { name: string; username: string } | undefined;
  await page.route('**/api/platform/git/credentials', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
    const input = route.request().postDataJSON();
    saved = { name: input.name, username: input.username };
    return route.fulfill({ json: { id: 'fixture-credential', name: input.name, username: input.username, host: input.host, kind: input.kind, temporary: false } });
  });
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '从 GitHub／Gitee 导入', exact: true }).click();
  await page.getByRole('button', { name: '添加凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加凭据', exact: true });
  const name = dialog.getByRole('textbox', { name: '凭据名称', exact: true });
  await expect(dialog).toBeVisible();
  await name.click();
  await expect(name).toBeFocused();
  await name.pressSequentially('test-account');
  await expect(name).toHaveValue('test-account');
  await name.press('Tab');
  await expect(dialog.getByLabel('凭据服务平台', { exact: true })).toBeFocused();
  const username = dialog.getByRole('textbox', { name: '仓库用户名', exact: true });
  await username.click();
  await username.pressSequentially('test-user');
  await expect(username).toHaveValue('test-user');
  await dialog.getByLabel('访问令牌', { exact: true }).fill('fixture-only-not-a-real-token');
  await expect(dialog.getByRole('button', { name: '保存仓库凭据', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭添加凭据', exact: true }).click();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(name).toHaveValue('test-account');
  await expect(username).toHaveValue('test-user');
  await dialog.getByRole('button', { name: '保存仓库凭据', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(saved).toEqual({ name: 'test-account', username: 'test-user' });
  await expect(page.getByLabel('仓库认证', { exact: true })).toHaveValue('fixture-credential');
});
