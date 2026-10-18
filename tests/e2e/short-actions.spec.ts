import { expandFolderPath } from '../support/notebook-tree';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('keeps all note actions reachable in a short window without scrolling the whole page', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 568, height: 240 });
  await page.goto('/');
  await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
  await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  const remove = page.getByRole('button', { name: '删除笔记', exact: true });
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeInViewport({ ratio: 0.99 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(
    true,
  );
  await remove.click();
  await expect(page.getByText('移入回收站？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
});
