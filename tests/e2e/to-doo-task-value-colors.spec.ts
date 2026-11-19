import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup } from '../support/to-doo-ant-controls';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function openValueOptions(page: Page, detail: Locator, name: string) {
  const control = detail.getByRole('combobox', { name, exact: true });
  const selector = control.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
  await selector.locator('.ant-select-selector').click();
  return { control, selector, popup: page.locator('.ant-select-dropdown:visible') };
}
async function colors(scope: Locator, kind: 'priority' | 'status') {
  const labels = scope.locator(`.todo-task-value-label[data-kind="${kind}"]`);
  return labels.evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((element) => [
        element.getAttribute('data-value'),
        getComputedStyle(element).color,
      ]),
    ),
  );
}
async function createFixture(page: Page, title: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action: 'create_task', payload: { title } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).ids[0] as string;
}
async function stored(page: Page, id: string) {
  return (await page.request.get('/api/to-doo/state?taskIds=' + id)).json();
}

test('creation choices and selected values keep their colors, icons and real enum values', async ({
  page,
}, info) => {
  const title = '彩色任务字段 ' + info.project.name + '-' + crypto.randomUUID();
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  const priority = await openValueOptions(page, detail, '优先级');
  await expect(priority.popup.locator('.todo-task-value-icon')).toHaveCount(4);
  const priorityColors = await colors(priority.popup, 'priority');
  expect(Object.keys(priorityColors).sort()).toEqual(['high', 'low', 'none', 'normal']);
  expect(new Set(Object.values(priorityColors)).size).toBe(4);
  await priority.popup.getByText('高优先级', { exact: true }).click();
  const selectedPriority = priority.selector.locator(
    '.ant-select-selection-item .todo-task-value-label',
  );
  await expect(selectedPriority).toHaveText('高优先级');
  await expect(selectedPriority).toHaveCSS('color', priorityColors.high);
  await expect(selectedPriority.locator('svg')).toBeVisible();

  await expandToDooGroup(detail, '更多选项');
  const status = await openValueOptions(page, detail, '初始状态');
  await expect(status.popup.locator('.todo-task-value-icon')).toHaveCount(6);
  const statusColors = await colors(status.popup, 'status');
  expect(Object.keys(statusColors).sort()).toEqual([
    'blocked',
    'cancelled',
    'doing',
    'done',
    'skipped',
    'todo',
  ]);
  expect(new Set(Object.values(statusColors)).size).toBe(6);
  const paths = await status.popup
    .locator('.todo-task-value-icon path')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('d')));
  expect(new Set(paths).size).toBe(6);
  // Filtering still searches the readable label, rather than a rendered VNode.
  await status.control.fill('进行');
  await expect(status.popup.locator('.todo-task-value-label')).toHaveCount(1);
  await status.popup.getByText('进行中', { exact: true }).click();
  const selectedStatus = status.selector.locator(
    '.ant-select-selection-item .todo-task-value-label',
  );
  await expect(selectedStatus).toHaveText('进行中');
  await expect(selectedStatus).toHaveCSS('color', statusColors.doing);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.action === 'create_task' &&
      response.request().postDataJSON()?.payload.title === title,
  );
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).ids[0];
  const data = await stored(page, id);
  expect(data.tasks.find((task: any) => task.id === id)).toMatchObject({ priority: 'high' });
  expect(data.occurrences.find((occurrence: any) => occurrence.taskId === id)).toMatchObject({
    status: 'doing',
  });
});

test('dark context menus use the same semantic colors and keep priority and status independent', async ({
  page,
}, info) => {
  const session = await (await page.request.get('/api/auth/get-session')).json();
  await page.addInitScript((ownerId: string) => {
    localStorage.setItem(
      'dooknow.preferences.v1:' + encodeURIComponent(ownerId),
      JSON.stringify({ theme: 'dark' }),
    );
  }, session.user.id);
  const title = '彩色任务菜单 ' + info.project.name + '-' + crypto.randomUUID();
  const id = await createFixture(page, title);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const searchButton = page.getByRole('button', { name: '搜索任务', exact: true });
  await searchButton.click();
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill(title);
  await page.getByRole('button', { name: '执行搜索', exact: true }).click();
  await search.press('Escape');
  const row = page.locator('.todo-task-row').filter({ hasText: title });
  await row.hover();
  await row.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menu').getByText('优先级', { exact: true }).click();
  const high = page.getByRole('menuitem', { name: '高优先级', exact: true });
  await expect(high.locator('.todo-task-value-icon')).toBeVisible();
  const menuColors = await colors(
    page.locator(':is(.ant-menu-submenu-popup, .ant-dropdown-menu-submenu-popup):visible'),
    'priority',
  );
  expect(new Set(Object.values(menuColors)).size).toBe(4);
  const changedPriority = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.action === 'update_task' &&
      response.request().postDataJSON()?.payload.id === id,
  );
  await high.click();
  expect((await changedPriority).ok()).toBe(true);
  await row.hover();
  await row.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await page.getByRole('menu').getByText('状态', { exact: true }).click();
  const blocked = page.getByRole('menuitem', { name: '受阻', exact: true });
  await expect(blocked.locator('.todo-task-value-icon')).toBeVisible();
  const statusColors = await colors(
    page.locator(':is(.ant-menu-submenu-popup, .ant-dropdown-menu-submenu-popup):visible'),
    'status',
  );
  expect(new Set(Object.values(statusColors)).size).toBe(6);
  const changedStatus = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.action === 'set_occurrence_status' &&
      response.request().postDataJSON()?.payload.status === 'blocked',
  );
  await blocked.click();
  expect((await changedStatus).ok()).toBe(true);
  const data = await stored(page, id);
  expect(data.tasks.find((task: any) => task.id === id)).toMatchObject({ priority: 'high' });
  expect(data.occurrences.find((occurrence: any) => occurrence.taskId === id)).toMatchObject({
    status: 'blocked',
  });
  // The edit selection must agree with the corresponding menu after the status change.
  await row.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await detail.getByRole('button', { name: '编辑优先级', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '优先级', exact: true });
  await expect(editor.locator('.ant-select-selection-item .todo-task-value-label')).toHaveCSS(
    'color',
    menuColors.high,
  );
  await expect(editor.locator('.ant-select-selection-item .todo-task-value-icon')).toBeVisible();
});
