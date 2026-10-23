import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument, insertTable } from '../support/document-editor';
test('回车、表格编辑和列操作可保存为 Markdown', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('新段落');
  await expect(editor).toContainText('新段落');
  await insertTable(page);
  await expect(editor.locator('table')).toBeVisible();
  await editor.locator('td p').first().fill('单元格内容');
  await page.getByRole('button', { name: '下方插入行', exact: true }).click();
  await expect(editor.locator('tr')).toHaveCount(4);
  await saveDocument(page);
  const saved = await (await page.request.get('/api/notes/' + note.id)).json();
  expect(saved.content).toContain('单元格内容');
  expect(saved.content).toContain('新段落');
  expect(saved.content).toContain('|');
});
test('链接通过对话框编辑，复杂表格粘贴可取消或明确按文本插入', async ({ page, context }) => {
  await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: '插入链接', exact: true }).click();
  await page.getByRole('textbox', { name: '链接文字', exact: true }).fill('访问资料');
  await page
    .getByRole('textbox', { name: '链接地址', exact: true })
    .fill('https://example.invalid/docs');
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.invalid/docs');
  await editor.click();
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<table><tr><td colspan="2">复杂内容</td></tr></table>');
    data.setData('text/plain', '复杂内容');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '按普通文本粘贴', exact: true }).click();
  await expect(editor).toContainText('复杂内容');
});
test('上传图片显示授权地址，源码保留相对路径且可编辑替代文字', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  await page.keyboard.press('End');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传附件', exact: true }).click();
  const chooser = await choosing;
  await chooser.setFiles({
    name: 'example.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(editor.locator('img[src]')).toHaveAttribute('src', /^\/api\/assets\//);
  await editor.locator('img[src]').click();
  await page.getByRole('textbox', { name: '图片替代文字', exact: true }).fill('示例图片');
  await page.getByRole('button', { name: '应用图片说明', exact: true }).click();
  await saveDocument(page);
  const text = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(text).toContain('示例图片');
  expect(text).not.toContain('/api/assets/');
  expect(text.indexOf('正文')).toBeLessThan(text.indexOf('!['));
});
test('明确删除保留块可撤销，Shift+Enter 和中文输入组合不会被切换截断', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, '正文\n\n<!-- 原文保留 -->\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.getByRole('button', { name: '删除此内容', exact: true }).click();
  await page.getByRole('button', { name: '确认删除此内容', exact: true }).click();
  await expect(editor.locator('.opaque-source-card')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('.opaque-source-card')).toHaveCount(1);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('换行内容');
  await expect(editor.locator('br')).toHaveCount(1);
  await editor.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中文组合');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.dispatchEvent('compositionend', { data: '中文组合' });
  await expect(page.locator('.cm-content')).toContainText('中文组合');
  await expect(page.locator('.cm-content')).toContainText('<!-- 原文保留 -->');
});
test('粘贴常见排版保留颜色和对齐，纯文本标记不误变标题', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  await page.keyboard.press('End');
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<h2>粘贴标题</h2><p style="text-align:center"><span style="color:#AABBCC">彩色正文</span></p>',
    );
    data.setData('text/plain', '粘贴标题\n彩色正文');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor).toContainText('彩色正文');
  await expect(editor.locator('h2')).toHaveText('粘贴标题');
  await saveDocument(page);
  const text = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(text).toContain('text-align:center');
  expect(text.toLowerCase()).toContain('color:#aabbcc');
});
test('粘贴图片文件沿用上传流程，不在正文里留下空白占位', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.click();
  await editor.evaluate((el) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor.locator('img[src]')).toHaveAttribute('src', /^\/api\/assets\//);
  await saveDocument(page);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    'pasted.png',
  );
});
test('任务完成状态、定义列表和上下标粘贴需明确选择，不静默删格式', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '原文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  for (const html of [
    '<ul><li><input type="checkbox" checked>完成</li><li><input type="checkbox">待办</li></ul>',
    '<dl><dt>名词</dt><dd>定义</dd></dl>',
    '<p>x<sup>2</sup></p>',
    '<p>H<sub>2</sub>O</p>',
    '<p><img src=https://example.invalid/x.png alt="原图片"></p>',
  ]) {
    await editor.click();
    await editor.evaluate((el, html) => {
      const data = new DataTransfer();
      data.setData('text/html', html);
      data.setData('text/plain', '保留文字');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, html);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor).toHaveText('原文');
  }
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('原文');
});
test('已有链接的显示文字和地址一起修改，可一次撤销', async ({ page, context }) => {
  await openDocumentNote(page, context, '[原链接](https://example.invalid/old)');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('a').click();
  await page.getByRole('button', { name: '插入链接', exact: true }).click();
  await page.getByRole('textbox', { name: '链接文字', exact: true }).fill('新文字');
  await page
    .getByRole('textbox', { name: '链接地址', exact: true })
    .fill('https://example.invalid/new');
  await page.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveText('新文字');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.invalid/new');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('a')).toHaveText('原链接');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.invalid/old');
});
test('上传失败保留原文，上传中继续输入后需重新确认插入位置', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '原文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  const assetURL = `**/api/notes/${note.id}/assets`;
  await page.route(assetURL, async (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '测试附件服务暂不可用' }),
        })
      : route.continue(),
  );
  const file = {
    name: 'deferred.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nfixture\n%%EOF'),
  };
  let choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传附件', exact: true }).click();
  await (await choosing).setFiles(file);
  await expect(page.getByRole('alert').filter({ hasText: 'deferred.pdf 上传失败' })).toContainText(
    '测试附件服务暂不可用',
  );
  await expect(page.getByRole('button', { name: '重试上传', exact: true })).toBeVisible();
  await expect(editor).toHaveText('原文');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.unroute(assetURL);
  let release!: () => void,
    started = false;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(assetURL, async (route) => {
    if (route.request().method() === 'POST') {
      started = true;
      await hold;
    }
    await route.continue();
  });
  await editor.click();
  await page.keyboard.press('End');
  choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传附件', exact: true }).click();
  await (await choosing).setFiles(file);
  await expect.poll(() => started).toBe(true);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('后续输入');
  release();
  await expect(page.getByRole('button', { name: '插入已上传附件', exact: true })).toBeVisible();
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(editor).toContainText('后续输入');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe('原文');
  await page.getByRole('button', { name: '插入已上传附件', exact: true }).click();
  await expect(editor.locator('a')).toHaveText('deferred.pdf');
  await expect(editor).toContainText('后续输入');
});
