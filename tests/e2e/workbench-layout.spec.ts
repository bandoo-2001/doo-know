import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { showSidebar } from '../support/settings-navigation';

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
});

test('search and creation have separate rows and folder actions create in the current directory', async ({
  page,
}, info) => {
  await showSidebar(page);
  const search = (await page
    .getByRole('textbox', { name: '搜索笔记与目录', exact: true })
    .boundingBox())!;
  const create = (await page
    .locator('.sidebar-create')
    .getByRole('button', { name: '新建笔记', exact: true })
    .boundingBox())!;
  expect(create.y).toBeGreaterThanOrEqual(search.y + search.height + 6);
  expect(create.width).toBeGreaterThan(140);
  await page.locator('.tree-select').getByText('30-Knowledge', { exact: true }).click();
  const header = page.locator('.folder-header');
  const actions = header.locator('.folder-actions');
  await expect(actions.getByRole('button', { name: '新建笔记', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '新建文件夹', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '导入 Markdown', exact: true })).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThan(180);
  await page.screenshot({ path: info.outputPath('folder-workbench.png'), animations: 'disabled' });
  await actions.getByRole('button', { name: '新建笔记', exact: true }).click();
  const fileName = `workbench-${crypto.randomUUID()}.md`;
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill(fileName);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: fileName.replace(/\.md$/, ''), exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).searchParams.get('note');
  const note = await (await page.request.get('/api/notes/' + id)).json();
  expect(note.relativePath).toBe('30-Knowledge/' + fileName);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('note-workbench.png'), animations: 'disabled' });
});

test('desktop rail remains available in focus mode and returns from trash with the draft intact', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Mobile keeps the drawer navigation');
  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.locator('.workspace-footer');
  const sidebar = page.locator('#notebook-navigation');
  const railBox = (await rail.boundingBox())!;
  expect(railBox.x).toBe(0);
  expect(railBox.width).toBeLessThanOrEqual(72);
  expect((await sidebar.boundingBox())!.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  await page.getByRole('button', { name: '展开 00-Inbox', exact: true }).click();
  const firstNote = page.locator('.tree-row.is-note .tree-select').first();
  // Each run already contains the welcome fixture in the knowledge directory.
  if (!(await firstNote.count())) {
    await page.getByRole('button', { name: '展开 30-Knowledge', exact: true }).click();
    await page.getByRole('button', { name: '展开 个人知识管理', exact: true }).click();
    await page.getByRole('button', { name: '展开 方法', exact: true }).click();
  }
  await firstNote.click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page).toHaveURL(/note=/);
  const originalUrl = page.url();
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('功能栏切换后保留这段草稿');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(sidebar).toBeHidden();
  const notes = page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '笔记', exact: true });
  await expect(notes).toBeInViewport();
  await rail.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.locator('.trash-workspace')).toBeVisible();
  await notes.click();
  await expect(page.locator('.cm-content')).toContainText('功能栏切换后保留这段草稿');
  expect(page.url()).toBe(originalUrl);
  await expect(sidebar).toBeVisible();
  const outline = page.getByRole('button', { name: '章节目录', exact: true });
  await expect(outline).toBeVisible();
  await expect(page.locator('.document-outline')).toBeHidden();
  await outline.click();
  const chapters = page.getByRole('navigation', { name: '本文章节', exact: true });
  await expect(chapters).toBeVisible();
  await outline.click();
  await expect(chapters).toBeHidden();
  await page.screenshot({ path: info.outputPath('rail-and-editor.png'), animations: 'disabled' });
});

test('folder actions remain reachable beside a wide directory in a narrow desktop window', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Desktop directory resizing');
  await page.evaluate(() => localStorage.setItem('dooknow.sidebarWidth', '400'));
  await page.setViewportSize({ width: 743, height: 700 });
  await page.goto('/?folder=30-Knowledge');
  const header = page.locator('.folder-header');
  await expect(header).toBeVisible();
  const group = (await header.locator('.folder-actions').boundingBox())!;
  expect(group.x + group.width).toBeLessThanOrEqual(743);
  for (const name of ['新建笔记', '新建文件夹', '导入 Markdown']) {
    await expect(header.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
