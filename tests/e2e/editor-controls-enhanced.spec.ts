import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';

test('H6 can be created with the keyboard in document and source modes', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, '保留标题');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  const heading = page.getByRole('combobox', { name: '段落格式', exact: true });
  await heading.focus();
  await heading.press('ArrowDown');
  const options = page.getByRole('listbox', { name: '段落样式', exact: true });
  await options.press('End');
  await page.keyboard.press('Enter');
  await expect(editor.locator('h6')).toHaveText('保留标题');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('p')).toHaveText('保留标题');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.locator('.cm-content').click();
  await heading.click();
  await page.getByRole('option', { name: '标题 6', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('###### 保留标题');
});

test('clear formatting preserves link destinations and protected source in one undo step', async ({
  page,
  context,
}) => {
  await openDocumentNote(
    page,
    context,
    '<span style="color:#dc2626">**A😀中**</span> 与 *斜体* [链接](https://example.invalid/keep)\n\n<!-- 保留原文 -->',
  );
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect
    .poll(() =>
      editor.evaluate(
        (element: any) => element.editor.state.selection.to - element.editor.state.selection.from,
      ),
    )
    .toBeGreaterThan(8);
  await page.getByRole('button', { name: '清除格式', exact: true }).click();
  await expect(editor.locator('strong, em, [style*="color"]')).toHaveCount(0);
  await expect(editor.getByRole('link', { name: '链接', exact: true })).toHaveAttribute(
    'href',
    'https://example.invalid/keep',
  );
  await expect(editor).toContainText('A😀中 与 斜体 链接');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('A😀中');
  await expect(editor.locator('em')).toHaveText('斜体');
});

test('document search replaces across marks while excluding hidden source and URLs', async ({
  page,
  context,
}) => {
  await openDocumentNote(
    page,
    context,
    '前**正**文 [链接](https://example.invalid/正文)\n\n<!-- 正文 -->\n\n```mermaid\nflowchart LR; 正文-->B\n```',
  );
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').first().click();
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: '当前笔记查找', exact: true });
  await search.getByLabel('查找内容', { exact: true }).fill('正文');
  await expect(search).toContainText('1');
  await search.getByLabel('替换内容', { exact: true }).fill('新文😀');
  await search.getByRole('button', { name: '全部替换', exact: true }).click();
  await expect(editor.locator('p').first()).toContainText('前新文😀 链接');
  await expect(editor.getByRole('link', { name: '链接', exact: true })).toHaveAttribute(
    'href',
    'https://example.invalid/正文',
  );
  await search.getByRole('button', { name: '关闭查找', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('p').first()).toContainText('前正文 链接');
});
