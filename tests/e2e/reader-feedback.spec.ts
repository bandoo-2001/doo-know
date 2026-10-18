import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('lets a guest retry a temporary share read failure without treating the link as revoked', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `分享读取重试-${test.info().project.name}-${Date.now()}.md`,
      content: '# 周末阅读记录\n\n暂时失败后仍然能够打开同一篇分享笔记。',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const shared = await page.request.post(`/api/notes/${note.id}/share`, { headers });
  expect(shared.ok()).toBe(true);
  const share = await shared.json();
  await context.clearCookies();
  let attempts = 0;
  await page.route(`**/api/public/shares/${share.token}`, async (route) => {
    attempts++;
    if (attempts === 1)
      await route.fulfill({ status: 503, json: { error: 'TEMPORARY_READ_FAILURE' } });
    else await route.continue();
  });
  await page.goto(share.url);
  await expect(
    page.getByRole('heading', { name: '暂时无法读取分享笔记', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '分享不存在或已取消', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.reader-title')).toHaveText('周末阅读记录');
  await expect(page.locator('.markdown')).toContainText('同一篇分享笔记');
  expect(attempts).toBe(2);
});

test('explains a missing share link separately from a temporary read failure', async ({ page }) => {
  await page.goto('/s/' + 'x'.repeat(43));
  await expect(
    page.getByRole('heading', { name: '分享不存在或已取消', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('请向笔记主人获取有效链接。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toHaveCount(0);
});

test('keeps the current shared fragment readable when the next fragment fails and can be retried', async ({
  page,
}) => {
  const token = 'y'.repeat(43);
  await page.route(`**/api/public/shares/${token}/meta`, (route) =>
    route.fulfill({ json: { editorMode: 'large', readState: 'ready', title: '项目阅读片段' } }),
  );
  let nextAttempts = 0;
  await page.route(`**/api/public/shares/${token}/read`, async (route) => {
    const cursor = route.request().postDataJSON().cursor;
    if (cursor && ++nextAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: 'TEMPORARY_READ_FAILURE' } });
      return;
    }
    await route.fulfill({
      json: {
        kind: 'ready',
        data: {
          content: cursor
            ? '## 第二片段\n\n继续阅读后续的项目记录。'
            : '# 项目阅读片段\n\n当前片段应当保留。',
          modifiedAt: '1000000000',
          ...(cursor ? {} : { nextCursor: 'fixture-next-page' }),
        },
      },
    });
  });
  await page.goto('/s/' + token);
  await expect(page.locator('.markdown')).toContainText('当前片段应当保留');
  await page.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('下一片段读取失败');
  await expect(page.locator('.markdown')).toContainText('当前片段应当保留');
  await expect(page.getByRole('heading', { name: '分享不存在或已取消', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(page.locator('.markdown')).toContainText('继续阅读后续的项目记录');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(nextAttempts).toBe(2);
});
