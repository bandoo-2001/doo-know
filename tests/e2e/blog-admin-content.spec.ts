import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('empty taxonomy offers a real note picker without publishing or changing the site', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.route('**/api/blog', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const dashboard = await response.json();
    await route.fulfill({
      response,
      json: {
        ...dashboard,
        posts: [],
        total: 0,
        nextCursor: null,
        taxonomy: { categories: [], tags: [] },
      },
    });
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/blog') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(request.url());
  });
  await page.goto('/?view=apps&app=blog&appSection=taxonomy');
  await expect(page.getByRole('heading', { name: '还没有分类', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有标签', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索分类与标签' })).toHaveCount(0);
  await page.getByRole('button', { name: '从笔记中选稿', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择一篇笔记', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('textbox', { name: '搜索待选笔记' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: '从笔记中选稿', exact: true })).toBeFocused();
  expect(writes).toEqual([]);
});

test('taxonomy distinguishes no results, resets search and clears unrelated article filters', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const unique = info.project.name + '-' + crypto.randomUUID();
  const title = '分类筛选文章 ' + unique;
  const category = '长分类名称：阅读与知识整理 ' + unique;
  const tag = '标签-' + unique;
  const noteReply = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'taxonomy-' + unique + '.md',
      content: '# ' + title,
      requestId: crypto.randomUUID(),
    },
  });
  expect(noteReply.status()).toBe(201);
  const note = await noteReply.json();
  const postReply = await page.request.post('/api/blog/posts', {
    headers,
    data: {
      sourceNoteId: note.id,
      metadata: { title, category, tags: [tag] },
      requestId: crypto.randomUUID(),
    },
  });
  expect(postReply.ok()).toBe(true);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/blog') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(request.url());
  });
  await page.goto('/?view=apps&app=blog&appSection=articles');
  await page.getByRole('textbox', { name: '搜索博客文章' }).fill('no-matching-article-' + unique);
  await expect(page.getByText('没有匹配的文章', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分类与标签', exact: true }).click();
  const search = page.getByRole('textbox', { name: '搜索分类与标签' });
  await search.fill('no-matching-taxonomy-' + unique);
  await expect(page.getByRole('heading', { name: '没有匹配的分类', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '没有匹配的标签', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有分类', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看全部分类', exact: true }).click();
  await expect(search).toHaveValue('');
  await search.fill(category);
  await page.locator('.blog-category').filter({ hasText: category }).click();
  await expect(page.getByRole('textbox', { name: '搜索博客文章' })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: '文章状态', exact: true })).toHaveValue('all');
  await expect(page.locator('.blog-filter-chip')).toContainText(category);
  await expect(page.locator('.blog-post-option').filter({ hasText: title })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索博客文章' }).fill('another-unrelated-query');
  await page.getByRole('button', { name: '分类与标签', exact: true }).click();
  await search.fill(tag);
  await page.locator('.blog-tags button').filter({ hasText: tag }).click();
  await expect(page.getByRole('textbox', { name: '搜索博客文章' })).toHaveValue('');
  await expect(page.locator('.blog-filter-chip')).toContainText(tag);
  await expect(page.locator('.blog-filter-chip')).not.toContainText(category);
  await expect(page.locator('.blog-post-option').filter({ hasText: title })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});
