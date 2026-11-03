import { test, expect } from '@playwright/test';
import type {} from '../fixtures/mindmap-adapter/harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.diagramAdapter);
});

test('edits Chinese text, inserts a child through the real keyboard and undoes', async ({
  page,
}) => {
  const root = page.locator('me-root me-tpc');
  await expect(root).toHaveText('中文根');
  await root.click();
  await page.keyboard.press('Tab');
  const editor = page.locator('#input-box');
  await expect(editor).toBeVisible();
  await editor.dispatchEvent('compositionstart');
  await editor.fill('中文输入');
  await editor.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    bubbles: true,
  });
  await expect(editor).toBeVisible();
  await editor.dispatchEvent('compositionend', { data: '中文输入' });
  await editor.fill('中文输入完成');
  await page.keyboard.press('Enter');
  await expect(page.locator('me-tpc').filter({ hasText: /^中文输入完成$/ })).toHaveCount(1);
  const tree = await page.evaluate(() => window.diagramAdapter.tree());
  expect(tree.children.some((node) => node.topic === '中文输入完成')).toBe(true);
  await page.evaluate(() => window.diagramAdapter.undo());
  await expect(page.locator('me-tpc').filter({ hasText: /^中文输入完成$/ })).toHaveCount(0);
});

test('captures the whole expanded tree without modifying the editor or fetching external resources', async ({
  page,
}) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4196/'))
      outside.push(request.url());
  });
  await page.locator('me-epd').first().click();
  const result = await page.evaluate(() => window.diagramAdapter.render());
  expect(result).toMatchObject({ type: 'image/png', stateUnchanged: true, viewUnchanged: true });
  expect(result.width).toBeGreaterThan(200);
  expect(result.height).toBeGreaterThan(100);
  expect(result.size).toBeGreaterThan(1000);
  expect(outside).toEqual([]);
  await expect(page.locator('#result')).toBeVisible();
  await page.screenshot({ path: '.local/markdown-diagrams/mindmap-adapter.png', fullPage: true });
});

test('renders 500 nodes with bounded PNG dimensions and records latency', async ({
  page,
}, testInfo) => {
  const started = Date.now();
  const result = await page.evaluate(async () => {
    window.diagramAdapter.mountTree({
      id: 'r',
      topic: '500 个中文节点',
      children: Array.from({ length: 19 }, (_, i) => ({
        id: 'b' + i,
        topic: '分支 ' + i,
        children: Array.from({ length: i < 5 ? 26 : 25 }, (_, j) => ({
          id: i + '-' + j,
          topic: '中文 ' + i + '/' + j,
          children: [],
        })),
      })),
    });
    return window.diagramAdapter.render();
  });
  expect(result.width).toBeLessThanOrEqual(8192);
  expect(result.height).toBeLessThanOrEqual(8192);
  expect(result.width * result.height).toBeLessThanOrEqual(16_777_216);
  expect(result.size).toBeLessThanOrEqual(10 * 1024 * 1024);
  expect(Date.now() - started).toBeLessThan(45000);
  await testInfo.attach('500-node-performance', {
    body: JSON.stringify({ milliseconds: Date.now() - started, ...result }),
    contentType: 'application/json',
  });
});

