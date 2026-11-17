import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { openToDooDetailProperty } from '../support/to-doo-detail-controls';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('closing the list property cancels an unfinished creation and releases the task draft', async ({
  page,
}, info) => {
  const title = '保留外层任务 ' + crypto.randomUUID().slice(0, 8);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action: 'create_task', payload: { title } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).ids[0];
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + id);
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const edited = title + ' 已编辑';
  await detail.getByLabel('任务标题', { exact: true }).fill(edited);
  const property = await openToDooDetailProperty(page, 'list');
  const input = property.getByRole('combobox', { name: '所属目标或清单', exact: true });
  await input
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  const popup = page.locator('.todo-list-tree-popup:visible');
  await popup
    .locator('.todo-list-tree-footer')
    .getByRole('button', { name: '创建清单', exact: true })
    .click();
  await popup.getByLabel('新清单名称', { exact: true }).fill('先不保存的清单');
  await property.locator('.ant-modal-close').click();
  await expect(property).toBeHidden();
  await expect(popup).toBeHidden();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeEnabled();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  expect(writes).toBe(0);
});

test('the list tree searches ancestors, shows icons and creates a child without submitting its task', async ({
  page,
}, info) => {
  const prefix = 'tree-picker-' + info.project.name + '-' + crypto.randomUUID().slice(0, 6);
  const root = {
    id: prefix + '-parent',
    name: '产品项目 ' + prefix,
    kind: 'list',
    icon: 'folder',
    color: '#4566c6',
  };
  const child = {
    id: prefix + '-child',
    name: '界面体验 ' + prefix,
    kind: 'list',
    parentId: root.id,
    icon: '📚',
    color: '#4f8c7a',
  };
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  for (const entity of [root, child]) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: { kind: 'list', entity },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
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
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '待保存的输入 ' + prefix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByLabel('任务说明', { exact: true }).fill('创建子清单时，任务说明应保留。');
  const input = detail.getByRole('combobox', { name: '目标或清单', exact: true });
  await input
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  const popup = page.locator('.todo-list-tree-popup:visible');
  await input.fill('产体');
  const node = popup.locator('[data-list-id="' + child.id + '"]');
  await expect(node).toBeVisible();
  await expect(node.locator('.todo-list-icon')).toHaveText('📚');
  const add = node.getByRole('button', { name: '在 ' + child.name + ' 下创建子清单', exact: true });
  await add.click();
  const create = popup.getByRole('group', { name: '新建清单', exact: true });
  await expect(create).toContainText(child.name);
  const childName = '手机适配 ' + prefix;
  await create.getByLabel('新清单名称', { exact: true }).fill(childName);
  await expect(detail.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  await create.getByRole('button', { name: '创建清单', exact: true }).click();
  await expect(popup).toBeHidden();
  const selected = detail.locator('.todo-list-tree-select .ant-select-selection-item');
  await expect(selected).toContainText(childName);
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(
    '创建子清单时，任务说明应保留。',
  );
  expect(taskWrites).toBe(0);
  const state = await (await page.request.get('/api/to-doo/state?kind=list&limit=1000')).json();
  const stored = state.lists.filter((list: any) => list.name === childName);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ parentId: child.id, color: child.color });
  await input
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  await input.fill(child.name);
  await popup.locator('[data-list-id="' + child.id + '"] .todo-list-tree-node-name').click();
  await expect(selected.locator('.todo-list-icon')).toHaveText('📚');
  await page.screenshot({
    path: info.outputPath('tree-selected-icon.png'),
    animations: 'disabled',
  });
});
