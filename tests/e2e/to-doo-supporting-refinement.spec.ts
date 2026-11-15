import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

const workspace = (page: Page) => page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
async function openSection(page: Page, section: string) {
  await page.goto('/?view=apps&app=to-doo&appSection=' + section);
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
}
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

for (const viewport of [{ width: 1080, height: 812 }, { width: 390, height: 844 }]) {
  test(`notification primary scopes stay visible and filters do not move the list at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openSection(page, 'notifications');
    const app = workspace(page);
    await expect(app.getByRole('tab', { name: '未读', exact: true })).toBeVisible();
    await expect(app.getByRole('tab', { name: '全部', exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '搜索通知', exact: true })).not.toBeVisible();
    const list = app.locator('.todo-notifications-panel');
    const before = await list.boundingBox();
    const trigger = app.getByRole('button', { name: '打开通知筛选', exact: true });
    await trigger.click();
    const search = page.getByRole('searchbox', { name: '搜索通知', exact: true });
    await expect(search).toBeVisible();
    const after = await list.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    await search.press('Escape');
    await expect(search).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await app.getByRole('button', { name: '其他通知状态', exact: true }).click();
    for (const name of ['已读', '已确认', '稍后', '忽略'])
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: '已确认', exact: true }).click();
    await expect(app.getByRole('button', { name: '其他通知状态', exact: true })).toContainText('已确认');
  });
}

test('review content has one active panel while goal and history bridges remain reachable', async ({ page }) => {
  await openSection(page, 'stats');
  const app = workspace(page);
  await expect(app.locator('#to-doo-stats-overview')).toBeVisible();
  await expect(app.locator('#to-doo-stats-goals')).not.toBeVisible();
  await expect(app.locator('#to-doo-stats-reviews')).not.toBeVisible();
  await app.getByRole('tab', { name: '目标进展', exact: true }).click();
  await expect(app.locator('#to-doo-stats-goals')).toBeVisible();
  await expect(app.locator('#to-doo-stats-overview')).not.toBeVisible();
  await app.getByRole('tab', { name: '历史复盘', exact: true }).click();
  await expect(app.locator('#to-doo-stats-reviews')).toBeVisible();
  await expect(app.getByRole('button', { name: '＋ 新增推进记录', exact: true })).toBeVisible();
  await app.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(app.getByRole('button', { name: '查看专注记录', exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: '查看习惯记录', exact: true })).toBeVisible();
});

test('settings keeps connection creation and pasted imports behind their explicit entries', async ({ page }) => {
  await openSection(page, 'settings');
  const app = workspace(page);
  await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  await expect(app.getByLabel('HTTPS 日历地址', { exact: true })).not.toBeVisible();
  await app.getByText('连接外部只读日历', { exact: true }).click();
  await expect(app.getByLabel('HTTPS 日历地址', { exact: true })).toBeVisible();
  await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
  const content = app.getByLabel('或粘贴文件内容', { exact: true });
  await expect(content).not.toBeVisible();
  await app.getByRole('button', { name: '粘贴文件内容', exact: true }).click();
  await expect(content).toBeVisible();
  await content.fill('{"tasks":[]}');
  await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
  await expect(content).toHaveValue('{"tasks":[]}');
  await content.fill('');
});
