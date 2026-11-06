import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { closeSidebar, openSettingsSection, showMainMenu, showSidebar } from '../support/settings-navigation';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function insideWindow(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const viewport = page.viewportSize()!;
  // Opening the actual drawer animates its transform; wait for geometry rather
  // than sampling a visible-but-still-entering input or sleeping a fixed time.
  await expect.poll(async () => (await target.boundingBox())?.x ?? -Infinity).toBeGreaterThanOrEqual(-1);
  await expect.poll(async () => (await target.boundingBox())?.y ?? -Infinity).toBeGreaterThanOrEqual(-1);
  await expect.poll(async () => {
    const box = await target.boundingBox();
    return box ? box.x + box.width : Infinity;
  }).toBeLessThanOrEqual(viewport.width + 1);
  await expect.poll(async () => {
    const box = await target.boundingBox();
    return box ? box.y + box.height : Infinity;
  }).toBeLessThanOrEqual(viewport.height + 1);
}

async function canReceivePointer(target: Locator) {
  expect(await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || !!(hit && element.contains(hit));
  })).toBe(true);
}

test('owner chrome keeps context and content aligned while navigation and resize remain usable', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const header = page.getByRole('banner', { name: 'DooKnow 工作区', exact: true });
  await expect(header).toHaveCount(0);
  const railBox = (await page.locator('.workspace-footer').boundingBox())!;
  expect(Math.abs(railBox.width - 60)).toBeLessThanOrEqual(1);
  for (const area of ['#notebook-navigation', '.main-content']) {
    const box = (await page.locator(area).boundingBox())!;
    expect(box.y).toBeCloseTo(0, 0);
    await insideWindow(page, page.locator(area));
  }
  const resize = page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 16));
  await page.reload();
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 16));

  await showMainMenu(page);
  await page.locator('.workspace-footer').getByRole('button', { name: '设置', exact: true }).click();
  await expect(header).toContainText('设置');
  await expect(page.locator('.settings-workspace h1')).toBeVisible();
  await page.goto('/');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 844 },
    { width: 844, height: 390 },
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(viewport);
    // The existing owner workspace may keep its desktop directory open when
    // resizing. Close that legitimate state before testing the open trigger.
    await closeSidebar(page);
    await expect(header).toHaveCount(0);
    await insideWindow(page, page.locator('.main-content'));
    await insideWindow(page, page.locator('.workspace-tabbar'));
    const trigger = page.getByRole('button', { name: '打开侧栏', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await insideWindow(page, page.getByPlaceholder('搜索笔记与目录'));
    if (viewport.height === 390)
      await expect(page.locator('#notebook-navigation')).toHaveCSS('padding-top', '8px');
    const close = page.getByRole('button', { name: '关闭侧栏', exact: true });
    await canReceivePointer(close);
    await close.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await expect(page.locator('.todo-topbar')).toBeVisible();
  await expect(header).toHaveCount(0);
  await expect(page.locator('.todo-topbar')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('existing-todoo-single-header.png'), animations: 'disabled' });
});

