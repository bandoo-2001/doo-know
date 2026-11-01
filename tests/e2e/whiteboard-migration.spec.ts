import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.use({ actionTimeout: 10000 });
test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('桌面知识库设置使用固定源生成迁移预览，中断后重开续跑保持原 UUID', async ({ page }) => {
  const name = '迁移-' + crypto.randomUUID(),
    csrf = await (await page.request.get('/api/security/csrf')).json();
  const created = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: name + '.excalidraw',
      content: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [],
        appState: { viewBackgroundColor: '#fff' },
        files: {},
        futureField: { keep: 'original' },
      }),
    },
  });
  expect(created.status()).toBe(201);
  const old = await created.json();
  await page.goto('/?view=settings&section=library');
  const panel = page
    .locator('section.settings-card')
    .filter({ has: page.getByRole('heading', { name: '旧白板迁移', exact: true }) });
  await expect(panel).toBeVisible();
  await panel
    .locator('li')
    .filter({ hasText: name })
    .getByRole('button', { name: '预检', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: '生成预览并迁移此白板', exact: true }),
  ).toBeEnabled();
  let interrupted = false;
  await page.route('**/api/whiteboard-migrations/prepare', async (route) => {
    if (!interrupted) {
      interrupted = true;
      await route.abort('failed');
    } else await route.continue();
  });
  await panel.getByRole('button', { name: '生成预览并迁移此白板', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + old.id)).json()).relativePath).toBe(
    old.relativePath,
  );
  await page.reload();
  const job = panel
    .locator('li')
    .filter({ hasText: name })
    .filter({ has: page.getByRole('button', { name: '续跑', exact: true }) });
  await expect(job).toBeVisible();
  await job.getByRole('button', { name: '续跑', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/notes/' + old.id)).json()).relativePath)
    .toBe('00-Inbox/' + name + '.md');
  const resource = await (await page.request.get('/api/notes/' + old.id + '/diagram')).json();
  expect(resource.preview.state).toBe('ready');
  expect(JSON.parse(resource.source.content).futureField).toEqual({ keep: 'original' });
  await expect(
    panel
      .locator('li')
      .filter({ hasText: name })
      .filter({ has: page.getByRole('button', { name: '打开文档', exact: true }) }),
  ).toContainText('迁移完成');
});

test('桌面迁移一次准备新式、旧式及内嵌白板的全部原生链接预览，并能回滚原始预览', async ({
  page,
}) => {
  const name = 'native-' + crypto.randomUUID(),
    csrf = await (await page.request.get('/api/security/csrf')).json(),
    headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const empty = {
    type: 'excalidraw',
    version: 2,
    elements: [],
    appState: { viewBackgroundColor: '#fff' },
    files: {},
  };
  const main = await post('/api/notes', {
    folderPath: '00-Inbox',
    fileName: name + '.excalidraw',
    content: JSON.stringify(empty),
  });
  const rect = (link: string) =>
    JSON.stringify({
      ...empty,
      elements: [
        {
          id: 'r',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 150,
          height: 80,
          angle: 0,
          strokeColor: '#000000',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 1,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link,
          locked: false,
        },
      ],
    });
  const legacy = await post('/api/notes', {
    folderPath: '00-Inbox',
    fileName: name + '-legacy.excalidraw',
    content: rect(name + '.excalidraw'),
  });
  const primaryIntent = await post('/api/diagram-documents/intents', {
      path: '00-Inbox/' + name + '-primary.md',
      type: 'whiteboard',
      requestId: crypto.randomUUID(),
    }),
    scene = rect('../' + name + '.excalidraw'),
    hash = (await import('node:crypto')).createHash('sha256').update(scene).digest('hex'),
    png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
  const prepared = await post('/api/diagram-documents/prepare', {
    target: { kind: 'creation', intentId: primaryIntent.id },
    type: 'whiteboard',
    source: scene,
    sourceHash: hash,
    title: name,
    renderer: 'excalidraw@0.18.1+dooknow@1',
    config: {},
    pngBase64: png,
    requestId: crypto.randomUUID(),
  });
  const { renderPreparedDiagramDocument } = await import('../../shared/diagram-primary');
  const primary = await post('/api/diagram-documents/commit', {
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: name, source: scene }),
    requestId: crypto.randomUUID(),
  });
  const embedded = await post('/api/notes', {
      folderPath: '00-Inbox',
      fileName: name + '-embedded.md',
      content: '# Embedded',
    }),
    pair = await post('/api/notes/' + embedded.id + '/diagram-artifacts', {
      kind: 'excalidraw',
      source: scene,
      sourceHash: hash,
      pngBase64: png,
      requestId: crypto.randomUUID(),
    });
  const { renderPortableFigure } = await import('../../shared/portable-figure'),
    { serializeDiagramBinding, normalizeDiagramCode } =
      await import('../../shared/diagram-portability'),
    code = JSON.stringify({ source: pair.source.markdownPath }),
    codeHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(normalizeDiagramCode(code))
      .digest('hex'),
    body =
      renderPortableFigure({
        alt: 'EXCALIDRAW 预览',
        previewPath: pair.preview.markdownPath,
        source: { type: 'file', path: pair.source.markdownPath },
      }) +
      '\n' +
      serializeDiagramBinding({ kind: 'excalidraw', sourceHash: hash, codeHash }) +
      '\n\n```excalidraw\n' +
      code +
      '\n```\n';
  expect(
    (
      await page.request.put('/api/notes/' + embedded.id, {
        headers,
        data: { content: body, expectedModifiedAt: embedded.modifiedAt },
      })
    ).ok(),
  ).toBe(true);
  let snapshots = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/diagram-operation-previews\/[^/]+\/prepare$/.test(r.url()))
      snapshots++;
  });
  await page.goto('/?view=settings&section=library');
  const panel = page
    .locator('section.settings-card')
    .filter({ has: page.getByRole('heading', { name: '旧白板迁移', exact: true }) });
  await panel
    .locator('li')
    .filter({ hasText: '00-Inbox/' + name + '.excalidraw' })
    .getByRole('button', { name: '预检', exact: true })
    .click();
  await panel.getByRole('button', { name: '生成预览并迁移此白板', exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get('/api/notes/' + main.id)).json()).relativePath,
      { timeout: 60000 },
    )
    .toBe('00-Inbox/' + name + '.md');
  const completed = panel
    .locator('li')
    .filter({ hasText: '00-Inbox/' + name + '.excalidraw' })
    .filter({ has: page.getByRole('button', { name: '打开文档', exact: true }) });
  await expect(completed).toContainText('迁移完成', { timeout: 30000 });
  expect(snapshots).toBeGreaterThanOrEqual(4);
  for (const id of [primary.id, legacy.id])
    expect(
      (await (await page.request.get('/api/notes/' + id + '/diagram')).json()).preview.state,
    ).toBe('ready');
  await completed.getByRole('button', { name: '回滚未编辑的迁移', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/notes/' + main.id)).json()).relativePath)
    .toBe(main.relativePath);
  expect(
    (await (await page.request.get('/api/notes/' + legacy.id + '/diagram')).json()).preview.state,
  ).toBe('ready');
  expect((await (await page.request.get('/api/notes/' + embedded.id)).json()).content).toBe(body);
});
