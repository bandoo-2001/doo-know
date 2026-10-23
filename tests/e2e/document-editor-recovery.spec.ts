import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';
test('刷新可恢复文档草稿，恢复后可保存', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 标题\n\n原文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('恢复目标');
  await expect(page.getByRole('status').filter({ hasText: '本地草稿已暂存' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText(
    '恢复目标',
  );
  await saveDocument(page);
});
test('回执丢失后核对原保存，期间新输入和模式切换仍保留', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '# 标题\n\n原文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('已提交');
  await page.route(
    '**/api/notes/' + note.id,
    async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('后续输入');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('后续输入');
  await expect(page.locator('.save-state')).toContainText('未保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).not.toContain(
    '后续输入',
  );
});
test('组合输入产生不能保存的结构时保留现场和恢复副本，不能误报保存成功', async ({
  page,
  context,
}) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.dispatchEvent('compositionstart', { data: '' });
  await editor.evaluate((el) => {
    const e = (el as HTMLElement & { editor: any }).editor;
    e.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    let where = 0;
    e.state.doc.descendants((node: any, pos: number) => {
      if (!where && node.type.name === 'tableCell') where = pos + 1;
    });
    e.view.dispatch(
      e.state.tr.insert(
        where,
        e.schema.nodes.paragraph.create(null, e.schema.text('不能丢失的未提交内容')),
      ),
    );
  });
  await editor.dispatchEvent('compositionend', { data: '' });
  await expect(page.getByRole('button', { name: '下载恢复副本', exact: true })).toBeVisible();
  await expect(page.locator('.save-state')).toContainText('未保存');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载恢复副本', exact: true }).click();
  const file = await download;
  const backup = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(backup.markdown).toBe('正文');
  expect(JSON.stringify(backup.richDocument)).toContain('不能丢失的未提交内容');
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/notes/' + note.id)) writes++;
  });
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toContainText('不能丢失的未提交内容');
  expect(writes).toBe(0);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('正文');
});
test('输入法组合期间连续保存只提交一次完整内容', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await editor.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中文提交');
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/notes/' + note.id)) writes++;
  });
  const save = page.locator('.toolbar').getByRole('button', { name: '保存', exact: true });
  await save.click();
  await save.click();
  expect(writes).toBe(0);
  await editor.dispatchEvent('compositionend', { data: '中文提交' });
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect(writes).toBe(1);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    '中文提交',
  );
});
