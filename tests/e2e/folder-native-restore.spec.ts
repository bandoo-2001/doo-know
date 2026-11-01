import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.setTimeout(90000);
test('renamed trash folder renders all archived and live native final snapshots before activation', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179),
    csrf = await (await page.request.get('/api/security/csrf')).json(),
    headers = { origin, 'x-csrf-token': csrf.token },
    suffix = crypto.randomUUID(),
    name = 'archive-native-' + suffix,
    next = 'restored-native-' + suffix,
    folder = '00-Inbox/' + name;
  expect(
    (await page.request.post('/api/folders', { headers, data: { parent: '00-Inbox', name } })).ok(),
  ).toBe(true);
  async function note(folderPath: string, fileName: string, content: string) {
    const response = await page.request.post('/api/notes', {
      headers,
      data: { folderPath, fileName, content },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const inside = await note(folder, 'inside.md', '# Inside');
  function scene(link: string) {
    return JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'label', type: 'text', text: '归档原生标签', link }],
      appState: {},
      files: {},
    });
  }
  const board = await note(folder, 'board.excalidraw', scene('../' + name + '/inside.md'));
  const outside = await note(
    '00-Inbox',
    'outside-native-' + suffix + '.excalidraw',
    scene(name + '/inside.md'),
  );
  const archivedResponse = await page.request.delete('/api/folders', {
    headers,
    data: { path: folder, requestId: crypto.randomUUID() },
  });
  expect(archivedResponse.ok(), await archivedResponse.text()).toBe(true);
  const archived = await archivedResponse.json();
  const preparedIds: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/diagram-operation-previews\/[^/]+\/prepare$/.test(new URL(request.url()).pathname)
    )
      preparedIds.push(new URL(request.url()).pathname.split('/').at(-2)!);
  });
  await page.goto('/?view=trash');
  const row = page
    .locator('li.trash-item')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '更换文件夹名', exact: true }).click();
  await row.getByLabel('恢复时使用的文件夹名').fill(next);
  await row.getByRole('button', { name: '恢复文件夹', exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get('/api/notes/' + inside.id)).json()).relativePath,
      { timeout: 45000 },
    )
    .toBe('00-Inbox/' + next + '/inside.md');
  const archivedNative = await (
      await page.request.get('/api/notes/' + board.id + '/diagram')
    ).json(),
    liveNative = await (await page.request.get('/api/notes/' + outside.id + '/diagram')).json();
  expect(archivedNative.preview.state).toBe('ready');
  expect(liveNative.preview.state).toBe('ready');
  expect(JSON.parse(archivedNative.source.content).elements[0].link).toBe('inside.md');
  expect(JSON.parse(liveNative.source.content).elements[0].link).toBe(next + '/inside.md');
  expect(preparedIds).toHaveLength(2);
  await page.screenshot({
    path: info.outputPath('renamed-folder-native-restored.png'),
    animations: 'disabled',
  });
});
