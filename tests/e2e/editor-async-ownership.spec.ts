import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#365edc"/></svg>';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
  'base64',
);

test('迟到的图形附件列表不能覆盖后来打开笔记的图片', async ({ page, context }) => {
  const original = '```svg\n' + svg + '\n```\n';
  const first = await openDocumentNote(page, context, original);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '30-Knowledge',
      fileName: `next-${crypto.randomUUID()}.md`,
      content: '# 后一篇\n',
    },
  });
  expect(created.status()).toBe(201);
  const second = await created.json();
  const uploaded = await page.request.post('/api/notes/' + second.id + '/assets', {
    headers,
    multipart: { file: { name: 'next.png', mimeType: 'image/png', buffer: png } },
  });
  expect(uploaded.status()).toBe(201);
  const asset = await uploaded.json();
  const saved = await page.request.put('/api/notes/' + second.id, {
    headers,
    data: {
      content: '# 后一篇\n\n![后一篇图片](' + asset.markdownPath + ')\n',
      expectedModifiedAt: second.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(saved.status()).toBe(200);
  await page.reload();
  const diagram = page.locator('.document-diagram .diagram-card');
  await expect(diagram.locator('.diagram-image img')).toBeVisible();
  let release!: () => void, observed!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const requested = new Promise<void>((resolve) => (observed = resolve));
  await page.route('**/api/notes/' + first.id + '/assets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    observed();
    await held;
    await route.continue();
  });
  await diagram.getByRole('button', { name: '生成通用预览', exact: true }).click();
  await requested;
  await page
    .locator('button.tree-toggle[aria-label="展开 30-Knowledge"]')
    .evaluateAll((buttons) => (buttons[0] as HTMLButtonElement | undefined)?.click());
  const nextButton = page
    .locator('button.tree-select')
    .filter({ has: page.locator('span', { hasText: second.relativePath.split('/').at(-1) }) });
  await expect(nextButton).toHaveCount(1);
  await nextButton.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page).toHaveURL(new RegExp('note=' + second.id));
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const image = page.locator('.preview-panel img[alt="后一篇图片"]');
  await expect(image).toHaveAttribute('data-dooknow-image-src', '/api/assets/' + asset.id);
  const lateResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/notes/' + first.id + '/assets') &&
      response.request().method() === 'GET',
  );
  release();
  await (await lateResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(image).toHaveAttribute('data-dooknow-image-src', '/api/assets/' + asset.id);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(1);
  expect((await (await page.request.get('/api/notes/' + first.id)).json()).content).toBe(original);
});

test('源码输入与撤销后查找计数及时更新', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 查找\n\n原文\n');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const search = page.getByRole('search', { name: '当前笔记查找', exact: true });
  await search.getByLabel('查找内容', { exact: true }).fill('beta');
  await expect(search.getByRole('button', { name: '下一个匹配', exact: true })).toBeDisabled();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('beta');
  await expect(search.getByRole('button', { name: '下一个匹配', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(search.getByRole('button', { name: '下一个匹配', exact: true })).toBeDisabled();
});

test('查找栏在首次切换到异步加载的源码编辑器后更新范围', async ({page,context}) => {
  await openDocumentNote(page,context,'# 模式范围\n\n正文。\n\n<!-- beta -->\n');
  await page.getByRole('button',{name:'查找替换',exact:true}).click();
  const search=page.getByRole('search',{name:'当前笔记查找',exact:true});
  await search.getByLabel('查找内容',{exact:true}).fill('beta');
  await expect(search.getByRole('button',{name:'下一个匹配',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Markdown 源码',exact:true}).click();
  await expect(page.locator('.cm-content')).toContainText('<!-- beta -->');
  await expect(search.getByRole('button',{name:'下一个匹配',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'文档编辑',exact:true}).click();
  await expect(search.getByRole('button',{name:'下一个匹配',exact:true})).toBeDisabled();
});
