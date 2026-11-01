import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.use({ actionTimeout: 8000 });
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
test('批量整理为关联原生白板准备预览，刷新记录后可撤销并保留原身份', async ({ page }) => {
  const origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179),
    csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin, 'x-csrf-token': csrf.token },
    suffix = crypto.randomUUID();
  const target = await (
    await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: 'batch-target-' + suffix + '.md',
        content: '# Target\n',
      },
    })
  ).json();
  const scene = {
    type: 'excalidraw',
    version: 2,
    elements: [
      { id: 'label', type: 'text', text: '保留标签', link: target.relativePath.split('/').at(-1) },
    ],
    appState: {},
    files: {},
  };
  const board = await (
    await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: 'batch-board-' + suffix + '.excalidraw',
        content: JSON.stringify(scene),
      },
    })
  ).json();
  const folderName = 'batch-' + suffix;
  expect(
    (
      await page.request.post('/api/folders', {
        headers,
        data: { parent: '00-Inbox', name: folderName },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/?view=settings&section=library');
  const panel = page
    .locator('section.settings-card')
    .filter({ has: page.getByRole('heading', { name: '批量整理', exact: true }) });
  await expect(panel).toBeVisible();
  await panel.locator('summary').filter({ hasText: '选择需要移动的笔记' }).click();
  await panel.getByLabel('选择 ' + target.relativePath, { exact: true }).check();
  await panel.locator('.directory-select .ant-select-selector').click();
  await panel.getByRole('combobox', { name: '整理目标目录', exact: true }).fill(folderName);
  await page.locator('.directory-tree-popup').getByText(folderName, { exact: true }).click();
  await panel.getByRole('button', { name: '移动选中笔记', exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get('/api/notes/' + target.id)).json()).relativePath,
    )
    .toBe('00-Inbox/' + folderName + '/' + target.relativePath.split('/').at(-1));
  const updated = await (await page.request.get('/api/notes/' + board.id + '/diagram')).json();
  expect(updated.preview.state).toBe('ready');
  expect(JSON.parse(updated.source.content).elements[0].link).toContain(folderName);
  await page.reload();
  await panel.getByRole('button', { name: '撤销此整理', exact: true }).first().click();
  await expect
    .poll(
      async () => (await (await page.request.get('/api/notes/' + target.id)).json()).relativePath,
    )
    .toBe(target.relativePath);
  const reverted = await (await page.request.get('/api/notes/' + board.id + '/diagram')).json();
  expect(reverted.preview.state).toBe('ready');
  expect(JSON.parse(reverted.source.content).elements[0].link).toBe(scene.elements[0].link);
});
