import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('the selected calendar module loads while its initial data request is still pending', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dataRequested = false;
  let moduleRequested = false;
  let writes = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/components/to-doo/ToDooCalendar.vue') moduleRequested = true;
    if (request.method() === 'POST' && url.pathname === '/api/to-doo/commands') writes++;
  });
  await page.route('**/api/to-doo/state?**', async (route) => {
    const url = new URL(route.request().url());
    if (
      !dataRequested &&
      url.searchParams.get('view') === 'calendar' &&
      !url.searchParams.has('kind')
    ) {
      dataRequested = true;
      await pending;
    }
    await route.continue();
  });
  try {
    await page.goto('/?view=apps&app=to-doo&appSection=calendar');
    await expect.poll(() => dataRequested).toBe(true);
    await expect.poll(() => moduleRequested).toBe(true);
  } finally {
    release();
  }
  await expect(page.locator('.todo-calendar-toolbar')).toBeVisible();
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  expect(writes).toBe(0);
});
