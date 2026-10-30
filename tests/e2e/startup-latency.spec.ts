import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { showMainMenu } from '../support/settings-navigation';

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

async function unpreparedNote(context: BrowserContext, content = original) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `preparing-${crypto.randomUUID()}.md`;
  await writeFile(join(config.knowledgeRoot, '00-Inbox', fileName), content);
  const entries = await (await context.request.get('/api/tree')).json();
  const find = (items: any[]): any => items.map((item) => item.name === fileName ? item : find(item.children || [])).find(Boolean);
  return find(entries).id as string;
}

// Replay the metadata view at a real accepted preparation boundary. Only the
// preparing discriminator is derived: the initial metadata, accepted operation,
// operation completion, final metadata and document all come from the backend.
// Holding delivery does not claim that the physical snapshot worker is stalled.
async function holdSmallPreparation(page: Page, context: BrowserContext, id: string) {
  const completion = gate();
  let operationId = '', pending = false;
  let accepted: any;
  await page.route('**/api/notes/' + id + '/meta', async (route) => {
    const response = await route.fetch(), metadata = await response.json();
    if (!operationId) {
      expect(metadata.readState).toBe('unknown');
      expect(metadata.editorMode).toBe('large');
      expect(metadata.sizeBytes).toBe(Buffer.byteLength(original));
      accepted = await (await context.request.get('/api/notes/' + id + '/outline')).json();
      expect(accepted.kind).toBe('accepted');
      expect(['queued', 'running']).toContain(accepted.operation.status);
      operationId = accepted.operation.operationId;
      await route.fulfill({ response, json: { ...metadata, readState: 'preparing' } });
    } else await route.fulfill({ response });
  });
  await page.route('**/api/notes/' + id + '/outline', async (route) => {
    // Deliver the actual earlier accepted reply even if the worker has since
    // finished; subsequent operation reads remain real backend responses.
    pending = true;
    await completion.pending;
    await route.fulfill({ json: accepted }).catch(() => {});
  });
  return { release: completion.release, pending: () => pending, operationId: () => operationId };
}

for (const source of [false, true]) test.describe(source ? '准备中的 Markdown' : '准备中的文档', () => {
  test.use({ sourceEditorPreference: source });
  test('小笔记已有准备任务时等待完整正文，保持所选编辑器与原文字节', async ({ page, context }) => {
    const id = await unpreparedNote(context), preparation = await holdSmallPreparation(page, context, id);
    let writes = 0;
    page.on('request', (request) => { if (['PUT', 'PATCH', 'DELETE'].includes(request.method()) || request.url().endsWith('/patch')) writes++; });
    const editor = source ? page.locator('.cm-content') : page.getByRole('textbox', { name: '文档正文', exact: true });
    try {
      await page.goto('/?note=' + id);
      await expect.poll(preparation.pending).toBe(true);
      await expect(page.locator('.large-workspace')).toHaveCount(0);
      await expect(editor).toHaveCount(0);
    } finally { preparation.release(); }
    await expect(editor).toBeEditable();
    await expect(editor).toContainText('原文与草稿归属必须保留');
    await expect(page.locator('.large-workspace')).toHaveCount(0);
    expect((await (await context.request.get('/api/notes/' + id + '/meta')).json()).editorMode).toBe('full');
    expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
    const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    const note = await (await context.request.get('/api/notes/' + id)).json();
    expect(await readFile(join(config.knowledgeRoot, note.relativePath), 'utf8')).toBe(original);
    expect(writes).toBe(0);
  });
});

