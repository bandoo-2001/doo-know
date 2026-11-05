import { readFile } from 'node:fs/promises';
import type { BrowserContext, Download, Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.use({ sourceEditorPreference: true });

async function downloadedText(download: Download) {
  const file = await download.path();
  expect(file).toBeTruthy();
  return readFile(file!, 'utf8');
}

async function openEmbeddedWhiteboard(page: Page, context: BrowserContext) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建白板', exact: true });
  await create.getByLabel('文件名', { exact: true }).fill('close-prompt-' + crypto.randomUUID());
  await create.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const boardId = new URL(page.url()).searchParams.get('note')!;
  const boardResponse = await page.request.get('/api/notes/' + boardId);
  expect(boardResponse.status()).toBe(200);
  const board = await boardResponse.json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const parentSource = '# 关闭提示宿主\n\n```excalidraw\n' + boardId + '\n```\n\n父正文保留。\n';
  const response = await page.request.post('/api/notes', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: 'close-parent-' + crypto.randomUUID() + '.md', content: parentSource },
  });
  expect(response.status(), await response.text()).toBe(201);
  const parent = await response.json();
  await page.goto('/?note=' + parent.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.locator('.preview-panel').getByRole('button', { name: '编辑设计', exact: true }).click();
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  return { workspace, boardId, board, parent, parentSource };
}

async function failSaveWithMarkdownDraft(page: Page, workspace: Locator) {
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = workspace.locator('.cm-content');
  await expect(editor).toContainText('dooknow:primary:start');
  // Only the post-creation save transport fails. The real editor/session/close
  // code owns the draft and recovery decision throughout this scenario.
  await page.route('**/api/diagram-documents/prepare', (route) => route.abort('failed'));
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\n尚未保存的关闭提示草稿。\n');
  await expect(editor).toContainText('尚未保存的关闭提示草稿。');
  return editor;
}

for (const width of [320, 390]) {
  test(`diagram close prompt keeps recovery actions reachable and draft intact at ${width}px`, async ({ page, context }) => {
    test.setTimeout(90000);
    const { workspace, boardId, board, parent, parentSource } = await openEmbeddedWhiteboard(page, context);
    const editor = await failSaveWithMarkdownDraft(page, workspace);
    await page.setViewportSize({ width, height: 844 });
    await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
    const prompt = workspace.getByRole('dialog', { name: '保留图形草稿', exact: true });
    await expect(prompt).toBeVisible();
    const bounds = (await prompt.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(width - 32);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    for (const name of ['继续编辑', '下载草稿', '放弃修改并返回']) {
      const button = prompt.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      expect(await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    }
    await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(prompt).toBeHidden();
    await expect(editor).toContainText('尚未保存的关闭提示草稿。');
    await editor.press('ControlOrMeta+Home');
    await expect(editor).toContainText('dooknow:primary:start');
    await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
    await expect(prompt).toBeVisible();
    const pendingDownload = page.waitForEvent('download');
    await prompt.getByRole('button', { name: '下载草稿', exact: true }).click();
    const download = await pendingDownload;
    const content = await downloadedText(download);
    expect(content).toContain('dooknow:primary:start');
    expect(content).toContain('尚未保存的关闭提示草稿。');
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    await expect(workspace).toBeVisible();
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: '放弃修改并返回', exact: true }).click();
    await expect(workspace).toHaveCount(0);
    await expect(page.locator('.preview-panel')).toContainText('父正文保留。');
    expect(new URL(page.url()).searchParams.get('note')).toBe(parent.id);
    expect((await (await page.request.get('/api/notes/' + parent.id)).json()).content).toBe(parentSource);
    expect((await (await page.request.get('/api/notes/' + boardId)).json()).content).toBe(board.content);
  });
}

test('diagram close decision traps keyboard focus and blocks background actions', async ({ page, context }) => {
  test.setTimeout(90000);
  const { workspace } = await openEmbeddedWhiteboard(page, context);
  await failSaveWithMarkdownDraft(page, workspace);
  await page.setViewportSize({ width: 320, height: 844 });
  const back = workspace.getByRole('button', { name: '返回笔记', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  const prompt = workspace.getByRole('dialog', { name: '保留图形草稿', exact: true });
  await expect(prompt).toBeVisible();
  const proceed = prompt.getByRole('button', { name: '继续编辑', exact: true });
  await expect(proceed).toBeFocused();
  let modalPrepares = 0;
  const countPrepare = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/diagram-documents/prepare') modalPrepares++;
  };
  page.on('request', countPrepare);
  await page.keyboard.press('ControlOrMeta+s');
  // Stay inside the close decision past the real 1200ms autosave debounce:
  // neither a window-level shortcut nor resumed debounce may bypass it.
  await page.waitForTimeout(1800);
  expect(modalPrepares).toBe(0);
  page.off('request', countPrepare);
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    expect(await prompt.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const retry = workspace.locator('.diagram-document-error button').filter({ hasText: '重试' });
  const point = (await retry.boundingBox())!;
  expect(await retry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(false);
  await page.mouse.click(point.x + point.width / 2, point.y + point.height / 2);
  await expect(prompt).toBeVisible();
  await proceed.click();
  await expect(prompt).toBeHidden();
  await expect(back).toBeFocused();
  await expect(workspace.locator('.cm-content')).toContainText('尚未保存的关闭提示草稿。');
  const outsideSave = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/diagram-documents/prepare');
  await page.keyboard.press('ControlOrMeta+s');
  await outsideSave;
});

test('long folder ancestry remains fully readable and creation stays reachable at 320px', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token };
  const names = ['long-ancestry-' + crypto.randomUUID(), 'SharedPrefixLongContinuousDirectoryNameForNarrowScreenAlpha', 'SharedPrefixLongContinuousDirectoryNameForNarrowScreenOmega'];
  let path = '00-Inbox';
  for (const name of names) {
    const response = await page.request.post('/api/folders', { headers, data: { parent: path, name } });
    expect(response.status(), await response.text()).toBe(201);
    path += '/' + name;
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?folder=' + encodeURIComponent(path));
  const folder = page.locator('.folder-view');
  await expect(folder.getByRole('heading', { name: names[2], exact: true })).toBeVisible();
  const breadcrumb = folder.locator(':scope > .folder-header > .breadcrumb');
  await expect(breadcrumb).toContainText(names[0]);
  await expect(breadcrumb).toContainText(names[2]);
  const lines = await breadcrumb.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
  });
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.left).toBeGreaterThanOrEqual(0);
    expect(line.right).toBeLessThanOrEqual(320);
  }
  await folder.locator('.folder-header').getByRole('button', { name: '新建笔记', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建笔记', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '新建笔记', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(folder.getByRole('button', { name: '新建文件夹', exact: true })).toBeVisible();
});

