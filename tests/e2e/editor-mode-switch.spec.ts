import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
test('源码加载期间选择同时预览后不会被旧请求抢走焦点', async ({ page, context }) => {
  let release!: () => void;
  const pendingSource = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(
    (url) =>
      url.pathname.endsWith('/components/MarkdownEditor.vue') ||
      /\/assets\/MarkdownEditor-[^/]+\.js$/.test(url.pathname),
    async (route) => {
      held = true;
      await pendingSource;
      await route.continue().catch(() => {});
    },
  );
  try {
    const original = 'abcdef\n\n<!-- 目标注释 -->\n\nuvwxyz\n';
    const note = await openDocumentNote(page, context, original);
    const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
    await editor
      .locator('.opaque-source-card')
      .getByRole('button', { name: '在源码中编辑', exact: true })
      .click();
    await expect.poll(() => held).toBe(true);
    const simultaneous = page.getByRole('checkbox', { name: '同时预览', exact: true });
    await simultaneous.focus();
    await simultaneous.press('Space');
    await expect(simultaneous).toBeChecked();
    await expect(simultaneous).toBeFocused();
    release();
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect(simultaneous).toBeFocused();
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  } finally {
    release();
  }
});
test('切换二十次不改写原文、不发保存请求，源码编辑后可跨模式撤销', async ({ page, context }) => {
  const raw = '标题\n====\n\n__原始粗体__\n\n* 原始列表\n';
  const note = await openDocumentNote(page, context, raw);
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/api/notes/' + note.id)) writes++;
  });
  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('====');
    await page.getByRole('button', { name: '文档编辑', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
  }
  expect(writes).toBe(0);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.locator('.cm-content').fill('# 源码修改\n\n保留草稿');
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText(
    '源码修改',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText(
    '原始粗体',
  );
});
test('未知块保留且不能通过全选删除隐式丢失', async ({ page, context }) => {
  const md = '---\ntitle: 保留元数据\n---\n\n普通正文\n\n<!-- 保留注释 -->\n';
  await openDocumentNote(page, context, md);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor.locator('.opaque-source-card')).toHaveCount(2);
  await editor.locator('p').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(editor.locator('.opaque-source-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('title: 保留元数据');
  await expect(page.locator('.cm-content')).toContainText('<!-- 保留注释 -->');
});
test('源码格式快捷键的撤销只撤销本次格式，不吞掉刚输入的文字', async ({ page, context }) => {
  await openDocumentNote(page, context, '原文');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = page.locator('.cm-content');
  await source.fill('新输入');
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(source).toContainText('**文字**');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(source).toHaveText('新输入');
});
test('修改前文后保留块的源码按钮仍定位当前原文', async ({ page, context }) => {
  await openDocumentNote(page, context, '开头\n\n<!-- 目标注释 -->\n\n结尾\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').first().fill('开头增加许多文字');
  await editor.getByRole('button', { name: '在源码中编辑', exact: true }).click();
  await expect(page.locator('.cm-activeLine')).toContainText('<!-- 目标注释 -->');
});
test('源码反向选区插入附件替换选中文字，并保留撤销历史', async ({ page, context }) => {
  await openDocumentNote(page, context, 'abcdef');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = page.locator('.cm-content');
  await source.click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('cd');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传附件', exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: 'selection.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nfixture\n%%EOF'),
  });
  await expect(source).toHaveText(/^ab\[selection\.pdf\]\([^\n]+\)ef$/);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(source).toHaveText('abcdef');
});