test('等待小笔记准备期间进入设置，迟到的任务完成不会重新打开笔记', async ({ page, context }) => {
  const id = await unpreparedNote(context), preparation = await holdSmallPreparation(page, context, id);
  await page.clock.install();
  const outline = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/notes/' + id + '/outline');
  let fullReads = 0, writes = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/notes/' + id && request.method() === 'GET') fullReads++;
    if (request.method() === 'PUT' || request.url().endsWith('/patch')) writes++;
  });
  try {
    await page.goto('/?note=' + id);
    await expect.poll(preparation.pending).toBe(true);
    await showMainMenu(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '编辑器与外观', exact: true })).toBeVisible();
  } finally { preparation.release(); }
  await (await outline).finished();
  // Cross the existing operation-poll timer after delivering its accepted reply,
  // so absence of a stale open is checked after the suspended continuation runs.
  await page.clock.runFor(1000);
  await expect.poll(async () => (await (await context.request.get('/api/operations/' + preparation.operationId())).json()).status).toBe('succeeded');
  await expect(page).toHaveURL(/view=settings/);
  await expect(page.getByRole('heading', { name: '编辑器与外观', exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toHaveCount(0);
  expect(fullReads).toBe(0);
  expect(writes).toBe(0);
});

for (const [label, content] of [
  ['长行', '# Long line\n' + 'x'.repeat(32769) + '\n'],
  ['大文件', '# Large\n' + 'unchanged line\n'.repeat(80000) + 'UNLOADED_SENTINEL'],
]) test(`${label}准备后仍使用受限片段，不请求完整正文或隐式保存`, async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `bounded-${crypto.randomUUID()}.md`, path = join(config.knowledgeRoot, '00-Inbox', fileName);
  await writeFile(path, content);
  const entries = await (await context.request.get('/api/tree')).json();
  const find = (items: any[]): any => items.map((item) => item.name === fileName ? item : find(item.children || [])).find(Boolean);
  const id = find(entries).id;
  let fullReads = 0, writes = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/notes/' + id && request.method() === 'GET') fullReads++;
    if (request.method() === 'PUT' || request.url().endsWith('/patch')) writes++;
  });
  await page.goto('/?note=' + id);
  await expect(page.locator('.large-workspace')).toBeVisible();
  await expect(page.locator('.large-workspace .cm-content')).toBeEditable();
  expect(fullReads).toBe(0);
  expect(writes).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(content);
});

for (const last of ['安全令牌', '服务状态']) test(`登录确认后并行核对安全与服务，${last}最后完成前不开启工作区`, async ({ page, context }) => {
  const id = await seed(context), security = gate(), service = gate();
  let securityPending = false, servicePending = false, statusReads = 0, workspaceReads = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/tree' || path.startsWith('/api/notes/')) workspaceReads++;
  });
  await page.route('**/api/security/csrf', async (route) => {
    securityPending = true;
    await security.pending;
    await route.continue().catch(() => {});
  });
  await page.route('**/api/platform/status', async (route) => {
    if (++statusReads === 1) { servicePending = true; await service.pending; }
    await route.continue().catch(() => {});
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => securityPending).toBe(true);
    await expect.poll(() => servicePending).toBe(true);
    expect(workspaceReads).toBe(0);
    await expect(page.locator('.sidebar .brand')).toHaveCount(0);
    const completed = page.waitForResponse((response) => new URL(response.url()).pathname ===
      (last === '安全令牌' ? '/api/platform/status' : '/api/security/csrf'));
    if (last === '安全令牌') service.release(); else security.release();
    expect((await completed).status()).toBe(200);
    await expect(page.locator('.sidebar .brand')).toHaveCount(0);
    expect(workspaceReads).toBe(0);
  } finally { security.release(); service.release(); }
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeEditable();
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

test('并行服务核对提前发现会话失效，安全核对完成后仍显示重新登录', async ({ page, context }) => {
  const id = await seed(context), security = gate();
  let statusReads = 0, rejected = false, workspaceReads = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/tree' || path.startsWith('/api/notes/')) workspaceReads++;
  });
  await page.route('**/api/security/csrf', async (route) => {
    await security.pending;
    await route.continue().catch(() => {});
  });
  await page.route('**/api/platform/status', async (route) => {
    if (++statusReads === 1) {
      await route.fulfill({ status: 401, json: { error: 'Session expired' } });
      rejected = true;
    } else await route.continue();
  });
  try {
    await page.goto('/?note=' + id, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => rejected).toBe(true);
    await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
    expect(workspaceReads).toBe(0);
  } finally { security.release(); }
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  await expect(page.locator('.sidebar .brand')).toHaveCount(0);
  expect(workspaceReads).toBe(0);
  expect((await (await context.request.get('/api/notes/' + id)).json()).content).toBe(original);
});

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
