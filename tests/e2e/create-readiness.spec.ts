import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test('new-note creation waits for the initial folder list before choosing its destination', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/tree',
    async (route) => {
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.goto('/');
    await showSidebar(page);
    await expect(page.locator('.sidebar .brand')).toBeVisible();
    await expect(
      page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  const create = page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  await page
    .getByRole('textbox', { name: '文件名', exact: true })
    .fill('ready-' + crypto.randomUUID());
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
  );
  await page.getByRole('button', { name: '创建', exact: true }).click();
  const response = await pending;
  expect(response.request().postDataJSON().folderPath).toBe('00-Inbox');
  expect(response.status()).toBe(201);
  await expect(page.locator('.cm-content')).toBeVisible();
});
