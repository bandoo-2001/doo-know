import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption, expandToDooGroup } from '../support/to-doo-ant-controls';

test.setTimeout(90000);
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
async function fixture(page: Page) {
  const suffix = crypto.randomUUID().slice(0, 8),
    parent = 'view-parent-' + suffix,
    child = 'view-child-' + suffix;
  const parentName = '项目 ' + suffix,
    childName = '阅读 ' + suffix;
  await command(page, 'save_entity', {
    kind: 'list',
    entity: { id: parent, name: parentName, icon: 'folder', color: '#4566c6' },
  });
  await command(page, 'save_entity', {
    kind: 'list',
    entity: { id: child, name: childName, parentId: parent, icon: '📚', color: '#4f8c7a' },
  });
  const high = '进行中的重点 ' + suffix,
    normal = '等待确认 ' + suffix;
  await command(page, 'create_task', {
    title: high,
    listId: child,
    priority: 'high',
    initialStatus: 'doing',
  });
  await command(page, 'create_task', {
    title: normal,
    listId: child,
    priority: 'normal',
    initialStatus: 'blocked',
  });
  return { parent, child, parentName, childName, high, normal };
}
async function open(scope: Locator, label: string) {
  const input = scope.getByRole('combobox', { name: label, exact: true });
  const control = input.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
  // The selected tag has its own close target; open through the combobox itself.
  await input.focus();
  await input.press('ArrowDown');
  return { input, control };
}
async function ready(page: Page) {
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
}

test('board headings and quick priority filters share colors and retain all-priorities clearing', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/?view=apps&app=to-doo&appSection=board&list=' + f.child);
  await expect(page.locator('.todo-board-column-heading')).toHaveCount(4);
  const row = page
    .locator('.todo-board-card')
    .filter({ has: page.getByRole('button', { name: f.high, exact: true }) })
    .locator('.todo-task-row')
    .first();
  const completion = (await row.locator('.todo-check').boundingBox())!;
  const body = (await row.locator('.todo-task-body').boundingBox())!;
  expect(completion.x + completion.width).toBeLessThanOrEqual(body.x);
  expect(
    Math.abs(completion.y + completion.height / 2 - body.y - body.height / 2),
  ).toBeLessThanOrEqual(1);
  const headings = page.locator(
    '.todo-board-column-heading .todo-task-value-label[data-kind="status"]',
  );
  expect(
    new Set(
      await headings.evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).color),
      ),
    ).size,
  ).toBe(4);
  await page.locator('.todo-filter-toggle').click();
  const filter = page.locator('.todo-task-filter-popup:visible');
  await open(filter, '筛选优先级');
  const popup = page.locator('.todo-task-values-popup:visible');
  await expect(popup.locator('.todo-task-value-icon')).toHaveCount(4);
  await popup.getByText('高优先级', { exact: true }).click();
  await expect(page.locator('.todo-task-name')).toHaveText([f.high]);
  await selectToDooOption(filter, '筛选优先级', '全部优先级');
  await expect
    .poll(async () => (await page.locator('.todo-task-name').allTextContents()).sort())
    .toEqual([f.high, f.normal].sort());
  await filter.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('board-status-colors.png'),
    animations: 'disabled',
  });
});

test('advanced filters keep colored enum arrays and tree list selections independent', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/?view=apps&app=to-doo&appSection=matrix');
  await page.locator('.todo-filter-toggle').click();
  await page.getByRole('button', { name: '更多筛选条件', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '高级筛选', exact: true });
  await editor.getByRole('button', { name: '＋ 添加条件', exact: true }).click();
  const first = editor.locator('.todo-condition-controls').first();
  await selectToDooOption(first, '筛选字段', '任务状态');
  await selectToDooOption(first, '筛选比较方式', '是其中之一');
  const statuses = await open(first, '筛选选项');
  for (const label of ['进行中', '受阻']) {
    await statuses.input.fill(label);
    await page.locator('.todo-task-values-popup:visible').getByText(label, { exact: true }).click();
  }
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await statuses.control
    .locator('.ant-select-selection-item')
    .filter({ hasText: '待开始' })
    .locator('.ant-select-selection-item-remove')
    .click();
  await editor.getByRole('button', { name: '＋ 添加条件', exact: true }).click();
  const second = editor.locator('.todo-condition-controls').nth(1);
  await selectToDooOption(second, '筛选字段', '目标或清单');
  await selectToDooOption(second, '筛选比较方式', '是其中之一');
  const lists = await open(second, '筛选选项');
  await expect(page.locator('.todo-list-tree-multi-popup:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  if (await lists.control.locator('.ant-select-clear').count()) {
    await lists.control.hover();
    await lists.control.locator('.ant-select-clear').click();
    await expect(lists.control.locator('.todo-list-tree-tag')).toHaveCount(0);
  }
  await lists.input.focus();
  await lists.input.press('ArrowDown');
  await lists.input.fill(f.childName);
  const popup = page.locator('.todo-list-tree-multi-popup:visible');
  const child = popup.locator('[data-list-id="' + f.child + '"]');
  await expect(child.locator('.todo-list-icon')).toHaveText('📚');
  await child
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select-tree-treenode ")][1]',
    )
    .locator('.ant-select-tree-checkbox')
    .click();
  await page.keyboard.press('Escape');
  let filterValue: any;
  page.on('request', (request) => {
    if (request.method() !== 'GET' || !request.url().includes('/api/to-doo/state?')) return;
    const filter = new URL(request.url()).searchParams.get('filter');
    if (filter) filterValue = JSON.parse(filter);
  });
  await editor.getByRole('button', { name: '应用条件组', exact: true }).click();
  await expect(editor).toBeHidden();
  await ready(page);
  await expect
    .poll(async () => (await page.locator('.todo-task-name').allTextContents()).sort())
    .toEqual([f.high, f.normal].sort());
  const conditions = filterValue.group.conditions;
  expect(conditions.find((condition: any) => condition.field === 'status').value.sort()).toEqual([
    'blocked',
    'doing',
  ]);
  expect(conditions.find((condition: any) => condition.field === 'listId').value).toEqual([
    f.child,
  ]);
});

test('overview and batch controls retain hierarchy and icons without creating or changing data', async ({
  page,
}, info) => {
  const f = await fixture(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  await page.locator('details.todo-overview-resources > summary').click();
  const parent = page.locator('.todo-overview-list[data-list-id="' + f.parent + '"]');
  const child = page.locator('.todo-overview-list[data-list-id="' + f.child + '"]');
  await expect(child.locator('.todo-list-icon')).toHaveText('📚');
  expect(
    await child.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineStart)),
  ).toBeGreaterThan(
    await parent.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineStart)),
  );
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + f.child);
  await page.getByRole('button', { name: '任务显示与管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '选择任务', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 ' + f.high, exact: true }).check();
  await expandToDooGroup(page, '更多批量操作');
  const batch = page.locator('.todo-batch');
  await open(batch, '移动到清单');
  const tree = page.locator('.todo-list-tree-popup:visible');
  await expect(tree.locator('[data-list-id="' + f.child + '"] .todo-list-icon')).toHaveText('📚');
  await expect(tree.locator('.todo-list-tree-footer')).toHaveCount(0);
  await expect(tree.locator('.todo-list-tree-add')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await open(batch, '批量优先级');
  await expect(page.locator('.todo-task-values-popup:visible .todo-task-value-icon')).toHaveCount(
    4,
  );
  await page.screenshot({
    path: info.outputPath('batch-rich-controls.png'),
    animations: 'disabled',
  });
  expect(writes).toBe(0);
});
