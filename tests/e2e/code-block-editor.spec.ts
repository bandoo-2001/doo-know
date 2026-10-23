import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

test.use({ actionTimeout: 10000 });

const original = '前面的正文\r\n\r\n````ts\r\nconst value = `中文😀`;\r\n````\r\n\r\n~~~unknown-syntax\r\n未修改 ```\r\n~~~\r\n\r\n<!-- 原样保留 -->\r\n';

test('轻量代码块按需进入编辑，显示操作和切换源码保留原始围栏及换行', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, original);
  const block = page.locator('.document-code-block').first();
  await expect(page.locator('.document-code-block')).toHaveCount(2);
  await expect(page.locator('.document-code-block .cm-editor')).toHaveCount(0);
  await block.locator('pre code').click();
  await expect(block.getByRole('textbox', { name: '代码内容', exact: true })).toBeFocused();
  await expect(page.locator('.document-code-block .cm-editor')).toHaveCount(1);
  await block.getByRole('button', { name: '代码行号', exact: true }).click();
  await block.getByRole('button', { name: '代码自动折行', exact: true }).click();
  await block.getByRole('button', { name: '折叠代码', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('const value = `中文😀`;');
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await expect(page.locator('.save-state')).toContainText('已保存');
});

test('代码和正文共用撤销，保存后未知语言块和原文保留块保持不变', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, original);
  await page.locator('.document-code-block pre code').first().click();
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  await code.press('ControlOrMeta+End');
  await page.keyboard.insertText(' // 修改');
  await page.getByRole('textbox', { name: '文档正文', exact: true }).locator(':scope > p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('补充');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.tiptap > p').first()).toHaveText('前面的正文');
  await expect(page.getByRole('textbox', { name: '代码内容', exact: true })).toContainText('// 修改');
  await page.keyboard.press('ControlOrMeta+z');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = await page.locator('.cm-content').evaluate(element =>
    [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
  expect(source).toBe(original.replace(/\r\n/g, '\n'));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await saveDocument(page);
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved).toContain('const value = `中文😀`; // 修改');
  expect(saved.slice(saved.indexOf('~~~unknown-syntax'))).toBe('~~~unknown-syntax\r\n未修改 ```\r\n~~~\r\n\r\n<!-- 原样保留 -->\r\n');
});

test('代码语言可搜索，高亮和缩进不建立独立撤销，方向键可回正文', async ({ page, context }) => {
  await openDocumentNote(page, context, '前面的正文\n\n```javascript\nfunction greet() {\n  return "你好";\n}\n```\n\n后面的正文');
  const block = page.locator('.document-code-block');
  await block.locator('pre code').click();
  const code = block.getByRole('textbox', { name: '代码内容', exact: true });
  await expect(block.locator('.cm-content span').first()).toBeVisible();
  const language = block.getByRole('combobox', { name: '代码语言', exact: true });
  await language.fill('unknown-syntax');
  await language.press('Enter');
  await expect(block.locator('.cm-content span')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(block.getByRole('combobox', { name: '代码语言', exact: true })).toHaveValue('javascript');
  await code.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeFocused();
  await page.keyboard.insertText('可回正文');
  await expect(page.locator('.tiptap > p').first()).toHaveText('前面的正文可回正文');
});

test('Mermaid 继续使用图形预览，普通代码保持独立编辑入口', async ({ page, context }) => {
  await openDocumentNote(page, context, '```mermaid\ngraph TD\nA-->B\n```\n\n```text\n普通代码\n```');
  await expect(page.locator('.document-diagram')).toHaveCount(1);
  await expect(page.locator('.document-diagram .cm-editor')).toHaveCount(0);
  await expect(page.locator('.document-code-block')).toHaveCount(1);
});
