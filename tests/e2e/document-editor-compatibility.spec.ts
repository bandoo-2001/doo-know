import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
test('恢复含跨段引用的草稿时回退源码，不能用旧文档投影覆盖恢复文本', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 原始标题\n\n磁盘正文');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const draft = '# 需要恢复的完整草稿\n\n[引用][id]\n\n[id]: https://example.invalid\n';
  await page.locator('.cm-content').fill(draft);
  await expect(page.getByRole('status').filter({ hasText: '本地草稿已暂存' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('需要恢复的完整草稿');
  await expect(page.locator('.cm-content')).toContainText('[id]: https://example.invalid');
  await expect(page.locator('.save-state')).toContainText('未保存');
});
test('已输入草稿超过文档上限后完整回退源码，磁盘内容不被自动改写', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '原文保持');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.evaluate((el) =>
    (el as HTMLElement & { editor: any }).editor.commands.insertContent({
      type: 'paragraph',
      content: [{ type: 'text', text: 'a'.repeat(270000) + '完整末尾' }],
    }),
  );
  await expect(page.getByRole('button', { name: 'Markdown 源码', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const source = page.locator('.cm-content');
  await source.press('ControlOrMeta+End');
  await expect(source).toContainText('完整末尾');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('原文保持');
  await expect(page.locator('.save-state')).toContainText('未保存');
});
