import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('quick capture dismisses its calendar and clock before closing their shared editor', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  const title = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await title.fill('明天 14:00 检查快捷输入的关闭顺序');
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  const trigger = page.getByRole('button', { name: '纠正计划日期', exact: true });
  await trigger.click();
  const editor = page.locator('.todo-capture-chip-editor:visible');
  const original = await title.inputValue();
  const date = editor.getByRole('textbox', { name: '纠正计划日期', exact: true });
  await date.click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await date.press('Escape');
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
  await expect(editor).toBeVisible();
  const time = editor.getByRole('textbox', { name: '纠正计划时间', exact: true });
  await time.click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await time.press('Escape');
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
  await expect(editor).toBeVisible();
  await time.press('Escape');
  await expect(editor).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(title).toHaveValue(original);
  expect(writes).toBe(0);
});
