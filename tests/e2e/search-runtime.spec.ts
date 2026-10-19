import { openSettingsSection } from '../support/settings-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test('observes optional local-search download and cancels it from desktop and mobile settings', async ({
  page,
  context,
}) => {
  test.skip(
    process.env.DOOKNOW_E2E_SEARCH_RUNTIME !== '1',
    'requires the bounded local artifact fixture',
  );
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await openSettingsSection(page, '搜索与索引');
  const csrf = await page.request.get('/api/security/csrf');
  expect(csrf.status()).toBe(200);
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  let taskId: string | undefined;
  try {
    const [prepared] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/api/platform/search-runtime/prepare'),
      ),
      page.getByRole('button', { name: /^(准备本地检索|重新准备)$/ }).click(),
    ]);
    expect(prepared.status()).toBe(200);
    taskId = (await prepared.json()).taskId;
    expect(taskId).toEqual(expect.any(String));
    await expect(page.getByRole('button', { name: '取消检索准备', exact: true })).toBeVisible();
    // Observe real bytes, rather than cancelling as soon as the phase name changes.
    const progress = page.getByRole('status').filter({ hasText: '下载检索包' });
    await expect(progress).toContainText('1 / 2 MiB', { timeout: 10000 });
    const [cancelled] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith(`/search-runtime/tasks/${taskId}/cancel`),
      ),
      page.getByRole('button', { name: '取消检索准备', exact: true }).click(),
    ]);
    expect(cancelled.status()).toBe(200);
    expect(await cancelled.json()).toMatchObject({ taskId, state: 'cancelled' });
    await expect(page.getByRole('button', { name: '重新准备', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^已取消$/ })).toBeVisible();
    const state = await page.request.get('/api/platform/search-runtime');
    expect((await state.json()).task).toMatchObject({ id: taskId, state: 'cancelled' });
  } finally {
    // A failed assertion must not leak this case's preparation into the status drawer cases.
    if (taskId) {
      const response = await page.request.post(
        `/api/platform/search-runtime/tasks/${taskId}/cancel`,
        { headers, data: {}, timeout: 5000 },
      );
      expect(response.status()).toBe(200);
      expect((await response.json()).state).toBe('cancelled');
    }
  }
});
