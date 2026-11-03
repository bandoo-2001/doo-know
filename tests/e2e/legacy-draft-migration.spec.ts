import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
test('旧白板 JSON 草稿在稳定身份迁移后经核对转换，保存为完整 Markdown 而不是 JSON', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179),
    csrf = await (await page.request.get('/api/security/csrf')).json();
  const name = 'legacy-draft-' + crypto.randomUUID(),
    created = await page.request.post('/api/notes', {
      headers: { origin, 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: name + '.excalidraw',
        content: JSON.stringify({
          type: 'excalidraw',
          version: 2,
          elements: [],
          appState: { viewBackgroundColor: '#fff' },
          files: {},
        }),
      },
    });
  expect(created.status()).toBe(201);
  const old = await created.json();
  await page.route('**/api/notes/' + old.id, async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/?note=' + old.id);
  const canvas = page.locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 300, box.y + 230);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 320, { steps: 8 });
  await page.mouse.up();
  const record = () =>
    page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('dooknow-local-drafts', 2);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return new Promise<any>((resolve, reject) => {
        const r = db.transaction('drafts').objectStore('drafts').getAll();
        r.onsuccess = () => {
          db.close();
          resolve(r.result.find((value) => value.noteId === id));
        };
        r.onerror = () => reject(r.error);
      });
    }, old.id);
  await expect
    .poll(async () => {
      const draft = await record();
      return draft ? JSON.parse(draft.content).elements.length : 0;
    })
    .toBeGreaterThan(0);
  const held = await record();
  expect((await (await page.request.get('/api/notes/' + old.id)).json()).content).toBe(old.content);
  await page.goto('/?view=settings&section=library');
  const panel = page
    .locator('section.settings-card')
    .filter({ has: page.getByRole('heading', { name: '旧白板迁移', exact: true }) });
  await panel
    .locator('li')
    .filter({ hasText: name })
    .getByRole('button', { name: '预检', exact: true })
    .click();
  const planned = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/whiteboard-migrations/plan' &&
    response.request().method() === 'POST' &&
    response.request().postDataJSON()?.noteId === old.id,
  );
  const committed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/whiteboard-migrations/commit' &&
    response.request().method() === 'POST',
  );
  await panel.getByRole('button', { name: '生成预览并迁移此白板', exact: true }).click();
  const planResponse = await planned;
  expect(planResponse.status()).toBe(200);
  const migration = await planResponse.json();
  expect(migration.noteId).toBe(old.id);
  const commitResponse = await committed;
  expect(commitResponse.request().postDataJSON().migrationId).toBe(migration.id);
  expect(commitResponse.status()).toBe(200);
  expect(await commitResponse.json()).toMatchObject({
    id: migration.id,
    noteId: old.id,
    status: 'committed',
    newPath: '00-Inbox/' + name + '.md',
  });
  expect((await (await page.request.get('/api/notes/' + old.id)).json()).relativePath)
    .toBe('00-Inbox/' + name + '.md');
  await page.goto('/?note=' + old.id);
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  expect((await record()).content).toBe(held.content);
  const offered = await record();
  await page.evaluate((id) => {
    const original = IDBObjectStore.prototype.put;
    (window as any).__restoreDraftPut = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (args[0]?.noteId === id && args[0]?.diagram?.documentMarkdown)
        throw new DOMException('fixture quota', 'QuotaExceededError');
      return (original as any).apply(this, args);
    };
  }, old.id);
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(workspace.getByRole('alert')).toContainText('本地存储空间不足');
  expect((await record()).version).toBe(offered.version);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    workspace.getByRole('button', { name: '下载草稿', exact: true }).click(),
  ]);
  expect(await readFile((await download.path())!, 'utf8')).toBe(offered.content);
  await page.evaluate(() => {
    (window as any).__restoreDraftPut();
  });
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toHaveCount(0);
  await expect(workspace.locator('canvas.interactive')).toBeVisible();
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const current = await (await page.request.get('/api/notes/' + old.id)).json(),
    resource = await (await page.request.get('/api/notes/' + old.id + '/diagram')).json();
  expect(current.id).toBe(old.id);
  expect(current.content).toContain('dooknow:primary:start');
  expect(current.content.trimStart().startsWith('{')).toBe(false);
  expect(JSON.parse(resource.source.content).elements.length).toBe(
    JSON.parse(held.content).elements.length,
  );
  expect(resource.preview.state).toBe('ready');
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toHaveCount(0);
});
