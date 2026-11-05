import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))));

async function createPrimary(page: Page, label: '白板' | '脑图', name: string) {
  await page.goto('/'); await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建' + label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible({ timeout: 45000 });
  await expect(workspace.getByRole('status')).toContainText('已保存', { timeout: 45000 });
  return { workspace, id: new URL(page.url()).searchParams.get('note')! };
}

for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`native canvas background HEX is reachable above app navigation at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { workspace, id } = await createPrimary(page, '白板', 'hex-viewport-' + crypto.randomUUID());
    const native = workspace.locator('.excalidraw');
    await expect(native.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
    const before = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
    await native.getByTestId('main-menu-trigger').click();
    const background = native.getByRole('button', { name: '画布背景', exact: true });
    await background.scrollIntoViewIfNeeded(); await background.click();
    const input = native.getByRole('textbox', { name: '画布背景', exact: true });
    await expect(input).toBeVisible();
    await page.screenshot({ path: info.outputPath('color-popover-open.png'), animations: 'disabled' });
    await expect.poll(async () => input.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return element === hit || !!hit && element.contains(hit);
    })).toBe(true);
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    const tab = page.locator('.workspace-tabbar');
    const bottom = await tab.isVisible() ? (await tab.boundingBox())!.y : viewport.height;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(bottom);
    await input.click(); await expect(input).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('d5eadc'); await page.keyboard.press('Enter');
    await expect(input).toHaveValue('d5eadc');
    await page.keyboard.press('Escape');
    if (await native.locator('.dropdown-menu').isVisible()) await native.getByTestId('main-menu-trigger').click();
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect.poll(async () => {
      const resource = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
      return JSON.parse(resource.source.content).appState.viewBackgroundColor;
    }, { timeout: 30000 }).toBe('#d5eadc');
    const after = await (await page.request.get('/api/notes/' + id + '/diagram')).json();
    expect(JSON.parse(after.source.content).elements).toEqual(JSON.parse(before.source.content).elements);
    await page.screenshot({ path: info.outputPath('color-applied-canvas.png'), animations: 'disabled' });
  });
}

for (const width of [320, 390, 1440]) {
  test(`long mindmap root and child are initially readable inside the live canvas at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width < 800 ? 844 : 1000 });
    const name = 'long-mindmap-root-with-continuous-label-for-real-mobile-layout-' + crypto.randomUUID();
    const { workspace, id } = await createPrimary(page, '脑图', name);
    const root = workspace.locator('me-root me-tpc');
    await expect(root).toHaveText(name);
    const canvas = workspace.locator('.map-container');
    await expect(canvas).toBeVisible();
    await expect(workspace.locator('me-tpc')).toHaveCount(2);
    const before = await (await page.request.get('/api/notes/' + id)).json();
    await page.screenshot({ path: info.outputPath('mindmap-initial.png'), animations: 'disabled' });
    await expect.poll(async () => canvas.evaluate(element => {
      const clip = element.getBoundingClientRect();
      return [...element.querySelectorAll('me-tpc')].every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= Math.max(0, clip.left) - 1 && box.right <= Math.min(innerWidth, clip.right) + 1 &&
          box.top >= Math.max(0, clip.top) - 1 && box.bottom <= Math.min(innerHeight, clip.bottom) + 1;
      });
    })).toBe(true);
    await expect(root).toHaveText(name);
    await expect(workspace.locator('me-tpc').filter({ hasText: '新节点' })).toBeVisible();
    const effectiveFontSizes = await canvas.evaluate(element => [...element.querySelectorAll<HTMLElement>('me-tpc')].map(node => {
      const scale = node.getBoundingClientRect().height / node.offsetHeight;
      return parseFloat(getComputedStyle(node).fontSize) * scale;
    }));
    expect(Math.min(...effectiveFontSizes)).toBeGreaterThanOrEqual(12);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    const map = workspace.locator('.map-canvas');
    const initialTransform = await map.evaluate((element: HTMLElement) => element.style.transform);
    const area = (await canvas.boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + area.height - 24);
    await page.mouse.wheel(60, 30);
    await expect.poll(() => map.evaluate((element: HTMLElement) => element.style.transform)).not.toBe(initialTransform);
    const userTransform = await map.evaluate((element: HTMLElement) => element.style.transform);
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    expect(await map.evaluate((element: HTMLElement) => element.style.transform)).toBe(userTransform);
    expect((await (await page.request.get('/api/notes/' + id)).json()).content).toBe(before.content);
    const download = page.waitForEvent('download');
    await workspace.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('dialog', { name: '图形文档操作', exact: true }).getByRole('button', { name: '下载 Markdown', exact: true }).click();
    const file = await download;
    expect(await readFile((await file.path())!, 'utf8')).toBe(before.content);
  });
}

