import { openToDooTaskTools } from '../support/to-doo-navigation';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(page: Page) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '系统架构师 ' + suffix, kind: 'list' },
  });
  const groups = [];
  for (const [name, orderKey] of [
    ['导论', 'a'],
    ['基础', 'b'],
  ])
    groups.push(
      await command(page, 'save_entity', {
        kind: 'section',
        entity: { listId: list.ids[0], name, orderKey },
      }),
    );
  const parent = await command(page, 'create_task', {
    title: '学习架构定义 ' + suffix,
    listId: list.ids[0],
    sectionId: groups[0].ids[0],
  });
  const child = await command(page, 'create_task', {
    title: '整理生命周期 ' + suffix,
    parentTaskId: parent.ids[0],
    listId: list.ids[0],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  return {
    suffix,
    listId: list.ids[0],
    groupId: groups[0].ids[0],
    secondGroupId: groups[1].ids[0],
    parentId: parent.ids[0],
    childId: child.ids[0],
    title: '学习架构定义 ' + suffix,
    childTitle: '整理生命周期 ' + suffix,
  };
}
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('lean board cards retain the list context and group children without default fields', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.getByText('看板', { exact: true }).click();
  await expect(page.locator('.todo-page h1')).toHaveText('系统架构师 ' + f.suffix);
  const card = page.getByRole('article', { name: '任务 ' + f.title, exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText(f.childTitle);
  await expect(card.getByRole('combobox', { name: '修改任务状态', exact: true })).toHaveCount(0);
  await expect(card).not.toContainText('无优先级');
  await expect(card).not.toContainText('未安排');
  await card.getByRole('button', { name: '任务操作 ' + f.title, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '添加子任务', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: '添加子任务', exact: true })).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath('board-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('list groups collapse and insert adjacent groups while deleting a group preserves its tasks', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: '折叠分组 导论', exact: true }).click();
  await expect(page.getByRole('button', { name: f.title, exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '展开分组 导论', exact: true }).click();
  await expect(page.getByRole('button', { name: f.childTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分组操作 导论', exact: true }).click();
  await page.getByRole('menuitem', { name: '在下方添加分组', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建分组', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill('补充内容');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('.todo-task-group-heading h2')).toHaveText([
    '导论',
    '补充内容',
    '基础',
  ]);
  await page.getByRole('button', { name: '分组操作 导论', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除分组', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(confirm).toContainText('保留');
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: f.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: f.childTitle, exact: true })).toBeVisible();
});

test('task details put existing subtasks first and expose empty settings on demand', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: f.title, exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByRole('button', { name: f.childTitle, exact: false })).toBeVisible();
  await expect(detail).not.toContainText('未关联');
  await expect(detail).not.toContainText('未设置');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: info.project.name === 'mobile' ? 320 : 1440, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('detail-' + theme + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '编辑任务提醒', exact: true }).click();
  await expect(detail.getByRole('button', { name: '＋ 添加提醒', exact: true })).toBeInViewport();
});

test('context menu copy, priority and subtree move leave multi-selection untouched', async ({
  page,
}, info) => {
  const f = await fixture(page);
  const otherTitle = '保留选择 ' + f.suffix;
  await command(page, 'create_task', { title: otherTitle, listId: f.listId });
  const destination = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '工作 ' + f.suffix },
  });
  await page.reload();
  await openToDooTaskTools(page);
  await page.getByRole('button', { name: '任务管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '多选', exact: true }).click();
  const selected = page.getByRole('checkbox', { name: '选择 ' + otherTitle, exact: true });
  await selected.check();
  const row = page
    .locator('.todo-task-row')
    .filter({ has: page.getByRole('button', { name: f.title, exact: true }) });
  if (info.project.name === 'mobile')
    await row.getByRole('button', { name: '任务操作 ' + f.title, exact: true }).click();
  else await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect(page.getByRole('button', { name: f.title + ' 副本', exact: true })).toBeVisible();
  await expect(selected).toBeChecked();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row.getByRole('button', { name: '任务操作 ' + f.title, exact: true }).click();
  await page.getByRole('menu').getByText('优先级', { exact: true }).click();
  await page.getByRole('menuitem', { name: '高优先级', exact: true }).click();
  await expect(row).toContainText('高优先级');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row.getByRole('button', { name: '任务操作 ' + f.title, exact: true }).click();
  await page.getByRole('menu').getByText('移动到', { exact: true }).click();
  await page.getByRole('menuitem', { name: '工作 ' + f.suffix, exact: true }).click();
  await expect(page.getByRole('button', { name: f.title, exact: true })).not.toBeVisible();
  await expect(selected).toBeChecked();
  const stored = await (
    await page.request.get('/api/to-doo/state?taskIds=' + f.parentId + '&includeTree=true')
  ).json();
  expect(
    stored.tasks
      .filter((task: any) => [f.parentId, f.childId].includes(task.id))
      .map((task: any) => task.listId),
  ).toEqual([destination.ids[0], destination.ids[0]]);
});

test('group creation and view switching preserve the group, list and selected task', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: '添加任务到分组 基础', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '理解计算机组成 ' + f.suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  if (info.project.name === 'mobile') {
    await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(detail).not.toBeVisible();
  }
  for (const view of ['看板', '时间线', '列表']) {
    await page.getByText(view, { exact: true }).last().click();
    await expect(page.locator('.todo-page h1')).toHaveText('系统架构师 ' + f.suffix);
    if (info.project.name === 'mobile') {
      await page.getByRole('button', { name: title, exact: true }).click();
      await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
      await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await expect(detail).not.toBeVisible();
    } else await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
    if (view === '时间线') {
      await expect(
        page.getByRole('textbox', { name: '连续安排开始时间', exact: true }),
      ).not.toBeVisible();
      await page.locator('.todo-plan-disclosure .ant-collapse-header').click();
      await expect(
        page.getByRole('textbox', { name: '连续安排开始时间', exact: true }),
      ).toBeVisible();
    }
  }
  const stored = await (await page.request.get('/api/to-doo/state?kind=task&limit=1000')).json();
  expect(stored.tasks.find((task: any) => task.title === title)).toMatchObject({
    listId: f.listId,
    sectionId: f.secondGroupId,
  });
});

