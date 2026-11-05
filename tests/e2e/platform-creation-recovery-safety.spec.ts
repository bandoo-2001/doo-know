import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))));

async function creationState(page: Page, noteId: string) {
  return page.evaluate(async id => {
    const key = Object.keys(localStorage).find(key => key.startsWith('dooknow.diagram-creation.v1:'));
    const pending = key ? localStorage.getItem(key) : null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dooknow-local-drafts', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const record = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () => resolve(request.result.find(item => item.noteId === id)); request.onerror = () => reject(request.error);
    });
    db.close(); return { pending, record };
  }, noteId);
}
async function pendingOrdinaryForm(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click(); await page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: '新建白板', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建白板', exact: true });
  await form.getByLabel('文件名', { exact: true }).fill('frozen-intent-' + crypto.randomUUID());
  // Real intent and durable draft are created before a single prepare transport
  // failure. No response/state/DOM object is fabricated.
  await page.route('**/api/diagram-documents/prepare', route => route.abort('failed'), { times: 1 });
  const reserved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/diagram-documents/intents');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  const response = await reserved; expect(response.status()).toBe(201); const intent = await response.json();
  await expect(form.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  const held = await creationState(page, intent.noteId); expect(held.pending).toBeTruthy(); expect(held.record.diagram.intentId).toBe(intent.id);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await showSidebar(page); await page.getByRole('button', { name: '创建与导入', exact: true }).click(); await page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: '新建笔记', exact: true }).click();
  const ordinary = page.getByRole('dialog', { name: '新建笔记', exact: true });
  const name = 'ordinary-form-must-not-submit-' + crypto.randomUUID(); await ordinary.getByLabel('文件名', { exact: true }).fill(name);
  await expect(ordinary.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  return { intent, held, ordinary, name };
}

