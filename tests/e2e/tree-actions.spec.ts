import { test, expect } from '../support/browser-test';
import type { Response } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expandFolderPath } from '../support/notebook-tree';
import { showMainMenu, showSidebar } from '../support/settings-navigation';

test.use({ sourceEditorPreference: true });

async function isFinalMove(response: Response, path?: string) {
  const pathname = new URL(response.url()).pathname;
  if (response.request().method() !== 'POST' || !/^\/api\/notes\/[^/]+\/move$/.test(pathname)) return false;
  if (path && pathname !== path) return false;
  // The UI prepares required native previews and retries this same operation.
  if (response.status() === 409 && (await response.json()).code === 'DIAGRAM_PREVIEW_REQUIRED') return false;
  return true; // Unexpected failures remain terminal and fail the success assertion.
}

// Catch wrong-target operations, lost drafts, and menus unreachable on touch/keyboard.
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
});

test('folder menus create in the clicked folder without changing the open note', async ({
  page,
  context,
}) => {
  await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
  await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  const url = page.url();
  const sidebar = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (
    (await sidebar.isVisible()) &&
    !(await page.locator('#notebook-navigation').getAttribute('class'))?.includes('open')
  )
    await sidebar.click();
  const row = page
    .locator('.tree-row')
    .filter({ has: page.getByTitle('00-Inbox', { exact: true }) });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '00-Inbox 的操作' });
  await expect(menu).toBeVisible();
  expect(page.url()).toBe(url);
  await menu.getByRole('menuitem', { name: '新建笔记', exact: true }).click();
  const name = `menu-created-${crypto.randomUUID()}`;
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(name);
  const tree = await (await page.request.get('/api/tree')).json();
  expect(
    tree
      .find((entry: any) => entry.path === '00-Inbox')
      .children.some((entry: any) => entry.path === `00-Inbox/${name}.md`),
  ).toBe(true);

  if (
    (await sidebar.isVisible()) &&
    !(await page.locator('#notebook-navigation').getAttribute('class'))?.includes('open')
  )
    await sidebar.click();
  await row.getByRole('button', { name: '00-Inbox 的更多操作', exact: true }).click();
  await menu.getByRole('menuitem', { name: '新建子文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '文件夹名', exact: true }).fill('menu-child');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('文件夹已创建', { exact: true })).toBeVisible();
  const updated = await (await page.request.get('/api/tree')).json();
  expect(
    updated
      .find((entry: any) => entry.path === '00-Inbox')
      .children.some((entry: any) => entry.path === '00-Inbox/menu-child'),
  ).toBe(true);
  await expandFolderPath(page, '00-Inbox');
  const childMore = page.getByRole('button', { name: 'menu-child 的更多操作', exact: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await childMore.click();
  await page.getByRole('menuitem', { name: '复制路径', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('00-Inbox/menu-child');
  await childMore.click();
  await page.getByRole('menuitem', { name: '导入 Markdown', exact: true }).click();
  await page.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({
    name: 'menu-import.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Imported from menu'),
  });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(
    page.getByText('menu-import.md 已导入，进入工作区后可以查看。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').filter({ hasText: '导入 Markdown' }).getByRole('button', { name: '完成', exact: true }).click();
  const imported = await (await page.request.get('/api/tree')).json();
  expect(
    imported
      .find((entry: any) => entry.path === '00-Inbox')
      .children.find((entry: any) => entry.path === '00-Inbox/menu-child')
      .children.some((entry: any) => entry.path === '00-Inbox/menu-child/menu-import.md'),
  ).toBe(true);
});

test('note menus preserve drafts and rename or delete the target only after confirmation', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: JSON.parse(await readFile('.local/e2e-config.json', 'utf8')).origin, 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: 'menu-target.md',
      content: '# Target',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const target = await response.json();
  await page.reload();
  await expandFolderPath(page, '00-Inbox');
  await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
  await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page).toHaveURL(/note=/);
  const originalUrl = page.url();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('保留这段草稿');
  const sidebar = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (
    (await sidebar.isVisible()) &&
    !(await page.locator('#notebook-navigation').getAttribute('class'))?.includes('open')
  )
    await sidebar.click();
  const more = page.getByRole('button', { name: 'menu-target.md 的更多操作', exact: true });
  await more.click();
  const downloadOther = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载 Markdown', exact: true }).click();
  expect((await downloadOther).suggestedFilename()).toBe('menu-target.md');
  expect(page.url()).toBe(originalUrl);
  await expect(page.locator('.cm-content')).toContainText('保留这段草稿');
  await more.click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await expect(
    page.getByText('离开前，请选择如何处理当前编辑内容。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('保留这段草稿');
  expect(page.url()).toBe(originalUrl);
  expect((await page.request.get('/api/notes/' + target.id)).status()).toBe(200);

  await more.click();
  await page.getByRole('menuitem', { name: '重命名或移动', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByText('移动或重命名笔记', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('menu-renamed.md');
  const moveResponse = page.waitForResponse((response) =>
    isFinalMove(response, `/api/notes/${target.id}/move`),
  );
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  expect((await moveResponse).ok()).toBe(true);
  await expect(page.getByText('笔记已整理，历史和分享链接保持关联', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp('note=' + target.id));
  if (
    (await sidebar.isVisible()) &&
    !(await page.locator('#notebook-navigation').getAttribute('class'))?.includes('open')
  )
    await sidebar.click();
  await expect(page.getByRole('button', { name: 'menu-renamed.md', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + target.id)).json()).relativePath).toBe(
    '00-Inbox/menu-renamed.md',
  );

  await page.getByRole('button', { name: 'menu-renamed.md 的更多操作', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载 Markdown', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('menu-renamed.md');
  await page.getByRole('button', { name: 'menu-renamed.md 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await expect(page.getByText('移入回收站？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await page.request.get('/api/notes/' + target.id)).status()).toBe(200);
  await page.getByRole('button', { name: 'menu-renamed.md 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(
    page.locator('.tree-scroll').getByRole('button', { name: 'menu-renamed.md', exact: true }),
  ).toBeHidden();
  expect((await page.request.get('/api/notes/' + target.id)).status()).toBe(404);
});

test('menu works with keyboard and fits a small touch viewport', async ({ page }, info) => {
  const more = page.getByRole('button', { name: '00-Inbox 的更多操作', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '00-Inbox 的操作' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await page.setViewportSize({ width: 390, height: 480 });
  await more.click();
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(480);
  await page.screenshot({ path: info.outputPath('tree-menu.png'), animations: 'disabled' });
  await page.locator('.brand strong').click();
  await expect(menu).toBeHidden();
});

for (const action of ['delete', 'move', 'open'] as const) {
  test(`a delayed navigation cannot retarget tree action ${action}`, async ({ page }) => {
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const notes: { id: string }[] = [];
    for (const name of [`race-${action}-a.md`, `race-${action}-b.md`]) {
      const response = await page.request.post('/api/notes', {
        headers: { origin: JSON.parse(await readFile('.local/e2e-config.json', 'utf8')).origin, 'x-csrf-token': csrf.token },
        data: {
          folderPath: '00-Inbox',
          fileName: name,
          content: '# ' + name,
          requestId: crypto.randomUUID(),
        },
      });
      expect(response.status()).toBe(201);
      notes.push(await response.json());
    }
    await page.goto('/?note=' + notes[0].id);
    await expect(page.locator('.cm-content')).toBeVisible();
    const sidebar = page.getByRole('button', { name: '打开侧栏', exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await expandFolderPath(page, '00-Inbox');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(`**/api/notes/${notes[1].id}/meta`, async (route) => {
      requested();
      await gate;
      await route.continue();
    });
    await page.getByRole('button', { name: `race-${action}-b.md`, exact: true }).click();
    await started;
    await page.getByRole('button', { name: `race-${action}-a.md 的更多操作`, exact: true }).click();
    const label = action === 'delete' ? '移入回收站' : action === 'move' ? '重命名或移动' : '打开';
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    if (action !== 'open')
      await expect(
        page.getByText(action === 'delete' ? '移入回收站？' : '移动或重命名笔记', { exact: true }),
      ).toBeVisible();
    const loaded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/notes/${notes[1].id}/assets`),
    );
    release();
    await loaded;
    // Let the complete note load settle, not just the metadata request.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    if (action === 'delete') {
      const deleted = page.waitForRequest(
        (request) => request.method() === 'DELETE' && request.url().includes('/api/notes/'),
      );
      await page.getByRole('button', { name: '移入回收站', exact: true }).click();
      expect((await deleted).url()).toBe(new URL(`/api/notes/${notes[0].id}`, page.url()).href);
    } else if (action === 'move') {
      await page.getByRole('textbox', { name: '文件名', exact: true }).fill('race-move-renamed.md');
      const moved = page.waitForResponse(
        (response) => isFinalMove(response),
      );
      await page.getByRole('button', { name: '确认移动', exact: true }).click();
      const response = await moved;
      expect(response.url()).toBe(new URL(`/api/notes/${notes[0].id}/move`, page.url()).href);
      expect(response.ok()).toBe(true);
      await expect(page.getByText('移动或重命名笔记', { exact: true })).toBeHidden();
    } else {
      await expect(page).toHaveURL(new RegExp('note=' + notes[0].id));
      await expect(page.locator('.cm-content')).toContainText('race-open-a.md');
    }
    expect((await page.request.get('/api/notes/' + notes[1].id)).status()).toBe(200);
  });
}

test('Open from a retained note menu returns from trash without losing its draft', async ({
  page,
}) => {
  await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
  await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page).toHaveURL(/note=/);
  const originalUrl = page.url();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('返回时保留草稿');
  await showMainMenu(page);
  await page.locator('.footer-tools').getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.locator('.trash-workspace')).toBeVisible();
  await showSidebar(page);
  await page.getByRole('button', { name: '入门指南.md 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '打开', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('返回时保留草稿');
  expect(page.url()).toBe(originalUrl);
});

test('a queued directory scroll does not dismiss a newly opened menu, but subsequent scrolling does', async ({
  page,
}, info) => {
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const names = Array.from(
    { length: 40 },
    (_, index) => `queued-scroll-${info.project.name}-${String(index).padStart(2, '0')}.md`,
  );
  try {
    await Promise.all(
      names.map((name) => writeFile(join(knowledgeRoot, '00-Inbox', name), '# Scroll fixture')),
    );
    await page.reload();
    await expandFolderPath(page, '00-Inbox');
    await page.evaluate(
      (label) => {
        const scroller = document.querySelector<HTMLElement>('.tree-scroll')!;
        const button = [...document.querySelectorAll<HTMLButtonElement>('.tree-more')].find(
          (item) => item.getAttribute('aria-label') === label,
        )!;
        scroller.scrollTop = scroller.scrollHeight;
        // The scroll event is delivered after this click, while the item's geometry is unchanged.
        button.click();
      },
      `${names.at(-1)} 的更多操作`,
    );
    const menu = page.getByRole('menu', { name: `${names.at(-1)} 的操作`, exact: true });
    await expect(menu).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(menu).toBeVisible();
    await page.locator('.tree-scroll').evaluate((el) => {
      el.scrollTop -= 50;
    });
    await expect(menu).toBeHidden();
  } finally {
    await Promise.all(
      names.map((name) => rm(join(knowledgeRoot, '00-Inbox', name), { force: true })),
    );
  }
});


test('a committed move keeps waiting for its delayed receipt beyond the default request deadline', async ({
  page,
}, info) => {
  // The deliberate 17 s receipt hold is additional to setup and real server work.
  test.setTimeout(90000);
  const { origin, knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const suffix = crypto.randomUUID();
  const originalName = `delayed-receipt-${suffix}.md`;
  const movedName = `delayed-receipt-moved-${suffix}.md`;
  const referenceName = `delayed-receipt-reference-${suffix}.md`;
  const content = '# Delayed receipt target\n\nKeep this content and identity.\n';
  const create = async (fileName: string, noteContent: string) => {
    const response = await page.request.post('/api/notes', {
      headers: { origin, 'x-csrf-token': csrf.token },
      data: { folderPath: '00-Inbox', fileName, content: noteContent, requestId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const target = await create(originalName, content);
  // An incoming link makes the real move journal update more than one document.
  const reference = await create(referenceName, `# Reference\n\n[Target](${originalName})\n`);
  await page.goto('/?note=' + target.id);
  await expect(page.locator('.cm-content')).toContainText('Keep this content and identity.');
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await page.getByRole('button', { name: `${originalName} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名或移动', exact: true }).click();
  const dialog = page.locator('.dialog-card').filter({ hasText: '移动或重命名笔记' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '文件名', exact: true }).fill(movedName);
  const confirm = dialog.getByRole('button', { name: '确认移动', exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let received!: () => void;
  const receiptReady = new Promise<void>((resolve) => { received = resolve; });
  const routeErrors: unknown[] = [];
  let requests = 0, requestedAt = 0;
  let receipt: any;
  const waitUntil = async (deadline: number) => {
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(remaining)));
    }
  };
  const releaseReceipt = async () => {
    if (requestedAt) await waitUntil(requestedAt + 17000);
    release();
  };
  await page.route(`**/api/notes/${target.id}/move`, async (route) => {
    requests++;
    requestedAt = performance.now();
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      receipt = await response.json();
      received();
      await gate;
      await route.fulfill({ response });
    } catch (error) {
      routeErrors.push(error);
      received();
    }
  });
  try {
    await confirm.click();
    await receiptReady;
    expect(routeErrors).toEqual([]);
    expect(receipt).toMatchObject({ id: target.id, moved: true, relativePath: `00-Inbox/${movedName}` });
    // The actual server has committed, although its successful response is held.
    await expect(readFile(join(knowledgeRoot, '00-Inbox', originalName), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(knowledgeRoot, '00-Inbox', movedName), 'utf8')).toBe(content);
    expect(await readFile(join(knowledgeRoot, '00-Inbox', referenceName), 'utf8')).toBe(`# Reference\n\n[Target](${movedName})\n`);
    expect(await (await page.request.get('/api/notes/' + target.id)).json()).toMatchObject({ id: target.id, relativePath: `00-Inbox/${movedName}` });
    expect(await (await page.request.get('/api/notes/' + reference.id)).json()).toMatchObject({ id: reference.id, relativePath: `00-Inbox/${referenceName}` });
    // Use native elapsed time: replacing JS timers does not advance AbortSignal.timeout.
    await waitUntil(requestedAt + 16500);
    const pending = {
      elapsedMs: performance.now() - requestedAt,
      confirmDisabled: await confirm.isDisabled(),
      dialogVisible: await dialog.isVisible(),
      alerts: await dialog.getByRole('alert').allTextContents(),
      requests,
      receipt,
    };
    await info.attach('held-move-receipt', { body: JSON.stringify(pending, null, 2), contentType: 'application/json' });
    expect(pending.elapsedMs).toBeGreaterThanOrEqual(16500);
    expect(pending.confirmDisabled).toBe(true);
    expect(pending.dialogVisible).toBe(true);
    expect(pending.alerts).toEqual([]);
    expect(requests).toBe(1);
    await releaseReceipt();
    await expect(page.getByText('笔记已整理，历史和分享链接保持关联', { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp('note=' + target.id));
    expect(await (await page.request.get('/api/notes/' + target.id)).json()).toMatchObject({ id: target.id, relativePath: `00-Inbox/${movedName}` });
    expect(await readFile(join(knowledgeRoot, '00-Inbox', movedName), 'utf8')).toBe(content);
    expect(requests).toBe(1);
  } finally {
    await releaseReceipt();
    await page.unrouteAll({ behavior: 'wait' });
    expect(routeErrors).toEqual([]);
  }
});
