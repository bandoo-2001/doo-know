import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expectToDooSelection } from '../support/to-doo-ant-controls';
import { selectToDooList } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
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

const taskDetail = (page: Page) =>
  page.getByRole('complementary', { name: '任务详情', exact: true });

test('a new task creates its list in place without submitting the task or losing input', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '整理读书资料 ' + suffix;
  const description = '先把这段任务说明保留，再给它创建清单。';
  const listName = '阅读资料 ' + suffix;
  let taskWrites = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON().action === 'create_task'
    )
      taskWrites++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByLabel('新建任务', { exact: true }).click();
  const detail = taskDetail(page);
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByLabel('任务说明', { exact: true }).fill(description);
  await detail.getByRole('button', { name: '在任务中创建清单', exact: true }).click();
  const createList = detail.getByRole('group', { name: '新建清单', exact: true });
  await createList.getByRole('textbox', { name: '新清单名称', exact: true }).fill('暂不创建');
  await createList.getByRole('button', { name: '取消', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  await detail.getByRole('button', { name: '在任务中创建清单', exact: true }).click();
  await createList.getByRole('textbox', { name: '新清单名称', exact: true }).fill(listName);
  await createList.getByRole('textbox', { name: '新清单名称', exact: true }).press('Enter');
  await expect(createList).toHaveCount(0);
  await expectToDooSelection(detail, '目标或清单', listName);
  expect(taskWrites).toBe(0);
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  expect(taskWrites).toBe(1);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await selectToDooList(page, listName);
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expectToDooSelection(taskDetail(page), '所属目标或清单', listName);
  await expect(taskDetail(page).getByLabel('任务说明', { exact: true })).toHaveValue(description);
});

test('an existing task keeps unsaved edits while creating and selecting a new list', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const original = '尚未整理的任务 ' + suffix;
  const edited = '安排阅读与整理 ' + suffix;
  const listName = '学习计划 ' + suffix;
  const created = await command(page, 'create_task', { title: original });
  const taskId = created.ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox&task=' + taskId);
  const detail = taskDetail(page);
  await detail.getByLabel('任务标题', { exact: true }).fill(edited);
  await detail
    .getByLabel('任务说明', { exact: true })
    .fill('这段尚未保存的内容不能因新建清单而丢失。');
  await detail.getByRole('button', { name: '在任务中创建清单', exact: true }).click();
  await detail.getByRole('textbox', { name: '新清单名称', exact: true }).fill(listName);
  await detail.getByRole('button', { name: '创建清单', exact: true }).click();
  await expectToDooSelection(detail, '所属目标或清单', listName);
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  await expect(detail.getByText('未保存的更改', { exact: true })).toBeVisible();
  const unsaved = await (
    await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')
  ).json();
  expect(unsaved.tasks.find((task: any) => task.id === taskId)).toMatchObject({
    title: original,
    listId: null,
  });
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(taskDetail(page).getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  await expectToDooSelection(taskDetail(page), '所属目标或清单', listName);
});

test('retrying a list creation with a lost response does not create a second list', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listName = '可靠创建 ' + suffix;
  let lost = false;
  await page.route('**/api/to-doo/commands', async (route) => {
    const request = route.request().postDataJSON();
    if (!lost && request.action === 'save_entity' && request.payload.kind === 'list') {
      lost = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByLabel('新建任务', { exact: true }).click();
  const detail = taskDetail(page);
  await detail.getByLabel('任务标题', { exact: true }).fill('有待整理 ' + suffix);
  await detail.getByRole('button', { name: '在任务中创建清单', exact: true }).click();
  await detail.getByRole('textbox', { name: '新清单名称', exact: true }).fill(listName);
  await detail.getByRole('button', { name: '创建清单', exact: true }).click();
  const retry = detail.getByRole('button', { name: '重试创建清单', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expectToDooSelection(detail, '目标或清单', listName);
  const snapshot = await (await page.request.get('/api/to-doo/state?kind=list&limit=1000')).json();
  expect(snapshot.lists.filter((list: any) => list.name === listName)).toHaveLength(1);
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue('有待整理 ' + suffix);
});
