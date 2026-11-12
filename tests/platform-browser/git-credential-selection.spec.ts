import { test, expect, type BrowserContext } from '@playwright/test';
import { testPassword } from '../support/credentials.js';

let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const response = await context.request.post('http://127.0.0.1:4178/api/auth/sign-in/username', {
    headers: { origin: 'http://127.0.0.1:4178' },
    data: { username: 'owner', password: testPassword },
  });
  expect(response.status()).toBe(200);
  cookies = await context.cookies();
  await context.close();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

for (const scenario of [
  'new test',
  'switch back',
  'no credential',
  'refresh with blank URL',
  'late refresh',
  'retry failed test',
]) {
  test(`credential selection uses the visible choice: ${scenario}`, async ({ page }) => {
    const remote = 'https://github.com/fixture/notes.git';
    const oldJob = {
      id: 'old-test',
      requestId: 'old-request',
      kind: 'test',
      status: 'failed',
      phase: 'testing_connection',
      error: 'GIT_AUTH_FAILED',
    };
    let delayed = false,
      release: (() => void) | undefined;
    let started = false;
    await page.route('**/api/platform/git/status', async (route) => {
      if (delayed)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.fulfill({
        json: {
          branch: 'main',
          changes: 0,
          head: null,
          connection: null,
          discoveredRemotes: [],
          jobs: started ? [] : [oldJob],
        },
      });
    });
    await page.route('**/api/platform/git/credentials', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'old-key',
              name: 'knowledge-base-key',
              host: 'github.com',
              kind: 'https',
              username: 'fixture',
            },
            {
              id: 'new-key',
              name: 'dooknow-key',
              host: 'github.com',
              kind: 'https',
              username: 'fixture',
            },
          ],
        },
      }),
    );
    const requests: { path: string; input: any }[] = [];
    await page.route('**/api/platform/git/jobs**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        requests.push({ path, input });
        started = true;
        return route.fulfill({
          json: {
            ...oldJob,
            id: path.endsWith('/retry') ? 'old-test' : 'new-test',
            requestId: input.requestId || oldJob.requestId,
            status: 'succeeded',
            phase: 'complete',
            error: undefined,
          },
        });
      }
      return route.fulfill({ json: { items: [] } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '从 GitHub／Gitee 导入', exact: true }).click();
    const credential = page.getByLabel('仓库认证', { exact: true });
    await expect(credential.locator('option[value="new-key"]')).toHaveCount(1);
    if (scenario === 'late refresh') {
      delayed = true;
      await page.getByRole('button', { name: '刷新同步状态', exact: true }).click();
      await expect.poll(() => !!release).toBe(true);
    }
    await credential.selectOption('new-key');
    await expect(credential).toHaveValue('new-key');
    if (scenario === 'refresh with blank URL') {
      const refreshed = page.waitForResponse('**/api/platform/git/status');
      await page.getByRole('button', { name: '刷新同步状态', exact: true }).click();
      await refreshed;
    }
    if (scenario === 'late refresh') {
      const refreshed = page.waitForResponse('**/api/platform/git/status');
      delayed = false;
      release!();
      await refreshed;
    }
    await expect(credential).toHaveValue('new-key');
    const selected =
      scenario === 'switch back' ? 'old-key' : scenario === 'no credential' ? '' : 'new-key';
    await credential.selectOption(selected);
    await page.getByLabel('仓库克隆地址', { exact: true }).fill(remote);
    await page.getByLabel('云端分支（选填）', { exact: true }).fill('main');
    await page
      .getByRole('button', {
        name:
          scenario === 'retry failed test'
            ? /^(核对并重试任务|按当前配置重新测试)$/
            : '测试读取连接',
        exact: true,
      })
      .click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].path).toBe('/api/platform/git/jobs');
    expect(requests[0].input).toMatchObject({
      kind: 'test',
      url: remote,
      branch: 'main',
      ...(selected ? { credentialId: selected } : {}),
    });
    if (!selected) expect(requests[0].input).not.toHaveProperty('credentialId');
    await expect(credential).toHaveValue(selected);
  });
}
