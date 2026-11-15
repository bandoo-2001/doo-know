import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { confirmToDooAction } from '../support/to-doo-ant-controls';
import { selectToDooList, selectToDooQuickView } from '../support/to-doo-navigation';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ToDooCommandResult;
}

async function fixture(page: Page) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listName = '找回任务的原清单 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'list' },
  });
  const title = '保留整理好的旅行资料 ' + suffix;
  const parent = await command(page, 'create_task', {
    title,
    listId: list.ids[0],
    initialStatus: 'doing',
  });
  const childTitle = '检查行程资料 ' + suffix;
  const child = await command(page, 'create_task', {
    title: childTitle,
    listId: list.ids[0],
    parentTaskId: parent.ids[0],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  return {
    listId: list.ids[0],
    listName,
    id: parent.ids[0],
    childId: child.ids[0],
    title,
    childTitle,
  };
}

async function taskSnapshot(page: Page, id: string) {
  const response = await page.request.get(
    '/api/to-doo/state?taskIds=' +
      id +
      '&includeTree=true&filter=' +
      encodeURIComponent(JSON.stringify({ includeDeleted: true, includeArchived: true })),
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as ToDooSnapshot;
}

async function expectOriginalTasks(page: Page, data: Awaited<ReturnType<typeof fixture>>) {
  await selectToDooList(page, data.listName);
  await expect(page.locator('.todo-page h1')).toHaveText(data.listName);
  await expect(page.getByRole('button', { name: data.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: data.childTitle, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: data.title, exact: true })).toBeVisible();
  const snapshot = await taskSnapshot(page, data.id);
  for (const id of [data.id, data.childId]) {
    expect(snapshot.tasks.find((task) => task.id === id)).toMatchObject({
      listId: data.listId,
      deletedAt: null,
      archivedAt: null,
    });
  }
  expect(snapshot.occurrences.find((occurrence) => occurrence.taskId === data.id)?.status).toBe(
    'doing',
  );
  expect(
    snapshot.occurrences.find((occurrence) => occurrence.taskId === data.childId)?.status,
  ).toBe('todo');
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('a deleted task has one direct recovery action and returns with its children to the original list', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.getByRole('button', { name: '任务操作 ' + data.title, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
  await confirmToDooAction(page);
  await expect(page.getByRole('button', { name: data.title, exact: true })).not.toBeVisible();

  await selectToDooQuickView(page, '回收站');
  await expect(page.getByRole('button', { name: data.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '任务操作 ' + data.title, exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['恢复任务']);
  await menu.getByRole('menuitem', { name: '恢复任务', exact: true }).click();
  await expect(page.getByText('已恢复「' + data.title + '」', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: data.title, exact: true })).not.toBeVisible();
  await expectOriginalTasks(page, data);
});

test('an archived task can be unarchived directly without changing its execution state', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.getByRole('button', { name: '任务操作 ' + data.title, exact: true }).click();
  await page.getByRole('menuitem', { name: '归档任务', exact: true }).click();
  await expect(page.getByRole('button', { name: data.title, exact: true })).not.toBeVisible();

  await selectToDooQuickView(page, '已归档');
  await expect(page.getByRole('button', { name: data.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '任务操作 ' + data.title, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '归档任务', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  await expect(page.getByText('已取消归档「' + data.title + '」', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: data.title, exact: true })).not.toBeVisible();
  await expectOriginalTasks(page, data);
});

test('completed tasks stay visible and keep their completed state when recovered from trash and archive', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '保留已经完成的旅行准备 ' + suffix;
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '完成任务的原清单 ' + suffix, kind: 'list' },
  });
  const created = await command(page, 'create_task', { title, listId: list.ids[0] });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  const task = page.getByRole('button', { name: title, exact: true });
  await expect(task).toBeVisible();
  await page.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(task).not.toBeVisible();
  await selectToDooQuickView(page, '已完成');
  await expect(task).toBeVisible();
  await page.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
  await confirmToDooAction(page);
  await expect(task).not.toBeVisible();

  await selectToDooQuickView(page, '回收站');
  await expect(task).toBeVisible();
  const reopen = page.getByRole('button', { name: '重新打开 ' + title, exact: true });
  await expect(reopen).toBeDisabled();
  await expect(page.locator('.todo-task-row').filter({ has: task })).toHaveClass(/is-done/);
  await page.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复任务', exact: true }).click();
  await expect(task).not.toBeVisible();
  await selectToDooQuickView(page, '已完成');
  await expect(task).toBeVisible();
  await expect(reopen).toBeEnabled();
  let snapshot = await taskSnapshot(page, created.ids[0]);
  expect(snapshot.occurrences.find((item) => item.taskId === created.ids[0])?.status).toBe('done');

  await page.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menuitem', { name: '归档任务', exact: true }).click();
  await expect(task).not.toBeVisible();
  await selectToDooQuickView(page, '已归档');
  await expect(task).toBeVisible();
  await expect(reopen).toBeDisabled();
  await expect(page.locator('.todo-task-row').filter({ has: task })).toHaveClass(/is-done/);
  await page.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  await expect(task).not.toBeVisible();
  await selectToDooQuickView(page, '已完成');
  await expect(task).toBeVisible();
  await expect(reopen).toBeEnabled();
  await page.reload();
  await expect(task).toBeVisible();
  snapshot = await taskSnapshot(page, created.ids[0]);
  expect(snapshot.tasks.find((item) => item.id === created.ids[0])).toMatchObject({
    listId: list.ids[0],
    deletedAt: null,
    archivedAt: null,
  });
  expect(snapshot.occurrences.find((item) => item.taskId === created.ids[0])?.status).toBe('done');
});
