import { expandFolderPath } from '../support/notebook-tree';
import { clickNoteAction } from '../support/note-actions';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
async function open(page: any, context: any, name: string) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await page.request.get('/api/security/csrf');
  const h = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  const r = await page.request.post('/api/notes', {
    headers: h,
    data: { folderPath: '00-Inbox', fileName: name + '.md', content: '# A' },
  });
  expect(r.status()).toBe(201);
  const n = await r.json();
  await page.goto('/?note=' + n.id);
  await expect(page.locator('.cm-content')).toContainText('# A');
  return { n, h };
}
test('W01 switches committed long-line saves and lost responses into large mode', async ({
  page,
  context,
}, info) => {
  const { n } = await open(page, context, '长行-' + info.project.name + '-' + Date.now());
  await page.locator('.cm-content').fill('# Long\n' + 'x'.repeat(32769));
  await page.route(
    `**/api/notes/${n.id}`,
    async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click();
  await expect(page.getByText('大文件模式', { exact: true })).toBeVisible();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('# Long');
  await expect(page.getByText('原文件已更新', { exact: true })).toHaveCount(0);
  await expect(page.locator('.global-error')).toHaveCount(0);
});
test('W01 long-line save enters large mode and a saved short note reopens in full mode', async ({
  page,
  context,
}, info) => {
  const { n } = await open(page, context, '长行直返-' + info.project.name);
  await page.locator('.cm-content').fill('# Long\n' + 'x'.repeat(32769));
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await expect(page.getByText('大文件模式', { exact: true })).toBeVisible();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('# Long');
  await page.locator('.large-workspace .cm-content').fill('# Back\nshort');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  // The transient fragment notice can disappear immediately when the full editor is ready.
  // Metadata remains conservative until the short file's new snapshot has been read.
  await expect
    .poll(async () => (await page.request.get(`/api/notes/${n.id}/meta`)).json(), {
      timeout: 15000,
    })
    .toMatchObject({ editorMode: 'full', readState: 'ready', sizeBytes: 12 });
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await expandFolderPath(page, '00-Inbox');
  await page
    .getByRole('button', { name: '长行直返-' + info.project.name + '.md', exact: true })
    .click();
  await expect(page.locator('.large-workspace')).toHaveCount(0);
  await expect(page.locator('.editor-panels .cm-content')).toContainText('# Back');
  await expect(page.locator('.save-state')).toContainText('已保存');
});
test('W01 unknown 409 preserves request and does not display version conflict', async ({
  page,
  context,
}, info) => {
  const { n } = await open(page, context, '未知回执-' + info.project.name);
  await page.locator('.cm-content').fill('# draft');
  await page.route(
    `**/api/notes/${n.id}`,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'OPERATION_OUTCOME_UNKNOWN',
          error: '核对操作结果',
          retryable: true,
        }),
      }),
    { times: 1 },
  );
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await expect(page.getByText('原文件已更新', { exact: true })).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('# draft');
});
test('W02 stale deletion preserves share then checks a lost delete receipt', async ({
  page,
  context,
}, info) => {
  const { n, h } = await open(page, context, '删除保护-' + info.project.name);
  await page.request.post(`/api/notes/${n.id}/share`, { headers: h, data: {} });
  const update = await page.request.put(`/api/notes/${n.id}`, {
    headers: h,
    data: {
      content: '# B',
      expectedModifiedAt: n.modifiedAt,
      requestId: 'other-tab-' + info.project.name,
    },
  });
  expect(update.status()).toBe(200);
  await clickNoteAction(page, '删除笔记');
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByText('原文件已更新', { exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`/api/notes/${n.id}/share`)).json()).enabled).toBe(true);
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('# B');
  let request: any;
  await page.route(
    `**/api/notes/${n.id}`,
    async (route) => {
      request = route.request().postDataJSON();
      expect(request.expectedModifiedAt).toBe((await update.json()).modifiedAt);
      expect(request.requestId).toBeTruthy();
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await clickNoteAction(page, '删除笔记');
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对删除结果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对删除结果', exact: true }).click();
  await expect(page.locator('.note-header')).toHaveCount(0);
  const op = await (
    await page.request.get('/api/operations?requestId=' + request.requestId)
  ).json();
  expect(op.status).toBe('succeeded');
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏' }).click();
  if (!(await page.getByRole('button', { name: '回收站', exact: true }).isVisible()))
    await page.getByRole('button', { name: '个人账户', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  const row = page.locator('.utility-row').filter({ hasText: n.relativePath });
  let restoreInput: any;
  const restoreInputs: any[] = [];
  await page.route(
    `**/api/notes/${n.id}/restore`,
    async (route) => {
      restoreInput = route.request().postDataJSON();
      restoreInputs.push(restoreInput);
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.locator('.global-error')).toBeVisible();
  page.on('request', (req) => {
    if (req.url().endsWith(`/api/notes/${n.id}/restore`)) restoreInputs.push(req.postDataJSON());
  });
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(restoreInputs).toHaveLength(2);
  expect(restoreInputs[1]).toEqual(restoreInputs[0]);
  expect(restoreInput.requestId).toBeTruthy();
  const restored = await page.request.get(`/api/notes/${n.id}`);
  expect(restored.status()).toBe(200);
  expect((await restored.json()).content).toBe('# B');
});
