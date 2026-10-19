import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

async function openNote(page: any, context: any, name: string) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await page.request.get('/api/security/csrf');
  const created = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token },
    data: { folderPath: '00-Inbox', fileName: name + '.md', content: '# Original' },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.editor-panels .cm-content')).toContainText('# Original');
  return note;
}
for (const action of ['check', 'save']) {
  test(`ordinary note ${action} recovers an undelivered save once, retaining later input`, async ({
    page,
    context,
  }, info) => {
    const note = await openNote(
      page,
      context,
      `普通保存重试-${action}-${info.project.name}-${Date.now()}`,
    );
    const writes: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith(`/api/notes/${note.id}`))
        writes.push(request.postDataJSON());
    });
    await page.route(
      `**/api/notes/${note.id}`,
      async (route) => {
        if (route.request().method() === 'PUT') await route.abort('failed');
        else await route.continue();
      },
      { times: 1 },
    );
    const editor = page.locator('.editor-panels .cm-content');
    await editor.fill('# Submitted before disconnect');
    await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
    await editor.fill('# Later unsaved typing');
    if (action === 'check')
      await page.getByRole('button', { name: '核对保存结果', exact: true }).click();
    else await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toHaveCount(0);
    expect(writes[1]).toEqual(writes[0]);
    expect((writes[1] as any).expectedModifiedAt).toBe(note.modifiedAt);
    expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toBe(
      '# Submitted before disconnect',
    );
    await expect(editor).toContainText('# Later unsaved typing');
    await expect(page.locator('.save-state')).toContainText('未保存');
    await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toBe(
      '# Later unsaved typing',
    );
  });
}
test('ordinary note confirms a committed save whose response was lost without repeating the write', async ({
  page,
  context,
}, info) => {
  const note = await openNote(page, context, `普通保存回执-${info.project.name}-${Date.now()}`);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(`/api/notes/${note.id}`)) writes++;
  });
  await page.route(
    `**/api/notes/${note.id}`,
    async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  const editor = page.locator('.editor-panels .cm-content');
  await editor.fill('# Committed but response lost');
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await editor.fill('# Later unsaved typing');
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toBe(
    '# Committed but response lost',
  );
  await expect(editor).toContainText('# Later unsaved typing');
  await expect(page.locator('.save-state')).toContainText('未保存');
});
