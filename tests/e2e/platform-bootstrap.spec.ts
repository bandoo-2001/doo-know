import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { testPassword } from '../support/credentials.js';

test('a failed platform check after login can retry with the same signed-in session', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route(
    '**/api/platform/status',
    (route) => route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }),
    { times: 1 },
  );
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: '暂时无法打开知识库', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('登录信息已保留，请检查连接后重试。', { exact: true })).toBeVisible();
  const before = await (await page.request.get('/api/auth/get-session')).json();
  expect(before.user.id).toBeTruthy();
  await page.getByRole('button', { name: '重新尝试', exact: true }).click();
  await expect(page.locator('.workspace-empty')).toBeVisible();
  const after = await (await page.request.get('/api/auth/get-session')).json();
  expect(after.user.id).toBe(before.user.id);
  expect(after.session.id).toBe(before.session.id);
  expect(pageErrors).toEqual([]);
});

test('a failed platform check when reopening an authenticated page has a visible recovery action', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.route('**/api/platform/status', (route) => route.abort('connectionfailed'), {
    times: 1,
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '暂时无法打开知识库', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '退出并重新登录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新尝试', exact: true }).click();
  await expect(page.locator('.workspace-empty')).toBeVisible();
});

test('platform recovery keeps its actions after failed logout and returns to login after successful logout', async ({
  page,
}) => {
  await page.route('**/api/platform/status', (route) =>
    route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }),
  );
  await page.route(
    '**/api/auth/sign-out',
    (route) => route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }),
    { times: 1 },
  );
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '暂时无法打开知识库', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '退出并重新登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法退出，请检查连接后重试。');
  expect((await (await page.request.get('/api/auth/get-session')).json()).user.id).toBeTruthy();
  await page.getByRole('button', { name: '退出并重新登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录 DooKnow', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();
});

test('a failed platform recheck after reauthentication keeps the mounted editor and its draft', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.workspace-empty')).toBeVisible();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const created = await page.request.post('/api/notes', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `bootstrap-draft-${crypto.randomUUID()}.md`,
      content: '# Before reauthentication\n',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await page.goto('/?note=' + note.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Before reauthentication');
  const draft = '# Draft preserved through reauthentication\n';
  await editor.fill(draft);
  await context.clearCookies();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录已失效', exact: true })).toBeVisible();
  await page.route(
    '**/api/platform/status',
    (route) => route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }),
    { times: 1 },
  );
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录已失效', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '暂时无法打开知识库', exact: true })).toHaveCount(
    0,
  );
  await expect(editor).toContainText('Draft preserved through reauthentication');
  await expect(editor).toBeEditable();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(draft);
});

for (const phase of ['initializing', 'source_unavailable'] as const) {
  test(`reauthentication preserves the editor while platform status reports ${phase}`, async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.workspace-empty')).toBeVisible();
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const original = '# Before temporary service interruption\n';
    const response = await page.request.post('/api/notes', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: `reauth-${phase}-${crypto.randomUUID()}.md`,
        content: original,
        requestId: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    const note = await response.json();
    await page.goto('/?note=' + note.id);
    const editor = page.locator('.cm-content');
    await expect(editor).toContainText('Before temporary service interruption');
    const draft = '# Draft retained while the service recovers\n';
    await editor.fill(draft);
    await context.clearCookies();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录已失效', exact: true })).toBeVisible();
    let ready = false;
    await page.route('**/api/platform/status', async (route) => {
      const actual = await route.fetch();
      const status = await actual.json();
      await route.fulfill({
        json: ready
          ? status
          : { ...status, phase, components: { ...status.components, knowledge: false } },
      });
    });
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录已失效', exact: true })).toHaveCount(0);
    await expect(editor).toContainText('Draft retained while the service recovers');
    await expect(editor).toBeEditable();
    await expect(page.locator('.service-unavailable')).toContainText('暂时无法保存到服务器');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    let writes = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/notes/' + note.id)
        writes++;
    });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+s');
    expect(writes).toBe(0);
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
    ready = true;
    await page.getByRole('button', { name: '重新检查服务', exact: true }).click();
    await expect(page.locator('.service-unavailable')).toHaveCount(0);
    await expect(editor).toContainText('Draft retained while the service recovers');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(draft);
  });
}
