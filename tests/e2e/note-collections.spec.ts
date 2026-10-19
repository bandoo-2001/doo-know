import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showSidebar, closeSidebar } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';

test('recent edits update from external writes and favorite controls stay in sync after reload', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  // App establishes its CSRF cookie before mounting. Seed only after that exchange settles.
  await expect(page.locator('.workspace')).toBeVisible();
  const csrf = (await (await page.request.get('/api/security/csrf')).json()).token;
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf };
  const name = `collection-${crypto.randomUUID()}.md`;
  const response = await page.request.post('/api/notes', {
    headers,
    data: { folderPath: '00-Inbox', fileName: name, content: '# Collection test' },
  });
  expect(response.status()).toBe(201);
  const n = await response.json();
  await page.reload();
  await showSidebar(page);
  await page.getByRole('button', { name: '最近', exact: true }).click();
  const list = page.getByRole('list', { name: '最近编辑的笔记' });
  await expect(list.locator('.collection-open').first()).toHaveAttribute('title', n.relativePath);
  await list.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.note-header').getByRole('button', { name: '收藏', exact: true }).click();
  await expect(
    page.locator('.note-header').getByRole('button', { name: '取消收藏', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '收藏', exact: true })
    .click();
  await expect(
    page.getByRole('list', { name: '收藏的笔记' }).getByRole('button', { name, exact: true }),
  ).toBeVisible();
  await closeSidebar(page);
  await page.reload();
  await expect(
    page.locator('.note-header').getByRole('button', { name: '取消收藏', exact: true }),
  ).toBeVisible();
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '笔记', exact: true })
    .click();
  await expandFolderPath(page, '00-Inbox');
  const row = page
    .locator('.tree-row')
    .filter({ has: page.getByTitle(n.relativePath, { exact: true }) });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '取消收藏', exact: true }).click();
  await closeSidebar(page);
  await expect(
    page.locator('.note-header').getByRole('button', { name: '收藏', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await showSidebar(page);
  await page.getByRole('button', { name: '最近', exact: true }).click();
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const external = `external-${crypto.randomUUID()}.md`;
  await writeFile(join(config.knowledgeRoot, '00-Inbox', external), '# External edit');
  await expect(list.locator('.collection-open').first()).toHaveAttribute(
    'title',
    '00-Inbox/' + external,
    { timeout: 20000 },
  );
  await list.getByRole('button', { name: external, exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('External edit');
  await showSidebar(page);
  // Reading an older note must leave the newer external write at the top.
  await expect(list.locator('.collection-open').first()).toHaveAttribute(
    'title',
    '00-Inbox/' + external,
  );
  await list.getByRole('button', { name, exact: true }).click();
  await showSidebar(page);
  await expect(list.locator('.collection-open').first()).toHaveAttribute(
    'title',
    '00-Inbox/' + external,
  );
  await writeFile(join(config.knowledgeRoot, n.relativePath), '# Updated existing note externally');
  await expect(list.locator('.collection-open').first()).toHaveAttribute('title', n.relativePath, {
    timeout: 20000,
  });
});

test('a late directory refresh cannot undo a successful favorite change', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.workspace')).toBeVisible();
  const csrf = (await (await page.request.get('/api/security/csrf')).json()).token;
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf },
    data: {
      folderPath: '00-Inbox',
      fileName: `late-refresh-${crypto.randomUUID()}.md`,
      content: '# Race',
    },
  });
  expect(response.status()).toBe(201);
  const n = await response.json();
  await page.goto('/?note=' + n.id);
  await expect(page.locator('.cm-content')).toBeVisible();
  let release!: () => void, captured!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route(
    '**/api/tree',
    async (route) => {
      const upstream = await route.fetch();
      captured();
      await hold;
      await route.fulfill({ response: upstream });
    },
    { times: 1 },
  );
  await showSidebar(page);
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await ready;
  await closeSidebar(page);
  const unfavorite = page
    .locator('.note-header')
    .getByRole('button', { name: '取消收藏', exact: true });
  await page.locator('.note-header').getByRole('button', { name: '收藏', exact: true }).click();
  await expect(unfavorite).toHaveAttribute('aria-pressed', 'true');
  const refreshed = page.waitForResponse('**/api/tree');
  release();
  await refreshed;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(unfavorite).toHaveAttribute('aria-pressed', 'true');
});
