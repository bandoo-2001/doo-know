import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('opens the authenticated workspace and apps without the secure-context UUID API', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await context.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?view=apps');
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /To Doo.*带着资料/ }).click();
  await expect(page.locator('.to-doo-workspace')).toBeVisible();
  expect(errors).toEqual([]);
});
