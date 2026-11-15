import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { fillToDooDate } from '../support/to-doo-ant-controls';
import { openToDooTaskTools, selectToDooQuickView } from '../support/to-doo-navigation';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const state = await (await page.request.get('/api/to-doo/state')).json();
  await page.clock.install({ time: new Date(state.now) });
});

test('rescheduling a Today task needs only a date and explains where it went', async ({ page }) => {
  const title = '准备家庭采购 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
  const input = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await input.fill(title);
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const task = page.getByRole('button', { name: title, exact: true });
  await task.click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const date = detail.getByLabel('计划日期', { exact: true });
  const tomorrow = await date
    .inputValue()
    .then((value) =>
      new Date(Date.parse(value + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10),
    );
  await fillToDooDate(date, tomorrow);
  await expect(page.getByRole('dialog', { name: /时间安排/ })).toHaveCount(0);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(task).not.toBeVisible();
  const feedback = page.locator('.todo-action-feedback');
  await expect(feedback).toContainText('明天');
  await feedback.getByRole('button', { name: '查看安排', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe(tomorrow);
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
  const snapshot = await (
    await page.request.get('/api/to-doo/state?view=calendar&from=' + tomorrow + '&to=' + tomorrow)
  ).json();
  const stored = snapshot.tasks.find((row: any) => row.title === title);
  const occurrence = snapshot.occurrences.find((row: any) => row.taskId === stored.id);
  expect(
    snapshot.timeBlocks.find((row: any) => row.occurrenceId === occurrence.id)?.start,
  ).toMatchObject({ date: tomorrow, time: null });
});

test('a date can be added, cleared and reloaded without inventing a start time', async ({
  page,
}) => {
  const title = '只安排日期的收集事项 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title);
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await fillToDooDate(detail.getByLabel('计划日期', { exact: true }), '2030-05-17');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  await page.reload();
  await expect(detail.getByLabel('计划日期', { exact: true })).toHaveValue('2030-05-17');
  await fillToDooDate(detail.getByLabel('计划日期', { exact: true }), '');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  await page.reload();
  await expect(detail.getByLabel('计划日期', { exact: true })).toHaveValue('');
});

test('a local search can find a completed task in another scope without losing the words', async ({
  page,
}) => {
  const title = '需要重新找到的采购任务 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title);
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const task = page.getByRole('button', { name: title, exact: true });
  await expect(task).toBeVisible();
  await page.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(task).not.toBeVisible();
  await selectToDooQuickView(page, '今天');
  await openToDooTaskTools(page);
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill(title);
  await page.getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(page.locator('.todo-task-row')).toHaveCount(0);
  await page.getByRole('button', { name: '在所有任务中搜索', exact: true }).click();
  await expect(page.locator('.todo-page h1')).toHaveText('所有任务');
  await openToDooTaskTools(page);
  await expect(search).toHaveValue(title);
  await expect(task).toBeVisible();
  await expect(page.locator('.todo-task-row').filter({ has: task })).toHaveClass(/is-done/);
  await page.getByRole('button', { name: '重新打开 ' + title, exact: true }).click();
  await expect(page.locator('.todo-task-row').filter({ has: task })).not.toHaveClass(/is-done/);
});

test('a task captured for tomorrow offers its destination instead of disappearing from Today', async ({
  page,
}) => {
  const title = '整理出行收据 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill('明天 ' + title);
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const feedback = page.locator('.todo-action-feedback');
  await expect(feedback).toContainText(title);
  await expect(feedback).toContainText('明天');
  await feedback.getByRole('button', { name: '查看安排', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
});

test('an accidental ordinary completion can be undone immediately', async ({ page }) => {
  const title = '暂时保留的采购记录 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title);
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const task = page.getByRole('button', { name: title, exact: true });
  await expect(task).toBeVisible();
  await page.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(task).not.toBeVisible();
  const feedback = page.locator('.todo-action-feedback');
  await expect(feedback).toContainText(title);
  await feedback.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(task).toBeVisible();
  await expect(page.locator('.todo-task-row').filter({ has: task })).not.toHaveClass(/is-done/);
  await expect(feedback.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
});
