import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
async function createFlow(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建流程图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建流程图', exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill('review-flow-' + crypto.randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  return await (
    await page.request.get('/api/notes/' + new URL(page.url()).searchParams.get('note'))
  ).json();
}
async function draftRecord(page: Page, noteId: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dooknow-local-drafts', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<any>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () => {
        resolve(request.result.find((r) => r.noteId === id));
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
  }, noteId);
}

test('未回答的恢复草稿在SPA离开并重新打开后保留相同版本和pending证据', async ({ page }, info) => {
  const note = await createFlow(page);
  await page.route('**/api/diagram-documents/commit', (route) => route.abort('failed'));
  const workspace = page.getByTestId('diagram-document-workspace'),
    cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nA[必须恢复] --> B\n');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('alert')).toBeVisible();
  const original = await draftRecord(page, note.id);
  expect(original.diagram.pending.markdown).toContain('必须恢复');
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  const held = await draftRecord(page, note.id);
  expect(held.content).toBe(original.content);
  expect(held.diagram.pending).toEqual(original.diagram.pending);
  const sidebar = page.locator('.sidebar');
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await sidebar.getByRole('button', { name: '00-Inbox', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await page
    .locator('.folder-entry-open')
    .filter({ hasText: note.relativePath.split('/').at(-1) })
    .click();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  expect(await draftRecord(page, note.id)).toEqual(held);
});

test('初始双读取交错外部保存时重新取得一致基线并保留外部说明', async ({ page }) => {
  const note = await createFlow(page);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  let reads = 0,
    release!: () => void;
  const externalDone = new Promise<void>((resolve) => (release = resolve));
  let changed = false;
  await page.route('**/api/notes/' + note.id, async (route) => {
    if (route.request().method() !== 'GET' || ++reads !== 2) {
      await route.continue();
      return;
    }
    const old = await route.fetch(),
      snapshot = await old.json();
    const update = await page.request.put('/api/notes/' + note.id, {
      headers: { origin: 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179), 'x-csrf-token': csrf.token },
      data: {
        content: snapshot.content + '\n外部已保存说明必须保留。\n',
        expectedModifiedAt: snapshot.modifiedAt,
        requestId: crypto.randomUUID(),
      },
    });
    expect(update.status(), await update.text()).toBe(200);
    changed = true;
    release();
    await route.fulfill({ response: old });
  });
  await page.route('**/api/notes/' + note.id + '/diagram', async (route) => {
    await externalDone;
    await route.continue();
  });
  await page.reload();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  expect(changed).toBe(true);
  const cm = workspace.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nA[交错后原生编辑] --> B\n');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const saved = await (await page.request.get('/api/notes/' + note.id)).json();
  expect(saved.content).toContain('交错后原生编辑');
  expect(saved.content).toContain('外部已保存说明必须保留。');
});
