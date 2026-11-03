import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import { test, expect } from '../support/browser-test';
import { clickNoteAction } from '../support/note-actions';
import { extractArchive } from '../../apps/server/platform/archive';

test('完整下载保存当前编辑内容并打包实际引用的附件', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const origin = new URL(page.url()).origin,
    csrf = await (await page.request.get('/api/security/csrf')).json(),
    headers = { origin, 'x-csrf-token': csrf.token };
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: '完整下载-' + crypto.randomUUID() + '.md',
      content: '# 完整下载\n\n原始段落。\n',
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  );
  const uploaded = await page.request.post('/api/notes/' + note.id + '/assets', {
    headers,
    multipart: { file: { name: 'image.png', mimeType: 'image/png', buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  expect(asset.markdownPath).toMatch(/^_doo-assets\//);
  const saved = await page.request.put('/api/notes/' + note.id, {
    headers,
    data: {
      content: '# 完整下载\n\n![图片](' + asset.markdownPath + ')\n\n原始段落。\n',
      expectedModifiedAt: note.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(saved.status()).toBe(200);
  await page.goto('/?note=' + note.id);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor).toBeVisible();
  await editor.locator('p').last().fill('下载时需要保存的最新段落。');
  await expect(page.locator('.save-state')).toContainText('未保存');
  const downloading = page.waitForEvent('download');
  await clickNoteAction(page, '下载完整文档');
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    '下载时需要保存的最新段落。',
  );
  const directory = await mkdtemp(join(tmpdir(), 'doo-complete-download-'));
  try {
    await extractArchive((await download.path())!, directory);
    const manifest = JSON.parse(await readFile(join(directory, 'dooknow-portable.json'), 'utf8'));
    const document = manifest.files.find((entry: any) => entry.kind === 'document');
    const markdown = await readFile(join(directory, document.path), 'utf8');
    expect(markdown).toContain('下载时需要保存的最新段落。');
    const image = new MarkdownIt()
      .parse(markdown, {})
      .flatMap((token) => token.children || [])
      .find((token) => token.type === 'image')!;
    const path = posix.normalize(
      posix.join(posix.dirname(document.path), decodeURIComponent(String(image.attrGet('src')!))),
    );
    expect(await readFile(join(directory, path))).toEqual(png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
