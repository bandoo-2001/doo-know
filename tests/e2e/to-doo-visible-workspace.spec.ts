import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showMainMenu, closeSidebar } from '../support/settings-navigation';
import {
  closeToDooDirectory,
  goToToDooSection,
  openToDooDirectory,
} from '../support/to-doo-navigation';

async function command(
  page: import('@playwright/test').Page,
  action: string,
  payload: Record<string, unknown>,
) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('primary tools and contextual task directories are discoverable without expanding hidden groups', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await showMainMenu(page);
  const main = page.getByRole('navigation', { name: 'To Doo 主菜单', exact: true });
  for (const label of ['任务', '日历', '四象限', '专注', '习惯', '纪念日', '复盘'])
    await expect(main.getByRole('button', { name: label, exact: true })).toBeVisible();
  const utilities = page.getByRole('navigation', { name: 'To Doo 工具', exact: true });
  for (const label of ['通知', '设置'])
    await expect(utilities.getByRole('button', { name: label, exact: true })).toBeVisible();
  await closeSidebar(page);
  const directory = await openToDooDirectory(page);
  for (const label of ['收集箱', '今天', '近七天', '所有任务', '目标总览'])
    await expect(directory.getByRole('button', { name: label, exact: true })).toBeVisible();
  for (const label of ['四象限', '专注', '通知', '设置'])
    await expect(directory.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await closeToDooDirectory(page);
  await expect(page.locator('.todo-view-switch').getByText('看板', { exact: true })).toBeVisible();
  await goToToDooSection(page, 'habits');
  await expect(page).toHaveURL(/appSection=habits/);
  await expect(page.getByRole('heading', { name: '习惯', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '功能导航', exact: true })).not.toBeVisible();
  await expect(page.locator('aside.todo-sidebar')).toHaveCount(0);
  await expect(page.locator('.todo-topbar').getByText('To Doo', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '所有任务', exact: true })).toBeVisible();
  await mkdir('.local/to-doo-visible-workspace', { recursive: true });
  await page.screenshot({
    path: `.local/to-doo-visible-workspace/${info.project.name}-tasks.png`,
    animations: 'disabled',
  });
});

test('matrix uses four distinguishable surfaces and explains each action without wasting the viewport', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=matrix');
  const quadrants = page.locator('.todo-quadrant');
  await expect(quadrants).toHaveCount(4);
  await expect(page.locator('aside.todo-sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '功能导航', exact: true })).toHaveCount(0);
  await expect(page.locator('.todo-topbar').getByText('To Doo', { exact: true })).toBeVisible();
  for (const action of ['立即行动', '安排计划', '协调处理', '留待以后'])
    await expect(page.getByText(action, { exact: true })).toBeVisible();
  const colors = await quadrants.evaluateAll((elements) =>
    elements.map((element) => {
      const header = element.querySelector('.todo-panel-header')!;
      const style = getComputedStyle(header);
      return [style.backgroundColor, style.borderTopColor, style.color].join('|');
    }),
  );
  expect(new Set(colors).size).toBe(4);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  if (page.viewportSize()!.width > 1000) {
    const workspace = await page.locator('.to-doo-workspace').boundingBox();
    const main = await page.locator('.todo-main').boundingBox();
    expect(Math.abs(main!.x - workspace!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(main!.width - workspace!.width)).toBeLessThanOrEqual(1);
    const box = await page.locator('.todo-quadrants').boundingBox();
    expect(box!.y).toBeLessThan(300);
    expect(box!.width).toBeGreaterThan(650);
  }
  await page.screenshot({
    path: `.local/to-doo-visible-workspace/${info.project.name}-matrix.png`,
    animations: 'disabled',
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.setViewportSize({ width: 320, height: 780 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: '功能导航', exact: true })).toHaveCount(0);
  await showMainMenu(page);
  const nav = page.getByRole('navigation', { name: 'To Doo 主菜单', exact: true });
  await expect(nav.getByRole('button', { name: '四象限', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.screenshot({
    path: `.local/to-doo-visible-workspace/${info.project.name}-mobile-navigation-dark.png`,
    animations: 'disabled',
  });
});

test('mobile navigation keeps keyboard focus inside and restores the opener on Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const trigger = page.getByRole('button', { name: '功能导航', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: '关闭功能导航', exact: true });
  await close.focus();
  await page.keyboard.press('q');
  await expect(close).toBeFocused();
  const last = dialog.getByRole('button').last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('q');
  await expect(page.getByRole('textbox', { name: '快速添加任务', exact: true })).toBeFocused();
});

test('leaving from navigation keeps focus on the unsaved confirmation and retains a cancelled draft', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const input = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await input.fill('保留这份尚未提交的行动');
  const original = page.url();
  await showMainMenu(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '返回 DooKnow', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
  await expect(confirmation).toBeVisible();
  const keepEditing = confirmation.getByRole('button', { name: '继续编辑', exact: true });
  await expect
    .poll(() => confirmation.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await keepEditing.click();
  await expect(confirmation).not.toBeVisible();
  await expect(page).toHaveURL(/app=to-doo/);
  await expect(page).toHaveURL(original);
  await expect(input).toHaveValue('保留这份尚未提交的行动');
});

test('priority edits persist independently from visible matrix classification and dates', async ({
  page,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '产品规划 · 体验演示', kind: 'list' },
  });
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const timeZone = initial.settings.timeZone;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  for (const [title, priority, importance, urgentOverride] of [
    ['提交产品方案', 'high', 'important', true],
    ['梳理下周迭代计划', 'normal', 'important', false],
    ['确认会议时间', 'low', 'normal', true],
    ['整理灵感与阅读清单', 'none', 'normal', false],
  ] as const)
    await command(page, 'create_task', {
      title,
      listId: list.ids[0],
      priority,
      importance,
      urgentOverride,
      due: { date, time: '17:00', timeZone },
    });
  const url = '/?view=apps&app=to-doo&appSection=matrix&list=' + list.ids[0];
  await page.goto(url);
  const quadrants = page.locator('.todo-quadrant');
  for (const [index, title] of [
    '提交产品方案',
    '梳理下周迭代计划',
    '确认会议时间',
    '整理灵感与阅读清单',
  ].entries()) {
    const row = quadrants.nth(index).locator('.todo-task-row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.locator('.todo-task-deadline')).toBeVisible();
    await expect(row.locator('.todo-priority-label')).toBeVisible();
  }
  await page.screenshot({
    path: `.local/to-doo-visible-workspace/${info.project.name}-matrix-populated.png`,
    animations: 'disabled',
  });
  await quadrants.first().getByRole('button', { name: '提交产品方案', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('重要程度', { exact: true })).toBeVisible();
  await expect(detail.getByLabel('紧急程度', { exact: true })).toBeVisible();
  await detail.locator('.todo-priority-select').click();
  await page.locator('.todo-priority-popup').getByText('低优先级', { exact: true }).click();
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('任务已保存');
  await page.reload();
  await expect(detail.locator('.todo-priority-select')).toContainText('低优先级');
  const snapshot = await (
    await page.request.get('/api/to-doo/state?listIds=' + list.ids[0])
  ).json();
  expect(snapshot.tasks.find((task: any) => task.title === '提交产品方案')).toMatchObject({
    priority: 'low',
    importance: 'important',
    urgentOverride: true,
  });
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(
    quadrants.first().getByRole('button', { name: '提交产品方案', exact: true }),
  ).toBeVisible();
});
