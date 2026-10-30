import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('batch import keeps a custom path while directories load and a blank destination preserves classification paths', async ({
  page,
}) => {
  await page.goto('/?view=settings&section=library');
  await expect(page.getByRole('button', { name: '批量导入', exact: true })).toBeVisible();
  const tree = await (await page.request.get('/api/tree')).json();
  let releaseTree!: () => void;
  const directoriesReady = new Promise<void>((resolve) => {
    releaseTree = resolve;
  });
  await page.route('**/api/tree', async (route) => {
    await directoriesReady;
    await route.fulfill({ json: tree });
  });
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入', exact: true });
  const destination = dialog.getByRole('textbox', { name: '导入到知识库目录', exact: true });
  const customPath = '00-Inbox/new-import-' + crypto.randomUUID();
  await destination.fill(customPath);
  const loaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/tree',
  );
  releaseTree();
  await loaded;
  await expect(destination).toHaveValue(customPath);
  const picker = dialog.getByRole('combobox', { name: '选择已有目录（可选）', exact: true });
  await expect(picker).toBeEnabled();
  await expect(dialog.locator('.directory-select .ant-select-selection-item')).toHaveText(
    customPath,
  );
  const name = '30-Knowledge/classification-' + crypto.randomUUID() + '.md';
  await dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Import destination fixture\n'),
  });
  const customPreview = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/manage/import/preview',
  );
  await dialog.getByRole('button', { name: '预览导入', exact: true }).click();
  const customResponse = await customPreview;
  expect(customResponse.ok()).toBe(true);
  expect(customResponse.request().postDataJSON().folderPath).toBe(customPath);
  await expect(dialog.getByRole('row').filter({ hasText: name })).toContainText(
    customPath + '/' + name,
  );
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  await picker.focus();
  await picker.press('ArrowDown');
  await picker.fill('30-Knowledge/个人知识管理/方法');
  await page.locator('.directory-tree-popup:visible').getByTitle('方法', { exact: true }).click();
  await expect(destination).toHaveValue('30-Knowledge/个人知识管理/方法');
  await picker.focus();
  await picker.press('ArrowDown');
  await page
    .locator('.directory-tree-popup:visible')
    .getByTitle('保留完整分类路径', { exact: true })
    .click();
  await expect(destination).toHaveValue('');
  const rootPreview = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/manage/import/preview',
  );
  await dialog.getByRole('button', { name: '预览导入', exact: true }).click();
  const rootResponse = await rootPreview;
  expect(rootResponse.ok()).toBe(true);
  expect(rootResponse.request().postDataJSON().folderPath).toBe('');
  await expect(
    dialog.getByRole('row').filter({ hasText: name }).getByRole('cell').first(),
  ).toHaveText(name);
});

test('outcome-note destinations keep the default implicit and send an explicitly selected directory', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  for (const folderPath of ['', '30-Knowledge/个人知识管理/方法']) {
    const created = await page.request.post('/api/to-doo/commands', {
      headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'create_task',
        payload: { title: '目录成果 ' + crypto.randomUUID() },
      },
    });
    expect(created.ok()).toBe(true);
    const task = await created.json();
    await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + task.ids[0]);
    const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
    const summary = detail
      .locator('summary')
      .filter({ hasText: '完成标准与成果' })
      .or(detail.locator('summary[aria-label="完成标准与成果"]'));
    if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
      await summary.click();
    await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建成果笔记', exact: true });
    const picker = dialog.getByRole('combobox', { name: '保存目录', exact: true });
    await picker.focus();
    await picker.press('ArrowDown');
    if (folderPath) {
      await picker.fill(folderPath);
      await page
        .locator('.directory-tree-popup:visible')
        .getByTitle('方法', { exact: true })
        .click();
    } else {
      await page
        .locator('.directory-tree-popup:visible')
        .getByTitle('默认目录', { exact: true })
        .click();
    }
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/to-doo/outcome-note',
    );
    await dialog.getByRole('button', { name: '创建并关联成果笔记', exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    const body = response.request().postDataJSON();
    if (folderPath) expect(body.folderPath).toBe(folderPath);
    else expect(body).not.toHaveProperty('folderPath');
    const noteId = (await response.json()).noteId;
    const note = await (await page.request.get('/api/notes/' + noteId)).json();
    if (folderPath) expect(note.relativePath).toMatch(/^30-Knowledge\/个人知识管理\/方法\//);
    await expect(dialog).toBeHidden();
  }
});