test('canceling an unfinished diagram locks recovery and never submits the ordinary create form', async ({ page }) => {
  const { intent, ordinary, name } = await pendingOrdinaryForm(page);
  const notes: unknown[] = [], deletes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes') notes.push(request.postDataJSON()); });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/diagram-documents/intents/' + intent.id, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletes.push(route.request().url()); entered(); await gate; await route.continue();
  });
  await ordinary.getByRole('button', { name: '取消未完成图形', exact: true }).click(); await seen;
  try {
    // A held real cancellation exposes unintended default form submit instead
    // of allowing a fast response to close or replace the evidence first.
    await page.waitForTimeout(400);
    expect(notes).toEqual([]);
    await expect(ordinary.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeDisabled();
    await expect(ordinary.getByRole('button', { name: '取消未完成图形', exact: true })).toBeDisabled();
    await expect(ordinary.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
    expect(deletes).toHaveLength(1);
  } finally { release(); }
  await expect(ordinary.locator('.unfinished-creation')).toHaveCount(0);
  await expect(ordinary.getByLabel('文件名', { exact: true })).toHaveValue(name);
  await expect(ordinary.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  expect(notes).toEqual([]);
  expect((await (await page.request.get('/api/diagram-documents/intents/' + intent.id)).json()).status).toBe('cancelled');
  const cleared = await creationState(page, intent.noteId); expect(cleared.pending).toBeNull(); expect(cleared.record).toBeUndefined();
});

test('resuming the original intent locks cancel and manual create and publishes only once', async ({ page }) => {
  const { intent, held, ordinary } = await pendingOrdinaryForm(page);
  let reads = 0, deletes = 0; const reserves: unknown[] = [], prepares: any[] = [], commits: unknown[] = [], notes: unknown[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' && path.endsWith('/intents/' + intent.id)) deletes++;
    if (request.method() !== 'POST') return;
    if (path === '/api/diagram-documents/intents') reserves.push(request.postDataJSON());
    if (path === '/api/diagram-documents/prepare') prepares.push(request.postDataJSON());
    if (path === '/api/diagram-documents/commit') commits.push(request.postDataJSON());
    if (path === '/api/notes') notes.push(request.postDataJSON());
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/diagram-documents/intents/' + intent.id, async route => {
    if (route.request().method() !== 'GET') return route.continue(); reads++; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
  });
  await ordinary.getByRole('button', { name: '恢复未完成图形', exact: true }).click(); await seen;
  try {
    await expect(ordinary.getByRole('button', { name: '取消未完成图形', exact: true })).toBeDisabled();
    await expect(ordinary.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeDisabled();
    await expect(ordinary.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
    expect(deletes).toBe(0); expect(notes).toEqual([]);
    expect((await creationState(page, intent.noteId)).pending).toBe(held.pending);
  } finally { release(); }
  const workspace = page.getByTestId('diagram-document-workspace'); await expect(workspace).toBeVisible({ timeout: 30000 }); await expect(workspace.getByRole('status')).toContainText('已保存');
  expect(new URL(page.url()).searchParams.get('note')).toBe(intent.noteId);
  expect(reads).toBe(1); expect(deletes).toBe(0); expect(reserves).toEqual([]); expect(notes).toEqual([]); expect(prepares).toHaveLength(1); expect(commits).toHaveLength(1);
  expect(prepares[0].target).toEqual({ kind: 'creation', intentId: intent.id });
  const document = await (await page.request.get('/api/notes/' + intent.noteId)).json(); expect(document.relativePath).toBe(JSON.parse(held.pending!).path);
});

for (const lostAfterDelivery of [false, true]) {
  test(`${lostAfterDelivery ? 'lost cancellation receipt' : 'undelivered cancellation'} unlocks with the original held intent and draft preserved`, async ({ page }) => {
    const { intent, held, ordinary, name } = await pendingOrdinaryForm(page);
    let deletes = 0; const notes: unknown[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/notes') notes.push(request.postDataJSON()); });
    await page.route('**/api/diagram-documents/intents/' + intent.id, async route => {
      if (route.request().method() !== 'DELETE') return route.continue(); deletes++;
      if (lostAfterDelivery) await route.fetch(); await route.abort('failed');
    });
    await ordinary.getByRole('button', { name: '取消未完成图形', exact: true }).click();
    await expect(ordinary.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeEnabled();
    await expect(ordinary.getByRole('button', { name: '取消未完成图形', exact: true })).toBeEnabled();
    await expect(ordinary.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
    await expect(ordinary.getByLabel('文件名', { exact: true })).toHaveValue(name);
    expect(deletes).toBe(1); expect(notes).toEqual([]);
    const retained = await creationState(page, intent.noteId); expect(retained.pending).toBe(held.pending); expect(retained.record).toEqual(held.record);
    expect((await (await page.request.get('/api/diagram-documents/intents/' + intent.id)).json()).status).toBe(lostAfterDelivery ? 'cancelled' : 'reserved');
    // A lost receipt may have cancelled the server intent. Keeping local bytes
    // is not a claim that a server-cancelled intent can be republished.
  });
}

test('a published creation with a lost final note read can reconcile the same held UI intent without another commit', async ({ page }) => {
  const { intent, ordinary, held } = await pendingOrdinaryForm(page);
  let commits = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/diagram-documents/commit') commits++; });
  await page.route('**/api/notes/' + intent.noteId, route => route.request().method() === 'GET' ? route.abort('failed') : route.continue(), { times: 1 });
  await ordinary.getByRole('button', { name: '恢复未完成图形', exact: true }).click();
  await expect(ordinary.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeEnabled();
  expect((await (await page.request.get('/api/diagram-documents/intents/' + intent.id)).json()).status).toBe('published');
  expect((await creationState(page, intent.noteId)).pending).toBeNull();
  await ordinary.getByRole('button', { name: '恢复未完成图形', exact: true }).click();
  await expect(page.getByTestId('diagram-document-workspace')).toBeVisible({ timeout: 15000 });
  expect(new URL(page.url()).searchParams.get('note')).toBe(intent.noteId);
  const note = await (await page.request.get('/api/notes/' + intent.noteId)).json();
  expect(note.relativePath).toBe(JSON.parse(held.pending!).path);
  expect(commits).toBe(1);
});

async function progressFromLostReservation(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: '新建白板', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建白板', exact: true });
  const name = 'ids-complete-once-' + crypto.randomUUID(); await form.getByLabel('文件名', { exact: true }).fill(name);
  const reserves: any[] = [], prepares: any[] = [], commits: unknown[] = [], ordinaryNotes: unknown[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/diagram-documents/intents') reserves.push(request.postDataJSON());
    if (path === '/api/diagram-documents/prepare') prepares.push(request.postDataJSON());
    if (path === '/api/diagram-documents/commit') commits.push(request.postDataJSON());
    if (path === '/api/notes') ordinaryNotes.push(request.postDataJSON());
  });
  let reserved: any;
  await page.route('**/api/diagram-documents/intents', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    // The server really reserves the target; only its first response is lost.
    const response = await route.fetch(); expect(response.status()).toBe(201); reserved = await response.json(); await route.abort('failed');
  }, { times: 1 });
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(form.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeEnabled();
  const original = JSON.parse((await creationState(page, reserved.noteId)).pending!);
  expect(original.intentId).toBeUndefined(); expect(original.noteId).toBeUndefined();
  const failed = page.waitForEvent('requestfailed', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/diagram-documents/prepare');
  await page.route('**/api/diagram-documents/prepare', route => route.abort('failed'), { times: 1 });
  await form.getByRole('button', { name: '恢复未完成图形', exact: true }).click();
  await failed; await expect(form.getByRole('button', { name: '恢复未完成图形', exact: true })).toBeEnabled();
  const held = await creationState(page, reserved.noteId), enriched = JSON.parse(held.pending!);
  expect(enriched).toMatchObject({ requestId: original.requestId, path: original.path, type: original.type, title: original.title, intentId: reserved.id, noteId: reserved.noteId });
  expect(reserves).toHaveLength(2); expect(reserves[1]).toEqual(reserves[0]);
  expect(held.record.diagram.intentId).toBe(reserved.id); expect(prepares).toHaveLength(1); expect(commits).toEqual([]);
  return { form, reserved, original, held, enriched, name, reserves, prepares, commits, ordinaryNotes };
}

for (const action of ['resume', 'cancel'] as const) {
  test(`same request ID progress after a lost reserve and failed prepare allows ${action} in the unchanged open form`, async ({ page }) => {
    const state = await progressFromLostReservation(page);
    const { form, reserved } = state;
    let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/diagram-documents/intents/' + reserved.id) deletes++; });
    await form.getByRole('button', { name: action === 'resume' ? '恢复未完成图形' : '取消未完成图形', exact: true }).click();
    if (action === 'resume') {
      const workspace = page.getByTestId('diagram-document-workspace'); await expect(workspace).toBeVisible({ timeout: 15000 }); await expect(workspace.getByRole('status')).toContainText('已保存');
      expect(new URL(page.url()).searchParams.get('note')).toBe(reserved.noteId);
      const note = await (await page.request.get('/api/notes/' + reserved.noteId)).json(); expect(note.relativePath).toBe(state.original.path);
      expect(state.commits).toHaveLength(1); expect(state.prepares).toHaveLength(2); expect(deletes).toBe(0);
    } else {
      await expect(form.locator('.unfinished-creation')).toHaveCount(0);
      await expect(form.getByLabel('文件名', { exact: true })).toHaveValue(state.name);
      expect((await (await page.request.get('/api/diagram-documents/intents/' + reserved.id)).json()).status).toBe('cancelled');
      expect(state.commits).toEqual([]); expect(deletes).toBe(1);
      const cleared = await creationState(page, reserved.noteId); expect(cleared.pending).toBeNull(); expect(cleared.record).toBeUndefined();
    }
    expect(state.reserves).toHaveLength(2); expect(state.ordinaryNotes).toEqual([]);
  });
}

test('allocated IDs become stable after progress and a different real reservation cannot replace them', async ({ page }) => {
  const state = await progressFromLostReservation(page);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/diagram-documents/intents', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: { path: '00-Inbox/replacement-' + crypto.randomUUID() + '.md', type: 'whiteboard', requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201); const other = await response.json();
  // Controlled corrupt client descriptor, using real but different server IDs.
  // Keep the immutable tuple equal, so only the already-allocated IDs differ.
  await page.evaluate(ids => {
    const key = Object.keys(localStorage).find(key => key.startsWith('dooknow.diagram-creation.v1:'))!;
    const value = JSON.parse(localStorage.getItem(key)!); value.intentId = ids.intentId; value.noteId = ids.noteId; localStorage.setItem(key, JSON.stringify(value));
  }, { intentId: other.id, noteId: other.noteId });
  const calls: string[] = [];
  page.on('request', request => { if (/\/api\/diagram-documents\//.test(new URL(request.url()).pathname)) calls.push(request.method() + ' ' + new URL(request.url()).pathname); });
  for (const name of ['恢复未完成图形', '取消未完成图形']) {
    await state.form.getByRole('button', { name, exact: true }).click();
    await expect(state.form.getByRole('alert')).toContainText('未完成图形已变化');
    await expect(state.form.getByRole('button', { name, exact: true })).toBeEnabled();
  }
  expect(calls).toEqual([]);
  expect((await (await page.request.get('/api/diagram-documents/intents/' + state.reserved.id)).json()).status).toBe('reserved');
  expect((await (await page.request.get('/api/diagram-documents/intents/' + other.id)).json()).status).toBe('reserved');
  expect((await creationState(page, state.reserved.noteId)).record).toEqual(state.held.record);
});
