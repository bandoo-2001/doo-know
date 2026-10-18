import {
  configurePlugin,
  returnToNotes,
  showSidebar,
  closeSidebar,
  openSettingsSection,
} from '../support/settings-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('installs a separate ESM plugin and removes its interactions when disabled', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, '计数验收插件');
  await expect(page.getByRole('heading', { name: '扩展功能', exact: true })).toBeVisible();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await returnToNotes(page);
  await showSidebar(page);
  await page.getByRole('button', { name: '计数验收', exact: true }).click();
  await expect(page.getByRole('button', { name: '插件计数 0', exact: true })).toHaveCSS(
    'border-top-width',
    '5px',
  );
  await page.getByRole('button', { name: '插件计数 0', exact: true }).click();
  await expect(page.getByRole('button', { name: '插件计数 1', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '关闭插件面板', exact: true })).toHaveCount(0);
  await closeSidebar(page);
  await openSettingsSection(page, '插件与连接');
  await page.getByRole('button', { name: '停用计数验收插件', exact: true }).click();
  await returnToNotes(page);
  await showSidebar(page);
  await expect(page.getByRole('button', { name: '计数验收', exact: true })).toHaveCount(0);
});