test('rejects native clipboard payloads carrying images or HTML before the engine can consume them', async ({
  page,
}) => {
  const leaked: string[] = [];
  await page.route('**/clipboard-leak*', async (route) => {
    leaked.push(route.request().url());
    await route.abort();
  });
  await page.locator('me-root me-tpc').click();
  await page.evaluate(async () => {
    const container = document.querySelector('.map-container')!;
    for (const dangerous of [
      { image: { url: location.origin + '/clipboard-leak.png', width: 100, height: 100 } },
      { dangerouslySetInnerHTML: '<img data-clipboard src="/clipboard-leak-html.png">' },
    ]) {
      const data = new DataTransfer();
      data.setData(
        'text/plain',
        JSON.stringify({
          magic: 'MIND-ELIXIR-WAIT-COPY',
          data: [{ id: 'bad', topic: '不支持的粘贴', children: [], ...dangerous }],
        }),
      );
      container.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('me-tpc')).toHaveCount(4);
  await expect(page.locator('[data-clipboard]')).toHaveCount(0);
  expect(leaked).toEqual([]);
  expect((await page.evaluate(() => window.diagramAdapter.tree())).children).toHaveLength(2);
});

test('allows the engine to copy and paste supported text nodes', async ({ page }) => {
  await page
    .locator('me-tpc')
    .filter({ hasText: /^另一个分支$/ })
    .click();
  await page.evaluate(async () => {
    const container = document.querySelector('.map-container')!;
    const data = new DataTransfer();
    container.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    container.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('me-tpc')).toHaveCount(5);
  const tree = await page.evaluate(() => window.diagramAdapter.tree());
  expect(tree.children[1].children[0].topic).toBe('另一个分支');
});

test('captures the invocation snapshot even if the caller edits the tree while fonts are awaited', async ({
  page,
}) => {
  expect(await page.evaluate(() => window.diagramAdapter.snapshotConsistency())).toBe(true);
});
test('rejects native styling rather than silently losing it in Markdown',async({page})=>{
 const message=await page.evaluate(()=>{window.diagramAdapter.setRootStyle();try{window.diagramAdapter.tree();return '';}catch(e){return (e as Error).message;}});
 expect(message).toContain('样式');
});
test('root text edits remain representable in the supported Markdown subset',async({page})=>{
 await page.locator('me-root me-tpc').click();await page.keyboard.press('F2');await page.locator('#input-box').fill('已编辑根');await page.keyboard.press('Enter');expect(await page.evaluate(()=>window.diagramAdapter.tree().topic)).toBe('已编辑根');
});

test('node context menu shows supported actions and shortcuts, edits the clicked branch and protects the root', async ({ page }) => {
  const branch = page.locator('me-tpc').filter({ hasText: /^另一个分支$/ });
  await branch.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '脑图节点操作', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '新增子节点 Tab', exact: true })).toBeVisible();
  await expect(menu).not.toContainText('关系线');
  await expect(menu).not.toContainText('摘要');
  await menu.getByRole('menuitem', { name: '新增子节点 Tab', exact: true }).click();
  await page.locator('#input-box').fill('右键新增中文节点');
  await page.keyboard.press('Enter');
  expect((await page.evaluate(() => window.diagramAdapter.tree())).children[1].children[0].topic).toBe('右键新增中文节点');
  await page.locator('me-root me-tpc').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '删除节点 Delete', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: '新增同级节点 Enter', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: '展开 / 收起分支', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('shortcut reference is keyboard accessible, fits a narrow screen and closes without editing the tree', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await page.evaluate(() => window.diagramAdapter.tree());
  const trigger = page.getByRole('button', { name: '脑图快捷键', exact: true });
  await trigger.click();
  const help = page.getByRole('dialog', { name: '脑图快捷键', exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText('F2');
  await expect(help).toContainText('Tab');
  await expect(help).toContainText('Enter');
  const bounds = (await help.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.diagramAdapter.tree())).toEqual(before);
});

test('keyboard menu navigation works and read-only renders expose no editing controls', async ({ page }) => {
  await page.locator('me-root me-tpc').click();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: '脑图节点操作', exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '新增子节点 Tab', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.evaluate(() => window.diagramAdapter.mount('# 只读预览\n\n- 子节点\n', true));
  await expect(page.getByRole('button', { name: '脑图快捷键', exact: true })).toHaveCount(0);
  await page.locator('me-root me-tpc').click({ button: 'right' });
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => window.diagramAdapter.mount('# 可编辑\n\n- 子节点\n'));
  await expect(page.getByRole('button', { name: '脑图快捷键', exact: true })).toHaveCount(1);
});
