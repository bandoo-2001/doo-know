import { clickNoteAction } from '../support/note-actions';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('search and history expose their remaining pages', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(
    page.locator('.sidebar-create').getByRole('button', { name: '新建笔记', exact: true }),
  ).toBeEnabled();
  const csrf = await page.request.get('/api/security/csrf');
  expect(csrf.status()).toBe(200);
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  const suffix = randomUUID().replaceAll('-', '');
  const keyword = `platformpagination${info.project.name}${suffix}`;
  let current: any;
  for (let i = 0; i < 12; i++) {
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: `分页正文-${info.project.name}-${suffix}-${i}.md`,
        content: `# ${keyword}\n${i}`,
      },
    });
    expect(created.status()).toBe(201);
    current = await created.json();
  }
  // Wait for this case's documents; unrelated large-file retries need not be idle.
  await expect
    .poll(
      async () => {
        const response = await page.request.post('/api/search/advanced', {
          headers,
          data: { query: '"' + keyword + '"', mode: 'text', limit: 50 },
        });
        expect(response.status()).toBe(200);
        return new Set((await response.json()).results.map((hit: { noteId: string }) => hit.noteId))
          .size;
      },
      { timeout: 30000 },
    )
    .toBe(12);
  await page.getByPlaceholder('搜索笔记与目录').fill(keyword);
  await expect(page.locator('.search-result')).toHaveCount(10, { timeout: 30000 });
  await page.getByRole('button', { name: '加载更多搜索结果', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(12);
  for (let i = 0; i < 51; i++) {
    const saved = await page.request.put(`/api/notes/${current.id}`, {
      headers,
      data: {
        content: `# ${keyword}\n版本${i}`,
        expectedModifiedAt: current.modifiedAt,
        requestId: `${keyword}-save-${i}`,
      },
    });
    expect(saved.status()).toBe(200);
    current = await saved.json();
  }
  await page.goto(`/?note=${current.id}`);
  await clickNoteAction(page, '历史版本');
  await expect(page.locator('.revision-item')).toHaveCount(50);
  await page.getByRole('button', { name: '加载更早版本', exact: true }).click();
  await expect(page.locator('.revision-item')).toHaveCount(51);
});
