import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.use({ actionTimeout: 8000 });
test.setTimeout(60000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
for (const legacy of [false, true])
  test(`桌面创建${legacy ? '旧白板的 Markdown' : '普通笔记'}副本，保留原件并分配新身份`, async ({
    page,
  }) => {
    const origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179);
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const name = 'copy-source-' + crypto.randomUUID(),
      content = legacy
        ? JSON.stringify({
            type: 'excalidraw',
            version: 2,
            elements: [],
            appState: { viewBackgroundColor: '#fff' },
            files: {},
            future: { keep: 'original' },
          })
        : '# Copy source\n说明正文必须保留。\n';
    const created = await page.request.post('/api/notes', {
      headers: { origin, 'x-csrf-token': csrf.token },
      data: { folderPath: '00-Inbox', fileName: name + (legacy ? '.excalidraw' : '.md'), content },
    });
    expect(created.status()).toBe(201);
    const source = await created.json();
    await page.goto('/?folder=00-Inbox');
    const row = page.locator('.folder-entry-open').filter({ hasText: name });
    await row.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建文档副本', exact: true });
    const destination = 'copied-' + crypto.randomUUID() + '.md';
    await dialog.getByLabel('副本文件名', { exact: true }).fill(destination);
    await dialog.getByRole('button', { name: '创建副本', exact: true }).click();
    await expect(dialog).toBeHidden();
    const id = new URL(page.url()).searchParams.get('note')!;
    expect(id).not.toBe(source.id);
    const copy = await (await page.request.get('/api/notes/' + id)).json();
    expect(copy.relativePath).toBe('00-Inbox/' + destination);
    expect((await (await page.request.get('/api/notes/' + source.id)).json()).content).toBe(
      source.content,
    );
    if (legacy) {
      expect(copy.documentType).toBe('whiteboard');
      const diagram = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
      expect(diagram.preview.state).toBe('ready');
      expect(JSON.parse(diagram.source.content).future).toEqual({ keep: 'original' });
    } else expect(copy.content).toBe(content);
  });
