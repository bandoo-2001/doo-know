import { readFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { goToToDooSection, openToDooDirectory } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

function tabs(page: Page, app = 'To Doo') {
  return page.getByRole('navigation', {
    name: app === 'To Doo' ? 'To Doo 快捷导航' : app + ' 标签导航',
    exact: true,
  });
}

async function expectBottomNavigation(page: Page, navigation: Locator) {
  await expect(navigation).toBeVisible();
  const bar = await navigation.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bar).not.toBeNull();
  expect(bar!.x).toBeGreaterThanOrEqual(-1);
  expect(bar!.width).toBeCloseTo(viewport.width, 0);
  expect(bar!.y + bar!.height).toBeCloseTo(viewport.height, 0);
  expect(bar!.height).toBeGreaterThanOrEqual(48);
  const content = await page.locator('.main-content').boundingBox();
  expect(content).not.toBeNull();
  expect(content!.y + content!.height).toBeLessThanOrEqual(bar!.y + 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
  ).toBeLessThanOrEqual(1);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' });
}

test('phone shortcuts reach stable destinations and the menu opens the same app navigation', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const navigation = tabs(page);
  await expectBottomNavigation(page, navigation);
  await expect(page.locator('.todo-page h1')).toHaveText('所有任务');
  await expect(page.locator('.workspace-footer')).toHaveCount(0);
  for (const label of ['今天', '收集箱', '日历'])
    await expect(navigation.getByRole('button', { name: label, exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '日历', exact: true }).click();
  await expect(page).toHaveURL(/appSection=calendar/);
  await expect(navigation.getByRole('button', { name: '日历', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectBottomNavigation(page, navigation);

  const menuButton = navigation.getByRole('button', { name: '打开导航菜单', exact: true });
  await menuButton.click();
  const fullMenu = page.getByRole('dialog', { name: '功能导航', exact: true });
  await expect(fullMenu).toBeVisible();
  await fullMenu.getByRole('button', { name: '习惯', exact: true }).click();
  await expect(page).toHaveURL(/appSection=habits/);
  await expect(fullMenu).not.toBeVisible();
  await expect(menuButton).toContainText('菜单');
  await expectBottomNavigation(page, navigation);
  await capture(page, info, 'phone-app-navigation');
  await menuButton.click();
  await expect(fullMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fullMenu).not.toBeVisible();
  await expect(menuButton).toBeFocused();
});

test('tab navigation preserves the unsaved settings leave confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const navigation = tabs(page);
  await expectBottomNavigation(page, navigation);
  await expandToDooGroup(page, '日期与提醒');
  const zone = page.getByLabel('显示时区', { exact: true });
  await zone.fill('Etc/GMT+5');
  const original = page.url();
  await navigation.getByRole('button', { name: '今天', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(original);
  await expect(zone).toHaveValue('Etc/GMT+5');
  await navigation.getByRole('button', { name: '今天', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '放弃更改并离开', exact: true }).click();
  await expect(page).toHaveURL(/appSection=tasks/);
  await expect(page.locator('.todo-page h1')).toHaveText('今天');
});

test('More and account menus keep keyboard focus inside and close one level at a time', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps');
  await expect(page.locator('.apps-home')).toBeVisible();
  const navigation = tabs(page, 'DooKnow');
  const more = navigation.getByRole('button', { name: '更多导航', exact: true });
  await more.click();
  const menu = page.getByRole('dialog', { name: '更多导航', exact: true });
  await expect(menu).toBeVisible();
  const first = menu.getByRole('button').first();
  const last = menu.getByRole('button').last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();

  const account = menu.getByRole('button', { name: '个人账户', exact: true });
  await account.click();
  const popup = page.getByRole('dialog', { name: '账户菜单', exact: true });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('button').first()).toBeFocused();
  const actionCount = await popup.getByRole('button').count();
  for (let index = 0; index < actionCount + 2; index++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => popup.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
  await capture(page, info, 'phone-account-keyboard');

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(account).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
});

test('tablet rotation keeps one navigation while changing its container', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  const navigation = tabs(page);
  await expectBottomNavigation(page, navigation);
  await openToDooDirectory(page);
  await expect(page.getByRole('dialog', { name: '功能导航', exact: true })).toBeVisible();
  await capture(page, info, 'tablet-portrait-navigation');
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(navigation).toBeHidden();
  await expect(page.getByRole('dialog', { name: '功能导航', exact: true })).not.toBeVisible();
  const sidebar = page.locator('.to-doo-workspace > .todo-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.workspace-footer')).toHaveCount(0);
  const sideBox = await sidebar.boundingBox();
  expect(sideBox!.x).toBeCloseTo(0, 0);
  expect(sideBox!.width).toBeGreaterThanOrEqual(200);
  await goToToDooSection(page, 'habits');
  await expect(page).toHaveURL(/appSection=habits/);
  await capture(page, info, 'tablet-landscape-navigation');
  await page.setViewportSize({ width: 820, height: 1180 });
  await expectBottomNavigation(page, navigation);
  await expect(sidebar).not.toBeVisible();
});

test('rotating with the account popup open closes both menus and restores a visible focus target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/?view=apps');
  await expect(page.locator('.apps-home')).toBeVisible();
  const navigation = tabs(page, 'DooKnow');
  await navigation.getByRole('button', { name: '更多导航', exact: true }).click();
  await page.getByRole('button', { name: '个人账户', exact: true }).click();
  const popup = page.getByRole('dialog', { name: '账户菜单', exact: true });
  await expect(popup).toBeVisible();
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(popup).toBeHidden();
  await page.setViewportSize({ width: 820, height: 1180 });
  await expectBottomNavigation(page, navigation);
  await expect(page.locator('.workspace-footer')).toBeHidden();
  await expect
    .poll(() => navigation.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await navigation.getByRole('button', { name: '更多导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人账户', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(popup).toBeHidden();
});

test('large touch tablet portrait keeps bottom tabs', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The mobile project supplies a coarse pointer.');
  await page.setViewportSize({ width: 1200, height: 1600 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  await expectBottomNavigation(page, tabs(page));
  await capture(page, info, 'large-touch-tablet-portrait');
});

test('blog labels fit the phone tabbar and site settings remain reachable', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=blog&appSection=overview');
  const navigation = tabs(page, '博客');
  await expectBottomNavigation(page, navigation);
  for (const label of ['概览', '文章', '装修主页', '分类与标签']) {
    const button = navigation.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    expect(
      await button.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await navigation.getByRole('button', { name: '分类与标签', exact: true }).click();
  await expect(page).toHaveURL(/appSection=taxonomy/);
  await expect(navigation.getByRole('button', { name: '分类与标签', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await capture(page, info, 'phone-blog-labels');

  const more = navigation.getByRole('button', { name: '更多导航', exact: true });
  await more.click();
  await page
    .getByRole('navigation', { name: '博客 工具', exact: true })
    .getByRole('button', { name: '站点设置', exact: true })
    .click();
  await expect(page).toHaveURL(/appSection=settings/);
  await expect(page.getByLabel('站点名称', { exact: true })).toBeVisible();
  await expect(page.locator('.workspace-footer')).toBeHidden();
  await expect(more).toContainText('站点设置');
  await expectBottomNavigation(page, navigation);
  // Overview exposes the picker with both an empty and an existing blog.
  await navigation.getByRole('button', { name: '概览', exact: true }).click();
  await page.setViewportSize({ width: 568, height: 320 });
  await page.getByRole('button', { name: '开始选稿', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择一篇笔记', exact: true });
  await expect(picker).toBeVisible();
  const pickerBox = await picker.boundingBox();
  const tabbarBox = await navigation.boundingBox();
  expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(tabbarBox!.y + 1);
  const note = picker.locator('.blog-picker-notes button').last();
  await note.scrollIntoViewIfNeeded();
  await expect(note).toBeInViewport();
  const noteBox = await note.boundingBox();
  expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(tabbarBox!.y + 1);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
});

test('short phone landscape keeps navigation controls above its shortcuts', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  const navigation = tabs(page);
  await expectBottomNavigation(page, navigation);
  const directory = await openToDooDirectory(page);
  const panel = await page.getByRole('dialog', { name: '功能导航', exact: true }).boundingBox();
  const bar = await navigation.boundingBox();
  expect(panel!.y).toBeGreaterThanOrEqual(-1);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(bar!.y + 1);
  const settings = directory.getByRole('button', { name: '设置', exact: true });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await capture(page, info, 'phone-short-landscape-navigation');
  await settings.click();
  await expect(page).toHaveURL(/appSection=settings/);
  await expect(page.getByRole('dialog', { name: '功能导航', exact: true })).not.toBeVisible();
  await expectBottomNavigation(page, navigation);
});

test('desktop keeps a single full-text sidebar with direct navigation', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  await expect(tabs(page)).toBeHidden();
  await expect(page.locator('.todo-page h1')).toHaveText('日历');
  await expect(page.locator('.workspace-footer')).toHaveCount(0);
  const sidebar = page.locator('.to-doo-workspace > .todo-sidebar');
  await expect(sidebar).toBeVisible();
  const box = await sidebar.boundingBox();
  expect(box!.x).toBeCloseTo(0, 0);
  expect(box!.width).toBeGreaterThanOrEqual(200);
  const menu = await openToDooDirectory(page);
  await expect(menu.getByRole('button', { name: '今天', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: '习惯', exact: true }).click();
  await expect(page).toHaveURL(/appSection=habits/);
  await expect(menu.getByRole('button', { name: '习惯', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const content = await page.locator('.main-content').boundingBox();
  expect(content!.x).toBeCloseTo(0, 0);
  expect(content!.y + content!.height).toBeCloseTo(1000, 0);
  await capture(page, info, 'desktop-app-sidebar');
});
