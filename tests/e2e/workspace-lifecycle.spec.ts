import { returnToNotes, showMainMenu } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { test, expect } from '../support/browser-test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.use({ sourceEditorPreference: true });

type FixtureNote = { id: string; relativePath: string; content: string };

async function createNote(page: Page, fileName: string, content: string): Promise<FixtureNote> {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName, content, requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function showSidebar(page: Page) {
  const open = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (
    (await open.isVisible()) &&
    !(await page.locator('.sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await open.click();
}

async function selectNote(page: Page, note: FixtureNote) {
  await showSidebar(page);
  await expandFolderPath(page, note.relativePath.split('/').slice(0, -1).join('/'));
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: note.relativePath.split('/').at(-1), exact: true })
    .click();
}

async function waitForLocalDraft(page: Page, noteId: string, content: string) {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ noteId, content }) => {
          if (!(await indexedDB.databases()).some((db) => db.name === 'dooknow-local-drafts'))
            return false;
          return new Promise<boolean>((resolve, reject) => {
            const request = indexedDB.open('dooknow-local-drafts');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const read = db.transaction('drafts').objectStore('drafts').getAll();
              read.onsuccess = () => {
                db.close();
                resolve(
                  read.result.some((draft) => draft.noteId === noteId && draft.content === content),
                );
              };
              read.onerror = () => {
                db.close();
                reject(read.error);
              };
            };
          });
        },
        { noteId, content },
      ),
    )
    .toBe(true);
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('a failed destination metadata request keeps the current note editable and its URL selected', async ({
  page,
}, info) => {
  const suffix = `${info.project.name}-${Date.now()}`;
  const a = await createNote(page, `lifecycle-navigation-a-${suffix}.md`, '# Current note A\n'),
    b = await createNote(page, `lifecycle-navigation-b-${suffix}.md`, '# Destination note B\n');
  await page.goto('/?note=' + a.id);
  await expect(page.locator('.cm-content')).toContainText('Current note A');
  await expect(page.locator('.cm-content')).toBeEditable();
  await page.route(`**/api/notes/${b.id}/meta`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: '导航目标暂时不可用', code: 'SOURCE_UNAVAILABLE' },
    }),
  );
  const refused = page.waitForResponse((response) =>
    response.url().endsWith(`/api/notes/${b.id}/meta`),
  );
  await selectNote(page, b);
  expect((await refused).status()).toBe(503);
  await expect(page.getByText('导航目标暂时不可用', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp('note=' + a.id));
  // The mobile navigation drawer must not cover the editor after a refused open.
  const closeSidebar = page.getByRole('button', { name: '关闭侧栏', exact: true });
  if (
    (await closeSidebar.isVisible()) &&
    (await page.locator('.sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await closeSidebar.click();
  await expect(page.locator('.cm-content')).toContainText('Current note A');
  await expect(page.locator('.cm-content')).toBeEditable();
  const content = '# Current note A remains editable after failed navigation\n';
  await page.locator('.cm-content').fill(content);
  await waitForLocalDraft(page, a.id, content);
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  expect(await readFile(join(config.knowledgeRoot, a.relativePath), 'utf8')).toBe(a.content);
  expect(await readFile(join(config.knowledgeRoot, b.relativePath), 'utf8')).toBe(b.content);
});

test('a refused account logout keeps the owner signed in and local drafts writable after reopening a note', async ({
  page,
}, info) => {
  const note = await createNote(
    page,
    `lifecycle-logout-${info.project.name}-${Date.now()}.md`,
    '# Source after refused logout\n',
  );
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toContainText('Source after refused logout');
  await expect(page.locator('.cm-content')).toBeEditable();
  await showMainMenu(page);
  const accountSettings = page.getByRole('button', { name: '账户设置', exact: true });
  if (!(await accountSettings.isVisible()))
    await page.getByRole('button', { name: '个人账户', exact: true }).click();
  await accountSettings.click();
  await expect(page.getByRole('heading', { name: '账户与安全', exact: true })).toBeVisible();
  await page.route('**/api/auth/sign-out', (route) =>
    route.fulfill({
      status: 503,
      json: { error: '退出服务暂时不可用' },
    }),
  );
  const refused = page.waitForResponse((response) => response.url().endsWith('/api/auth/sign-out'));
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click();
  expect((await refused).status()).toBe(503);
  await expect(page.getByRole('heading', { name: '账户与安全', exact: true })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
  expect((await (await page.request.get('/api/auth/get-session')).json()).user.id).toBeTruthy();
  // Reopen within the existing workspace: a page reload would recreate the
  // draft store and conceal a store left stopped by the failed logout.
  await returnToNotes(page);
  await selectNote(page, note);
  await expect(page.locator('.cm-content')).toContainText('Source after refused logout');
  await expect(page.locator('.cm-content')).toBeEditable();
  const content = '# Draft entered after refused logout\n';
  await page.locator('.cm-content').fill(content);
  await waitForLocalDraft(page, note.id, content);
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '复制恢复文本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '本地草稿恢复文本', exact: true })).toHaveValue(
    content,
  );
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  expect(await readFile(join(config.knowledgeRoot, note.relativePath), 'utf8')).toBe(note.content);
});

test('typing during a committed full-to-large save remains copyable after the editor mode changes', async ({
  page,
}, info) => {
  const note = await createNote(
    page,
    `lifecycle-mode-${info.project.name}-${Date.now()}.md`,
    '# Original full editor source\n',
  );
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toContainText('Original full editor source');
  await expect(page.locator('.cm-content')).toBeEditable();
  const submitted = '# Submitted long-line source\n' + 'x'.repeat(32769),
    subsequent = '# Later typing must survive the full-to-large response\n';
  await page.locator('.cm-content').fill(submitted);
  let release!: () => void, received!: () => void;
  const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
  const saveUrl = `**/api/notes/${note.id}`;
  await page.route(saveUrl, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    // Real server persistence and long-line classification produce the large
    // response. Only its delivery is delayed; no metadata result is invented.
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json()).editorMode).toBe('large');
    received();
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press('ControlOrMeta+s');
    await requestReceived;
    await expect(page.locator('.large-workspace')).toHaveCount(0);
    await page.locator('.cm-content').press('ControlOrMeta+a');
    await page.keyboard.insertText(subsequent);
    // Release immediately, before the normal debounce can persist this input.
    // The mode transition itself must flush it before disabling full drafts.
    release();
    await expect(page.locator('.large-workspace')).toBeVisible();
    await expect(page.getByText('笔记已保存', { exact: true })).toBeVisible();
    await waitForLocalDraft(page, note.id, subsequent);
    await page.reload();
    await expect(page.locator('.large-workspace .draft-recovery')).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '复制恢复文本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '本地草稿恢复文本', exact: true })).toHaveValue(
      subsequent,
    );
    const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    expect(await readFile(join(config.knowledgeRoot, note.relativePath), 'utf8')).toBe(submitted);
  } finally {
    release();
    await page.unroute(saveUrl);
  }
});
