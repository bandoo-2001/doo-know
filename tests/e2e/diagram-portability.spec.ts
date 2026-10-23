import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import { createHash } from 'node:crypto';

test.setTimeout(60000);
test.use({ actionTimeout: 10000 });
const origin = 'http://127.0.0.1:4179';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#dbeafe"/></svg>';

async function insertSvg(page: import('@playwright/test').Page, content = svg) {
  await page
    .getByRole('textbox', { name: '文档正文', exact: true })
    .locator(':scope > p')
    .last()
    .click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: '按 Markdown 粘贴', exact: true }).click();
  const paste = page.getByRole('dialog', { name: '按 Markdown 粘贴', exact: true });
  await paste.getByLabel('Markdown 内容', { exact: true }).fill('```svg\n' + content + '\n```\n');
  await paste.getByRole('button', { name: '插入 Markdown', exact: true }).click();
  await expect(paste).toBeHidden();
}

test('新图形保存先准备源与PNG，父笔记只在明确保存后落盘', async ({ page, context }) => {
  const raw = '# 新图形\n\n保留正文。\n';
  const note = await openDocumentNote(page, context, raw);
  await insertSvg(page);
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存图形预览', exact: true });
  await expect(dialog).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await dialog.getByRole('button', { name: '生成预览并保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const content = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(content).toContain('![SVG 预览](assets/diagram-');
  expect(content).toContain('[图形源文件](assets/diagram-');
  expect(content).toContain('<!-- dooknow:diagram-preview v1 kind=svg code=');
  expect(content).toContain('```svg\n' + svg + '\n```');
  expect(content.startsWith(raw)).toBe(true);
  const pngPath = /!\[SVG 预览\]\(([^)]+)\)/.exec(content)![1];
  const sourcePath = /\[图形源文件\]\(([^)]+)\)/.exec(content)![1];
  const assets = await (await page.request.get('/api/notes/' + note.id + '/assets')).json();
  const image = assets.find((asset: any) => asset.relativePath.endsWith(pngPath));
  const source = assets.find((asset: any) => asset.relativePath.endsWith(sourcePath));
  const response = await page.request.get('/api/assets/' + image.id);
  expect((await response.body()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(await (await page.request.get('/api/assets/' + source.id + '?download=1')).text()).toBe(
    svg + '\n',
  );
});

test('图形准备失败保留草稿，用户仍能明确选择仅保存源码', async ({ page, context }) => {
  const raw = '# 源码保留\n\n正文。\n';
  const note = await openDocumentNote(page, context, raw);
  const invalid = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await insertSvg(page, invalid);
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存图形预览', exact: true });
  await dialog.getByRole('button', { name: '生成预览并保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await dialog.getByRole('button', { name: '仅保存源码', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const content = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(content).toContain(invalid);
  expect(content).not.toContain('![SVG 预览]');
});

test('源码变化后旧PNG不能被当作新预览，源码保存明确移除过期回退', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '# 更新图形\n\n正文。\n');
  await insertSvg(page);
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '保存图形预览', exact: true });
  await dialog.getByRole('button', { name: '生成预览并保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const previous = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const search = page.getByRole('search', { name: '当前笔记查找', exact: true });
  await search.getByLabel('查找内容', { exact: true }).fill('#dbeafe');
  await search.getByLabel('替换内容', { exact: true }).fill('#ff0000');
  await search.getByRole('button', { name: '全部替换', exact: true }).click();
  await search.getByRole('button', { name: '关闭查找', exact: true }).click();
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await expect(page.locator('.document-diagram')).toContainText('旧版本');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(previous);
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '保存图形预览', exact: true });
  await dialog.getByRole('button', { name: '仅保存源码', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved).toContain(svg.replace('#dbeafe', '#ff0000'));
  expect(saved).not.toContain('![SVG 预览]');
  expect(saved).not.toContain('[图形源文件]');
  expect(saved).not.toContain('dooknow:diagram-preview');
});

test('独立白板生成普通Markdown预览副本，原白板内容和保存状态不被改写', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, '# 白板入口\n');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin, 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `portable-${crypto.randomUUID()}.excalidraw`,
      content: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      }),
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const board = await response.json();
  await page.goto('/?note=' + board.id);
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  const canonical = (await (await page.request.get('/api/notes/' + board.id)).json()).content;
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notes',
  );
  await workspace.getByRole('button', { name: '生成 Markdown 预览笔记', exact: true }).click();
  const preview = await (await created).json();
  expect(preview.relativePath).toMatch(/\.md$/);
  expect(preview.content).toContain('![');
  expect(preview.content).toContain('.png)');
  expect(preview.content).toContain('.excalidraw)');
  expect(preview.content).not.toContain('/api/');
  expect((await (await page.request.get('/api/notes/' + board.id)).json()).content).toBe(canonical);
  await expect(workspace.locator('.whiteboard-status')).toContainText('已保存');
});

test('白板在PNG上传期间更新时保留父笔记草稿，重新生成后绑定新版本', async ({ page, context }) => {
  const raw = '# 父笔记\n\n保留正文。\n';
  const note = await openDocumentNote(page, context, raw);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin, 'x-csrf-token': csrf.token };
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'changing-' + crypto.randomUUID() + '.excalidraw',
      content: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 80, height: 40 }],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      }),
    },
  });
  expect(created.status()).toBe(201);
  const board = await created.json();
  await page.getByRole('textbox', { name: '文档正文', exact: true }).locator('p').last().click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: '按 Markdown 粘贴', exact: true }).click();
  const paste = page.getByRole('dialog', { name: '按 Markdown 粘贴', exact: true });
  await paste
    .getByLabel('Markdown 内容', { exact: true })
    .fill('```excalidraw\n' + board.id + '\n```\n');
  await paste.getByRole('button', { name: '插入 Markdown', exact: true }).click();
  let release!: () => void,
    observed!: () => void,
    heldOnce = false;
  const held = new Promise<void>((resolve) => (release = resolve)),
    requested = new Promise<void>((resolve) => (observed = resolve));
  await page.route('**/api/notes/' + note.id + '/diagram-artifacts', async (route) => {
    if (route.request().method() !== 'POST' || heldOnce) return route.continue();
    heldOnce = true;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    observed();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存图形预览', exact: true });
  await dialog.getByRole('button', { name: '生成预览并保存', exact: true }).click();
  await requested;
  const latest = await (await page.request.get('/api/notes/' + board.id)).json();
  const scene = JSON.parse(latest.content);
  scene.appState.viewBackgroundColor = '#fef3c7';
  const changed = await page.request.put('/api/notes/' + board.id, {
    headers,
    data: {
      content: JSON.stringify(scene),
      expectedModifiedAt: latest.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  const current = await changed.json();
  release();
  await expect(dialog.getByRole('alert')).toContainText('白板设计在生成预览时已变化');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
  await dialog.getByRole('button', { name: '生成预览并保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const content = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(content).toContain('source=' + createHash('sha256').update(current.content).digest('hex'));
});
