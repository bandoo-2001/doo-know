import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

test('基础格式、标题和列表可用按钮完成，每次操作可撤销', async ({ page, context }) => {
  await openDocumentNote(page, context, 'Alpha beta');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  for (const [name, selector] of [
    ['加粗', 'strong'],
    ['斜体', 'em'],
    ['删除线', 's'],
    ['行内代码', 'code'],
    ['引用', 'blockquote'],
    ['无序列表', 'ul'],
    ['有序列表', 'ol'],
  ]) {
    await editor.locator('p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('Alpha beta');
    await page.getByRole('button', { name, exact: true }).click();
    await expect(editor.locator(selector)).toContainText('Alpha beta');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(editor.locator(selector)).toHaveCount(0);
    await expect(editor).toHaveText('Alpha beta');
  }
  for (let level = 1; level <= 5; level++) {
    await editor.locator('p').click();
    await page.getByRole('combobox', { name: '段落格式', exact: true }).click();
    await page.getByRole('option', { name: `标题 ${level}`, exact: true }).click();
    await expect(editor.locator(`h${level}`)).toHaveText('Alpha beta');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(editor.locator('p')).toHaveText('Alpha beta');
  }
});

test('任务勾选和代码语言保存后在阅读与源码中保持含义', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '- [ ] 待办事项\n\n代码示例');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.getByRole('checkbox').check();
  await editor.locator('p').filter({ hasText: '代码示例' }).click();
  await page.getByRole('button', { name: '代码块', exact: true }).click();
  await expect(editor.locator('pre code')).toHaveText('代码示例');
  await page.getByRole('combobox', { name: '代码语言', exact: true }).fill('typescript');
  await page.keyboard.press('Tab');
  await saveDocument(page);
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved).toContain('- [x] 待办事项');
  expect(saved).toContain('```typescript');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('.preview-panel')).toContainText('☑');
  await expect(page.locator('.preview-panel input[type="checkbox"]')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await expect(editor.getByRole('checkbox')).toBeChecked();
  await expect(editor.locator('pre code')).toHaveText('代码示例');
});

test('表格列对齐、增删列、删除和撤销不丢失已有单元格', async ({ page, context }) => {
  await openDocumentNote(page, context, '| A | B |\n| --- | --- |\n| 保留单元格 | C |\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('td p').first().click();
  await page.getByRole('button', { name: '列居中', exact: true }).click();
  await expect(editor.locator('td').first()).toHaveCSS('text-align', 'center');
  await page.getByRole('button', { name: '右侧插入列', exact: true }).click();
  await expect(editor.locator('tr').first().locator('th')).toHaveCount(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('tr').first().locator('th')).toHaveCount(2);
  await editor.locator('td p').first().click();
  await page.getByRole('button', { name: '删除表格', exact: true }).click();
  await expect(editor.locator('table')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('table')).toContainText('保留单元格');
});