test('a board child context menu opens that child rather than its parent', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.getByText('看板', { exact: true }).click();
  const child = page
    .locator('.todo-board-subtask')
    .filter({ has: page.getByRole('button', { name: f.childTitle, exact: true }) });
  if (info.project.name === 'mobile')
    await child.getByRole('button', { name: '任务操作 ' + f.childTitle, exact: true }).click();
  else await child.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '打开任务详情', exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: '任务详情', exact: true })
      .getByLabel('任务标题', { exact: true }),
  ).toHaveValue(f.childTitle);
});

test('switching a new task to another list clears its original group', async ({ page }) => {
  const f = await fixture(page);
  const destinationName = '新清单 ' + f.suffix;
  const destination = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: destinationName },
  });
  await page.reload();
  await page.getByRole('button', { name: '添加任务到分组 基础', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '切换清单后保存 ' + f.suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await selectToDooOption(detail, '目标或清单', destinationName);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  const stored = await (await page.request.get('/api/to-doo/state?kind=task&limit=1000')).json();
  expect(stored.tasks.find((task: any) => task.title === title)).toMatchObject({
    listId: destination.ids[0],
    sectionId: null,
  });
});

test('searching only a child preserves its inherited group', async ({ page }) => {
  const f = await fixture(page);
  await openToDooTaskTools(page);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill(f.childTitle);
  await page.getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(
    page
      .locator('.todo-task-group')
      .filter({ has: page.getByRole('heading', { name: '导论', exact: true }) })
      .getByRole('button', { name: f.childTitle, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: f.title, exact: true })).not.toBeVisible();
});
