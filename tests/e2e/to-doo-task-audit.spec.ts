import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { goToToDooSection, selectToDooContext } from '../support/to-doo-navigation';
import {
  selectToDooOption,
  expandToDooGroup,
  expectToDooSelection,
} from '../support/to-doo-ant-controls';

async function command(page: any, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
const app = (page: any) => page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('board scope remains visible and column creation saves initial status and creation fields together', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '审查任务清单 ' + suffix },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=board&list=' + list.ids[0]);
  await expect(app(page).getByLabel('当前任务范围')).toContainText('审查任务清单');
  await selectToDooContext(page, '今天', '任务目录');
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('board');
  await expect(app(page).getByLabel('当前任务范围')).toContainText('今天');
  const doing = app(page)
    .locator('.todo-board-column')
    .filter({ has: page.getByRole('heading', { name: '进行中', exact: true }) });
  await doing.getByRole('button', { name: '＋ 添加任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '列内直接配置 ' + suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await expectToDooSelection(detail, '初始状态', '进行中');
  await expect(detail.getByLabel('计划日期', { exact: true })).not.toHaveValue('');
  await selectToDooOption(detail, '优先级', '高优先级');
  await expandToDooGroup(detail, '更多选项');
  await expect(detail.getByLabel('计划时间', { exact: true })).toHaveValue('');
  await selectToDooOption(detail, '重复', '每天');
  await detail.getByRole('button', { name: '＋ 添加提醒', exact: true }).click();
  await selectToDooOption(detail, '提醒依据', '计划时间');
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '创建任务', exact: true })).not.toBeVisible();
  const data = await (
    await page.request.get(
      '/api/to-doo/state?filter=' + encodeURIComponent(JSON.stringify({ query: title })),
    )
  ).json();
  const task = data.tasks.find((t: any) => t.title === title);
  expect(task).toMatchObject({ priority: 'high', recurrence: { frequency: 'daily' } });
  expect(task.reminders).toHaveLength(1);
  const first = data.occurrences
    .filter((o: any) => o.taskId === task.id)
    .sort((a: any, b: any) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
  expect(first.status).toBe('doing');
  expect(data.timeBlocks.find((b: any) => b.occurrenceId === first.id).start.time).toBeNull();
});

test('matrix direct editor identifies a manual override and restores automatic urgency', async ({
  page,
}, info) => {
  const title = '象限直接配置 ' + info.project.name + '-' + crypto.randomUUID();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '象限范围 ' + crypto.randomUUID() },
  });
  await command(page, 'create_task', {
    title,
    listId: list.ids[0],
    priority: 'high',
    importance: 'important',
    urgentOverride: false,
  });
  await page.goto('/?view=apps&app=to-doo&appSection=matrix&list=' + list.ids[0]);
  const item = app(page)
    .locator('.todo-quadrant-item')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await expect(item).toContainText('手动不紧急');
  await selectToDooOption(item, '设置象限 ' + title, '紧急不重要');
  await expect(app(page).locator('.todo-quadrant-delegate')).toContainText(title);
  await item.getByRole('button', { name: '恢复自动紧急判断 ' + title, exact: true }).click();
  await expect(item).not.toContainText('手动紧急');
  const data = await (
    await page.request.get(
      '/api/to-doo/state?filter=' + encodeURIComponent(JSON.stringify({ query: title })),
    )
  ).json();
  expect(data.tasks[0]).toMatchObject({
    priority: 'high',
    importance: 'normal',
    urgentOverride: null,
  });
});

