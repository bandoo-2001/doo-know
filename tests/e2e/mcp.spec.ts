import {
  configurePlugin,
  returnToNotes,
  showSidebar,
  closeSidebar,
  openSettingsSection,
} from '../support/settings-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('loads independently built MCP settings and exposes connection requirements on desktop and mobile', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'MCP 服务');
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await expect(
    page.getByText('网页授权尚未就绪：需要浏览器可达的 HTTPS 授权站点和 MCP 地址', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible();
  await expect(page.getByLabel('Tunnel Bearer 密钥', { exact: true })).toBeHidden();
  await returnToNotes(page);
  await showSidebar(page);
  await page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭插件面板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await closeSidebar(page);
  await openSettingsSection(page, '插件与连接');
  await page.getByRole('button', { name: '停用MCP 服务', exact: true }).click();
  await returnToNotes(page);
  await showSidebar(page);
  await expect(page.getByRole('button', { name: 'MCP 连接', exact: true })).toHaveCount(0);
});
