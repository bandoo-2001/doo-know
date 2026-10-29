import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('loads advanced retention on demand and preserves a saved duration after reopening settings', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  let reads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/maintenance/organization-settings' && request.method() === 'GET') reads++;
  });
  async function open() {
    await page.locator('summary').filter({ hasText: /^异常写入恢复$/ }).click();
    await expect(page.getByRole('heading', { name: '异常写入恢复', exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: /^整理撤销材料保留期限（高级）$/ }).click();
    await expect(page.getByRole('spinbutton', { name: '整理撤销材料保留天数', exact: true })).toBeVisible();
  }
  await page.goto('/?view=settings&section=backup');
  await expect(page.getByRole('heading', { name: '任务与结果', exact: true })).toBeVisible();
  expect(reads).toBe(0);
  await open();
  expect(reads).toBe(1);
  const input = page.getByRole('spinbutton', { name: '整理撤销材料保留天数', exact: true });
  const initial = Number(await input.inputValue());
  try {
    const value = initial === 7 ? 14 : 7;
    await input.fill(String(value));
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/maintenance/organization-settings' && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存保留期限', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: '已保存，后续整理任务' })).toContainText(`${value} 天`);
    await page.reload();
    await open();
    await expect(input).toHaveValue(String(value));
    await expect(page.getByText('未完成或需要核对的任务材料会继续保留。到期清理撤销材料，不删除笔记。', { exact: true })).toBeVisible();
  } finally {
    await page.evaluate(async retentionDays => {
      const { token } = await (await fetch('/api/security/csrf')).json();
      const response = await fetch('/api/maintenance/organization-settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ retentionDays }) });
      if (!response.ok) throw Error('Could not restore retention fixture');
    }, initial);
  }
});
