import { test, expect } from '../support/browser-test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { showSidebar } from '../support/settings-navigation';

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
});

test('the directory tree fits a short viewport and searches full paths before creating a note', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 664, height: 390 });
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      mkdir(join(knowledgeRoot, '00-Inbox', `height-check-${String(index).padStart(2, '0')}`)),
    ),
  );
  await page.reload();
  await showSidebar(page);
  await page
    .locator('.sidebar-create')
    .getByRole('button', { name: '新建笔记', exact: true })
    .click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  await dialog.locator('[aria-label="所在目录"]').click();
  const popup = page.locator('.n-base-select-menu:visible, .directory-tree-popup:visible');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveClass(/ant-slide-(up|down)-enter/);
  await expect(async () => {
    const bounds = (await popup.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(4);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(390 - 4);
  }).toPass({ timeout: 3000 });
  await expect(popup.getByRole('tree')).toBeVisible();
  expect(
    await popup
      .locator('.ant-select-tree-list-holder')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('directory-tree-popup.png'),
    animations: 'disabled',
  });
  const input = dialog.getByRole('combobox', { name: '所在目录', exact: true });
  await input.fill('30-Knowledge/个人知识管理/方法');
  const method = popup.getByTitle('方法', { exact: true });
  await expect(method).toBeVisible();
  await method.click();
  await expect(popup).toBeHidden();
  const name = 'directory-tree-' + crypto.randomUUID();
  await dialog.getByRole('textbox', { name: '文件名', exact: true }).fill(name);
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
  );
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().folderPath).toBe('30-Knowledge/个人知识管理/方法');
  await expect(page.locator('.cm-content')).toContainText(name);
  await page.screenshot({
    path: info.outputPath('created-with-directory-tree.png'),
    animations: 'disabled',
  });
});

test('root selection stays valid for creating a category and Escape only closes the tree popup', async ({
  page,
}) => {
  await showSidebar(page);
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  const input = dialog.getByRole('combobox', { name: '所在目录', exact: true });
  await input.focus();
  await page.keyboard.press('ArrowDown');
  const popup = page.locator('.directory-tree-popup:visible');
  await popup.getByTitle('知识库根目录', { exact: true }).click();
  await input.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '文件夹名', exact: true }).fill('50-Journal');
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/folders',
  );
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().parent).toBe('');
  await expect(dialog).toBeHidden();
});

test('moving and importing use the selected directory path from the same tree', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const fileName = 'picker-move-' + crypto.randomUUID() + '.md';
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName,
      content: '# Move fixture',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('button', { name: '移动或重命名', exact: true }).click();
  const moveDialog = page.locator('.n-modal').filter({ hasText: '移动或重命名笔记' });
  const directory = moveDialog.getByRole('combobox', { name: '目标目录', exact: true });
  await moveDialog.locator('[aria-label="目标目录"]').click();
  await directory.fill('30-Knowledge/个人知识管理/方法');
  await page.locator('.directory-tree-popup:visible').getByTitle('方法', { exact: true }).click();
  await moveDialog.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(page.getByText('笔记已整理，历史和分享链接保持关联', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).relativePath).toBe(
    '30-Knowledge/个人知识管理/方法/' + fileName,
  );
  await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '导入 Markdown', exact: true }).click();
  const importDialog = page.locator('.n-modal').filter({ hasText: '导入到' });
  const destination = importDialog.getByRole('combobox', { name: '导入目录', exact: true });
  await importDialog.locator('[aria-label="导入目录"]').click();
  await destination.fill('00-Inbox');
  await page
    .locator('.directory-tree-popup:visible')
    .getByTitle('00-Inbox', { exact: true })
    .click();
  const importName = 'picker-import-' + crypto.randomUUID() + '.md';
  await importDialog.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({
    name: importName,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Import fixture'),
  });
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
  );
  await importDialog.getByRole('button', { name: '确认导入', exact: true }).click();
  const imported = await pending;
  expect(imported.status()).toBe(201);
  expect(imported.request().postDataJSON().folderPath).toBe('00-Inbox');
});
