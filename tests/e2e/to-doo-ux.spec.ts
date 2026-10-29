import { readFile, mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  confirmToDooAction,
  selectToDooOption,
  toDooDisclosureHeader,
} from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test('quick add today persists its plan without opening details and keeps completed tasks folded', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app).toBeVisible();
  await app.getByRole('button', { name: '今天', exact: true }).click();
  const title = '快速今日行动 ' + info.project.name + '-' + Date.now();
  const input = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  await expect(input).toBeVisible();
  await input.fill(title);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.action === 'create_task',
  );
  await input.press('Enter');
  const response = await createdResponse;
  expect(response.ok()).toBe(true);
  const created = await response.json();
  const task = created.snapshot.tasks.find((item: any) => item.title === title);
  expect(task).toBeTruthy();
  const state = await (await page.request.get('/api/to-doo/state?taskIds=' + task.id)).json();
  const occurrence = state.occurrences.find((item: any) => item.taskId === task.id);
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: state.settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const datePart = (type: string) => dateParts.find((part) => part.type === type)!.value;
  const today = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
  expect(
    state.timeBlocks.some(
      (block: any) => block.occurrenceId === occurrence.id && block.start.date === today,
    ),
  ).toBe(true);
  await expect(input).toHaveValue('');
  await expect(app.getByRole('complementary', { name: '任务详情' })).not.toBeVisible();
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await mkdir('.sdd/to-doo-ux/screenshots', { recursive: true });
  await page.screenshot({
    path: '.sdd/to-doo-ux/screenshots/' + info.project.name + '-tasks.png',
    fullPage: true,
  });

  await app.getByRole('button', { name: '所有任务', exact: true }).click();
  await app.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(app.getByRole('button', { name: title, exact: true })).not.toBeVisible();
  await app.getByRole('button', { name: '显示已完成任务', exact: true }).click();
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await app.getByRole('button', { name: '隐藏已完成任务', exact: true }).click();
  await expect(app.getByRole('button', { name: title, exact: true })).not.toBeVisible();
  const persisted = await (await page.request.get('/api/to-doo/state?taskIds=' + task.id)).json();
  expect(persisted.occurrences.find((item: any) => item.id === occurrence.id)?.status).toBe('done');
});

test('quick add inherits the selected list and clearing filters restores tasks across views', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const suffix = info.project.name + '-' + Date.now();
  const listName = '快速清单 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'list' },
  });
  const listId = list.ids[0];
  const outsideTitle = '清单外的行动 ' + suffix;
  await command(page, 'create_task', { title: outsideTitle });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app.getByRole('heading', { name: listName, exact: true })).toBeVisible();
  const input = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  const title = '继承当前清单 ' + suffix;
  await input.fill(title);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  const state = await (await page.request.get('/api/to-doo/state?listIds=' + listId)).json();
  expect(state.tasks.find((task: any) => task.title === title)?.listId).toBe(listId);
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).not.toBeVisible();

  await app.getByRole('button', { name: /^筛选与排序/ }).click();
  await selectToDooOption(app, '筛选目标清单', '全部目标与清单');
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).toBeVisible();
  const search = app.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill(title);
  await app.getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).not.toBeVisible();
  await app.locator('.todo-view-switch').getByText('看板', { exact: true }).click();
  await expect(search).toHaveValue(title);
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).not.toBeVisible();
  await app.locator('.todo-view-switch').getByText('四象限', { exact: true }).click();
  await expect(search).toHaveValue(title);
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await app.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).toBeVisible();
  await app.locator('.todo-view-switch').getByText('列表', { exact: true }).click();
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: outsideTitle, exact: true })).toBeVisible();
});

