import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

for (const [key, tag, marker, shift] of [
  ['b', 'strong', '**', false], ['i', 'em', '*', false],
  ['s', 's', '~~', true], ['e', 'code', '`', false],
] as const) {
  test(`pending DOM caret movement keeps ${tag} on the next typed text`, async ({ page, context }) => {
    const original = '正文\n\n<!-- 此原文必须保留 -->\n';
    const note = await openDocumentNote(page, context, original);
    const body = page.getByRole('textbox', { name: '文档正文', exact: true });
    await body.locator('p').click();
    // Reproduce the browser interval after End moves its caret but before the
    // queued selectionchange updates the editor. Dispatch the shortcut in that
    // same interval; do not wait away the race or modify editor dependencies.
    const before = await body.evaluate((element, { key, shift }) => {
      const dom = element as HTMLElement & { editor: any };
      dom.editor.commands.setTextSelection(1);
      dom.editor.view.focus();
      const text = dom.querySelector('p')!.firstChild!;
      const selection = dom.ownerDocument.getSelection()!;
      selection.setBaseAndExtent(text, 2, text, 2);
      const oldCaret = dom.editor.state.selection.anchor;
      const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
      dom.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0),
        ctrlKey: !mac, metaKey: mac, shiftKey: shift, bubbles: true, cancelable: true,
      }));
      return oldCaret;
    }, { key, shift });
    expect(before).toBe(1);
    await expect.poll(() => body.evaluate((dom: any) => dom.editor.state.selection.anchor)).toBe(3);
    await page.keyboard.type('保留格式');
    await expect(body.locator(tag)).toHaveText('保留格式');
    await saveDocument(page);
    const expected = original.replace('正文', `正文${marker}保留格式${marker}`);
    const saved = await page.request.get('/api/notes/' + note.id);
    expect((await saved.json()).content).toBe(expected);
    await expect.poll(async () => {
      const download = await page.request.get('/api/notes/' + note.id + '/download');
      return download.status() === 200 ? (await download.body()).toString('base64') : null;
    }).toBe(Buffer.from(expected).toString('base64'));
    await page.reload();
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true }).locator(tag)).toHaveText('保留格式');
  });
}

test('strikethrough shortcut keeps a changed draft unsaved until the save shortcut', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文\n');
  const body = page.getByRole('textbox', { name: '文档正文', exact: true });
  let writes = 0;
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/notes/' + note.id) writes++;
  });
  await body.locator('p').fill('未保存正文');
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await page.keyboard.type('删除线');
  await expect(body.locator('s')).toHaveText('删除线');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('正文\n');
  expect(writes).toBe(0);
  await expect(page.locator('.save-state')).toContainText('未保存');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect(writes).toBe(1);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('未保存正文~~删除线~~\n');
});
