import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('an ordinary root note can prepare the existing inbox without losing its name or creating itself', async ({
  page,
}) => {
  await page.route('**/api/tree', (route) => route.fulfill({ json: [] }), { times: 1 });
  let noteWrites = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes')
      noteWrites++;
  });
  await page.goto('/');
  await showSidebar(page);
  const create = page
    .locator('.sidebar-create')
    .getByRole('button', { name: '新建笔记', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  const fileName = '补齐目录后继续-' + crypto.randomUUID();
  const name = dialog.getByRole('textbox', { name: '文件名', exact: true });
  await name.fill(fileName);
  await expect(dialog.getByRole('button', { name: '创建收集箱并继续', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
  const folderRequest = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/folders',
  );
  await dialog.getByRole('button', { name: '创建收集箱并继续', exact: true }).click();
  const folderResponse = await folderRequest;
  expect(folderResponse.request().postDataJSON()).toEqual({ parent: '', name: '00-Inbox' });
  expect(folderResponse.status()).toBe(409);
  await expect(name).toHaveValue(fileName);
  await expect(dialog.locator('.directory-select .ant-select-selection-item')).toHaveText(
    '00-Inbox',
  );
  await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  expect(noteWrites).toBe(0);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
  );
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    folderPath: '00-Inbox',
    fileName: fileName + '.md',
  });
  const note = await response.json();
  await expect(page.locator('.cm-content')).toContainText('# ' + fileName);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    '# ' + fileName + '\n\n',
  );
});

test('failed inbox preparation preserves the note name and can retry without writing the note', async ({
  page,
}) => {
  let prepared = false;
  let fail = true;
  let noteWrites = 0;
  const inbox = { type: 'folder', name: '00-Inbox', path: '00-Inbox', children: [] };
  await page.route('**/api/tree', (route) => route.fulfill({ json: prepared ? [inbox] : [] }));
  await page.route('**/api/folders', (route) => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    prepared = true;
    return route.fulfill({ status: 201, json: [inbox] });
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes')
      noteWrites++;
  });
  await page.goto('/');
  await showSidebar(page);
  const create = page
    .locator('.sidebar-create')
    .getByRole('button', { name: '新建笔记', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  const name = dialog.getByRole('textbox', { name: '文件名', exact: true });
  await name.fill('保留我的笔记名');
  await expect(dialog.getByRole('button', { name: '创建收集箱并继续', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '创建收集箱并继续', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '暂时无法准备收集箱，请重试。文件名已保留。',
  );
  await expect(name).toHaveValue('保留我的笔记名');
  fail = false;
  await dialog.getByRole('button', { name: '创建收集箱并继续', exact: true }).click();
  await expect(dialog.locator('.directory-select .ant-select-selection-item')).toHaveText(
    '00-Inbox',
  );
  await expect(name).toHaveValue('保留我的笔记名');
  await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  expect(noteWrites).toBe(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('a root folder purpose fills the supported category name before explicit creation', async ({
  page,
}, info) => {
  await page.route('**/api/folders', (route) => route.fulfill({ status: 201, json: [] }));
  await page.goto('/');
  await showSidebar(page);
  const create = page.getByRole('button', { name: '新建文件夹', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  const directory = dialog.getByRole('combobox', { name: '所在目录', exact: true });
  await directory.focus();
  await directory.press('ArrowDown');
  await page
    .locator('.directory-tree-popup:visible')
    .getByTitle('知识库根目录', { exact: true })
    .click();
  const purpose = dialog.getByRole('combobox', { name: '分类用途', exact: true });
  await expect(purpose).toBeVisible();
  await purpose.focus();
  await purpose.press('ArrowDown');
  await expect(
    page
      .locator('.ant-select-dropdown:visible')
      .getByText('知识 · 主题笔记和学习整理', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('root-folder-purpose.png'),
    animations: 'disabled',
  });
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('知识 · 主题笔记和学习整理', { exact: true })
    .click();
  await expect(dialog.getByRole('textbox', { name: '文件夹名', exact: true })).toHaveValue(
    '30-Knowledge',
  );
  await expect(dialog).toContainText('文件夹名会自动填写');
  const pending = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/folders',
  );
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  expect((await pending).postDataJSON()).toEqual({ parent: '', name: '30-Knowledge' });
  await expect(dialog).toBeHidden();
});

test('an existing inbox can be selected from the root without creating another folder or note', async ({
  page,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      ['/api/folders', '/api/notes'].includes(new URL(request.url()).pathname)
    )
      writes.push(new URL(request.url()).pathname);
  });
  await page.goto('/');
  await showSidebar(page);
  const create = page
    .locator('.sidebar-create')
    .getByRole('button', { name: '新建笔记', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  const name = dialog.getByRole('textbox', { name: '文件名', exact: true });
  await name.fill('保留选择根目录前的名称');
  const directory = dialog.getByRole('combobox', { name: '所在目录', exact: true });
  await directory.focus();
  await directory.press('ArrowDown');
  await page
    .locator('.directory-tree-popup:visible')
    .getByTitle('知识库根目录', { exact: true })
    .click();
  await expect(dialog.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '使用收集箱并继续', exact: true }).click();
  await expect(dialog.locator('.directory-select .ant-select-selection-item')).toHaveText(
    '00-Inbox',
  );
  await expect(name).toHaveValue('保留选择根目录前的名称');
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});
