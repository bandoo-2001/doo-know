import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('installs a separate ESM plugin and removes its interactions when disabled', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '插件市场', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '安装计数验收插件', exact: true }).click();
  await page.getByRole('button', { name: '启用计数验收插件', exact: true }).click();
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '计数验收', exact: true }).click();
  await expect(page.getByRole('button', { name: '插件计数 0', exact: true })).toHaveCSS('border-top-width', '5px');
  await page.getByRole('button', { name: '插件计数 0', exact: true }).click();
  await expect(page.getByRole('button', { name: '插件计数 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await page.getByRole('button', { name: '停用计数验收插件', exact: true }).click();
  await expect(page.getByRole('button', { name: '计数验收', exact: true })).toHaveCount(0);
});
