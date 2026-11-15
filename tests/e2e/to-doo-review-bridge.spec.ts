import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  expandToDooGroup,
  fillToDooDate,
  selectToDooOption,
  expectToDooSelection,
} from '../support/to-doo-ant-controls';
import {
  goToToDooSection,
  selectToDooList,
  selectToDooQuickView,
} from '../support/to-doo-navigation';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function appliedRange(page: Page, from: string, to: string) {
  await page.getByText('自定义', { exact: true }).click();
  await fillToDooDate(page.getByLabel('统计开始日期', { exact: true }), from);
  await fillToDooDate(page.getByLabel('统计结束日期', { exact: true }), to);
  await page.getByRole('button', { name: '查看区间', exact: true }).click();
  await expect(page.locator('.todo-completion-chart')).toHaveAttribute(
    'aria-label',
    new RegExp(from + ' — ' + to),
  );
}
const shift = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  await page.clock.install({ time: new Date(snapshot.now) });
});

test('a review uses its applied dates and starts an explicit next task without losing the source', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = '阅读与执行复盘 ' + suffix;
  const listName = '阅读实践目标 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'goal' },
  });
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: snapshot.settings.timeZone }).format(
    new Date(snapshot.now),
  );
  const from = shift(today, -2),
    to = today;
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  await appliedRange(page, from, to);
  await page.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建复盘', exact: true });
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('复盘 ' + from + ' — ' + to);
  await expect(editor.getByLabel('开始日期', { exact: true })).toHaveValue(from);
  await expect(editor.getByLabel('结束日期', { exact: true })).toHaveValue(to);
  await expect(editor.getByLabel('复盘内容', { exact: true })).toHaveValue(/下一步行动/);
  await editor.getByLabel('名称', { exact: true }).fill(name);
  const content = '本期收获：已把阅读落实到练习。\n下一步行动：整理实践中的问题。';
  await editor.getByLabel('复盘内容', { exact: true }).fill(content);
  await expandToDooGroup(editor, '补充信息');
  await selectToDooOption(editor, '关联目标或清单', listName);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByRole('tab', { name: '历史复盘', exact: true }).click();
  const review = page.getByRole('article', { name: '复盘 ' + name, exact: true });
  await expect(review).toContainText(from + ' — ' + to);
  let taskWrites = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'create_task'
    )
      taskWrites++;
  });
  await review.getByRole('button', { name: '＋ 添加下一步任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue('');
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(
    new RegExp('来自复盘「' + name + '」'),
  );
  expect(await detail.getByLabel('任务说明', { exact: true }).inputValue()).toContain(content);
  await expectToDooSelection(detail, '目标或清单', listName);
  expect(taskWrites).toBe(0);
  const taskTitle = '整理实践中的问题 ' + suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(taskTitle);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  expect(taskWrites).toBe(1);
  const tasks = await (
    await page.request.get(
      '/api/to-doo/state?kind=task&filter=' +
        encodeURIComponent(JSON.stringify({ query: taskTitle })),
    )
  ).json();
  const stored = tasks.tasks.find((task: any) => task.title === taskTitle);
  expect(stored).toMatchObject({ listId: list.ids[0], description: expect.stringContaining(name) });
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await selectToDooList(page, listName);
  await expect(page.getByRole('button', { name: taskTitle, exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: taskTitle, exact: true }).click();
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(new RegExp(name));
});

test('review goal progress and completion totals lead to real task destinations', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listName = '可以打开行动的目标 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'goal' },
  });
  const next = '继续实践与记录 ' + suffix;
  await command(page, 'create_task', { title: next, listId: list.ids[0] });
  const finished = await command(page, 'create_task', {
    title: '已完成的阅读行动 ' + suffix,
    listId: list.ids[0],
  });
  const occurrence = finished.snapshot.occurrences.find(
    (row: any) => row.taskId === finished.ids[0],
  );
  await command(page, 'set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  await page.getByRole('tab', { name: '目标进展', exact: true }).click();
  await page.getByRole('button', { name: '查看目标任务 ' + listName, exact: true }).click();
  await expect(page.locator('.todo-page h1')).toHaveText(listName);
  await expect(page.getByRole('button', { name: next, exact: true })).toBeVisible();
  await goToToDooSection(page, 'stats');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '查看全部已完成任务', exact: true }).click();
  await expect(page.locator('.todo-page h1')).toHaveText('已完成');
  await expect(
    page.getByRole('button', { name: '已完成的阅读行动 ' + suffix, exact: true }),
  ).toBeVisible();
});

