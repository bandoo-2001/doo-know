import {
  openSettingsSection,
  openMcpTab,
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
  await openSettingsSection(page, 'MCP 连接');
  await setFeatureSwitch(page, 'MCP 服务', true);
  await expect(
    page.getByText('OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。', { exact: true }),
  ).toBeVisible();
  await openMcpTab(page, '调用记录');
  await expect(page.getByRole('heading', { name: '最近调用', exact: true })).toBeVisible();
  await openMcpTab(page, '客户端');
  await page.getByRole('button', { name: 'API Key 客户端', exact: true }).click();
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

test('shows one MCP tab at a time and supports keyboard navigation at desktop and phone widths', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/?view=settings&section=mcp');

  const bar = page.getByRole('tablist', { name: 'MCP 连接选项' });
  const labels = ['接入指南', '客户端', '权限设置', '调用记录'] as const;
  await expect(bar.getByRole('tab')).toHaveText([...labels]);
  const panel = page.getByRole('tabpanel');
  const guide = bar.getByRole('tab', { name: '接入指南' });
  await expect(guide).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute('id', (await guide.getAttribute('aria-controls'))!);
  await expect(page.getByRole('button', { name: '复制连接地址' })).toBeVisible();
  for (const label of labels) {
    await expect(bar.getByRole('tab', { name: label, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await guide.focus();
  for (const [key, name] of [['ArrowRight', '客户端'], ['End', '调用记录'], ['ArrowRight', '接入指南'], ['ArrowLeft', '调用记录'], ['Home', '接入指南']]) {
    await page.keyboard.press(key);
    const tab = bar.getByRole('tab', { name, exact: true });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
  }
  for (const label of labels) {
    await openMcpTab(page, label);
    await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});
