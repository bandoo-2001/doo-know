import {
  openFeatureSettings,
  setFeatureSwitch,
  returnToNotes,
  showSidebar,
} from '../support/settings-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('loads the built-in MCP settings and exposes connection requirements on desktop and mobile', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await openFeatureSettings(page, 'MCP 服务');
  await setFeatureSwitch(page, 'MCP 服务', true);
  await expect(
    page.getByText('OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'API Key 客户端', exact: true })).toBeVisible();
  await returnToNotes(page);
  await showSidebar(page);
  await page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  await expect(page.getByRole('region', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  await setFeatureSwitch(page, 'MCP 服务', false);
  await returnToNotes(page);
  await showSidebar(page);
  await expect(page.getByRole('button', { name: 'MCP 连接', exact: true })).toHaveCount(0);
});
