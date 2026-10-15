import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('observes optional local-search download and cancels it from desktop and mobile settings', async ({
  page,
  context,
}) => {
  test.skip(
    process.env.DOOKNOW_E2E_SEARCH_RUNTIME !== '1',
    'requires the bounded local artifact fixture',
  );
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '准备本地检索', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检索准备', exact: true })).toBeVisible();
  await expect(page.getByText(/下载检索包/)).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '取消检索准备', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试准备本地检索', exact: true })).toBeVisible();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
});
