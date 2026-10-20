import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('关闭文档编辑开关时，分屏偏好可保存并用于下次打开', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=settings&section=editor');
  await page.getByRole('combobox', { name: '默认打开方式', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByText('分屏', { exact: true }).click();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.getByText('编辑器偏好已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.ant-select-selection-item').filter({ hasText: /^分屏$/ })).toBeVisible();
});