test('quick add keeps its draft after a failed POST and retries into real server data', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const form = app.getByRole('form', { name: '快速添加任务', exact: true });
  const input = form.getByRole('textbox', { name: '快速添加任务', exact: true });
  const title = '失败后保留快速输入 ' + info.project.name + '-' + Date.now();
  await expect(input).toBeVisible();
  await page.route(
    '**/api/to-doo/commands',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: '快速添加暂时不可用，请重试' },
      }),
    { times: 1 },
  );
  await input.fill(title);
  await form.getByRole('button', { name: '添加任务', exact: true }).click();
  await expect(app.getByRole('alert')).toContainText('快速添加暂时不可用');
  await expect(input).toHaveValue(title);
  await expect(app.getByRole('complementary', { name: '任务详情' })).not.toBeVisible();
  await app.getByRole('button', { name: '重试原操作', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(app.getByRole('complementary', { name: '任务详情' })).not.toBeVisible();
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  const state = await (
    await page.request.get(
      '/api/to-doo/state?filter=' + encodeURIComponent(JSON.stringify({ query: title })),
    )
  ).json();
  expect(state.tasks.filter((task: any) => task.title === title)).toHaveLength(1);
});

test('today and inbox quick navigation survive reload and browser history', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app).toBeVisible();
  await app.getByRole('button', { name: '今天', exact: true }).click();
  await expect(app.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('today');
  await page.reload();
  await expect(app.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('today');

  await app.getByRole('button', { name: '收集箱', exact: true }).click();
  await expect(app.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('inbox');
  await page.goBack();
  await expect(app.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('today');
  await page.goForward();
  await expect(app.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('inbox');
});

test('wide task details continue the quick draft and submit exactly one real task', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const quickForm = app.getByRole('form', { name: '快速添加任务', exact: true });
  const title = '从快速输入继续编辑 ' + info.project.name + '-' + Date.now();
  await quickForm.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title);
  await quickForm.getByRole('button', { name: '详细添加', exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(quickForm).not.toBeVisible();
  await expect(app.getByRole('heading', { name: '所有任务', exact: true })).toBeVisible();
  await expect(toDooDisclosureHeader(detail, '更多选项')).toBeVisible();
  await expect(detail.getByLabel('截止日期', { exact: true })).not.toBeVisible();
  await expect(detail.getByLabel('完成标准', { exact: true })).not.toBeVisible();
  await mkdir('.sdd/to-doo-ux/screenshots', { recursive: true });
  await page.screenshot({
    path: '.sdd/to-doo-ux/screenshots/' + info.project.name + '-detail.png',
    fullPage: true,
  });
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeVisible();
  const state = await (
    await page.request.get(
      '/api/to-doo/state?filter=' + encodeURIComponent(JSON.stringify({ query: title })),
    )
  ).json();
  expect(state.tasks.filter((task: any) => task.title === title)).toHaveLength(1);
});

test('discarding a wide new-task detail clears its original list draft and preserves another list', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const suffix = info.project.name + '-' + Date.now();
  const listAName = '草稿清单 A ' + suffix;
  const listBName = '草稿清单 B ' + suffix;
  const listA = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listAName, kind: 'list' },
  });
  const listB = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listBName, kind: 'list' },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listB.ids[0]);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const sidebar = app.locator('.todo-sidebar');
  const input = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  const titleA = '放弃 A 中的草稿 ' + suffix;
  const titleB = '保留 B 中的草稿 ' + suffix;
  await expect(app.getByRole('heading', { name: listBName, exact: true })).toBeVisible();
  await input.fill(titleB);
  await sidebar.getByRole('button', { name: listAName, exact: true }).click();
  await expect(app.getByRole('heading', { name: listAName, exact: true })).toBeVisible();
  await input.fill(titleA);
  await app.getByRole('button', { name: '详细添加', exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(titleA);

  await sidebar.getByRole('button', { name: listBName, exact: true }).click();
  await expect(app.getByRole('heading', { name: listBName, exact: true })).toBeVisible();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(titleA);
  await detail.getByRole('button', { name: '放弃这份新建草稿', exact: true }).click();
  await confirmToDooAction(page);
  await expect(detail).not.toBeVisible();
  await expect(input).toHaveValue(titleB);
  await sidebar.getByRole('button', { name: listAName, exact: true }).click();
  await expect(app.getByRole('heading', { name: listAName, exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await sidebar.getByRole('button', { name: listBName, exact: true }).click();
  await expect(app.getByRole('heading', { name: listBName, exact: true })).toBeVisible();
  await expect(input).toHaveValue(titleB);
});

test('quick entry stays usable in a 320px dark workspace', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await app.getByRole('button', { name: '今天', exact: true }).click();
  const input = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  const title = '窄屏快速行动 ' + info.project.name + '-' + Date.now();
  await input.fill(title);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(app.getByRole('complementary', { name: '任务详情' })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(app.getByRole('button', { name: '详细添加', exact: true })).toBeVisible();
  await mkdir('.sdd/to-doo-ux/screenshots', { recursive: true });
  await page.screenshot({
    path: '.sdd/to-doo-ux/screenshots/' + info.project.name + '-320-dark-quick-entry.png',
    fullPage: true,
  });
});

test('deleting a list immediately removes it from the sidebar catalog', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const name = '待移除清单 ' + info.project.name + '-' + Date.now();
  await command(page, 'save_entity', { kind: 'list', entity: { name, kind: 'list' } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const entry = app.locator('.todo-sidebar nav').getByRole('button', { name, exact: true });
  await entry.click();
  await app.getByRole('button', { name: '编辑当前清单', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑目标与清单', exact: true })
    .getByRole('button', { name: '移入回收站', exact: true })
    .click();
  await confirmToDooAction(page);
  await expect(page.getByRole('dialog', { name: '编辑目标与清单', exact: true })).not.toBeVisible();
  await expect(entry).not.toBeVisible();
});

test('retrying a deleted list refreshes the sidebar after its editor was closed', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const name = '待重试移除清单 ' + info.project.name + '-' + Date.now();
  await command(page, 'save_entity', { kind: 'list', entity: { name, kind: 'list' } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const entry = app.locator('.todo-sidebar nav').getByRole('button', { name, exact: true });
  await entry.click();
  await app.getByRole('button', { name: '编辑当前清单', exact: true }).click();
  await page.route(
    '**/api/to-doo/commands',
    (route) => route.fulfill({ status: 503, json: { error: '删除暂时不可用' } }),
    { times: 1 },
  );
  const editor = page.getByRole('dialog', { name: '编辑目标与清单', exact: true });
  await editor.getByRole('button', { name: '移入回收站', exact: true }).click();
  await confirmToDooAction(page);
  await expect(editor.getByRole('alert')).toContainText('删除暂时不可用');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(entry).toBeVisible();
  await app.getByRole('button', { name: '重试原操作', exact: true }).click();
  await expect(entry).not.toBeVisible();
});

test.describe('quick view time zones', () => {
  test.use({ timezoneId: 'UTC' });

  test('initial today quick view uses the loaded workspace time zone across midnight', async ({
    page,
    context,
  }, info) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    const title = '上海次日行动 ' + info.project.name + '-' + Date.now();
    await command(page, 'create_task', {
      title,
      plan: { date: '2026-10-30', time: null, timeZone: 'Asia/Shanghai' },
    });
    await page.clock.install({ time: new Date('2026-10-29T23:30:00Z') });
    const requestedDates: string[] = [];
    await page.route('**/api/to-doo/state?**', async (route) => {
      const filter = JSON.parse(new URL(route.request().url()).searchParams.get('filter') || '{}');
      if (typeof filter.from === 'string') requestedDates.push(filter.from);
      const response = await route.fetch();
      const snapshot = await response.json();
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          settings: { ...snapshot.settings, timeZone: 'Asia/Shanghai' },
        },
      });
    });
    await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
    await expect(app.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
    await expect
      .poll(() => requestedDates.at(-1), {
        message: 'Today must load October 30 in the workspace time zone at 23:30 UTC',
      })
      .toBe('2026-10-30');
    await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
    // Drain timezone-rewriting responses before fixture teardown closes their request context.
    await page.unrouteAll({ behavior: 'wait' });
  });
});
