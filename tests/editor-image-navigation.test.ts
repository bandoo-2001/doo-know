import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';

const original =
  '正文\r\n\r\n' +
  Array.from({ length: 6 }, (_, i) => `![图片${i}](held-${i})`).join('\r\n\r\n') +
  '\r\n\r\n<!-- 原文保留 -->\r\n';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b9sAAAAASUVORK5CYII=',
  'base64',
);
const active = new Set<number>();
let server: Server,
  browser: Browser,
  context: BrowserContext,
  page: Page,
  origin: string,
  serial = 0;
beforeAll(async () => {
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { Editor } from '@tiptap/core';
    import { createRichProjection, richExtensions } from './apps/web/editor/rich-adapter.ts';
    import { bindImageRequests, trackImageRequest } from './apps/web/image-requests.ts';
    const original = ${JSON.stringify(original)}, projection = createRichProjection(original);
    let changes = 0;
    const editor = new Editor({element:document.querySelector('#editor'), extensions:richExtensions(undefined, src=>'/api/assets/'+src), content:projection.json, injectCSS:false, onUpdate(){changes++;}});
    window.fixture = { editor, trackImageRequest, serialize:()=>projection.serialize(editor.getJSON()), changes:()=>changes,
      createPreview(){ const root=document.createElement('section'); root.id='preview'; document.body.append(root); root.innerHTML=Array.from({length:6},(_,i)=>'<img src="/api/assets/preview-'+i+'">').join(''); const stop=bindImageRequests(root); window.fixture.preview={root,stop}; }
    };
  `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'import.meta.env': '{"VITE_DOCUMENT_EDITOR_ENABLED":"1"}' },
  });
  server = createServer((q, r) => {
    if (q.url?.startsWith('/api/assets/')) {
      const id = ++serial;
      active.add(id);
      r.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'no-store',
      });
      r.write(png.subarray(0, 8));
      // Real HTTP/1.1 streams fill all six browser connections until canceled
      // or completed. Route interception would not exercise that connection pool.
      const timer = setTimeout(() => r.end(png.subarray(8)), 3000);
      r.on('close', () => {
        clearTimeout(timer);
        active.delete(id);
      });
    } else if (q.url === '/app.js') {
      r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      r.end(compiled.outputFiles[0].text);
    } else {
      r.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      r.end(
        '<!doctype html><html><body><div id="editor"></div><script src="/app.js"></script></body></html>',
      );
    }
  });
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((yes) => server.close(() => yes()));
});
beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(origin, { waitUntil: 'commit' });
  await page.waitForFunction(() => !!(window as any).fixture);
  await expect.poll(() => active.size).toBe(6);
});
afterEach(async () => {
  await context?.close();
  await expect.poll(() => active.size).toBe(0);
});

it('releases outstanding editor images before a full-page navigation can be starved of connections', async () => {
  const started = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  expect(Date.now() - started).toBeLessThan(1500);
});

it('keeps image sources, original CRLF Markdown and editor state when leaving is canceled', async () => {
  await page.locator('#editor').click();
  // Clicking supplies the activation required for a real leave dialog. Establish
  // the bookmark explicitly afterward, rather than capturing a queued click's
  // stale ProseMirror selection before its native selectionchange is delivered.
  await page.evaluate(() => {
    const e = (window as any).fixture.editor;
    e.commands.setTextSelection(1);
    e.view.focus();
  });
  const selection = await page.evaluate(() =>
    (window as any).fixture.editor.state.selection.toJSON(),
  );
  await page.evaluate(() =>
    window.addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    }),
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  let canceled = false;
  try {
    await page.reload({ waitUntil: 'commit', timeout: 5000 });
  } catch {
    canceled = true;
  }
  expect(canceled).toBe(true);
  // ProseMirror also creates spacer img elements without a src; those are not
  // document images and must not be mistaken for failed restoration.
  await expect.poll(() => page.locator('#editor img[src]').count()).toBe(6);
  expect(await page.evaluate(() => (window as any).fixture.serialize())).toEqual({
    ok: true,
    markdown: original,
  });
  expect(await page.evaluate(() => (window as any).fixture.changes())).toBe(0);
  expect(
    await page.evaluate(() => (window as any).fixture.editor.state.selection.toJSON()),
  ).toEqual(selection);
});

it('stops requests belonging to a destroyed editor rather than leaving them behind a note switch', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size, { timeout: 1500 }).toBe(0);
});

it('does not restart completed image downloads when a later leave is canceled', async () => {
  await expect.poll(() => active.size, { timeout: 5000 }).toBe(0);
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>('#editor img[src]')].every(
      (image) => image.complete,
    ),
  );
  const before = serial;
  await page.locator('#editor').click();
  await page.evaluate(() =>
    window.addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    }),
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.reload({ waitUntil: 'commit', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
  expect(serial).toBe(before);
  expect(await page.evaluate(() => (window as any).fixture.serialize())).toEqual({
    ok: true,
    markdown: original,
  });
});

async function preview() {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  await page.evaluate(() => (window as any).fixture.createPreview());
  await expect.poll(() => active.size).toBe(6);
}
it('releases image connections from a read-only HTML surface before navigation', async () => {
  await preview();
  const start = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  expect(Date.now() - start).toBeLessThan(1500);
});
it('releases removed preview images even when the root binding is disposed in the same turn', async () => {
  await preview();
  await page.evaluate(() => {
    const { root, stop } = (window as any).fixture.preview;
    root.replaceChildren();
    stop();
    root.remove();
  });
  await expect.poll(() => active.size, { timeout: 1500 }).toBe(0);
});

it.each(['root', 'ancestor'])(
  'releases pending preview streams when its whole %s is removed without explicit disposal',
  async (kind) => {
    await preview();
    await page.evaluate((kind) => {
      const { root } = (window as any).fixture.preview;
      const wrapper = document.createElement('article');
      root.before(wrapper);
      wrapper.append(root);
      (kind === 'root' ? root : wrapper).remove();
    }, kind);
    await expect.poll(() => active.size, { timeout: 1500 }).toBe(0);
  },
);

it('keeps pending preview streams alive across a synchronous move', async () => {
  await preview();
  const before = serial;
  await page.evaluate(() => {
    const { root } = (window as any).fixture.preview;
    root.remove();
    document.body.append(root);
  });
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(await page.locator('#preview img[src]').count()).toBe(6);
  expect(active.size).toBe(6);
  expect(serial).toBe(before);
});

it('does not cancel an unrelated image removed outside the bound preview', async () => {
  await preview();
  await page.evaluate(() => {
    const root = (window as any).fixture.preview.root;
    [...root.querySelectorAll('img')].slice(1).forEach((image: any) => image.remove());
  });
  await expect.poll(() => active.size).toBe(1);
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.src = '/api/assets/unrelated';
    image.id = 'outside';
    document.body.append(image);
    (window as any).outsideImage = image;
  });
  await expect.poll(() => active.size).toBe(2);
  await page.evaluate(() => (window as any).outsideImage.remove());
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(await page.evaluate(() => (window as any).outsideImage.getAttribute('src'))).toBe(
    '/api/assets/unrelated',
  );
  expect(active.size).toBe(2);
});

it('uses the current editor source if an image changes while an attempted leave is canceled', async () => {
  await page.evaluate(() => {
    window.addEventListener('beforeunload', () => {
      const editor = (window as any).fixture.editor;
      let first: number | undefined;
      editor.state.doc.descendants((node: any, pos: number) => {
        if (first === undefined && node.type.name === 'image') first = pos;
      });
      editor.commands.setNodeSelection(first);
      editor.commands.updateAttributes('image', { src: '../outside' });
    });
    window.dispatchEvent(new Event('beforeunload'));
  });
  await expect.poll(() => page.locator('#editor img[src]').count()).toBe(5);
  expect(await page.locator('#editor img[alt="图片0"]').getAttribute('src')).toBeNull();
  expect(await page.evaluate(() => (window as any).fixture.serialize())).toMatchObject({
    ok: true,
    markdown: original.replace('(held-0)', '(../outside)'),
  });
});

it('restores unaffected images if another image cannot resolve its current source', async () => {
  await preview();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.trackImageRequest(f.preview.root.querySelector('img'), () => {
      throw Error('Synthetic resolver unavailable');
    });
    window.dispatchEvent(new Event('beforeunload'));
  });
  await expect.poll(() => page.locator('#preview img[src]').count(), { timeout: 1500 }).toBe(5);
  expect(errors).toEqual([]);
});
