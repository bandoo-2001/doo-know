import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar, closeSidebar } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { openDocumentNote } from '../support/document-editor';
import type { Page } from '@playwright/test';

test.use({ sourceEditorPreference: true });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function expectApplicationLayout(page: Page, mobile: boolean) {
  if (mobile) await showSidebar(page);
  await expect(page.locator('.notebook-sidebar-content')).toBeHidden();
  await expect(page.getByRole('separator', { name: '调整侧栏宽度', exact: true })).toBeHidden();
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '应用', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '笔记', exact: true }),
  ).toBeInViewport();
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }),
  ).toBeInViewport();
  if (mobile) await closeSidebar(page);
  await expect
    .poll(async () => (await page.locator('.main-content').boundingBox())!.x)
    .toBeCloseTo(mobile ? 0 : 60, 0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
}

for (const [title, route] of [
  ['应用首页', '/?view=apps'],
  ['博客概览', '/?view=apps&app=blog'],
  ['博客文章', '/?view=apps&app=blog&appSection=articles'],
] as const) {
  test(`${title} uses the application area without a notebook column, including after reload`, async ({
    page,
  }, info) => {
    if (info.project.name === 'desktop') await page.setViewportSize({ width: 1878, height: 900 });
    await page.goto(route);
    await expect(
      page.locator(title === '应用首页' ? '.apps-home' : '.blog-workspace'),
    ).toBeVisible();
    await expectApplicationLayout(page, info.project.name === 'mobile');
    await page.reload();
    await expect(
      page.locator(title === '应用首页' ? '.apps-home' : '.blog-workspace'),
    ).toBeVisible();
    await expectApplicationLayout(page, info.project.name === 'mobile');
    await page.screenshot({
      path: info.outputPath('application-layout.png'),
      animations: 'disabled',
    });
  });
}

test('application navigation retains the mounted note, expanded directories and search context', async ({
  page,
  context,
}, info) => {
  const original = '# 切换应用\n\n原文保持不变。\n';
  const note = await openDocumentNote(page, context, original);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.fill('# 切换应用\n\n未保存的编辑仍应保留。\n');
  const handle = await editor.elementHandle();
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await page.locator('.sidebar-footer').getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('.apps-home')).toBeVisible();
  await page.getByRole('button', { name: /博客.*把值得分享/ }).click();
  await expect(page.locator('.blog-workspace')).toBeVisible();
  await expectApplicationLayout(page, info.project.name === 'mobile');
  await showSidebar(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '笔记', exact: true }).click();
  await expect(editor).toContainText('未保存的编辑仍应保留');
  expect(await handle!.evaluate((node) => node.isConnected)).toBe(true);
  await showSidebar(page);
  await expect(page.getByRole('button', { name: '收起 00-Inbox', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const search = page.getByPlaceholder('搜索笔记与目录');
  await search.fill('保留搜索条件');
  await page.locator('.sidebar-footer').getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('.blog-workspace')).toBeVisible();
  await expectApplicationLayout(page, info.project.name === 'mobile');
  await showSidebar(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '笔记', exact: true }).click();
  await expect(editor).toContainText('未保存的编辑仍应保留');
  await showSidebar(page);
  await expect(search).toHaveValue('保留搜索条件');
  await closeSidebar(page);
  await editor.press('ControlOrMeta+z');
  await expect(editor).toContainText('原文保持不变');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await handle?.dispose();
});
