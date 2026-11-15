import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showMainMenu, closeSidebar } from '../support/settings-navigation';
import { openDocumentNote } from '../support/document-editor';
import { showSource } from '../support/editor-navigation';
import { expandToDooGroup } from '../support/to-doo-ant-controls';
import {
  goToToDooSection,
  openToDooDirectory,
  closeToDooDirectory,
  selectToDooQuickView,
  returnFromToDoo,
} from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('To Doo owns one navigation while returning restores the DooKnow menu', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(page.locator('.workspace-footer')).toHaveCount(0);
  const menu = await openToDooDirectory(page);
  await expect(menu.getByRole('button', { name: '今天', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '日历', exact: true })).toBeVisible();
  await closeToDooDirectory(page);
  await goToToDooSection(page, 'matrix');
  await expect(page).toHaveURL(/appSection=matrix/);
  await expect(page.locator('aside.todo-sidebar:not(.todo-drawer-sidebar)')).toHaveCount(1);
  await goToToDooSection(page, 'focus');
  await expect(page).toHaveURL(/appSection=focus/);
  await goToToDooSection(page, 'settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expandToDooGroup(app, '日期与提醒');
  await expect(app.getByLabel('显示时区', { exact: true })).toBeVisible();
  await returnFromToDoo(page);
  await showMainMenu(page);
  await expect(page.getByRole('button', { name: '个人账户', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '常用工具', exact: true })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await closeSidebar(page);
  await expect(page).toHaveURL(/view=settings/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('returning to DooKnow preserves the mounted note draft and reentering an app restores its location', async ({
  page,
  context,
}) => {
  await page.goto('/?view=apps');
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
  const pin = page.getByRole('button', { name: '将To Doo加入左侧菜单', exact: true });
  if (await pin.isVisible()) await pin.click();
  const original = '# 应用导航\n\n原文保持不变。\n';
  const note = await openDocumentNote(page, context, original);
  await showSource(page);
  const editor = page.locator('.cm-content');
  await editor.fill('# 应用导航\n\n保留未保存的知识库内容。\n');
  const handle = await editor.elementHandle();
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: 'To Doo', exact: true })
    .click();
  await closeSidebar(page);
  await goToToDooSection(page, 'calendar');
  await expect(page).toHaveURL(/appSection=calendar/);
  await returnFromToDoo(page);
  await expect(editor).toContainText('保留未保存的知识库内容');
  expect(await handle!.evaluate((node) => node.isConnected)).toBe(true);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: 'To Doo', exact: true })
    .click();
  await closeSidebar(page);
  await expect(page).toHaveURL(/appSection=calendar/);
  await handle?.dispose();
});

test('cancelled app settings navigation and return retain both the route and the unsaved form', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expandToDooGroup(app, '日期与提醒');
  const zone = app.getByLabel('显示时区', { exact: true });
  await zone.fill('Etc/GMT+5');
  const original = page.url();
  for (const target of ['今天', '返回 DooKnow']) {
    if (target === '今天') await selectToDooQuickView(page, '今天');
    else await returnFromToDoo(page);
    const confirmation = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(page).toHaveURL(original);
    await expect(zone).toHaveValue('Etc/GMT+5');
  }
});

test('cancelling browser back from unsaved app settings restores its URL and permits a later confirmed back', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await goToToDooSection(page, 'settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expandToDooGroup(app, '日期与提醒');
  const zone = app.getByLabel('显示时区', { exact: true });
  await zone.fill('Etc/GMT+6');
  const original = page.url();
  await page.goBack();
  const confirmation = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(original);
  await expect(zone).toHaveValue('Etc/GMT+6');
  await page.goBack();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '放弃更改并离开', exact: true }).click();
  await expect(page).toHaveURL(/appSection=tasks/);
  await expect(page.getByRole('heading', { name: '所有任务', exact: true })).toBeVisible();
});

test('the default app hub remains reachable and unpinned app cards restore the last app page', async ({
  page,
}) => {
  await page.goto('/?view=apps');
  await page
    .locator('.app-card')
    .filter({ has: page.getByRole('heading', { name: '博客', exact: true }) })
    .click();
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '博客 主菜单', exact: true })
    .getByRole('button', { name: '文章', exact: true })
    .click();
  await closeSidebar(page);
  await expect(page).toHaveURL(/appSection=articles/);
  await showMainMenu(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '返回 DooKnow', exact: true })
    .click();
  await closeSidebar(page);
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await closeSidebar(page);
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
  await page
    .locator('.app-card')
    .filter({ has: page.getByRole('heading', { name: '博客', exact: true }) })
    .click();
  await expect(page).toHaveURL(/appSection=articles/);
});

test('app return restores a DooKnow collection instead of losing its last location', async ({
  page,
}) => {
  await page.goto('/?view=favorites');
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await closeSidebar(page);
  await page
    .locator('.app-card')
    .filter({ has: page.getByRole('heading', { name: 'To Doo', exact: true }) })
    .click();
  await returnFromToDoo(page);
  await expect(page).toHaveURL(/view=favorites/);
});

test('an initial To Doo load failure still returns to the original note and preserves its draft', async ({
  page,
  context,
}) => {
  await page.goto('/?view=apps');
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
  const pin = page.getByRole('button', { name: '将To Doo加入左侧菜单', exact: true });
  if (await pin.isVisible()) await pin.click();
  const original = '# 应用加载恢复\n\n原文保持不变。\n';
  const note = await openDocumentNote(page, context, original);
  await showSource(page);
  const editor = page.locator('.cm-content');
  await editor.fill('# 应用加载恢复\n\n保留未保存的笔记内容。\n');
  const handle = await editor.elementHandle();
  await page.route('**/components/ToDooWorkspace.vue*', (route) => route.abort('failed'));
  await showMainMenu(page);
  await page
    .getByRole('navigation', { name: '工作区', exact: true })
    .getByRole('button', { name: 'To Doo', exact: true })
    .click();
  const fallback = page.getByRole('alert', { name: 'To Doo 加载失败', exact: true });
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole('button', { name: '重新加载页面', exact: true })).toBeVisible();
  await fallback.getByRole('button', { name: '返回 DooKnow', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  await expect(editor).toContainText('保留未保存的笔记内容');
  expect(await handle!.evaluate((node) => node.isConnected)).toBe(true);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await handle?.dispose();
});
