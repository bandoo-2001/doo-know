import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup, toDooDisclosureHeader } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('statistics presets reveal date controls only for a custom interval', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const from = app.getByRole('textbox', { name: '统计开始日期', exact: true });
  await expect(app.getByRole('group', { name: '区间统计' })).toBeVisible();
  await expect(from).not.toBeVisible();
  await app.getByText('自定义', { exact: true }).click();
  await expect(from).toBeVisible();
  await expect(app.getByRole('button', { name: '查看区间', exact: true })).toBeVisible();
  await app.getByText('近 30 天', { exact: true }).click();
  await expect(from).not.toBeVisible();
  await expect(app.locator('.todo-completion-chart')).toBeVisible();
});

test('saving reveals and focuses an invalid timezone inside folded preferences', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const field = app.getByLabel('显示时区', { exact: true });
  await expect(field).not.toBeVisible();
  await expandToDooGroup(app, '日期与提醒');
  const original = await field.inputValue();
  await field.fill('Invalid/Zone');
  await toDooDisclosureHeader(app, '日期与提醒').click();
  await app.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(app.getByRole('alert')).toContainText('请检查显示时区');
  await field.fill(original);
  await expect(app.getByText('有未保存的更改', { exact: true })).not.toBeVisible();
});

test('optional calendar forms retain drafts across tabs and idle recovery stays folded', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  const address = app.getByRole('textbox', { name: 'HTTPS 日历地址', exact: true });
  await expect(address).not.toBeVisible();
  await expandToDooGroup(app, '连接外部只读日历');
  await address.fill('https://example.test/draft.ics');
  await toDooDisclosureHeader(app, '连接外部只读日历').click();
  await app.getByRole('tab', { name: '偏好', exact: true }).click();
  await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  await expandToDooGroup(app, '连接外部只读日历');
  await expect(address).toHaveValue('https://example.test/draft.ics');
  await address.fill('');
  await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
  await expect(toDooDisclosureHeader(app, '成果笔记恢复')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(app.getByRole('button', { name: '导出 JSON', exact: true })).toBeVisible();
  await expect(app.getByLabel('或粘贴文件内容', { exact: true })).toBeVisible();
});
