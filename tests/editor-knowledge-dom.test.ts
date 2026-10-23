import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

let browser: Browser, page: Page, bundle: string;
beforeAll(async () => {
  const built = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { Editor } from '@tiptap/core';
    import { createRichProjection, richExtensions } from './apps/web/editor/rich-adapter.ts';
    import { buildReadingHtml, printReadingHtml } from './apps/web/reading-export.ts';
    let editor, projection;
    const opened = [], links = [];
    function reset(markdown) {
      editor?.destroy(); document.body.replaceChildren(); opened.length=0; links.length=0;
      projection = createRichProjection(markdown);
      const mount=document.body.appendChild(document.createElement('div'));
      editor=new Editor({element:mount,content:projection.json,extensions:richExtensions(
        id=>opened.push(id),undefined,undefined,undefined,url=>links.push(url)
      ),injectCSS:false});
    }
    window.knowledgeFixture={reset,opened,links,buildReadingHtml,printReadingHtml,get projection(){return projection;},get editor(){return editor;}};
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', external: ['*.vue'], define: { 'import.meta.env': '{}' } });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle });
});
afterEach(async () => { await page?.close(); });

it('mounts native MathML and full footnote explanations without changing the preserved Markdown', async () => {
  const source = '公式 $x^2$\r\n\r\n引用[^a]\r\n\r\n[^a]: 脚注解释\r\n\r\n> [!TIP]\r\n> 使用提示\r\n';
  await page.evaluate(markdown => (window as any).knowledgeFixture.reset(markdown), source);
  await expect.poll(() => page.locator('.knowledge-source-preview math').count()).toBe(1);
  expect(await page.locator('.knowledge-source-preview').allTextContents()).toContainEqual(expect.stringContaining('脚注解释'));
  expect(await page.locator('.markdown-alert-tip').count()).toBe(1);
  expect(await page.evaluate(() => { const f = (window as any).knowledgeFixture; return f.projection.serialize(f.editor.getJSON()); })).toEqual({ ok: true, markdown: source });
  await page.getByRole('button', { name: '在源码中编辑' }).first().click();
  expect(await page.evaluate(() => (window as any).knowledgeFixture.opened)).toEqual(['s0-0']);
});

it('keeps images inert until they resolve through the authorized attachment path', async () => {
  const requests: string[] = [];
  page.on('request', request => { requests.push(request.url()); });
  await page.evaluate(() => (window as any).knowledgeFixture.reset('公式 $x$ ![外链图](https://example.invalid/should-not-load.png) <script>window.previewExecuted=true</script>\n'));
  await expect.poll(() => page.locator('math').count()).toBe(1);
  expect(await page.locator('.knowledge-source-preview img').getAttribute('src')).toBeNull();
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => (window as any).previewExecuted)).toBeUndefined();
});

it('routes enhanced wiki links through the same note navigation callback as ordinary editor links', async () => {
  await page.evaluate(() => {
    const f = (window as any).knowledgeFixture;
    f.reset('[[目标笔记|打开笔记]]\n');
    document.body.addEventListener('click', event => event.preventDefault());
  });
  await page.getByRole('link', { name: '打开笔记' }).click();
  expect(await page.evaluate(() => (window as any).knowledgeFixture.links)).toEqual(['%E7%9B%AE%E6%A0%87%E7%AC%94%E8%AE%B0.md']);
});

it('prints generated reading HTML with embedded images and no frontend requests', async () => {
  const result = await page.evaluate(async () => {
    const f = (window as any).knowledgeFixture;
    const png = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WP5l2kAAAAASUVORK5CYII='), x => x.charCodeAt(0))], { type: 'image/png' });
    const html = await f.buildReadingHtml({ title: '打印笔记', markdown: '![图](assets/a.png)\n\n公式 $x^2$\n', resolveImage: async () => png });
    const frame = document.body.appendChild(document.createElement('iframe'));
    const target = frame.contentWindow!;
    let printed = false;
    target.print = () => { printed = true; };
    await f.printReadingHtml(html, target);
    return { printed, images: target.document.images.length, imageSource: target.document.images[0].getAttribute('src'), math: target.document.querySelectorAll('math').length, scripts: target.document.scripts.length };
  });
  expect(result.printed).toBe(true);
  expect(result.images).toBe(1);
  expect(result.imageSource).toMatch(/^data:image\/png;base64,/);
  expect(result.math).toBe(1);
  expect(result.scripts).toBe(0);
});
