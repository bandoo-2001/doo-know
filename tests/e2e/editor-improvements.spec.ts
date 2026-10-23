import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

test('文档查找替换可撤销且不直接保存服务器', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '# 查找\n\nhello **world** hello');
  await page.getByRole('textbox', { name: '文档正文', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: '当前笔记查找' });
  await search.getByLabel('查找内容', { exact: true }).fill('hello');
  await expect(search).toContainText('2');
  await search.getByLabel('替换内容', { exact: true }).fill('你好');
  await search.getByRole('button', { name: '全部替换', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('你好');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    'hello',
  );
  await search.getByRole('button', { name: '关闭查找', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('hello');
});

test('笔记属性更新保留未知YAML字段及正文原文', async ({ page, context }) => {
  const raw = '---\ntitle: 原标题\ntags: [旧标签]\ncustom: keep-me\n---\n\n# 正文\n\n保留文字。\n';
  const note = await openDocumentNote(page, context, raw);
  await page.getByRole('button', { name: '笔记属性', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '笔记属性', exact: true });
  await dialog.getByLabel('标题', { exact: true }).fill('新标题');
  await dialog.getByLabel('标签', { exact: true }).fill('标签一, 标签二');
  await dialog.getByRole('button', { name: '应用到草稿', exact: true }).click();
  await saveDocument(page);
  const content = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(content).toContain('custom: keep-me');
  expect(content).toContain('新标题');
  expect(content.endsWith('# 正文\n\n保留文字。\n')).toBe(true);
});

test('公式脚注提示块可阅读并保留Markdown源码', async ({ page, context }) => {
  const raw =
    '# 知识扩展\n\n公式 $x^2$ 与脚注[^a]。\n\n[^a]: 脚注内容\n\n> [!NOTE]\n> 保留提示内容\n';
  const note = await openDocumentNote(page, context, raw);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('.preview-panel math')).toBeVisible();
  await expect(page.locator('.preview-panel')).toContainText('脚注内容');
  await expect(page.locator('.preview-panel .markdown-alert-note')).toContainText('保留提示内容');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
});
