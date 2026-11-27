import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup } from '../support/to-doo-ant-controls';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function seedLists(page: Page) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const parent = {
    id: 'secondary-parent-' + suffix,
    name: '工作项目 ' + suffix,
    icon: 'folder',
    color: '#4566c6',
    kind: 'list',
  };
  const child = {
    id: 'secondary-child-' + suffix,
    name: '阅读学习 ' + suffix,
    parentId: parent.id,
    icon: '📚',
    color: '#4f8c7a',
    kind: 'list',
  };
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  for (const entity of [parent, child]) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: { kind: 'list', entity },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  return { parent, child };
}
async function openTree(scope: Locator, label: string) {
  const input = scope.getByRole('combobox', { name: label, exact: true });
  await input
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  return input;
}
test('habit and focus forms share list icons, hierarchy and inner Escape behavior', async ({
  page,
}, info) => {
  const { child } = await seedLists(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  let editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill('保留习惯表单输入');
  let input = await openTree(editor, '关联目标或清单');
  let popup = page.locator('.todo-list-tree-popup:visible');
  await input.fill(child.name);
  await expect(popup.locator(`[data-list-id="${child.id}"] .todo-list-icon`)).toHaveText('📚');
  await expect(popup.locator('.todo-list-tree-add, .todo-list-tree-footer')).toHaveCount(0);
  await input.press('Escape');
  await expect(popup).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留习惯表单输入');
  await page.screenshot({
    path: info.outputPath('habit-unified-form.png'),
    animations: 'disabled',
  });
  // A fresh page discards this browser-only form; no habit is submitted.
  await page.goto('/?view=apps&app=to-doo&appSection=focus&appPage=projects');
  await page.getByRole('button', { name: '专注项目更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  editor = page.getByRole('dialog', { name: '新建专注项目', exact: true });
  await expandToDooGroup(editor, '补充信息');
  input = await openTree(editor, '关联目标或清单');
  popup = page.locator('.todo-list-tree-popup:visible');
  await input.fill(child.name);
  await popup.locator(`[data-list-id="${child.id}"] .todo-list-tree-node-name`).click();
  await expect(editor.locator('.ant-select-selection-item .todo-list-icon')).toHaveText('📚');
  await editor.getByLabel('名称', { exact: true }).fill('保留专注项目输入');
  input = await openTree(editor, '关联目标或清单');
  await input.press('Escape');
  await expect(popup).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留专注项目输入');
  expect(writes).toBe(0);
});
test('settings show parent paths and reuse the tree for import and calendar feed ranges', async ({
  page,
}, info) => {
  const { parent, child } = await seedLists(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=lists');
  const parentRow = page
    .locator('.todo-managed-list')
    .filter({ has: page.getByText(parent.name, { exact: true }) });
  const childRow = page
    .locator('.todo-managed-list')
    .filter({ has: page.getByText(child.name, { exact: true }) });
  await expect(childRow.locator('.todo-list-icon')).toHaveText('📚');
  const parentInset = await parentRow
    .locator('.todo-managed-list-title')
    .evaluate((element) => getComputedStyle(element).paddingInlineStart);
  const childInset = await childRow
    .locator('.todo-managed-list-title')
    .evaluate((element) => getComputedStyle(element).paddingInlineStart);
  expect(parseFloat(childInset)).toBeGreaterThan(parseFloat(parentInset));
  await page.screenshot({
    path: info.outputPath('settings-list-hierarchy.png'),
    animations: 'disabled',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=data');
  const settings = page.locator('.todo-settings');
  await settings.getByRole('tab', { name: '导入', exact: true }).click();
  await expandToDooGroup(settings, '导入选项');
  const input = await openTree(settings, '目标清单');
  const popup = page.locator('.todo-list-tree-popup:visible');
  await expect(popup.getByText('使用原清单 / 收集箱', { exact: true })).toBeVisible();
  await input.fill(child.name);
  await expect(popup.locator(`[data-list-id="${child.id}"] .todo-list-icon`)).toHaveText('📚');
  await expect(popup.locator('.todo-list-tree-add, .todo-list-tree-footer')).toHaveCount(0);
  await input.press('Escape');
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=connections');
  await page.getByRole('tab', { name: '日历', exact: true }).click();
  await expandToDooGroup(page.locator('.todo-settings'), '创建 To Doo 只读订阅链接');
  await openTree(page.locator('.todo-settings'), '包含的清单（不选表示全部）');
  const ranges = page.locator('.todo-list-tree-multi-popup:visible');
  await expect(ranges.locator(`[data-list-id="${child.id}"] .todo-list-icon`)).toHaveText('📚');
  await expect(ranges.locator('.todo-list-tree-add, .todo-list-tree-footer')).toHaveCount(0);
  expect(writes).toBe(0);
});
