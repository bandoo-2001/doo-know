import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
for (const documentType of ['whiteboard', 'mindmap', 'flowchart']) {
  test(`公开 ${documentType} 读取只使用正文和PNG，不尝试恢复原件`, async ({ page }) => {
    const token = 'diagram-public-fixture',
      base = `/api/public/shares/${token}`;
    const originals: string[] = [];
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname.startsWith('/api/public/') &&
        /\/whiteboards\/|\/diagram(?:\/|\?|$)/.test(new URL(request.url()).pathname)
      )
        originals.push(request.url());
    });
    await page.route(`**${base}/meta`, (route) =>
      route.fulfill({
        json: {
          title: '公开图形',
          editorMode: 'full',
          documentType,
          permission: 'view',
          canEdit: false,
          allowDiagramSource: false,
        },
      }),
    );
    await page.route(`**${base}`, (route) =>
      route.fulfill({
        json: {
          title: '公开图形',
          documentType,
          permission: 'view',
          canEdit: false,
          allowDiagramSource: false,
          html: `<p><img src="${base}/assets/preview" alt="公开预览"></p><p>允许公开的说明。</p>`,
          headings: [],
        },
      }),
    );
    await page.route(`**${base}/assets/preview`, (route) =>
      route.fulfill({ contentType: 'image/png', body: png }),
    );
    await page.goto('/s/' + token);
    const preview = page.getByRole('img', { name: '公开预览', exact: true });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByText('允许公开的说明。')).toBeVisible();
    await expect(page.getByRole('button', { name: '源码', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '下载源码', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
    expect(originals).toEqual([]);
  });
}

test('图形原件下载需在分享设置中明确开启，并可再次关闭', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json(),
    response = await page.request.post('/api/notes', {
      headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: 'source-grant-' + crypto.randomUUID() + '.md',
        content: '# 原件授权设置\n',
        requestId: crypto.randomUUID(),
      },
    });
  expect(response.status(), await response.text()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: '允许下载图形原件', exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  let saved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/notes/${note.id}/share` &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '生成分享链接', exact: true }).click();
  expect((await (await saved).json()).allowDiagramSource).toBe(true);
  await expect(checkbox).toBeChecked();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  saved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/notes/${note.id}/share` &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '保存分享设置', exact: true }).click();
  expect((await (await saved).json()).allowDiagramSource).toBe(false);
  await expect(checkbox).not.toBeChecked();
});
