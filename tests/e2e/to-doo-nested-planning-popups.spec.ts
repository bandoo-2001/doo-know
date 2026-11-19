import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('continuous scheduling dismisses its time panel before the enclosing dialog', async ({
  page,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  await page.getByRole('button', { name: '日历工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '连续安排', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连续安排', exact: true });
  await expect(dialog).toBeVisible();
  const time = dialog.getByRole('textbox', { name: '连续安排开始时间', exact: true });
  const originalTime = await time.inputValue();
  await time.click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await time.press('Escape');
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(time).toBeFocused();
  await expect(time).toHaveValue(originalTime);
  await time.press('Escape');
  await expect(dialog).toBeHidden();
  expect(writes).toBe(0);
});

test('habit icon popup closes to its trigger while preserving the enclosing draft', async ({
  page,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page.getByRole('button', { name: '＋ 新建习惯', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建习惯', exact: true });
  const name = dialog.getByRole('textbox', { name: '名称', exact: true });
  await name.fill('尚未保存的习惯草稿');
  const trigger = dialog.getByRole('button', { name: '选择习惯图标', exact: true });
  await trigger.click();
  const options = page.getByRole('group', { name: '选择习惯图标', exact: true });
  await expect(options).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await options.getByRole('button').first().focus();
  await page.keyboard.press('Escape');
  await expect(options).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(name).toHaveValue('尚未保存的习惯草稿');
  await trigger.click();
  const icon = options.getByRole('button').first();
  const selectedIcon = (await icon.textContent())!.trim();
  await icon.click();
  await expect(options).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText(selectedIcon);
  await expect(name).toHaveValue('尚未保存的习惯草稿');
  expect(writes).toBe(0);
});
