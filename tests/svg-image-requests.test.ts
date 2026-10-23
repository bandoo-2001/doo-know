import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#123456"/></svg>';
const paths: string[] = [];
let server: Server, browser: Browser, context: BrowserContext, page: Page, origin: string;
beforeAll(async () => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import {trackImageRequest} from './apps/web/image-requests.ts';
      window.fixture = {load(source) {
        const image = document.createElement('img'); document.body.append(image);
        const owner = {image, source, stop:undefined};
        owner.stop = trackImageRequest(image, () => ({src:owner.source}));
        window.fixture.owner=owner; return image;
      }};
    `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  server = createServer((request, response) => {
    const path = request.url || '/';
    if (path === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(bundled.outputFiles[0].text);
    } else if (path.startsWith('/api/')) {
      paths.push(path);
      if (path.includes('denied')) {
        response.writeHead(401, { 'content-type': 'image/svg+xml' });
        response.end(svg);
      } else if (path.includes('download')) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="source.svg"',
        });
        response.end(svg);
      } else {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        const source = path.includes('unsafe')
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><script>fetch("/external-leak")</script><rect width="64" height="32"/></svg>'
          : path.includes('oversized')
            ? svg + ' '.repeat(1024 * 1024)
            : svg;
        if (path.includes('slow')) {
          const timer = setTimeout(() => response.end(source), 400);
          response.on('close', () => clearTimeout(timer));
        } else response.end(source);
      }
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><script src="/fixture.js"></script></body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  paths.length = 0;
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!(window as any).fixture);
});
afterEach(async () => context?.close());

it.each([
  '/api/assets/valid',
  '/api/public/shares/fixture/assets/valid',
  '/api/public/shares/fixture/asset?source=assets%2Fvalid.svg',
])('displays a validated SVG through the authorized image loader: %s', async (source) => {
  await page.evaluate((source) => (window as any).fixture.load(source), source);
  await expect
    .poll(() => page.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(64);
  expect(await page.locator('img').getAttribute('src')).toMatch(/^blob:/);
});

it.each(['unsafe', 'oversized', 'denied', 'download'])(
  'never publishes %s SVG response bytes as an image',
  async (id) => {
    await page.evaluate((id) => (window as any).fixture.load('/api/assets/' + id), id);
    await page.waitForFunction(() => !document.querySelector('img')!.hasAttribute('aria-busy'));
    expect(await page.locator('img').getAttribute('src')).toBeNull();
    expect(
      await page.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(0);
  },
);

it('does not request SVG source download URLs as previews', async () => {
  await page.evaluate(() => (window as any).fixture.load('/api/assets/valid?download=1'));
  await page.waitForFunction(() => !document.querySelector('img')!.hasAttribute('aria-busy'));
  expect(paths).toEqual([]);
  expect(await page.locator('img').getAttribute('src')).toBeNull();
});

it('rechecks the current source before publishing an older SVG response', async () => {
  await page.evaluate(() => (window as any).fixture.load('/api/assets/slow-old'));
  await expect.poll(() => paths.includes('/api/assets/slow-old')).toBe(true);
  await page.evaluate(() => {
    (window as any).fixture.owner.source = '/api/assets/denied';
  });
  await expect.poll(() => paths.includes('/api/assets/denied')).toBe(true);
  await page.waitForFunction(() => !document.querySelector('img')!.hasAttribute('aria-busy'));
  expect(await page.locator('img').getAttribute('src')).toBeNull();
});

it('releases an accepted SVG object URL after its final owner is disposed', async () => {
  await page.evaluate(() => (window as any).fixture.load('/api/assets/valid'));
  await expect
    .poll(() => page.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(64);
  const source = await page.locator('img').getAttribute('src');
  expect(await page.evaluate(async (source) => (await fetch(source!)).ok, source)).toBe(true);
  await page.evaluate(() => (window as any).fixture.owner.stop());
  expect(
    await page.evaluate(async (source) => {
      try {
        await fetch(source!);
        return true;
      } catch {
        return false;
      }
    }, source),
  ).toBe(false);
});