test('native canvas find and library controls stay inside 390 and 320 viewports', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建白板', exact: true });
  await create.getByLabel('文件名', { exact: true }).fill('platform-sidebar-' + crypto.randomUUID());
  await create.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  const native = workspace.locator('.excalidraw');
  await expect(native.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace.getByRole('status')).toContainText('已保存');
  await closeSidebar(page);

  for (const [width, height] of [[390, 844], [320, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await native.getByTestId('main-menu-trigger').click();
    const searchMenu = native.getByTestId('search-menu-button');
    if (height === 390) await searchMenu.scrollIntoViewIfNeeded();
    await searchMenu.click({ timeout: 5000 });
    const find = native.getByRole('textbox', { name: 'Find text on canvas...', exact: true });
    if (height === 390) await find.scrollIntoViewIfNeeded();
    await insideWindow(page, find);
    await canReceivePointer(find);
    await find.fill('isolated search');
    await expect(find).toBeFocused();
    const findClose = native.getByRole('button', { name: '关闭', exact: true });
    await insideWindow(page, findClose);
    await canReceivePointer(findClose);
    await page.screenshot({ path: info.outputPath(`canvas-find-${width}.png`), animations: 'disabled' });
    await findClose.click();
    await expect(find).toBeHidden();

    const libraryCheckbox = native.getByRole('checkbox', { name: '素材库', exact: true });
    const libraryTrigger = native.locator('label.sidebar-trigger__label-element').filter({
      has: page.getByRole('checkbox', { name: '素材库', exact: true }),
    });
    await insideWindow(page, libraryTrigger);
    await canReceivePointer(libraryTrigger);
    await libraryTrigger.click();
    await expect(libraryCheckbox).toBeChecked();
    const browse = native.getByRole('link', { name: '浏览素材库', exact: true });
    if (height === 390) await browse.scrollIntoViewIfNeeded();
    await insideWindow(page, browse);
    await canReceivePointer(browse);
    const libraryClose = native.getByRole('button', { name: '关闭', exact: true });
    if (height === 390) await libraryClose.scrollIntoViewIfNeeded();
    await insideWindow(page, libraryClose);
    await canReceivePointer(libraryClose);
    await page.screenshot({ path: info.outputPath(`canvas-library-${width}.png`), animations: 'disabled' });
    await libraryClose.click();
    await expect(browse).toBeHidden();
    if (height === 390) await native.locator('canvas.interactive').scrollIntoViewIfNeeded();
    await native.locator('canvas.interactive').click({ position: { x: 100, y: 100 } });
  }
});

test('Escape closes the create menu before its notebook drawer and returns focus one level at a time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await showSidebar(page);
  const create = page.getByRole('button', { name: '创建与导入', exact: true });
  await insideWindow(page, create);
  await create.click();
  const menu = page.getByRole('dialog', { name: '创建与导入', exact: true });
  await expect(menu).toBeVisible();
  await create.focus();
  await create.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#notebook-navigation')).toHaveClass(/\bopen\b/);
  await expect(create).toBeFocused();
  await create.press('Escape');
  await expect(page.locator('#notebook-navigation')).not.toHaveClass(/\bopen\b/);
  await expect(page.getByRole('button', { name: '打开侧栏', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await create.click();
  await expect(menu).toBeVisible();
  await create.focus();
  await create.press('Escape');
  await expect(menu).toBeHidden();
  await create.press('Escape');
  await expect(create).toBeFocused();
  await expect(create).toBeVisible();
});

test('closed notebook navigation is skipped by Tab and settings selection focuses visible content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await closeSidebar(page);
  const aside = page.locator('#notebook-navigation');
  const trigger = page.getByRole('button', { name: '打开侧栏', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  await expect.poll(() => aside.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await aside.evaluate(el => el.contains(document.activeElement))).toBe(false);
  await insideWindow(page, page.locator(':focus'));

  await openSettingsSection(page, '后台状态');
  await expect(aside).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('.main-content')).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await aside.evaluate(el => el.contains(document.activeElement))).toBe(false);
  await insideWindow(page, page.locator(':focus'));
});

test('long import card keeps its title and close control while scrolling to the final action', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 460 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '创建与导入', exact: true })).toBeEnabled();
  await closeSidebar(page);
  await page.locator('.workspace-empty').getByRole('button', { name: '导入 Markdown', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: '导入 Markdown', exact: true }),
  });
  await expect(dialog).toBeVisible();
  await dialog.locator('summary').filter({ hasText: '批量导入文件或目录' }).click();
  const complete = dialog.getByRole('button', { name: '完成', exact: true });
  await complete.scrollIntoViewIfNeeded();
  await expect(dialog).toHaveCSS('border-radius', '8px');
  expect(await dialog.locator(':scope > .n-card-content').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const header = dialog.locator(':scope > .n-card-header');
  await insideWindow(page, header);
  const close = header.getByRole('button', { name: /^(close|关闭)$/ });
  await insideWindow(page, close);
  await canReceivePointer(close);
  await insideWindow(page, complete);
  await canReceivePointer(complete);
  await page.screenshot({ path: info.outputPath('long-import-scroll.png'), animations: 'disabled' });
  await close.click();
  await expect(dialog).toBeHidden();
});

test('owner light and dark controls provide visual theme evidence', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeEnabled();
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async selected => {
      const path = '/preferences.ts';
      const preferences = await import(path);
      preferences.setEditorPreferences({ theme: selected });
      await document.fonts.ready;
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const button = page.getByRole('button', { name: '新建笔记', exact: true });
    const colors = await button.evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
    console.log(`owner ${theme} Ant primary: ${JSON.stringify(colors)}`);
    await page.screenshot({ path: info.outputPath(`owner-${theme}.png`), animations: 'disabled' });
  }
});

test('native library controls remain usable in short landscape', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建白板', exact: true });
  await create.getByLabel('文件名', { exact: true }).fill('short-library-' + crypto.randomUUID());
  await create.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  const native = workspace.locator('.excalidraw');
  await expect(native.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace.getByRole('status')).toContainText('已保存');
  await closeSidebar(page);
  await page.setViewportSize({ width: 844, height: 390 });
  const trigger = native.locator('label.sidebar-trigger__label-element').filter({ has: page.getByRole('checkbox', { name: '素材库', exact: true }) });
  await insideWindow(page, trigger);
  await canReceivePointer(trigger);
  await trigger.click();
  const browse = native.getByRole('link', { name: '浏览素材库', exact: true });
  const body = workspace.locator('.diagram-document-body');
  const bodyBox = (await body.boundingBox())!;
  await page.mouse.move(bodyBox.x + bodyBox.width - 10, bodyBox.y + bodyBox.height - 10);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await insideWindow(page, browse);
  await canReceivePointer(browse);
  await native.getByRole('button', { name: '关闭', exact: true }).click();
});