test('mobile task tools and dates stay readable with board and quadrant overview jumps', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '手机任务 ' + crypto.randomUUID() },
  });
  await command(page, 'create_task', {
    title: '手机双日期行动 ' + info.project.name,
    listId: list.ids[0],
    plan: { date: '2026-11-03', time: '14:00', timeZone: 'UTC' },
    due: { date: '2026-11-04', time: '08:30', timeZone: 'UTC' },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=board&list=' + list.ids[0]);
  const tools = app(page).getByRole('button', { name: '搜索与管理', exact: true });
  await expect(tools).toBeVisible();
  await expect(app(page).getByRole('textbox', { name: '搜索任务', exact: true })).not.toBeVisible();
  await tools.click();
  await expect(app(page).getByRole('textbox', { name: '搜索任务', exact: true })).toBeVisible();
  await tools.click();
  await expect(
    app(page).getByRole('navigation', { name: '看板列概览', exact: true }),
  ).toBeVisible();
  await app(page)
    .getByRole('navigation', { name: '看板列概览', exact: true })
    .getByRole('button', { name: /进行中/ })
    .click();
  await expect(
    app(page)
      .locator('#todo-board-status-doing')
      .getByRole('heading', { name: '进行中', exact: true }),
  ).toBeInViewport();
  await app(page)
    .getByRole('navigation', { name: '看板列概览', exact: true })
    .getByRole('button', { name: /待开始/ })
    .click();
  const dates = app(page).locator('.todo-task-dates').first();
  await expect(dates).toBeVisible();
  await expect(dates).toContainText('计划');
  await expect(dates).toContainText('截止');
  await mkdir('docs/design/to-doo/two-level-implementation-2026-11-04/regression-screenshots/tasks', { recursive: true });
  await page.screenshot({
    path:
      'docs/design/to-doo/two-level-implementation-2026-11-04/regression-screenshots/tasks/mobile-board-' + info.project.name + '.png',
    fullPage: true,
    animations: 'disabled',
  });
  await goToToDooSection(page, 'matrix');
  await expect(app(page).getByRole('navigation', { name: '象限概览', exact: true })).toBeVisible();
  await app(page)
    .getByRole('navigation', { name: '象限概览', exact: true })
    .getByRole('button', { name: /不紧急不重要/ })
    .click();
  await page.screenshot({
    path:
      'docs/design/to-doo/two-level-implementation-2026-11-04/regression-screenshots/tasks/mobile-matrix-' + info.project.name + '.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('completing a filtered parent discovers its hidden child and supports cancel before cascading', async ({
  page,
}, info) => {
  const title = '筛选父项 ' + info.project.name + '-' + crypto.randomUUID();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '父子范围 ' + crypto.randomUUID() },
  });
  const parent = await command(page, 'create_task', { title, listId: list.ids[0] });
  const child = await command(page, 'create_task', {
    title: '隐藏的子任务 ' + crypto.randomUUID(),
    parentTaskId: parent.ids[0],
    listId: list.ids[0],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  await expect(app(page).locator('.todo-tree')).toBeVisible();
  const toggle = app(page).getByRole('button', { name: '搜索与管理', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await app(page).getByRole('textbox', { name: '搜索任务', exact: true }).fill(title);
  await app(page).getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(app(page).locator('.todo-task-row')).toHaveCount(1);
  await app(page)
    .getByRole('button', { name: '完成 ' + title, exact: true })
    .click();
  const confirm = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(confirm).toContainText('1 个子任务');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  let data = await (
    await page.request.get('/api/to-doo/state?taskIds=' + parent.ids[0] + '&includeTree=true')
  ).json();
  expect(
    data.occurrences
      .filter((o: any) => [parent.ids[0], child.ids[0]].includes(o.taskId))
      .map((o: any) => o.status),
  ).toEqual(['todo', 'todo']);
  await app(page)
    .getByRole('button', { name: '完成 ' + title, exact: true })
    .click();
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect
    .poll(async () => {
      data = await (
        await page.request.get('/api/to-doo/state?taskIds=' + parent.ids[0] + '&includeTree=true')
      ).json();
      return data.occurrences
        .filter((o: any) => [parent.ids[0], child.ids[0]].includes(o.taskId))
        .map((o: any) => o.status);
    })
    .toEqual(['done', 'done']);
});