test('review history links preserve the selected range when the user returns', async ({ page }) => {
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: snapshot.settings.timeZone }).format(
    new Date(snapshot.now),
  );
  const from = shift(today, -23),
    to = shift(today, -17);
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  await appliedRange(page, from, to);
  await page.getByRole('button', { name: '查看专注记录', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('focus');
  const history = page.getByRole('complementary', { name: '专注概览和历史', exact: true });
  await expect(history).toBeVisible();
  await expect(history.getByLabel('专注开始日期', { exact: true })).toHaveValue(from);
  await expect(history.getByLabel('专注结束日期', { exact: true })).toHaveValue(to);
  await goToToDooSection(page, 'stats');
  await expect(page.locator('.todo-completion-chart')).toHaveAttribute(
    'aria-label',
    new RegExp(from + ' — ' + to),
  );
  await page.getByRole('button', { name: '查看习惯记录', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('habits');
  await expect(page.getByRole('radio', { name: '历史', exact: true })).toBeChecked();
  const weekday = new Date(to + 'T12:00:00Z').getUTCDay();
  const weekStart = shift(to, -((weekday - snapshot.settings.weekStartsOn + 7) % 7));
  await expect(page.locator('.todo-calendar-toolbar h2')).toContainText(weekStart);
  await goToToDooSection(page, 'stats');
  await expect(page.locator('.todo-completion-chart')).toHaveAttribute(
    'aria-label',
    new RegExp(from + ' — ' + to),
  );
});

test('opening an ordinary inbox task first does not discard the next review task source', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const existingTitle = '普通收集事项 ' + suffix;
  const existing = await command(page, 'create_task', { title: existingTitle });
  await page.goto(
    '/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox&task=' + existing.ids[0],
  );
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(existingTitle);
  await detail.getByRole('button', { name: '＋ 添加说明', exact: true }).click();
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue('');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await goToToDooSection(page, 'stats');
  await page.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建复盘', exact: true });
  const name = '无清单复盘 ' + suffix;
  const content = '下一步：整理新的资料并验证改进。';
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('复盘内容', { exact: true }).fill(content);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByRole('tab', { name: '历史复盘', exact: true }).click();
  const review = page.getByRole('article', { name: '复盘 ' + name, exact: true });
  let taskWrites = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'create_task'
    )
      taskWrites++;
  });
  await review.getByRole('button', { name: '＋ 添加下一步任务', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue('');
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(
    new RegExp('来自复盘「' + name + '」'),
  );
  expect(await detail.getByLabel('任务说明', { exact: true }).inputValue()).toContain(content);
  await expectToDooSelection(detail, '目标或清单', '收集箱');
  expect(taskWrites).toBe(0);
  const title = '接续复盘的资料整理 ' + suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  expect(taskWrites).toBe(1);
  const saved = await (
    await page.request.get(
      '/api/to-doo/state?kind=task&filter=' + encodeURIComponent(JSON.stringify({ query: title })),
    )
  ).json();
  expect(saved.tasks.find((task: any) => task.title === title)).toMatchObject({
    listId: null,
    description: expect.stringContaining(name),
  });
  const original = await (
    await page.request.get('/api/to-doo/state?taskIds=' + existing.ids[0])
  ).json();
  expect(original.tasks.find((task: any) => task.id === existing.ids[0])).toMatchObject({
    title: existingTitle,
    listId: null,
    description: '',
  });
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await selectToDooQuickView(page, '收集箱');
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(new RegExp(name));
});
