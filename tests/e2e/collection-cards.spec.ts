import { test, expect } from '../support/browser-test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showSidebar } from '../support/settings-navigation';

test('browser Back from an overview returns to the retained unsaved note', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.workspace')).toBeVisible();
  const csrf = (await (await page.request.get('/api/security/csrf')).json()).token;
  const note = await page.request.post('/api/notes', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf },
    data: {
      folderPath: '00-Inbox',
      fileName: 'draft-card-' + crypto.randomUUID() + '.md',
      content: '# 保留草稿\n',
    },
  });
  expect(note.status()).toBe(201);
  await page.goto('/?note=' + (await note.json()).id);
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('尚未保存的输入');
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '最近', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '最近笔记' })).toBeVisible();
  await page.goBack();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('尚未保存的输入');
  await expect(page.getByRole('dialog').filter({ hasText: '保存并继续' })).toHaveCount(0);
});

test('recent cards page lazily, bound rendered cards, and restore the reading position', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const folder = '00-Inbox/cards-' + crypto.randomUUID();
  await mkdir(join(knowledgeRoot, folder));
  await Promise.all(
    Array.from({ length: 80 }, (_, i) =>
      writeFile(
        join(knowledgeRoot, folder, `card-${String(i).padStart(3, '0')}.md`),
        `# 摘要卡片 ${i}\n\n这是一段用于快速了解笔记内容的正文摘要。\n\n后续正文不需要在列表中完整读取。`,
      ),
    ),
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/collections/status?kind=recent')).json()).total,
    )
    .toBeGreaterThanOrEqual(80);
  let treeReads = 0;
  const pages: { items: unknown[]; nextCursor: string | null }[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/tree') treeReads++;
  });
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/api/collections' && response.ok())
      pages.push(await response.json());
  });
  await page.goto('/?view=recent');
  const workspace = page.getByRole('region', { name: '最近笔记' });
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('.collection-card').first()).toContainText('正文摘要');
  await expect.poll(() => pages.length).toBeGreaterThan(0);
  expect(pages[0].items.length).toBeLessThanOrEqual(24);
  await page.screenshot({ path: info.outputPath('recent-cards.png'), animations: 'disabled' });
  const initialTrees = treeReads;
  const scroll = workspace.locator('.collection-scroll');
  for (let i = 0; i < 4; i++) {
    if (!pages.at(-1)?.nextCursor) break;
    const before = pages.length;
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => pages.length).toBeGreaterThan(before);
    const loaded = pages.reduce((count, page) => count + page.items.length, 0);
    await expect(workspace.locator('.collection-progress')).toContainText(`已加载 ${loaded} /`);
  }
  await expect.poll(() => pages.length).toBeGreaterThan(2);
  expect(treeReads).toBe(initialTrees);
  expect(await workspace.locator('.collection-card').count()).toBeLessThanOrEqual(45);
  const visible = workspace.locator('.collection-card-open').last();
  await visible.scrollIntoViewIfNeeded();
  const position = await scroll.evaluate((el) => el.scrollTop);
  expect(position).toBeGreaterThan(300);
  await visible.click();
  await expect(page.locator('.cm-content')).toBeVisible();
  const requests = pages.length;
  await page.goBack();
  await expect(workspace).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(position - 300);
  expect(pages.length).toBe(requests);
});

test('recent and favorites share summary cards and favorite removal updates the overview', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=recent');
  const recent = page.getByRole('region', { name: '最近笔记' });
  await expect(recent.locator('.collection-card').first()).toBeVisible();
  const card = recent.locator('.collection-card').first();
  const title = await card.locator('h2').innerText();
  const summary = await card.locator('.collection-card-summary').innerText();
  await card.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(card.getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '收藏', exact: true })
    .click();
  const favorites = page.getByRole('region', { name: '收藏笔记' });
  const saved = favorites
    .locator('.collection-card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(saved).toBeVisible();
  await expect(saved.locator('.collection-card-summary')).toHaveText(summary);
  await page.screenshot({ path: info.outputPath('favorite-cards.png'), animations: 'disabled' });
  await page.reload();
  await expect(saved).toBeVisible();
  await saved.getByRole('button', { name: '取消收藏', exact: true }).click();
  await expect(saved).toHaveCount(0);
});
