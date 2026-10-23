import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

const original = '# 启动归属保护\r\n\r\n这段原文保持完整。\r\n';
const marker = '中文草稿完整保留';
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}
async function seed(context: BrowserContext, content = original) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await context.request.get('/api/security/csrf')).json();
  const response = await context.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: `ownership-${crypto.randomUUID()}.md`, content, requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function sidebar(page: Page) {
  const open = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (await open.isVisible() && !await page.locator('.sidebar').evaluate((el) => el.classList.contains('open'))) await open.click();
}
async function draftContent(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    if (!(await indexedDB.databases()).some((db) => db.name === 'dooknow-local-drafts')) return;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dooknow-local-drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result.find((draft) => draft.noteId === id)?.content);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, id);
}

for (const source of [false, true]) test.describe(source ? 'Markdown' : '文档', () => {
  test.use({ sourceEditorPreference: source });
  test('启动归属核对阻止提前刷新与历史跳转，随后输入可恢复并完整保存', async ({ page, context }) => {
    const note = await seed(context), identity = gate();
    let sessions = 0, held = false, noteReads = 0, writes = 0;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/notes/' + note.id) && request.method() === 'GET') noteReads++;
      if (path === '/api/notes/' + note.id && request.method() === 'PUT') writes++;
    });
    await page.route('**/api/auth/get-session', async (route) => {
      if (++sessions === 2) { held = true; await identity.pending; }
      await route.continue().catch(() => {});
    });
    const editor = source ? page.locator('.cm-content') : page.getByRole('textbox', { name: '文档正文', exact: true });
    try {
      await page.goto('/');
      await expect.poll(() => held).toBe(true);
      await sidebar(page);
      const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/tree'));
      await page.getByRole('button', { name: '刷新目录', exact: true }).click();
      expect((await refreshed).ok()).toBe(true);
      await expect(page.getByRole('button', { name: '展开 00-Inbox', exact: true })).toHaveCount(0);
      // A real history event also reaches the common opening boundary while
      // the directory is intentionally unpublished.
      await page.evaluate((id) => {
        history.pushState({ dooknowIndex: 1 }, '', '/?note=' + id);
        dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      }, note.id);
      await expect(editor).toHaveCount(0);
      expect(noteReads).toBe(0);
    } finally { identity.release(); }
    await expect(editor).toBeEditable();
    await expect(editor).toContainText('这段原文保持完整');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(marker);
    await expect.poll(() => draftContent(page, note.id)).toContain(marker);
    const protectedContent = await draftContent(page, note.id);
    expect(writes).toBe(0);
    expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
    await expect(editor).toContainText(marker);
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/notes/' + note.id) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(protectedContent);
    const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    expect(await readFile(join(config.knowledgeRoot, note.relativePath), 'utf8')).toBe(protectedContent);
    await expect.poll(async () => {
      const response = await context.request.get('/api/notes/' + note.id + '/download');
      if (response.status() === 202) return;
      expect(response.status()).toBe(200);
      return response.text();
    }).toBe(protectedContent);
    await page.reload();
    await expect(editor).toContainText(marker);
    expect(writes).toBe(1);
  });
});

test('归属核对失败时不开放编辑，刷新重试后才显示完整原文', async ({ page, context }) => {
  const note = await seed(context);
  let sessions = 0, reads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/notes/' + note.id)) reads++; });
  await page.route('**/api/auth/get-session', async (route) => {
    if (++sessions === 2) return route.fulfill({ json: {} });
    await route.continue();
  });
  await page.goto('/?note=' + note.id);
  await expect(page.getByText('未能确认本地草稿所属账户与知识库，请手动保存原文。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  await sidebar(page);
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await page.getByRole('button', { name: '展开 00-Inbox', exact: true }).click();
  await page.getByRole('button', { name: note.relativePath.split('/').at(-1), exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeEditable();
  expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});

test('归属核对期间仍能进入设置，迟到的启动跳转不会覆盖新页面', async ({ page, context }) => {
  const note = await seed(context), identity = gate();
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      (window as any).__ownershipHashComplete = true;
      return result;
    };
  });
  let sessions = 0, held = false;
  await page.route('**/api/auth/get-session', async (route) => {
    if (++sessions === 2) { held = true; await identity.pending; }
    await route.continue().catch(() => {});
  });
  try {
    await page.goto('/?note=' + note.id);
    await expect.poll(() => held).toBe(true);
    await sidebar(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '编辑器与外观', exact: true })).toBeVisible();
  } finally { identity.release(); }
  await page.waitForFunction(() => (window as any).__ownershipHashComplete === true);
  await expect(page).toHaveURL(/view=settings/);
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '编辑器与外观', exact: true })).toBeVisible();
  expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});

test('侧栏返回笔记保留当前原文和编辑状态', async ({ page, context }) => {
  const note = await seed(context);
  await page.goto('/?note=' + note.id);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor).toBeEditable();
  await sidebar(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await sidebar(page);
  await page.locator('aside').getByRole('button', { name: '返回笔记', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  await expect(editor).toBeEditable();
  expect((await (await context.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});

test('新建对话框不打断已经开始的历史跳转', async ({ page, context }) => {
  const a = await seed(context), b = await seed(context, '# 历史目标B\n\n完整目标正文。\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await page.goto('/?note=' + a.id);
  await expect(editor).toBeEditable();
  await sidebar(page);
  await page.getByRole('button', { name: '展开 00-Inbox', exact: true }).click();
  await page.getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true }).click();
  await expect(editor).toContainText('历史目标B');
  await sidebar(page);
  await page.getByRole('button', { name: a.relativePath.split('/').at(-1), exact: true }).click();
  await expect(editor).toContainText('这段原文保持完整');
  const metadata = gate();
  let held = false;
  await page.route('**/api/notes/' + b.id + '/meta', async (route) => {
    held = true;
    await metadata.pending;
    await route.continue().catch(() => {});
  });
  try {
    await page.evaluate(() => history.back());
    await expect.poll(() => held).toBe(true);
    await sidebar(page);
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
  } finally { metadata.release(); }
  await expect(editor).toContainText('历史目标B');
  await expect(page).toHaveURL(new RegExp('note=' + b.id));
  expect((await (await context.request.get('/api/notes/' + a.id)).json()).content).toBe(original);
  expect((await (await context.request.get('/api/notes/' + b.id)).json()).content).toBe(b.content);
});
