import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  expectToDooSelection,
  fillToDooDate,
  selectToDooOption,
} from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

async function openListHabits(page: Page) {
  await page.getByRole('button', { name: '任务显示与管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '组织清单', exact: true }).click();
  await page.getByRole('menuitem', { name: '清单习惯', exact: true }).click();
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const state = await (await page.request.get('/api/to-doo/state')).json();
  await page.clock.install({ time: new Date(state.now) });
});

test('a habit links to its task list and check-in or undo never completes those tasks', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listName = '持续阅读计划 ' + suffix;
  const name = '每天阅读 ' + suffix;
  const taskTitle = '整理这一章的要点 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'list' },
  });
  const created = await command(page, 'create_task', {
    title: taskTitle,
    listId: list.ids[0],
    initialStatus: 'doing',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .locator('.todo-page-heading')
    .getByRole('button', { name: /新建习惯/ })
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  // The association belongs to the basic form, so no extra options need opening.
  await expect(editor.getByRole('combobox', { name: '关联目标或清单', exact: true })).toBeVisible();
  await selectToDooOption(editor, '关联目标或清单', listName);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await card.getByRole('button', { name: '查看 ' + listName + ' 的任务', exact: true }).click();
  await expect(page.locator('.todo-page h1')).toHaveText(listName);
  await expect(page.getByRole('button', { name: taskTitle, exact: true })).toBeVisible();
  await openListHabits(page);
  await expect.poll(() => new URL(page.url()).searchParams.get('list')).toBe(list.ids[0]);
  await expect(page.getByLabel('当前习惯范围', { exact: true })).toContainText(listName);
  await card.getByRole('button', { name: '打卡 ' + name, exact: true }).click();
  await expect(card).toContainText('今天已打卡');
  let state = await (await page.request.get('/api/to-doo/state?taskIds=' + created.ids[0])).json();
  expect(state.occurrences.find((row: any) => row.taskId === created.ids[0])?.status).toBe('doing');
  await card.getByRole('button', { name: '撤销今天记录 ' + name, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '撤销习惯记录', exact: true });
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await expect(card).toContainText('今天待打卡');
  await page.reload();
  await expect(card).toContainText('今天待打卡');
  state = await (await page.request.get('/api/to-doo/state?taskIds=' + created.ids[0])).json();
  expect(state.occurrences.find((row: any) => row.taskId === created.ids[0])?.status).toBe('doing');
});

test('creating a habit from a list retains that list and can return to all habits', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listName = '散步与健康 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'list' },
  });
  const otherList = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '其他计划 ' + suffix, kind: 'list' },
  });
  const state = await (await page.request.get('/api/to-doo/state')).json();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: state.settings.timeZone }).format(
    new Date(state.now),
  );
  const otherName = '别的清单习惯 ' + suffix;
  await command(page, 'save_entity', {
    kind: 'habit',
    entity: { name: otherName, listId: otherList.ids[0], startDate: date, goalMode: 'checkin' },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  await openListHabits(page);
  const empty = page.locator('.todo-habit-cards .ant-empty');
  await expect(empty).toContainText('这个清单还没有关联习惯');
  await empty.getByRole('button', { name: '新建习惯', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await expectToDooSelection(editor, '关联目标或清单', listName);
  const name = '晚饭后散步 ' + suffix;
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('article', { name: '习惯 ' + name, exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '习惯 ' + otherName, exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '查看全部习惯', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('list')).toBe(false);
  await expect(page.getByRole('article', { name: '习惯 ' + otherName, exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '习惯 ' + name, exact: true })).toBeVisible();
});

test('a review opens habit history at the reviewed week and the Today tab stays usable', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: snapshot.settings.timeZone }).format(
    new Date(snapshot.now),
  );
  const from = shift(today, -20),
    to = shift(today, -10);
  const name = '复盘里的阅读记录 ' + crypto.randomUUID().slice(0, 8);
  const habit = await command(page, 'save_entity', {
    kind: 'habit',
    entity: { name, startDate: from, goalMode: 'checkin', timeZone: snapshot.settings.timeZone },
  });
  await command(page, 'checkin_habit', {
    habitId: habit.ids[0],
    localDate: to,
    amount: 1,
    note: '',
    skipped: false,
    sourceSessionId: null,
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByText('自定义', { exact: true }).click();
  await fillToDooDate(app.getByRole('textbox', { name: '统计开始日期', exact: true }), from);
  await fillToDooDate(app.getByRole('textbox', { name: '统计结束日期', exact: true }), to);
  const loaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/to-doo/state' &&
      url.searchParams.get('view') === 'stats' &&
      url.searchParams.get('from') === from &&
      url.searchParams.get('to') === to
    );
  });
  await app.getByRole('button', { name: '查看区间', exact: true }).click();
  await loaded;
  await app.getByRole('button', { name: '查看习惯记录', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('habits');
  await expect(app.locator('.todo-habit-table')).toBeVisible();
  const cell = app.getByRole('button', { name: name + ' ' + to + ' 打卡，当前 1 次', exact: true });
  await expect(cell).toBeVisible();
  await app.locator('.todo-calendar-toolbar').getByText('今天', { exact: true }).click();
  await expect(app.locator('.todo-habit-cards')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