test('deep legal mindmap opens at a readable root and lets the user pan to level 24', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const { workspace, id } = await createPrimary(page, '脑图', '深链根-' + crypto.randomUUID().slice(0, 8));
  const initial = await (await page.request.get('/api/notes/' + id)).json();
  expect(initial.content).toContain('- 新节点\n');
  const labels = Array.from({ length: 24 }, (_, level) => `level-${level + 1}-continuous-readable-child-label-in-a-single-sided-chain`);
  const source = labels.map((label, level) => '  '.repeat(level) + '- ' + label + '\n').join('');
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await workspace.locator('.cm-content').fill(initial.content.replace('- 新节点\n', source));
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/api/notes/' + id)).json()).content).toContain(labels[23]);
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const saved = await (await page.request.get('/api/notes/' + id)).json();
  await workspace.getByRole('button', { name: '脑图', exact: true }).click();
  const canvas = workspace.locator('.map-container'), root = workspace.locator('me-root me-tpc');
  await expect(workspace.locator('me-tpc')).toHaveCount(25);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await page.screenshot({ path: info.outputPath('deep-map-initial.png'), animations: 'disabled' });
  await expect.poll(() => root.evaluate(element => {
    const box = element.getBoundingClientRect(), clip = element.closest('.map-container')!.getBoundingClientRect();
    return box.left >= Math.max(0, clip.left) - 1 && box.right <= Math.min(innerWidth, clip.right) + 1 && box.top >= Math.max(0, clip.top) - 1 && box.bottom <= Math.min(innerHeight, clip.bottom) + 1;
  })).toBe(true);
  const fontSizes = await canvas.evaluate(element => [...element.querySelectorAll<HTMLElement>('me-tpc')].map(node => parseFloat(getComputedStyle(node).fontSize) * node.getBoundingClientRect().height / node.offsetHeight));
  expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(12);
  const deepest = workspace.locator('me-tpc').filter({ hasText: labels[23] });
  const clip = (await canvas.boundingBox())!, target = (await deepest.boundingBox())!;
  await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height - 20);
  await page.mouse.wheel(target.x + target.width / 2 - clip.x - clip.width / 2, target.y + target.height / 2 - clip.y - clip.height / 2);
  await expect.poll(() => deepest.evaluate(element => {
    const box = element.getBoundingClientRect(), clip = element.closest('.map-container')!.getBoundingClientRect();
    return box.left >= clip.left - 1 && box.right <= clip.right + 1 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1;
  })).toBe(true);
  const map = canvas.locator('.map-canvas');
  const userTransform = await map.evaluate((element: HTMLElement) => element.style.transform);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  expect(await map.evaluate((element: HTMLElement) => element.style.transform)).toBe(userTransform);
  await expect(deepest).toHaveText(labels[23]);
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toBe(saved.content);
  await page.screenshot({ path: info.outputPath('deep-node-after-user-pan.png'), animations: 'disabled' });
  const downloaded = page.waitForEvent('download');
  await workspace.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('dialog', { name: '图形文档操作', exact: true }).getByRole('button', { name: '下载 Markdown', exact: true }).click();
  expect(await readFile((await (await downloaded).path())!, 'utf8')).toBe(saved.content);
});
