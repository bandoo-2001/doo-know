import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { selectHistoryVersion } from '../support/note-actions';
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建流程图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建流程图', exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill('decision-flow-' + crypto.randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const id = new URL(page.url()).searchParams.get('note')!;
  const initial = await (await page.request.get('/api/notes/' + id)).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const later = await page.request.put('/api/notes/' + id, {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      content: initial.content + '\nLater history prose\n',
      expectedModifiedAt: initial.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(later.status()).toBe(200);
  await page.reload();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  return { id, workspace, editor: workspace.locator('.cm-content') };
}
async function edit(page: Page, editor: ReturnType<Page['locator']>) {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nLocal[必须保留]-->B\n');
}
async function draft(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('dooknow-local-drafts', 2);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise<any>((resolve, reject) => {
      const r = db.transaction('drafts').objectStore('drafts').getAll();
      r.onsuccess = () => {
        resolve(r.result.find((v) => v.noteId === id));
        db.close();
      };
      r.onerror = () => reject(r.error);
    });
  }, id);
}
async function restoreChoice(page: Page) {
  const dialog = page.locator('.note-history-dialog');
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  const leave = page.locator('.n-modal').filter({ hasText: '离开前，请选择如何处理当前编辑内容' });
  await expect(leave).toBeVisible();
  return { dialog, leave };
}

test('history and dirty decision pause server autosave beyond debounce while native draft remains durable; closing resumes', async ({
  page,
}) => {
  const { id, workspace, editor } = await setup(page);
  const writes: string[] = [];
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      /\/diagram-documents\/(prepare|commit)$/.test(new URL(r.url()).pathname)
    )
      writes.push(r.url());
  });
  await edit(page, editor);
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  await selectHistoryVersion(page, 0);
  await expect.poll(async () => (await draft(page, id))?.content).toContain('必须保留');
  const held = await draft(page, id);
  // Elapsed time is the contract under test: keep the decision open past the real 1200 ms debounce.
  await page.waitForTimeout(1800);
  expect(writes).toEqual([]);
  expect((await draft(page, id)).content).toBe(held.content);
  const { dialog, leave } = await restoreChoice(page);
  await page.waitForTimeout(1500);
  expect(writes).toEqual([]);
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toContainText('必须保留');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/notes/' + id)).json()).content)
    .toContain('必须保留');
  await expect(workspace.getByRole('status')).toContainText('已保存');
});

test('discard decision waits for a manually started complete save before restoring and retaining an unknown restore receipt', async ({
  page,
}) => {
  const { id, workspace, editor } = await setup(page);
  await edit(page, editor);
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  await selectHistoryVersion(page, 0);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  await page.route('**/api/diagram-documents/commit', async (route) => {
    entered();
    await gate;
    await route.continue();
  });
  await page.route('**/api/diagram-history-restores/*/prepare', (route) => route.abort('failed'));
  const { dialog, leave } = await restoreChoice(page);
  await page.keyboard.press('ControlOrMeta+s');
  await seen;
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  try {
    await page.waitForTimeout(300);
    await expect(
      dialog.getByRole('alert').filter({ hasText: '正在保存，请完成后再放弃修改' }),
    ).toHaveCount(0);
    await expect(leave).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByRole('button', { name: '核对恢复结果', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toContain('必须保留');
});

test('failed native commit stays exactly pending when a history discard decision cannot prove its outcome', async ({
  page,
}) => {
  const { id, workspace, editor } = await setup(page);
  await edit(page, editor);
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  await selectHistoryVersion(page, 0);
  const requests: any[] = [];
  await page.route('**/api/diagram-documents/commit', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.abort('failed');
  });
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => requests.length).toBe(1);
  await expect(workspace.getByRole('status')).toContainText('保存未完成');
  const held = await draft(page, id);
  expect(held.diagram.pending).toBeTruthy();
  const { dialog, leave } = await restoreChoice(page);
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未核对');
  await expect(leave).toBeVisible();
  expect((await draft(page, id)).diagram.pending).toEqual(held.diagram.pending);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests[1]).toEqual(requests[0]);
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).not.toContain(
    '必须保留',
  );
});

test('history restore waits for the complete in-flight resource refresh before using the saved baseline', async ({
  page,
}) => {
  const { id, workspace, editor } = await setup(page);
  await edit(page, editor);
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  await selectHistoryVersion(page, 0);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  await page.route('**/api/notes/' + id + '/assets', async (route) => {
    entered();
    await gate;
    await route.continue();
  });
  let restores = 0;
  await page.route('**/api/diagram-history-restores/*/prepare', async (route) => {
    restores++;
    await route.abort('failed');
  });
  await page.keyboard.press('ControlOrMeta+s');
  await seen;
  const dialog = page.locator('.note-history-dialog');
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  try {
    await page.waitForTimeout(400);
    expect(restores).toBe(0);
    await expect(workspace.getByRole('status')).toContainText('正在保存');
  } finally {
    release();
  }
  await expect(dialog.getByRole('button', { name: '核对恢复结果', exact: true })).toBeVisible();
  expect(restores).toBe(1);
});

test('switching a clean diagram view during saved-document refresh keeps the parent baseline fresh for history restore', async ({
  page,
}) => {
  const { id, workspace, editor } = await setup(page);
  let release!: () => void,
    entered!: () => void,
    held = false;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  await page.route('**/api/notes/' + id, async (route) => {
    if (route.request().method() === 'GET' && !held) {
      held = true;
      entered();
      await gate;
    }
    await route.continue();
  });
  await edit(page, editor);
  await page.keyboard.press('ControlOrMeta+s');
  await seen;
  try {
    await workspace.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(workspace.locator('.diagram-reading')).toBeVisible();
  } finally {
    release();
  }
  await expect(workspace.getByRole('status')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toContain('必须保留');
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  await selectHistoryVersion(page, 0);
  const dialog = page.locator('.note-history-dialog');
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/notes/' + id)).json()).content)
    .not.toContain('必须保留');
  await expect(dialog).toBeHidden();
  expect(
    (await (await page.request.get('/api/notes/' + id + '/diagram')).json()).preview.state,
  ).toBe('ready');
});
