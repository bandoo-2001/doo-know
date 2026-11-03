import { test, expect } from '../support/browser-test';
import { dirname, resolve, relative } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { clickNoteAction } from '../support/note-actions';
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
for (const [type, label] of [
  ['whiteboard', '白板'],
  ['mindmap', '脑图'],
  ['flowchart', '流程图'],
] as const) {
  test(`桌面 ${label} 创建 Markdown，专用编辑保存并刷新保留说明`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '创建与导入', exact: true }).click();
    await page.getByRole('button', { name: '新建' + label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
    await dialog
      .getByLabel('文件名', { exact: true })
      .fill('桌面' + label + '-' + crypto.randomUUID());
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const workspace = page.getByTestId('diagram-document-workspace');
    await expect(workspace).toBeVisible({ timeout: 45000 });
    const id = new URL(page.url()).searchParams.get('note')!;
    const main = await (await page.request.get('/api/notes/' + id)).json();
    expect(main.relativePath).toMatch(/\.md$/);
    expect(main.content).toContain('dooknow:primary:start');
    expect(main.documentType).toBe(type);
    if (type === 'whiteboard') {
      const canvas = workspace.locator('canvas.interactive');
      await expect(canvas).toBeVisible({ timeout: 30000 });
      const box = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: 200, y: 200 } });
      await page.keyboard.press('r');
      await page.mouse.move(box.x + 350, box.y + 250);
      await page.mouse.down();
      await page.mouse.move(box.x + 450, box.y + 330, { steps: 8 });
      await page.mouse.up();
    } else if (type === 'mindmap') {
      await expect(workspace.locator('me-root me-tpc')).toBeVisible();
      await workspace.locator('me-root me-tpc').click();
      await page.keyboard.press('F2');
      await workspace.locator('#input-box').fill('已编辑脑图');
      await page.keyboard.press('Enter');
    } else {
      const source = workspace.locator('.cm-content');
      await source.click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText('flowchart TD\nA[已编辑] --> B[完成]\n');
    }
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await page.screenshot({ path: '.local/markdown-diagrams/desktop-' + type + '.png' });
    await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    const cm = workspace.locator('.cm-content');
    await cm.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n桌面说明保留。\n');
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await page.reload();
    await expect(page.getByTestId('diagram-document-workspace')).toBeVisible();
    await page
      .getByTestId('diagram-document-workspace')
      .getByRole('button', { name: 'Markdown 源码', exact: true })
      .click();
    await expect(page.locator('.cm-content')).toContainText('桌面说明保留。');
    const resource = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
    expect(resource.preview.state).toBe('ready');
    if (type === 'whiteboard')
      expect(JSON.parse(resource.source.content).elements.length).toBeGreaterThan(0);
    else if (type === 'mindmap') {
      expect(resource.title).toBe('已编辑脑图');
      expect(resource.source.content).not.toMatch(/^# /);
      expect(resource.source.content).toContain('- 新节点');
    } else expect(resource.source.content).toContain('已编辑');
  });
}

