import { expect, type Page } from '@playwright/test';

/** Exercise the visible controls of both the released editor and its rollout fallback. */
export async function showSource(page: Page) {
  const source = page.getByRole('button', { name: 'Markdown 源码', exact: true });
  const legacy = page.getByRole('button', { name: '编辑', exact: true });
  await expect(source.or(legacy)).toBeVisible();
  await (await source.count() ? source : legacy).click();
}
export async function showRead(page: Page) {
  const read = page.getByRole('button', { name: '阅读', exact: true });
  const legacy = page.getByRole('button', { name: '预览', exact: true });
  await expect(read.or(legacy)).toBeVisible();
  await (await read.count() ? read : legacy).click();
}
export async function showSplit(page: Page) {
  const source = page.getByRole('button', { name: 'Markdown 源码', exact: true });
  const legacy = page.getByRole('button', { name: '分屏', exact: true });
  await expect(source.or(legacy)).toBeVisible();
  if (await source.count()) {
    await showSource(page);
    await page.getByRole('checkbox', { name: '同时预览', exact: true }).check();
  } else await legacy.click();
}
