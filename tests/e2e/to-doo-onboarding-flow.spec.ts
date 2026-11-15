import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import {
  closeToDooDirectory,
  goToToDooSection,
  openToDooDirectory,
  selectToDooList,
  selectToDooQuickView,
} from '../support/to-doo-navigation';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { completeToDooDetailProperty, openToDooDetailProperty } from '../support/to-doo-detail-controls';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  await page.clock.install({ time: new Date(snapshot.now) });
});

test('a new user can capture today, organise a task and find it after completing it', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '准备本周的读书笔记 ' + suffix;
  const listName = '阅读计划 ' + suffix;
  await page.goto('/?view=apps');
  await page
    .locator('.app-card')
    .filter({ has: page.getByRole('heading', { name: 'To Doo', exact: true }) })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('today');
  await expect(page.locator('.todo-page h1')).toHaveText('今天');
  const capture = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await capture.fill(title);
  await capture.press('Enter');
  const task = page.getByRole('button', { name: title, exact: true });
  await expect(task).toBeVisible();
  await expect(capture).toHaveValue('');

  const directory = await openToDooDirectory(page);
  await directory.getByRole('button', { name: '新建清单', exact: true }).first().click();
  const listEditor = page.getByRole('dialog', { name: /新建.*清单/ });
  await expect(listEditor).toBeVisible();
  await listEditor.getByLabel('名称', { exact: true }).fill(listName);
  await listEditor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(listEditor).not.toBeVisible();

  await task.click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const listProperty = await openToDooDetailProperty(page, 'list');
  await selectToDooOption(listProperty, '所属目标或清单', listName);
  await completeToDooDetailProperty(page);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await selectToDooList(page, listName);
  await expect(page.locator('.todo-page h1')).toHaveText(listName);
  await expect(task).toBeVisible();
  await page.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(task).not.toBeVisible();

  await selectToDooQuickView(page, '已完成');
  await expect(page.locator('.todo-page h1')).toHaveText('已完成');
  await expect(task).toBeVisible();
  await expect(page.locator('.todo-task-row').filter({ has: task })).toHaveClass(/is-done/);
  await page.reload();
  await expect(task).toBeVisible();
});

test('calendar task creation uses the selected day and its secondary action reserves time', async ({
  page,
}) => {
  const date = '2030-05-17';
  const title = '准备当天的会议 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=' + date);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app
    .locator('.todo-page-heading')
    .getByRole('button', { name: '新建任务', exact: true })
    .click();
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('计划日期', { exact: true })).toHaveValue(date);
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const snapshot = await (
    await page.request.get('/api/to-doo/state?view=calendar&from=' + date + '&to=' + date)
  ).json();
  const task = snapshot.tasks.find((item: any) => item.title === title);
  const occurrence = snapshot.occurrences.find((item: any) => item.taskId === task.id);
  expect(
    snapshot.timeBlocks.some(
      (block: any) => block.occurrenceId === occurrence.id && block.start.date === date,
    ),
  ).toBe(true);
  await expect(app.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();

  await app
    .locator('.todo-calendar-toolbar')
    .getByRole('button', { name: '＋ 预留时间', exact: true })
    .click();
  const blockEditor = page.getByRole('dialog', { name: '新建时间安排', exact: true });
  await expect(blockEditor.getByLabel('日期', { exact: true })).toHaveValue(date);
  await blockEditor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(blockEditor).not.toBeVisible();
});

test('one navigation reaches the main tools and Today always returns to its task list', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
  await expect(page.locator('.workspace-main-menu[data-menu-id="to-doo"]')).toHaveCount(0);
  await expect(page.locator('.workspace > #notebook-navigation')).toHaveCount(0);
  for (const section of [
    'calendar',
    'habits',
    'focus',
    'overview',
    'stats',
    'anniversaries',
    'notifications',
    'settings',
  ]) {
    await goToToDooSection(page, section);
    await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    const directory = await openToDooDirectory(page);
    await expect(directory).toHaveCount(1);
    const more = directory.locator('details.todo-navigation-more');
    if (!(await directory.getByRole('button', { name: '已完成', exact: true }).isVisible()))
      await more.locator('summary').click();
    for (const name of ['今天', '收集箱', '近七天', '所有任务', '已完成'])
      await expect(directory.getByRole('button', { name, exact: true })).toBeVisible();
    await closeToDooDirectory(page);
    await selectToDooQuickView(page, '今天');
    await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('tasks');
    await expect(page.locator('.todo-page h1')).toHaveText('今天');
  }
  for (const [name, filter] of [
    ['逾期', 'overdue'],
    ['未安排', 'unscheduled'],
    ['受阻', 'blocked'],
  ] as const) {
    await selectToDooQuickView(page, name);
    await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe(filter);
    await expect(page.locator('.todo-page h1')).toHaveText(name);
    const directory = await openToDooDirectory(page);
    await expect(directory.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await closeToDooDirectory(page);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
