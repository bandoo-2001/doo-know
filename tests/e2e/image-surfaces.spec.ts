import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const origin = 'http://127.0.0.1:4179';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
  'base64',
);
async function decoded(image: ReturnType<import('@playwright/test').Page['locator']>) {
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(1);
}
test('文档、阅读预览和访客分享显示授权图片且不改写原文', async ({ page, context, browser }) => {
  const note = await openDocumentNote(page, context, '# 图片\r\n');
  const csrf = (await (await context.request.get('/api/security/csrf')).json()).token;
  const headers = { origin, 'x-csrf-token': csrf };
  const uploaded = await context.request.post('/api/notes/' + note.id + '/assets', {
    headers,
    multipart: { file: { name: 'surface.png', mimeType: 'image/png', buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  const original =
    '# 图片\r\n\r\n![说明](' + asset.markdownPath + ')\r\n\r\n<!-- 原文完整保留 -->\r\n';
  const latest = await (await context.request.get('/api/notes/' + note.id)).json();
  expect(
    (
      await context.request.put('/api/notes/' + note.id, {
        headers,
        data: { content: original, expectedModifiedAt: latest.modifiedAt, requestId: randomUUID() },
      })
    ).status(),
  ).toBe(200);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/notes/' + note.id)
      writes++;
  });
  await page.reload();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await decoded(editor.locator('img[alt="说明"]'));
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await decoded(page.locator('.preview-panel .markdown img'));
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(asset.markdownPath);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await decoded(editor.locator('img[alt="说明"]'));
  expect(writes).toBe(0);
  expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(
    original,
  );
  const shared = await (
    await context.request.post('/api/notes/' + note.id + '/share', { headers, data: {} })
  ).json();
  const guest = await browser.newContext({ baseURL: origin });
  try {
    const reader = await guest.newPage();
    await reader.goto('/s/' + shared.token);
    const image = reader.locator('.markdown img');
    await decoded(image);
    await expect(image).toHaveAttribute('data-dooknow-image-src', /^\/api\/public\/shares\//);
    expect((await guest.request.get('/api/assets/' + asset.id)).status()).toBe(401);
  } finally {
    await guest.close();
  }
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  expect(await readFile(join(config.knowledgeRoot, note.relativePath), 'utf8')).toBe(original);
});

test('大文件片段预览及大文件分享显示图片，完整文件保持原样', async ({
  page,
  context,
  browser,
}, info) => {
  const small = await openDocumentNote(page, context, '# 附件\n');
  const csrf = (await (await context.request.get('/api/security/csrf')).json()).token,
    headers = { origin, 'x-csrf-token': csrf };
  const uploaded = await context.request.post('/api/notes/' + small.id + '/assets', {
    headers,
    multipart: { file: { name: 'large.png', mimeType: 'image/png', buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
    name = 'large-image-' + info.project.name + '.md',
    path = join(config.knowledgeRoot, '00-Inbox', name);
  const original =
    '# Large\r\n\r\n![片段图片](' +
    asset.markdownPath +
    ')\r\n\r\n' +
    'unchanged line\n'.repeat(160000) +
    'UNLOADED_SENTINEL';
  await writeFile(path, original);
  await page.goto('/?folder=00-Inbox');
  await page.locator('.folder-view').getByRole('button', { name, exact: true }).click();
  await expect(page.getByText('大文件模式', { exact: true })).toBeVisible();
  let writes = 0;
  page.on('request', (request) => {
    if (
      ['PUT', 'POST'].includes(request.method()) &&
      /\/api\/notes\/[^/]+(?:\/patch)?$/.test(new URL(request.url()).pathname)
    )
      writes++;
  });
  await page.getByRole('button', { name: '预览当前片段', exact: true }).click();
  await decoded(page.locator('.large-preview img'));
  const id = new URL(page.url()).searchParams.get('note');
  expect(id).toBeTruthy();
  const shared = await (
    await context.request.post('/api/notes/' + id + '/share', { headers, data: {} })
  ).json();
  const guest = await browser.newContext({ baseURL: origin });
  try {
    const reader = await guest.newPage();
    await reader.goto('/s/' + shared.token);
    await decoded(reader.locator('.markdown img'));
  } finally {
    await guest.close();
  }
  expect(writes).toBe(0);
  expect(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  ).toBe(createHash('sha256').update(original).digest('hex'));
});
