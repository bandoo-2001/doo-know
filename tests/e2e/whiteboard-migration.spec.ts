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
