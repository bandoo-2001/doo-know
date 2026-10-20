import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const r = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `document-${crypto.randomUUID()}.md`,
      content: '# 原标题\n\n第一段正文。\n\n第二段保持。\n',
    },
  });
  expect(r.status()).toBe(201);
  await page.goto('/?note=' + (await r.json()).id);
});
test('新浏览器默认直接打开文档编辑，无需选择模式即可输入和保存', async ({ page }) => {
  const id = new URL(page.url()).searchParams.get('note');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await editor.locator('p').first().fill('直接输入的新内容。');
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + id)).json()).content)
    .toBe('# 原标题\n\n直接输入的新内容。\n\n第二段保持。\n');
});
test('可视化标题和正文，切换不写入或改写 Markdown', async ({ page }) => {
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && /\/api\/notes\/[^/]+$/.test(new URL(r.url()).pathname)) writes++;
  });
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor.getByRole('heading', { name: '原标题' })).toBeVisible();
  await expect(editor).not.toContainText('# 原标题');
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect(page.locator('.cm-content')).toHaveText('# 原标题第一段正文。第二段保持。');
    await page.getByRole('button', { name: '文档编辑', exact: true }).click();
    await expect(editor).toBeVisible();
  }
  expect(writes).toBe(0);
  await expect(page.locator('.save-state')).toContainText('已保存');
});
test('文档输入保存后可在源码及重新打开时读到同一内容', async ({ page }) => {
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor).toBeVisible();
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('新增内容');
  await expect(page.locator('.save-state')).toContainText('未保存');
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('新增内容');
  await page.reload();
  await expect(page.locator('.note-workspace')).toContainText('新增内容');
});
