import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import { readFile } from 'node:fs/promises';
test('窄屏深色与减少动态效果下仍可排版，键盘格式和原文复制可用', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const session = await (await page.request.get('/api/auth/get-session')).json();
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ theme: 'dark', editorKind: 'document', mode: 'edit' }));
  }, { key: 'dooknow.preferences.v1:' + encodeURIComponent(session.user.id) });
  await openDocumentNote(page, context, '正文\n\n<!-- 可复制原文 -->\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('加粗');
  await expect(editor.locator('strong')).toContainText('加粗');
  await editor.getByRole('button', { name: '复制原文', exact: true }).click();
  const text = page.getByRole('textbox', { name: '保留块原文', exact: true });
  await expect(text).toHaveValue('<!-- 可复制原文 -->\n');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
