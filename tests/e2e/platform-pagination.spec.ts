import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('search and history expose their remaining pages', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await page.request.get('/api/security/csrf');
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  const keyword = `platformpagination${info.project.name}`;
  let current: any;
  for (let i = 0; i < 12; i++) {
    const created = await page.request.post('/api/notes', { headers,
      data: { folderPath: '00-Inbox', fileName: `${keyword}-${i}.md`, content: `# ${keyword}\n${i}` } });
    expect(created.status()).toBe(201); current = await created.json();
  }
  await page.getByPlaceholder('搜索笔记与目录').fill(keyword);
  await expect(page.locator('.search-result')).toHaveCount(10, { timeout: 30000 });
  await page.getByRole('button', { name: '加载更多搜索结果', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(12);
  for (let i = 0; i < 51; i++) {
    const saved = await page.request.put(`/api/notes/${current.id}`, { headers,
      data: { content: `# ${keyword}\n版本${i}`, expectedModifiedAt: current.modifiedAt, requestId: `${keyword}-save-${i}` } });
    expect(saved.status()).toBe(200); current = await saved.json();
  }
  await page.goto(`/?note=${current.id}`);
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await expect(page.locator('.revision-item')).toHaveCount(50);
  await page.getByRole('button', { name: '加载更早版本', exact: true }).click();
  await expect(page.locator('.revision-item')).toHaveCount(51);
});
