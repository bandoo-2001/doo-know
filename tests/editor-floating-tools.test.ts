import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

let browser: Browser, page: Page, source: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { createFloatingTools, virtualAnchor } from './apps/web/editor/floating-tools.ts';
    window.floatingFixture = { createFloatingTools, virtualAnchor };
  `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  source = bundle.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 390, height: 300 } });
  await page.setContent(
    '<style>body{margin:0}#anchor{position:absolute;left:350px;top:260px;width:30px;height:30px}#menu{width:210px;height:150px;background:#eee}</style><button id="anchor">打开</button><div id="menu" role="menu">操作</div>',
  );
  await page.addScriptTag({ content: source });
});
afterEach(async () => {
  await page?.close();
});

it('flips a real anchor above a lower edge and keeps its controls inside the viewport', async () => {
  await page.evaluate(async () => {
    const menu = document.querySelector<HTMLElement>('#menu')!;
    (window as any).positioner = (window as any).floatingFixture.createFloatingTools(
      document.querySelector('#anchor'),
      menu,
      { padding: 8, gap: 6 },
      (style: any) => Object.assign(menu.style, style),
    );
    await (window as any).positioner.update();
  });
  const box = (await page.locator('#menu').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  expect(box.y + box.height).toBeLessThanOrEqual(254);
});

it('bounds a virtual pointer menu to a short viewport and stops updating on disposal', async () => {
  await page.evaluate(async () => {
    const fixture = (window as any).floatingFixture,
      menu = document.querySelector<HTMLElement>('#menu')!;
    menu.style.height = '600px';
    let top = 285;
    (window as any).moveAnchor = () => {
      top = 20;
    };
    const anchor = fixture.virtualAnchor(() => new DOMRect(380, top, 0, 0), document.body);
    (window as any).positioner = fixture.createFloatingTools(
      anchor,
      menu,
      { padding: 8, gap: 0, placement: 'bottom-start' },
      (style: any) => Object.assign(menu.style, style),
    );
    await (window as any).positioner.update();
  });
  let box = (await page.locator('#menu').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.y + box.height).toBeLessThanOrEqual(292);
  await page.evaluate(async () => {
    (window as any).positioner.stop();
    (window as any).moveAnchor();
    await (window as any).positioner.update();
  });
  expect(await page.locator('#menu').boundingBox()).toEqual(box);
});

it('tracks the real anchor while its scroll container moves', async () => {
  await page.setContent(
    '<style>body{margin:0}#scroller{height:280px;overflow:auto}#body{height:800px;padding-top:120px}#menu{width:100px;height:40px}</style><div id="scroller"><div id="body"><button id="anchor">打开</button></div></div><div id="menu">操作</div>',
  );
  await page.evaluate(async () => {
    const menu = document.querySelector<HTMLElement>('#menu')!;
    (window as any).positioner = (window as any).floatingFixture.createFloatingTools(
      document.querySelector('#anchor'),
      menu,
      { gap: 6 },
      (style: any) => Object.assign(menu.style, style),
    );
    await (window as any).positioner.update();
  });
  const before = (await page.locator('#menu').boundingBox())!.y;
  await page.locator('#scroller').evaluate((element) => (element.scrollTop = 60));
  await expect
    .poll(async () => (await page.locator('#menu').boundingBox())!.y)
    .toBeLessThan(before - 50);
});
