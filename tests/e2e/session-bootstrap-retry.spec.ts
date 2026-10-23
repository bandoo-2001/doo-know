import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

for (const failure of [429, 503, 'network'] as const) {
  test(`登录状态首次检查遇到 ${failure} 时保留重试入口，恢复后无需重新登录`, async ({
    page,
    context,
  }) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    let checks = 0;
    await page.route('**/api/auth/get-session', async (route) => {
      checks++;
      if (checks > 1) return route.continue();
      if (failure === 'network') return route.abort('connectionfailed');
      return route.fulfill({
        status: failure,
        contentType: 'application/json',
        headers: { 'retry-after': '1' },
        body: JSON.stringify({ error: '暂时无法检查登录状态' }),
      });
    });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '暂时无法确认登录状态', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
    expect(checks).toBe(1);
    await page.getByRole('button', { name: '重试连接', exact: true }).click();
    await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
    await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  });
}

test('首次登录确认成功后复用结果，草稿账户核对之外不重复检查', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  let checks = 0;
  await page.route('**/api/auth/get-session', async (route) => {
    checks++;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await expect.poll(() => checks).toBe(2);
});

test('服务确认没有登录会话时显示登录表单', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '暂时无法确认登录状态', exact: true }),
  ).toHaveCount(0);
});

test('CSRF预取挂起会结束等待并保留同账户手动重试入口', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const owner = (await (await context.request.get('/api/auth/get-session')).json()).user.id;
  let checks = 0,
    writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.startsWith('/api/notes/'))
      writes++;
  });
  await page.route('**/api/security/csrf', (route) => {
    checks++;
    if (checks === 1) return; // A real browser fetch remains pending until its signal aborts.
    return route.continue();
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '暂时无法确认登录状态', exact: true }),
  ).toBeVisible({ timeout: 18000 });
  await expect(page.getByRole('button', { name: '重试连接', exact: true })).toBeEnabled();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  expect(checks).toBe(1);
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  expect((await (await context.request.get('/api/auth/get-session')).json()).user.id).toBe(owner);
  expect(checks).toBe(2);
  expect(writes).toBe(0);
});
