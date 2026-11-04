import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooContext, openToDooDirectory } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('secondary settings navigation survives history and reload without duplicated tabs', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=connections');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-settings-tabs')).toHaveCount(0);
  await expect(app.locator('.todo-page-heading h1')).toHaveText('提醒与连接');
  await expect(app.getByRole('button', { name: '保存偏好', exact: true })).toHaveCount(0);
  await selectToDooContext(page, '清单管理');
  await expect(app.locator('.todo-page-heading h1')).toHaveText('清单管理');
  await page.reload();
  await expect(app.locator('.todo-page-heading h1')).toHaveText('清单管理');
  await selectToDooContext(page, '数据与恢复');
  await expect(app.getByRole('button', { name: '导出 JSON', exact: true })).toBeVisible();
  await page.goBack();
  await expect(app.locator('.todo-page-heading h1')).toHaveText('清单管理');
  await page.goForward();
  await expect(app.locator('.todo-page-heading h1')).toHaveText('数据与恢复');
});
test('calendar context preserves the anchor when switching month, week and timeline', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&date=2032-05-03&calendarView=month');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await selectToDooContext(page, '周视图');
  await expect.poll(() => new URL(page.url()).searchParams.get('calendarView')).toBe('week');
  expect(new URL(page.url()).searchParams.get('date')).toBe('2032-05-03');
  await selectToDooContext(page, '时间线');
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('timeline');
  expect(new URL(page.url()).searchParams.get('date')).toBe('2032-05-03');
  const directory = await openToDooDirectory(page, '日历目录');
  await expect(directory.getByRole('button', { name: '时间线', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
test('notification sidebar applies the real status query and restores it on reload', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=notifications');
  const request = page.waitForRequest(
    (r) =>
      r.url().includes('/api/to-doo/state?') &&
      new URL(r.url()).searchParams.get('reminderStates') === 'unread',
  );
  await selectToDooContext(page, '未读');
  await request;
  expect(new URL(page.url()).searchParams.get('appPage')).toBe('unread');
  await page.reload();
  const directory = await openToDooDirectory(page, '通知中心目录');
  await expect(directory.getByRole('button', { name: '未读', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
test('mobile contextual drawer restores focus and fits at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await selectToDooContext(page, '历史');
  await expect(page.getByRole('button', { name: '功能导航', exact: true })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('appPage')).toBe('history');
  await expect(page.locator('.todo-habit-table')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('an internal phone history action moves keyboard focus into the visible pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const button = page.getByRole('button', { name: '查看全部记录', exact: true });
  await expect(button).toBeVisible();
  await button.focus();
  await button.press('Enter');
  await expect(
    page.getByRole('complementary', { name: '专注概览和历史', exact: true }),
  ).toBeFocused();
  expect(new URL(page.url()).searchParams.get('appPage')).toBe('history');
});
