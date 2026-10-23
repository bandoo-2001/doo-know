import { test, expect } from '../support/browser-test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expandFolderPath } from '../support/notebook-tree';

test.use({ sourceEditorPreference: true });

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
  await page.getByRole('button', { name: '完成', exact: true }).click();
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
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
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
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
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
        headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
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
      expect((await deleted).url()).toBe(`http://127.0.0.1:4179/api/notes/${notes[0].id}`);
    } else if (action === 'move') {
      await page.getByRole('textbox', { name: '文件名', exact: true }).fill('race-move-renamed.md');
      const moved = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url().endsWith('/move'),
      );
      await page.getByRole('button', { name: '确认移动', exact: true }).click();
      expect((await moved).url()).toBe(`http://127.0.0.1:4179/api/notes/${notes[0].id}/move`);
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
  const sidebar = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.locator('.footer-tools').getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.locator('.trash-workspace')).toBeVisible();
  if (await sidebar.isVisible()) await sidebar.click();
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
