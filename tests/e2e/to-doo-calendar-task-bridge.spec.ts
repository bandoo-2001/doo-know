import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { completeToDooDetailProperty, openToDooDetailPlan } from '../support/to-doo-detail-controls';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const state = await (await page.request.get('/api/to-doo/state')).json();
  await page.clock.install({ time: new Date(state.now) });
});
async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('calendar schedules an existing task, opens its details and reflects completion without creating a copy', async ({
  page,
}) => {
  const date = '2030-05-17';
  const title = '安排已记下的阅读任务 ' + crypto.randomUUID().slice(0, 8);
  const created = await command(page, 'create_task', {
    title,
    due: { date, time: null, timeZone: 'UTC' },
  });
  const otherTitle = '同一天的另一项待办 ' + crypto.randomUUID().slice(0, 8);
  await command(page, 'create_task', { title: otherTitle });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&date=' + date);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '安排已有任务', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '安排已有任务', exact: true });
  await expect(picker.getByLabel('安排日期', { exact: true })).toHaveValue(date);
  await selectToDooOption(picker, '待安排任务', title);
  await picker.getByRole('button', { name: '安排任务', exact: true }).click();
  await expect(picker).not.toBeVisible();
  const event = app.getByRole('button', { name: new RegExp(title) }).first();
  await expect(event).toBeVisible();
  await app.getByRole('button', { name: '安排已有任务', exact: true }).click();
  await selectToDooOption(picker, '待安排任务', otherTitle);
  await picker.getByRole('button', { name: '安排任务', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(app.getByRole('button', { name: new RegExp(otherTitle) }).first()).toBeVisible();
  await event.click();
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  const plan = await openToDooDetailPlan(page);
  await expect(plan.getByLabel('日期', { exact: true })).toHaveValue(date);
  await completeToDooDetailProperty(page);
  await expect(page.getByRole('dialog', { name: /编辑时间安排/ })).toHaveCount(0);
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(detail.getByRole('button', { name: '重新打开', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(event).toHaveClass(/is-done/);
  for (const representation of await app.getByRole('button', { name: new RegExp(title) }).all())
    await expect(representation).toHaveClass(/is-done/);
  await page.reload();
  await expect(event).toHaveClass(/is-done/);
  const snapshot = await (
    await page.request.get('/api/to-doo/state?view=calendar&from=' + date + '&to=' + date)
  ).json();
  const tasks = snapshot.tasks.filter((row: any) => row.title === title);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toBe(created.ids[0]);
  expect(snapshot.occurrences.find((row: any) => row.taskId === created.ids[0])?.status).toBe(
    'done',
  );
  const occurrences = new Set(
    snapshot.occurrences
      .filter((row: any) => row.taskId === created.ids[0])
      .map((row: any) => row.id),
  );
  expect(
    snapshot.timeBlocks.filter((row: any) => occurrences.has(row.occurrenceId) && !row.deletedAt),
  ).toHaveLength(1);
});

test('calendar keeps independent reserved time separate from tasks', async ({ page }) => {
  const title = '保留一段安静时间 ' + crypto.randomUUID().slice(0, 8);
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&date=2030-05-17');
  await page.getByRole('button', { name: '＋ 预留时间', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建时间安排', exact: true });
  await editor.getByLabel('安排标题', { exact: true }).fill(title);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: '编辑时间安排', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '任务详情', exact: true })).toHaveCount(0);
});

test('an arrangement follows its chosen month and retrying a lost response never duplicates the task or plan', async ({
  page,
}) => {
  const title = '跨月安排已有任务 ' + crypto.randomUUID().slice(0, 8);
  const created = await command(page, 'create_task', { title });
  const targetDate = '2030-08-19';
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&date=2030-05-17');
  await page.getByRole('button', { name: '安排已有任务', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '安排已有任务', exact: true });
  await selectToDooOption(picker, '待安排任务', title);
  const date = picker.getByLabel('安排日期', { exact: true });
  await date.click();
  await date.fill(targetDate);
  await date.press('Enter');
  await date.press('Tab');
  let dropped = false;
  await page.route('**/api/to-doo/commands', async (route) => {
    if (!dropped && route.request().postDataJSON()?.action === 'apply_plan') {
      dropped = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort('failed');
    }
    return route.continue();
  });
  await picker.getByRole('button', { name: '安排任务', exact: true }).click();
  await expect(picker.getByRole('button', { name: '重试安排', exact: true })).toBeVisible();
  await picker.getByRole('button', { name: '重试安排', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe(targetDate);
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
  const snapshot = await (
    await page.request.get(
      '/api/to-doo/state?view=calendar&from=' + targetDate + '&to=' + targetDate,
    )
  ).json();
  const occurrence = snapshot.occurrences.find((row: any) => row.taskId === created.ids[0]);
  expect(snapshot.tasks.filter((row: any) => row.title === title)).toHaveLength(1);
  expect(
    snapshot.timeBlocks.filter((row: any) => row.occurrenceId === occurrence.id && !row.deletedAt),
  ).toHaveLength(1);
});
