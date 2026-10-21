import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import type { BrowserContext } from '@playwright/test';

const original = '# 启动完整性\r\n\r\n原文与草稿归属必须保留。\r\n\r\n<!-- 不改写 -->\r\n';

async function seed(context: BrowserContext) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await context.request.get('/api/security/csrf')).json();
  const response = await context.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox', fileName: `startup-${crypto.randomUUID()}.md`,
      content: original, requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}

function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

test('已确认登录后并行加载工作区界面，安全检查完成前不开启编辑', async ({ page, context }) => {
  const id = await seed(context), csrf = gate();
  let csrfPending = false, workspaceRequested = false, noteRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/components\/Workspace\.vue$|\/assets\/Workspace-[^/]+\.js$/.test(path)) workspaceRequested = true;
    if (path.startsWith('/api/notes/')) noteRequests++;
  });
  await page.route('**/api/security/csrf', async (route) => {
    csrfPending = true;
    await csrf.pending;
    await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => csrfPending).toBe(true);
    await expect.poll(() => workspaceRequested).toBe(true);
    expect(noteRequests).toBe(0);
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  } finally { csrf.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('启动完整性');
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

test('目录读取与草稿归属核对并行，确认归属后才打开笔记', async ({ page, context }) => {
  const id = await seed(context), scope = gate();
  let sessions = 0, scopePending = false, treeRequested = false, noteRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/tree') treeRequested = true;
    if (path.startsWith('/api/notes/')) noteRequests++;
  });
  await page.route('**/api/auth/get-session', async (route) => {
    if (++sessions === 2) { scopePending = true; await scope.pending; }
    await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => scopePending).toBe(true);
    await expect.poll(() => treeRequested).toBe(true);
    expect(noteRequests).toBe(0);
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新建笔记', exact: true }).first()).toBeDisabled();
  } finally { scope.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('启动完整性');
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

test('正文与附件信息并行读取，等待完成后用完整原文开启编辑', async ({ page, context }) => {
  const id = await seed(context), body = gate();
  let bodyPending = false, assetsRequested = false, writes = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/notes/${id}/assets`) assetsRequested = true;
    if (request.method() === 'PUT' && path === '/api/notes/' + id) writes++;
  });
  await page.route('**/api/notes/' + id, async (route) => {
    bodyPending = true;
    await body.pending;
    await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => bodyPending).toBe(true);
    await expect.poll(() => assetsRequested).toBe(true);
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  } finally { body.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('启动完整性');
  expect(writes).toBe(0);
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

test('提前加载界面失败不损坏登录状态，安全检查后仍能打开原文', async ({ page, context }) => {
  const id = await seed(context), csrf = gate();
  let workspaceURL = '', available = false, writes = 0;
  page.on('request', (request) => { if (request.method() === 'PUT') writes++; });
  await page.route('**/api/security/csrf', async (route) => {
    await csrf.pending;
    await route.continue();
  });
  await page.route((url) => /\/components\/Workspace\.vue$|\/assets\/Workspace-[^/]+\.js$/.test(url.pathname), async (route) => {
    workspaceURL = route.request().url();
    if (!available) return route.abort('connectionfailed');
    await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => workspaceURL).not.toBe('');
    // Establish a completed module-load failure, rather than assuming the
    // bundler makes exactly one preload request before evaluating its module.
    expect(await page.evaluate(async (url) => {
      try { await import(url); return true; } catch { return false; }
    }, workspaceURL)).toBe(false);
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  } finally { available = true; csrf.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('启动完整性');
  expect(writes).toBe(0);
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

test('正式构建阻断启动后的异步样式，恢复后目录操作样式仍完整', async ({ page, context }) => {
  test.skip(process.env.DOOKNOW_E2E_PRODUCTION !== '1', '此项验证生产打包的异步CSS；开发构建直接注入样式');
  const id = await seed(context), csrf = gate();
  let available = false, workspaceURL = '', deferredStyles = 0;
  page.on('request', (request) => {
    if (/\/assets\/Workspace-[^/]+\.js$/.test(new URL(request.url()).pathname)) workspaceURL = request.url();
  });
  await page.addInitScript(() => {
    window.addEventListener('vite:preloadError', (event) => {
      if (String((event as any).payload?.message).includes('CSS')) (window as any).__startupCssFailed = true;
    });
  });
  await page.route('**/api/security/csrf', async (route) => { await csrf.pending; await route.continue(); });
  await page.route((url) => /\/assets\/Workspace-[^/]+\.css$/.test(url.pathname), async (route) => {
    deferredStyles++;
    if (!available) return route.abort('connectionfailed');
    await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => workspaceURL).not.toBe('');
    expect(await page.evaluate(async (url) => {
      try { await import(url); return true; } catch { return false; }
    }, workspaceURL)).toBe(true);
    if (deferredStyles) await page.waitForFunction(() => (window as any).__startupCssFailed === true);
  } finally { available = true; csrf.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('启动完整性');
  await expect(page.locator('.tree-more').first()).toHaveCSS('display', 'flex');
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});
