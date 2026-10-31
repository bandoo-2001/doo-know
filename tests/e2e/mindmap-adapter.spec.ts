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