async function nativeRectangleDraft(page: Page, workspace: Locator, boardId: string) {
  await page.route('**/api/diagram-documents/prepare', (route) => route.abort('failed'));
  const canvas = workspace.locator('canvas.interactive');
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 200, y: 180 } });
  await page.keyboard.press('r');
  await page.mouse.move(bounds.x + 350, bounds.y + 250);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 450, bounds.y + 330, { steps: 8 });
  await page.mouse.up();
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('保存未完成');
  const draft = () => page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dooknow-local-drafts', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<any>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () => { resolve(request.result.find((item) => item.noteId === id)); db.close(); };
      request.onerror = () => reject(request.error);
    });
  }, boardId);
  await expect.poll(async () => JSON.parse((await draft())?.content || '{}').elements?.some((element: {type: string}) => element.type === 'rectangle')).toBe(true);
  return draft();
}

test('native-only recovery downloads the edited original before explicit discard', async ({ page, context }) => {
  test.setTimeout(90000);
  const { workspace, boardId, board, parent, parentSource } = await openEmbeddedWhiteboard(page, context);
  const resourceBefore = await (await page.request.get('/api/notes/' + boardId + '/diagram')).json();
  const local = await nativeRectangleDraft(page, workspace, boardId);
  await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
  const prompt = workspace.getByRole('dialog', { name: '保留图形草稿', exact: true });
  await expect(prompt).toBeVisible();
  const pendingDownload = page.waitForEvent('download');
  await prompt.getByRole('button', { name: '下载草稿', exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/\.excalidraw$/);
  const content = await downloadedText(download);
  expect(content).toBe(local.content);
  expect(JSON.parse(content).elements.some((element: {type: string}) => element.type === 'rectangle')).toBe(true);
  await expect(workspace).toBeVisible();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '放弃修改并返回', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('note')).toBe(parent.id);
  expect((await (await page.request.get('/api/notes/' + parent.id)).json()).content).toBe(parentSource);
  expect((await (await page.request.get('/api/notes/' + boardId)).json()).content).toBe(board.content);
  expect((await (await page.request.get('/api/notes/' + boardId + '/diagram')).json()).source.content).toBe(resourceBefore.source.content);
});

test('held mixed recovery downloads exact native and whole Markdown before explicit discard', async ({ page, context }) => {
  test.setTimeout(90000);
  const { workspace, boardId, board, parent, parentSource } = await openEmbeddedWhiteboard(page, context);
  const resourceBefore = await (await page.request.get('/api/notes/' + boardId + '/diagram')).json();
  const local = await nativeRectangleDraft(page, workspace, boardId);
  // Controlled existing-v2 storage fixture: start with a real native edit and
  // durable record, then add independently held Markdown. No API/session mocks
  // or production import capability are introduced by this setup.
  local.diagram.documentMarkdown += '\nMIXED_HELD_MARKDOWN_MUST_SURVIVE\n';
  const parentUrl = page.url();
  // Leave the live editor before seeding, so its beforeunload persistence
  // cannot replace this controlled fixture with the older live snapshot.
  await page.goto('/api/security/csrf');
  await page.evaluate(async (record) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dooknow-local-drafts', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put(record);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    });
  }, local);
  await page.goto(parentUrl);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.locator('.preview-panel').getByRole('button', { name: '编辑设计', exact: true }).click();
  await expect(workspace.locator('.draft-recovery')).toContainText('发现未保存的本地草稿');
  await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
  const prompt = workspace.getByRole('dialog', { name: '保留图形草稿', exact: true });
  await expect(prompt).toBeVisible();
  const pendingDownload = page.waitForEvent('download');
  await prompt.getByRole('button', { name: '下载草稿', exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/\.draft\.json$/);
  const saved = JSON.parse(await downloadedText(download));
  expect(saved).toEqual(local.diagram);
  expect(saved.documentMarkdown).toContain('dooknow:primary:start');
  expect(saved.documentMarkdown).toContain('MIXED_HELD_MARKDOWN_MUST_SURVIVE');
  expect(saved.payload).toBe(local.content);
  expect(JSON.parse(saved.payload).elements.some((element: {type: string}) => element.type === 'rectangle')).toBe(true);
  await expect(workspace).toBeVisible();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '放弃修改并返回', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('note')).toBe(parent.id);
  expect((await (await page.request.get('/api/notes/' + parent.id)).json()).content).toBe(parentSource);
  expect((await (await page.request.get('/api/notes/' + boardId)).json()).content).toBe(board.content);
  expect((await (await page.request.get('/api/notes/' + boardId + '/diagram')).json()).source.content).toBe(resourceBefore.source.content);
});
