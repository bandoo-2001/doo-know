import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('calendar picker uses an empty placeholder and Escape dismisses the inner control first', async ({
  page,
}, info) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const title = '选择器层级检查 ' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const created = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action: 'create_task', payload: { title } },
  });
  expect(created.ok()).toBe(true);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  for (const name of ['上一周期', '下一周期']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button.locator('svg')).toBeVisible();
    const bounds = (await button.boundingBox())!;
    const icon = (await button.locator('svg').boundingBox())!;
    expect(Math.abs(bounds.y + bounds.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(
      1,
    );
  }
  await page.getByRole('button', { name: '安排已有任务', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '安排已有任务', exact: true });
  const input = picker.getByRole('combobox', { name: '待安排任务', exact: true });
  await expect(input).toBeEnabled();
  const select = input.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
  await expect(select.locator('.ant-select-selection-placeholder')).toHaveText('选择一个待办任务');
  await expect(picker).not.toContainText('当前选项（尚未载入）');
  await select.locator('.ant-select-selector').click();
  await expect(page.locator('.ant-select-dropdown:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-select-dropdown:visible')).toBeHidden();
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: '安排日期', exact: true }).click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await expect(picker).toBeHidden();
  expect(writes).toBe(0);
});
