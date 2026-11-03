import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
test('回收站单篇原生笔记恢复前准备最终链接与PNG并保留原身份', async ({ page }) => {
  const origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179),
    csrf = await (await page.request.get('/api/security/csrf')).json(),
    headers = { origin, 'x-csrf-token': csrf.token },
    suffix = crypto.randomUUID();
  const create = async (fileName: string, content: string) => {
    const response = await page.request.post('/api/notes', {
      headers,
      data: { folderPath: '00-Inbox', fileName, content },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const target = await create('trash-target-' + suffix + '.md', '# Target');
  const name = 'trash-note-native-' + suffix,
    board = await create(
      name + '.excalidraw',
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [
          {
            id: 'text',
            type: 'text',
            text: '恢复原生链接',
            link: target.relativePath.split('/').at(-1),
          },
        ],
        appState: {},
        files: {},
      }),
    );
  expect(
    (
      await page.request.delete('/api/notes/' + board.id, {
        headers,
        data: { expectedModifiedAt: board.modifiedAt, requestId: crypto.randomUUID() },
      })
    ).ok(),
  ).toBe(true);
  const next = 'trash-renamed-' + suffix + '.md';
  expect(
    (
      await page.request.post('/api/notes/' + target.id + '/move', {
        headers,
        data: {
          folderPath: '00-Inbox',
          fileName: next,
          expectedModifiedAt: target.modifiedAt,
          requestId: crypto.randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true);
  const snapshots: string[] = [], restoreRequests: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/manage/trash/restore')
      restoreRequests.push(request.postDataJSON());
    if (
      request.method() === 'POST' &&
      /\/api\/diagram-operation-previews\/[^/]+\/prepare$/.test(new URL(request.url()).pathname)
    )
      snapshots.push(request.url());
  });
  await page.goto('/?view=trash');
  const row = page
    .locator('li.trash-item')
    .filter({
      has: page.getByRole('heading', { name: board.relativePath.split('/').at(-1)!, exact: true }),
    });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '恢复并打开', exact: true }).click();
  await expect
    .poll(
      async () => {
        // A maintenance lease preserves the immutable restore request for explicit retry.
        // Exercise that owner action instead of only polling a note that is still in trash.
        const busy = page.getByText(
          '知识库正在执行其他维护操作，请稍后按原请求重试。当前选择范围已保留。',
          { exact: true },
        );
        const retry = page.getByRole('button', { name: '按原请求核对结果', exact: true });
        if ((await busy.isVisible()) && (await retry.isEnabled())) await retry.click();
        const response = await page.request.get('/api/notes/' + board.id);
        return response.ok() ? (await response.json()).relativePath : '';
      },
      { timeout: 45000 },
    )
    .toBe(board.relativePath);
  const restored = await (await page.request.get('/api/notes/' + board.id + '/diagram')).json();
  expect(restored.noteId).toBe(board.id);
  expect(restored.preview.state).toBe('ready');
  expect(JSON.parse(restored.source.content).elements[0].link).toBe(next);
  expect(snapshots).toHaveLength(1);
  expect(restoreRequests.length).toBeGreaterThan(0);
  for (const request of restoreRequests) expect(request).toEqual(restoreRequests[0]);
  await expect(page).toHaveURL(new RegExp('note=' + board.id));
  await expect(page.locator('canvas.interactive')).toBeVisible();
  await page.reload();
  await expect(page.locator('canvas.interactive')).toBeVisible();
});
