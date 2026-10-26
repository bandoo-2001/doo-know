import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import type { Page } from '@playwright/test';

async function seedArticle(page: Page, title: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'polish-' + crypto.randomUUID() + '.md',
      content: '# ' + title,
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const chosen = await page.request.post('/api/blog/posts', {
    headers,
    data: { sourceNoteId: note.id, metadata: { title }, requestId: crypto.randomUUID() },
  });
  expect(chosen.ok()).toBe(true);
  return await chosen.json();
}

test('first article detail read shows pending, exposes a failed read and retries the real source', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const title = '详情反馈 ' + info.project.name + ' ' + crypto.randomUUID();
  const post = await seedArticle(page, title);
  let first = true,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/blog/posts/' + post.id, async (route) => {
    if (!first) return route.continue();
    first = false;
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '文章详情暂时无法读取', message: '文章详情暂时无法读取' }),
    });
  });
  try {
    await page.goto('/?view=apps&app=blog&appSection=articles');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await expect(page.getByRole('status').filter({ hasText: '正在读取文章' })).toBeVisible();
    release();
    await expect(page.getByRole('alert').filter({ hasText: '暂时无法读取' })).toBeVisible();
    await page.getByRole('button', { name: '重新读取文章', exact: true }).click();
    await expect(page.getByRole('region', { name: '文章发布设置' })).toBeVisible();
    await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(title);
    await expect(page.getByRole('button', { name: '发布文章', exact: true })).toBeEnabled();
    const actual = await (await page.request.get('/api/blog/posts/' + post.id)).json();
    expect(actual.sourceContent).toBe('# ' + title);
    await page.screenshot({
      path: `logs.local/blog-ui-polish-20261026/${info.project.name}-detail-retry.jpg`,
      type: 'jpeg',
      quality: 65,
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    release();
    await page.unroute('**/api/blog/posts/' + post.id);
  }
});

test('filtered empty articles can be reset and destructive confirmation supports keyboard cancellation', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const title = '键盘与筛选 ' + info.project.name + ' ' + crypto.randomUUID();
  const post = await seedArticle(page, title);
  const otherTitle = '另一篇选稿 ' + info.project.name + ' ' + crypto.randomUUID();
  const other = await seedArticle(page, otherTitle);
  const removals: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().includes('/api/blog/posts/'))
      removals.push(request.url());
  });
  await page.goto('/?view=apps&app=blog&appSection=articles');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('region', { name: '文章发布设置' })).toBeVisible();
  await page
    .getByRole('textbox', { name: '搜索博客文章' })
    .fill('NOT-MATCH-' + crypto.randomUUID());
  await expect(page.getByText('没有匹配的文章', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清除搜索和筛选', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索和筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索博客文章' })).toHaveValue('');
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
  const remove = page.getByRole('button', { name: '移除选稿', exact: true });
  await remove.click();
  const confirm = page.getByRole('alertdialog', { name: '确认博客操作' });
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(remove).toBeFocused();
  expect((await page.request.get('/api/blog/posts/' + post.id)).status()).toBe(200);
  await remove.click();
  await page.getByRole('button', { name: new RegExp(otherTitle) }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(otherTitle);
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(title);
  expect((await page.request.get('/api/blog/posts/' + other.id)).status()).toBe(200);
  expect(removals).toEqual([]);
  await page.getByLabel('文章标题', { exact: true }).fill(title + ' 未保存');
  await expect(page.getByRole('button', { name: '保存文章信息', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发布文章', exact: true })).toBeDisabled();
  if (info.project.name === 'mobile') {
    const inputSize = await page
      .getByLabel('文章标题', { exact: true })
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(inputSize).toBeGreaterThanOrEqual(16);
    const actionHeight = await page
      .getByRole('button', { name: '保存文章信息', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(actionHeight).toBeGreaterThanOrEqual(44);
    await page.locator('.blog-secondary-fields summary').click();
    await page.getByLabel('文章固定链接', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '保存文章信息', exact: true })).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `logs.local/blog-ui-polish-20261026/${info.project.name}-article-actions.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
});
