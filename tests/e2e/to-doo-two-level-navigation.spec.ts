import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooContext, goToToDooSection } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('settings tabs preserve deep links through history and reload within the shared navigation', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=connections');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-settings-tabs')).toHaveCount(1);
  await expect(app.locator('.todo-page-heading h1')).toHaveText('设置');
  await expect(app.getByRole('tab', { name: '提醒与连接', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(app.getByRole('button', { name: '保存偏好', exact: true })).toHaveCount(0);
  await selectToDooContext(page, '清单管理');
  await expect(app.getByRole('tab', { name: '清单管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.reload();
  await expect(app.getByRole('tab', { name: '清单管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await selectToDooContext(page, '数据与恢复');
  await expect(app.getByRole('button', { name: '导出 JSON', exact: true })).toBeVisible();
  await page.goBack();
  await expect(app.getByRole('tab', { name: '清单管理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goForward();
  await expect(app.getByRole('tab', { name: '数据与恢复', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
test('calendar view controls preserve the anchor and task layouts remain in the task view picker', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&date=2032-05-03&calendarView=month');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await selectToDooContext(page, '周视图');
  await expect.poll(() => new URL(page.url()).searchParams.get('calendarView')).toBe('week');
  expect(new URL(page.url()).searchParams.get('date')).toBe('2032-05-03');
  await expect(app.getByRole('radio', { name: '周', exact: true })).toBeChecked();
  await selectToDooContext(page, '月视图');
  await expect(app.getByRole('radio', { name: '月', exact: true })).toBeChecked();
  expect(new URL(page.url()).searchParams.get('date')).toBe('2032-05-03');
  await goToToDooSection(page, 'timeline');
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('timeline');
  await expect(app.getByRole('combobox', { name: '任务展示方式', exact: true })).toBeVisible();
});
test('notification tabs apply the real status query and restore explicit deep links on reload', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=notifications&appPage=all');
  const request = page.waitForRequest(
    (r) =>
      r.url().includes('/api/to-doo/state?') &&
      new URL(r.url()).searchParams.get('reminderStates') === 'unread',
  );
  await selectToDooContext(page, '未读');
  await request;
  expect(new URL(page.url()).searchParams.get('appPage')).toBe('unread');
  await page.reload();
  await expect(page.getByRole('tab', { name: '未读', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
test('mobile habit controls switch the local pane and fit at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await selectToDooContext(page, '历史');
  await expect(page.getByRole('radio', { name: '历史', exact: true })).toBeChecked();
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
