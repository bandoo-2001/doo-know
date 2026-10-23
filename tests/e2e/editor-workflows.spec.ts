import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

test.use({ actionTimeout: 10000 });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
  'base64',
);
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
const editorFor = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: '文档正文', exact: true });

test('明确按 Markdown 粘贴转换格式，未知语法保留，整次插入可撤销', async ({ page, context }) => {
  const raw = '# 原文\n\n保留正文。\n';
  const note = await openDocumentNote(page, context, raw);
  const editor = editorFor(page);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: '按 Markdown 粘贴', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '按 Markdown 粘贴', exact: true });
  const pasted = '## 新标题\r\n\r\n**新正文**\r\n\r\n<!-- exact source -->\r\n';
  await dialog.getByLabel('Markdown 内容', { exact: true }).fill(pasted);
  await dialog.getByRole('button', { name: '插入 Markdown', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor.locator('h2')).toHaveText('新标题');
  await expect(editor.locator('strong')).toHaveText('新正文');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('h2')).toHaveCount(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await saveDocument(page);
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  // A textarea normalizes line endings; within that representation unknown source stays exact.
  expect(saved).toContain(pasted.replace(/\r\n/g, '\n'));
  expect(saved.startsWith(raw)).toBe(true);
});

test('批量图片失败后只重试失败项，按原顺序插入并可导出离线阅读文件', async ({ page, context }) => {
  const raw = '# 批量附件\n\n正文。\n';
  const note = await openDocumentNote(page, context, raw);
  const requests: { name: string; requestId?: string }[] = [];
  const beforeAssets = await (await page.request.get('/api/notes/' + note.id + '/assets')).json();
  let interrupted = false;
  await page.route('**/api/notes/' + note.id + '/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataBuffer()!.toString();
    const name = /filename="([^"]+)"/.exec(body)![1];
    requests.push({ name, requestId: route.request().headers()['x-dooknow-upload-id'] });
    if (name === 'second.png' && !interrupted) {
      interrupted = true;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'temporary upload failure' }),
      });
    }
    return route.continue();
  });
  await editorFor(page).locator('p').click();
  await page.keyboard.press('End');
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传附件', exact: true }).click();
  await (await choosing).setFiles(['first.png', 'second.png', 'third.png'].map(file));
  const queue = page.getByLabel('批量附件上传', { exact: true });
  await expect(queue.getByRole('button', { name: '重试此附件', exact: true })).toBeEnabled();
  await expect(editorFor(page).locator('img:not(.ProseMirror-separator)')).toHaveCount(0);
  await queue.getByRole('button', { name: '重试此附件', exact: true }).click();
  const images = editorFor(page).locator('img:not(.ProseMirror-separator)');
  await expect(images).toHaveCount(3);
  expect(
    await images.evaluateAll((images) => images.map((image) => image.getAttribute('alt'))),
  ).toEqual(['first.png', 'second.png', 'third.png']);
  await expect
    .poll(() =>
      images.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
  expect(requests.map((request) => request.name)).toEqual([
    'first.png',
    'second.png',
    'third.png',
    'second.png',
  ]);
  expect(requests[1].requestId).toBeTruthy();
  expect(requests[1].requestId).toBe(requests[3].requestId);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await saveDocument(page);
  const assets = await (await page.request.get('/api/notes/' + note.id + '/assets')).json();
  expect(assets).toHaveLength(beforeAssets.length + 3);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click();
  const download = await downloading;
  const html = await readFile((await download.path())!, 'utf8');
  expect(html).not.toContain('/api/');
  expect(html).not.toContain('<script');
  const offline = await context.newPage();
  const network: string[] = [];
  offline.on('request', (request) => network.push(request.url()));
  await offline.setContent(html);
  await expect(offline.locator('img')).toHaveCount(3);
  await expect
    .poll(() =>
      offline
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  expect(network).toEqual([]);
  await offline.close();
});

test('图片粘贴和外部拖放使用同一个有序上传入口', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '# 粘贴拖放\n\n插入位置。\n');
  const beforeAssets = await (await page.request.get('/api/notes/' + note.id + '/assets')).json();
  const editor = editorFor(page);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await editor.evaluate((element, encoded) => {
    const data = new DataTransfer();
    for (const name of ['paste-one.png', 'paste-two.png'])
      data.items.add(
        new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], name, {
          type: 'image/png',
        }),
      );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, png.toString('base64'));
  await expect(editor.locator('img:not(.ProseMirror-separator)')).toHaveCount(2);
  await editor.evaluate((element, encoded) => {
    const data = new DataTransfer();
    for (const name of ['drop-one.png', 'drop-two.png'])
      data.items.add(
        new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], name, {
          type: 'image/png',
        }),
      );
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: data,
        clientX: box.left + 25,
        clientY: box.top + 25,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png.toString('base64'));
  await expect(editor.locator('img:not(.ProseMirror-separator)')).toHaveCount(4);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    '# 粘贴拖放\n\n插入位置。\n',
  );
  expect(await (await page.request.get('/api/notes/' + note.id + '/assets')).json()).toHaveLength(
    beforeAssets.length + 4,
  );
});

test('空行斜杠菜单可键盘插入脚注，并生成不冲突的普通 Markdown 标记', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 插入\n\n原有[^note]\n\n[^note]: 保留脚注\n\n正文。\n');
  const editor = editorFor(page);
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const dialog = page.getByRole('dialog', { name: '快捷插入', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('searchbox', { name: '搜索插入内容', exact: true }).fill('脚注');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('[^note-2]');
  await expect(page.locator('.cm-content')).toContainText('[^note]: 保留脚注');
});
