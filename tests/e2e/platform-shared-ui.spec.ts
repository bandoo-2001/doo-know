import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { closeSidebar, showMainMenu, showSidebar } from '../support/settings-navigation';

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
  await expect(header).toBeVisible();
  const headerBox = (await header.boundingBox())!;
  const railBox = (await page.locator('.workspace-footer').boundingBox())!;
  expect(Math.abs(headerBox.height - 56)).toBeLessThanOrEqual(1);
  expect(Math.abs(railBox.width - 64)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerBox.x - (railBox.x + railBox.width))).toBeLessThanOrEqual(1);
  for (const area of ['#notebook-navigation', '.main-content']) {
    const box = (await page.locator(area).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
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
    await insideWindow(page, header);
    await insideWindow(page, page.locator('.main-content'));
    await insideWindow(page, page.locator('.workspace-tabbar'));
    const trigger = page.getByRole('button', { name: '打开侧栏', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await insideWindow(page, page.getByPlaceholder('搜索笔记与目录'));
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

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await native.getByTestId('main-menu-trigger').click();
    await native.getByTestId('search-menu-button').click();
    const find = native.getByRole('textbox', { name: 'Find text on canvas...', exact: true });
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
    await insideWindow(page, browse);
    await canReceivePointer(browse);
    const libraryClose = native.getByRole('button', { name: '关闭', exact: true });
    await insideWindow(page, libraryClose);
    await canReceivePointer(libraryClose);
    await page.screenshot({ path: info.outputPath(`canvas-library-${width}.png`), animations: 'disabled' });
    await libraryClose.click();
    await expect(browse).toBeHidden();
    await native.locator('canvas.interactive').click({ position: { x: 100, y: 100 } });
  }
});
