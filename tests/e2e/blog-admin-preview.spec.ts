import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from '../support/browser-test';

test('enlarged homepage preview preserves device viewports and returns keyboard focus without saving', async ({
  page,
}) => {
  await page.context().addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/api/blog/design') &&
      request.method() !== 'GET' &&
      !request.url().includes('/preview')
    )
      writes.push(request.method() + ' ' + request.url());
  });
  await page.goto('/?view=apps&app=blog&appSection=design');
  await expect(page.getByRole('heading', { name: '装修主页', exact: true })).toBeVisible();
  const inline = page.frameLocator('iframe[title="博客主页草稿预览"]');
  await expect.poll(() => inline.locator('html').evaluate(() => innerWidth)).toBe(1100);
  const trigger = page.getByRole('button', { name: '放大预览', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '主页预览', exact: true });
  const close = dialog.getByRole('button', { name: '关闭预览', exact: true });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  const frame = dialog.frameLocator('iframe[title="博客主页放大预览"]');
  await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(1100);
  const sandbox = await dialog.locator('iframe').getAttribute('sandbox');
  expect(sandbox?.split(/\s+/)).not.toContain('allow-scripts');
  // A modal preview must prevent keyboard focus from escaping to the editor.
  await page
    .getByLabel('姓名', { exact: true })
    .evaluate((input: HTMLInputElement) => input.focus());
  await expect(close).toBeFocused();
  await dialog.getByRole('button', { name: '手机', exact: true }).click();
  await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(375);
  await dialog.locator('iframe').focus();
  await expect(dialog.locator('iframe')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => inline.locator('html').evaluate(() => innerWidth)).toBe(375);

  await trigger.click();
  await dialog.getByRole('button', { name: '桌面', exact: true }).click();
  await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(1100);
  // The dialog leaves a clickable backdrop even on a narrow phone screen.
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await close.click();
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('collection picks retain each chosen post identity beside long wrapped titles on a phone', async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 390, height: 664 });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: new URL(baseURL!).origin, 'x-csrf-token': csrf.token };
  const marker = randomUUID().slice(0, 8);
  async function publish(title: string) {
    const content = '# ' + title + '\n\n专题选择回归内容。';
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: randomUUID() + '.md',
        content,
        requestId: randomUUID(),
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const note = await created.json();
    const response = await page.request.post('/api/blog/publish', {
      headers,
      data: {
        noteId: note.id,
        expectedModifiedAt: note.modifiedAt,
        expectedContentHash: createHash('sha256').update(content).digest('hex'),
        expectedPublicationVersion: 0,
        metadata: {
          slug: 'picker-' + randomUUID().slice(0, 8),
          title,
          summary: '',
          category: '',
          tags: [],
        },
        requestId: randomUUID(),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  // Newest-first: two short targets, then long candidates that must keep their own hit areas.
  await publish('Long published title ' + 'r'.repeat(150) + ' ' + marker);
  await publish('Another published title ' + 'r'.repeat(150) + ' ' + marker);
  const first = await publish('专题第一篇 ' + marker);
  const second = await publish('专题第二篇 ' + marker);
  let designPublications = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/blog/design/publish'
    )
      designPublications++;
  });
  await page.goto('/?view=apps&app=blog&appSection=design');
  await page.getByRole('button', { name: '专题合集', exact: true }).click();
  await page.getByRole('button', { name: '＋ 添加专题', exact: true }).click();
  const collection = page.locator('.blog-edit-list-item').last();
  const collectionTitle = '选择身份回归 ' + marker;
  await collection.getByLabel('专题名称').fill(collectionTitle);
  await collection.getByLabel('专题路径').fill('picker-' + marker);
  await collection.getByText('从已发布文章中添加', { exact: true }).click();
  const selected = collection.locator('.blog-collection-order > li');
  await collection.getByRole('button', { name: '＋ ' + second.title, exact: true }).click();
  await expect(selected).toHaveCount(1);
  expect(
    await selected.evaluateAll((items) => items.map((item) => item.getAttribute('data-post-id'))),
  ).toEqual([second.id]);
  await collection.getByRole('button', { name: '＋ ' + first.title, exact: true }).click();
  await expect(selected).toHaveCount(2);
  expect(
    await selected.evaluateAll((items) => items.map((item) => item.getAttribute('data-post-id'))),
  ).toEqual([second.id, first.id]);
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === 'PATCH' &&
      new URL(result.url()).pathname === '/api/blog/design',
  );
  await page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
  expect((await response).ok()).toBe(true);
  const saved = await (await page.request.get('/api/blog/design')).json();
  expect(
    saved.draft.collections.find((item: { title: string }) => item.title === collectionTitle)
      .postIds,
  ).toEqual([second.id, first.id]);
  expect(designPublications).toBe(0);
});
