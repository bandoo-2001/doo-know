import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('选择 Markdown 源码编辑后，分屏偏好可保存并用于下次打开', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=settings&section=editor');
  await page
    .locator('.ant-select')
    .filter({ has: page.getByRole('combobox', { name: '默认编辑方式', exact: true }) })
    .click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('Markdown 源码', { exact: true })
    .click();
  await page.getByRole('combobox', { name: '默认打开方式', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  const split = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: '源码与预览分屏' });
  await expect(split).not.toHaveClass(/disabled/);
  await split.click();
  await expect(
    page.locator('.ant-select-selection-item').filter({ hasText: /^源码与预览分屏$/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.getByText('编辑器偏好已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.ant-select-selection-item').filter({ hasText: /^源码与预览分屏$/ }),
  ).toBeVisible();
});