async function newDiagram(page: import('@playwright/test').Page, label: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建' + label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
  await dialog
    .getByLabel('文件名', { exact: true })
    .fill('恢复' + label + '-' + crypto.randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  return dialog;
}
test('首次预览失败不创建活动stub，刷新后同一意图可恢复', async ({ page }) => {
  let noteId = '',
    intentId = '';
  page.on('response', async (response) => {
    if (
      new URL(response.url()).pathname === '/api/diagram-documents/intents' &&
      response.request().method() === 'POST'
    ) {
      const body = await response.json();
      noteId = body.noteId;
      intentId = body.id;
    }
  });
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      callback(null);
    };
  });
  const dialog = await newDiagram(page, '白板');
  await expect(dialog.getByRole('alert')).toContainText('PNG');
  expect(noteId).toBeTruthy();
  expect((await page.request.get('/api/notes/' + noteId)).status()).toBe(404);
  await page.reload();
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消未完成图形', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复未完成图形', exact: true })).toHaveCount(0);
  expect(
    (await (await page.request.get('/api/diagram-documents/intents/' + intentId)).json()).status,
  ).toBe('cancelled');
});
test('原生白板PNG失败后刷新仍可恢复实际笔画', async ({ page }) => {
  await newDiagram(page, '白板');
  const workspace = page.getByTestId('diagram-document-workspace');
  const canvas = workspace.locator('canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 30000 });
  const id = new URL(page.url()).searchParams.get('note')!;
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      callback(null);
    };
  });
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 350, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 450, box.y + 310, { steps: 8 });
  await page.mouse.up();
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('alert')).toBeVisible();
  const native = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('dooknow-local-drafts', 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise<any>((resolve, reject) => {
      const tx = db.transaction('drafts');
      const req = tx.objectStore('drafts').getAll();
      req.onsuccess = () => {
        const record = req.result.find((record) => record.noteId === id);
        resolve(record);
        db.close();
      };
      req.onerror = () => reject(req.error);
    });
  }, id);
  expect(native.diagram.payloadFormat).toBe('excalidraw');
  expect(JSON.parse(native.content).elements.length).toBeGreaterThan(0);
  expect(native.diagram.documentMarkdown).toContain('dooknow:document');
  await page.reload();
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(
    page.getByTestId('diagram-document-workspace').locator('canvas.interactive'),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(page.getByTestId('diagram-document-workspace').getByRole('status')).toContainText(
    '已保存',
  );
  const resource = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
  expect(JSON.parse(resource.source.content).elements.map((e: any) => e.id)).toEqual(
    JSON.parse(native.content).elements.map((e: any) => e.id),
  );
});
test('未发布意图刷新后恢复相同UUID并激活完整Markdown', async ({ page }) => {
  let noteId = '';
  page.on('response', async (r) => {
    if (
      new URL(r.url()).pathname === '/api/diagram-documents/intents' &&
      r.request().method() === 'POST'
    )
      noteId = (await r.json()).noteId;
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('preview-failed-once')) {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        sessionStorage.setItem('preview-failed-once', '1');
        HTMLCanvasElement.prototype.toBlob = original;
        callback(null);
      };
    }
  });
  const dialog = await newDiagram(page, '白板');
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await page.request.get('/api/notes/' + noteId)).status()).toBe(404);
  await page.reload();
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  await page.getByRole('button', { name: '恢复未完成图形', exact: true }).click();
  await expect(page.getByTestId('diagram-document-workspace')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('note')).toBe(noteId);
  const note = await (await page.request.get('/api/notes/' + noteId)).json();
  expect(note.content).toContain('dooknow:primary-binding');
  expect(note.relativePath).toMatch(/\.md$/);
});
test('未知主提交刷新后原样重试，同时保留后续输入', async ({ page }) => {
  await newDiagram(page, '流程图');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible();
  const id = new URL(page.url()).searchParams.get('note')!;
  const requests: any[] = [];
  let first = true;
  await page.route('**/api/diagram-documents/commit', async (route) => {
    requests.push(route.request().postDataJSON());
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  const cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nA[首次提交] --> B\n');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('alert')).toBeVisible();
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nA[之后输入] --> C\n');
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const req = indexedDB.open('dooknow-local-drafts', 2);
          req.onsuccess = () => resolve(req.result);
        });
        return new Promise<string>((resolve) => {
          const req = db.transaction('drafts').objectStore('drafts').getAll();
          req.onsuccess = () => {
            resolve(req.result.find((r) => r.noteId === id)?.content || '');
            db.close();
          };
        });
      }, id),
    )
    .toContain('之后输入');
  await page.reload();
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.getByTestId('diagram-document-workspace').locator('.cm-content')).toContainText(
    '之后输入',
  );
  await page.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.getByTestId('diagram-document-workspace').getByRole('status')).toContainText(
    '已保存',
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/notes/' + id + '/diagram')).json()).source.content,
    )
    .toContain('之后输入');
});
test('主白板UUID与md路径引用通过resource打开原生设计并保留父正文', async ({ page }) => {
  await newDiagram(page, '白板');
  await expect(
    page.getByTestId('diagram-document-workspace').locator('canvas.interactive'),
  ).toBeVisible({ timeout: 30000 });
  const boardId = new URL(page.url()).searchParams.get('note')!;
  const board = await (await page.request.get('/api/notes/' + boardId)).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const text =
    '# 引用主白板\n\n```excalidraw\n' +
    boardId +
    '\n```\n\n```excalidraw\n' +
    board.relativePath.split('/').at(-1) +
    '\n```\n\n保留父说明。\n';
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: '主图引用-' + crypto.randomUUID() + '.md',
      content: text,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const parent = await response.json();
  await page.goto('/?note=' + parent.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const edits = page
    .locator('.preview-panel')
    .getByRole('button', { name: '编辑设计', exact: true });
  await expect(edits).toHaveCount(2);
  for (const index of [0, 1]) {
    await edits.nth(index).click();
    const workspace = page.getByTestId('diagram-document-workspace');
    await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('whiteboard-workspace')).toHaveCount(0);
    await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
    await expect(workspace).toHaveCount(0);
  }
  expect((await (await page.request.get('/api/notes/' + parent.id)).json()).content).toBe(text);
});
test('不合法源码保留编辑文本与旧PNG，不能切换为空白设计', async ({ page }) => {
  await newDiagram(page, '流程图');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.locator('.diagram-pg img')).toBeVisible();
  const previous = await workspace.locator('.diagram-pg img').getAttribute('src');
  const cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('broken flowchart !!!');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('alert')).toBeVisible();
  await expect(cm).toHaveText('broken flowchart !!!');
  await expect(workspace.locator('.diagram-pg img')).toHaveAttribute('src', previous!);
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(cm).toHaveText('broken flowchart !!!');
});
test('阅读HTML与PNG和源码共享同一文档会话，阅读显示说明', async ({ page }) => {
  await newDiagram(page, '流程图');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible();
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n阅读说明保留。\n');
  await workspace.getByRole('button', { name: '阅读', exact: true }).click({ timeout: 2000 });
  await expect(workspace.locator('article')).toContainText('阅读说明保留。');
  await expect(workspace.locator('article img')).toBeVisible();
  await workspace.getByRole('button', { name: 'PNG 预览', exact: true }).click();
  await expect(workspace.locator('.diagram-pg img')).toBeVisible();
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(workspace.locator('.cm-content')).toContainText('阅读说明保留。');
});
test('白板原件丢失时保留最后PNG与Markdown，不创建空场景', async ({ page }) => {
  await newDiagram(page, '白板');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  const id = new URL(page.url()).searchParams.get('note')!;
  const note = await (await page.request.get('/api/notes/' + id)).json(),
    resource = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const path = resolve(
    config.knowledgeRoot,
    dirname(note.relativePath),
    decodeURIComponent(resource.source.path),
  );
  const local = relative(resolve(config.knowledgeRoot), path);
  expect(local).not.toMatch(/^\.\.|^\//);
  await unlink(path);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      /\/diagram-documents\/(?:prepare|commit)$/.test(new URL(r.url()).pathname)
    )
      writes.push(r.url());
  });
  await page.reload();
  await expect(page.getByTestId('diagram-document-workspace').getByRole('alert')).toContainText(
    '图形源不可编辑',
  );
  await expect(
    page.getByTestId('diagram-document-workspace').locator('.diagram-pg img'),
  ).toBeVisible();
  await expect(
    page.getByTestId('diagram-document-workspace').locator('canvas.interactive'),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存图形', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('dooknow:document');
  expect(writes).toEqual([]);
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toBe(note.content);
});
test('便携导出下载真实归档，设置页按整包导入并分配新ID', async ({ page }) => {
  await newDiagram(page, '流程图');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible();
  const originalId = new URL(page.url()).searchParams.get('note')!;
  const downloading = page.waitForEvent('download');
  await clickNoteAction(page, '下载完整文档');
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/);
  const buffer = await readFile((await download.path())!);
  await page.goto('/?view=settings&section=library');
  await page.getByRole('button', { name: '导入便携包', exact: true }).click({ timeout: 2000 });
  const dialog = page.getByRole('dialog', { name: '导入便携包', exact: true });
  await dialog
    .getByLabel('便携归档文件', { exact: true })
    .setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/gzip', buffer });
  await dialog
    .getByLabel('导入目录', { exact: true })
    .fill('00-Inbox/portable-' + crypto.randomUUID());
  const oldImports: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/manage/import') oldImports.push(r.url());
  });
  const uploaded = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/portable-deliveries/import' &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '导入整包', exact: true }).click();
  const response = await uploaded;
  expect(response.status(), await response.text()).toBe(201);
  expect(response.request().headers()['content-type']).toContain('multipart/form-data');
  const result = await response.json();
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0].noteId).not.toBe(originalId);
  await expect(dialog).toContainText('导入完成');
  expect(oldImports).toEqual([]);
  const imported = await (
    await page.request.get('/api/notes/' + result.notes[0].noteId + '/diagram')
  ).json();
  expect(imported).toMatchObject({ documentType: 'flowchart', preview: { state: 'ready' } });
  expect(imported.source.content).toContain('flowchart TD');
});
test('主图HTML下载嵌入已验证PNG和说明，默认不包含原生源', async ({ page }) => {
  await newDiagram(page, '流程图');
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible();
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nHTML说明保留。\n');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const downloading = page.waitForEvent('download');
  await workspace.getByRole('button', { name: '导出 HTML', exact: true }).click({ timeout: 2000 });
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  const html = await readFile((await download.path())!, 'utf8');
  expect(html).toContain('HTML说明保留。');
  expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain('flowchart TD');
  expect(html).not.toContain('dooknow:primary');
});
