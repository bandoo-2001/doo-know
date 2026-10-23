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
let holdHeaders = false;
let requestedPaths: string[] = [];
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
    import { bindImageRequests, trackImageRequest, deferRenderedImages } from './apps/web/image-requests.ts';
    const original = ${JSON.stringify(original)}, projection = createRichProjection(original);
    let changes = 0;
    const editor = new Editor({element:document.querySelector('#editor'), extensions:richExtensions(undefined, src=>'/api/assets/'+src), content:projection.json, injectCSS:false, onUpdate(){changes++;}});
    window.fixture = { editor, trackImageRequest, serialize:()=>projection.serialize(editor.getJSON()), changes:()=>changes,
      createPreview(html){ const root=document.createElement('section'); root.id='preview'; document.body.append(root); root.innerHTML=deferRenderedImages(html ?? Array.from({length:6},(_,i)=>'<img src="/api/assets/preview-'+i+'">').join('')); const stop=bindImageRequests(root); window.fixture.preview={root,stop}; }
    };
  `,
    },
    // Diagram views are loaded lazily and are outside this image-only fixture.
    // Keep the real rich adapter and image request lifecycle in the browser bundle.
    external: ['*.vue'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'import.meta.env': '{"VITE_DOCUMENT_EDITOR_ENABLED":"1"}' },
  });
  server = createServer((q, r) => {
    if (q.url?.startsWith('/api/assets/')) {
      requestedPaths.push(q.url);
      const id = ++serial;
      active.add(id);
      if (
        q.url === '/api/assets/denied' ||
        q.url === '/api/assets/redirect' ||
        q.url === '/api/assets/oversized'
      ) {
        r.on('close', () => active.delete(id));
        if (q.url.endsWith('redirect')) {
          r.writeHead(302, { location: '/api/assets/should-not-follow' });
          r.end();
        } else if (q.url.endsWith('denied')) {
          r.writeHead(403, { 'content-type': 'image/png' });
          r.end(png);
        } else {
          r.writeHead(200, { 'content-type': 'image/png' });
          r.end(Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 + 1)]));
        }
        return;
      }
      if (q.url === '/api/assets/bad-type') {
        r.writeHead(200, { 'content-type': 'application/json', 'content-length': 1000 });
        r.write('{');
        r.on('close', () => active.delete(id));
        return;
      }
      if (q.url === '/api/assets/progress-image') {
        r.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
        r.write(png.subarray(0, 8));
        let offset = 8;
        const timer = setInterval(() => {
          const next = Math.min(offset + 16, png.length);
          r.write(png.subarray(offset, next));
          offset = next;
          if (offset === png.length) {
            clearInterval(timer);
            r.end();
          }
        }, 4000);
        r.on('close', () => {
          clearInterval(timer);
          active.delete(id);
        });
        return;
      }
      const headers = {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'no-store',
      };
      if (!holdHeaders) {
        r.writeHead(200, headers);
        r.write(png.subarray(0, 8));
      }
      // Real HTTP/1.1 streams fill all six browser connections until canceled
      // or completed. Route interception would not exercise that connection pool.
      const headersHeld = holdHeaders;
      const timer = setTimeout(() => {
        if (headersHeld) r.writeHead(200, headers);
        r.end(headersHeld ? png : png.subarray(8));
      }, 3000);
      r.on('close', () => {
        clearTimeout(timer);
        active.delete(id);
      });
    } else if (q.url === '/control') {
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end('{}');
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
  holdHeaders = false;
  requestedPaths = [];
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(origin, { waitUntil: 'commit' });
  await page.waitForFunction(() => !!(window as any).fixture);
  await expect.poll(() => active.size).toBeGreaterThan(0);
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

it('releases image requests whose response headers have not arrived before navigating', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  holdHeaders = true;
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  await page.waitForFunction(() => !!(window as any).fixture);
  await expect.poll(() => active.size).toBeGreaterThan(0);
  const started = Date.now();
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  expect(Date.now() - started).toBeLessThan(1500);
});

it('keeps a control request responsive while six image response headers are pending', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  holdHeaders = true;
  await page.reload({ waitUntil: 'commit', timeout: 10000 });
  await page.waitForFunction(() => !!(window as any).fixture);
  await expect.poll(() => active.size).toBeGreaterThan(0);
  const started = Date.now();
  expect(await page.evaluate(async () => (await fetch('/control')).status)).toBe(200);
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
  await expect.poll(() => page.locator('#editor img[src]').count(), { timeout: 10000 }).toBe(6);
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
  await page.waitForFunction(
    () => {
      const images = [...document.querySelectorAll<HTMLImageElement>('#editor img[alt^="图片"]')];
      return (
        images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0)
      );
    },
    {},
    { timeout: 10000 },
  );
  await expect.poll(() => active.size).toBe(0);
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
  await expect.poll(() => active.size).toBeGreaterThan(0);
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
  // Observe the complete scheduled batch before testing that a move preserves it.
  await expect.poll(() => active.size).toBe(3);
  const before = serial,
    beforeActive = active.size;
  await page.evaluate(() => {
    const { root } = (window as any).fixture.preview;
    root.remove();
    document.body.append(root);
  });
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(await page.locator('#preview img').count()).toBe(6);
  expect(active.size).toBe(beforeActive);
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
  await expect.poll(() => page.locator('#editor img[src]').count(), { timeout: 10000 }).toBe(5);
  expect(await page.locator('#editor img[alt="图片0"]').getAttribute('src')).toBeNull();
  expect(await page.evaluate(() => (window as any).fixture.serialize())).toMatchObject({
    ok: true,
    markdown: original.replace('(held-0)', '(../outside)'),
  });
});

it.each(['changed', 'unavailable', 'throwing'] as const)(
  'rechecks a %s resolver when pending bytes finish without a model transaction',
  async (state) => {
    await page.evaluate(() => (window as any).fixture.editor.destroy());
    await expect.poll(() => active.size).toBe(0);
    await page.evaluate(() => {
      const f = (window as any).fixture;
      const image = document.createElement('img');
      image.id = 'resolver-image';
      image.alt = 'resolver fixture';
      document.body.append(image);
      f.resolverState = 'original';
      f.trackImageRequest(image, () => {
        if (f.resolverState === 'throwing') throw Error('Resolver unavailable');
        return {
          src:
            f.resolverState === 'unavailable'
              ? null
              : '/api/assets/' +
                (f.resolverState === 'changed' ? 'resolver-current' : 'resolver-old'),
        };
      });
    });
    await expect.poll(() => requestedPaths.includes('/api/assets/resolver-old')).toBe(true);
    await page.evaluate((state) => {
      (window as any).fixture.resolverState = state;
    }, state);
    const image = page.locator('#resolver-image');
    if (state === 'changed') {
      await expect
        .poll(() => requestedPaths.includes('/api/assets/resolver-current'), { timeout: 4500 })
        .toBe(true);
      expect(await image.getAttribute('src')).toBeNull();
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), {
          timeout: 4500,
        })
        .toBe(1);
      expect(await image.getAttribute('data-dooknow-image-src')).toBe(
        '/api/assets/resolver-current',
      );
    } else {
      await expect.poll(() => active.size, { timeout: 4500 }).toBe(0);
      expect(await image.getAttribute('src')).toBeNull();
      expect(await image.getAttribute('data-dooknow-image-src')).toBeNull();
    }
    expect(await image.getAttribute('alt')).toBe('resolver fixture');
    expect(await page.evaluate(() => (window as any).fixture.serialize())).toMatchObject({
      ok: true,
      markdown: original,
    });
  },
);

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
  await expect.poll(() => page.locator('#preview img[src]').count(), { timeout: 10000 }).toBe(5);
  expect(errors).toEqual([]);
});

it('aborts an unusable image response instead of retaining its connection', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  const before = serial;
  await page.evaluate(() =>
    (window as any).fixture.createPreview('<img alt="unavailable" src="/api/assets/bad-type">'),
  );
  await expect.poll(() => serial).toBe(before + 1);
  await expect.poll(() => active.size, { timeout: 1500 }).toBe(0);
  expect(await page.locator('#preview img').getAttribute('alt')).toBe('unavailable');
});
it('allows a progressing image transfer to finish beyond the control-request deadline', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  await page.evaluate(() =>
    (window as any).fixture.createPreview('<img alt="progress" src="/api/assets/progress-image">'),
  );
  await expect
    .poll(
      () =>
        page.locator('#preview img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
      { timeout: 18000 },
    )
    .toBe(1);
});

it('shares a simultaneous download without retaining the object URL after its last view is removed', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  const before = serial;
  await page.evaluate(() =>
    (window as any).fixture.createPreview(
      '<img alt="one" src="/api/assets/shared"><img alt="two" src="/api/assets/shared">',
    ),
  );
  await page.waitForFunction(
    () => {
      const images = [...document.querySelectorAll<HTMLImageElement>('#preview img')];
      return images.length === 2 && images.every((image) => image.naturalWidth === 1);
    },
    {},
    { timeout: 5000 },
  );
  expect(serial - before).toBe(1);
  const urls = await page
    .locator('#preview img')
    .evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  expect(new Set(urls).size).toBe(1);
  await page.evaluate(() => (window as any).fixture.preview.root.firstElementChild.remove());
  expect(
    await page.evaluate(
      async (url) => (await (await fetch(url!)).arrayBuffer()).byteLength,
      urls[0],
    ),
  ).toBe(png.length);
  await page.evaluate(() => (window as any).fixture.preview.root.remove());
  await expect
    .poll(() =>
      page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return false;
        } catch {
          return true;
        }
      }, urls[0]),
    )
    .toBe(true);
});

it.each(['denied', 'redirect', 'oversized'])(
  'does not display a %s response or follow it into another resource',
  async (kind) => {
    await page.evaluate(() => (window as any).fixture.editor.destroy());
    await expect.poll(() => active.size).toBe(0);
    const before = serial;
    await page.evaluate(
      (kind) =>
        (window as any).fixture.createPreview(
          '<img alt="retained" src="/api/assets/' + kind + '">',
        ),
      kind,
    );
    await expect.poll(() => serial).toBe(before + 1);
    await page.waitForFunction(
      () => !document.querySelector('#preview img')!.hasAttribute('aria-busy'),
    );
    expect(await page.locator('#preview img').getAttribute('src')).toBeNull();
    expect(await page.locator('#preview img').getAttribute('alt')).toBe('retained');
    expect(requestedPaths).not.toContain('/api/assets/should-not-follow');
    await expect.poll(() => active.size).toBe(0);
  },
);
it('does not trust a deferred-source attribute supplied without a rendered authorized source', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  const before = serial;
  await page.evaluate(() =>
    (window as any).fixture.createPreview(
      '<img alt="retained" data-dooknow-image-src="/api/assets/forged">',
    ),
  );
  await page.evaluate(() => new Promise<void>((yes) => requestAnimationFrame(() => yes())));
  expect(serial).toBe(before);
  expect(await page.locator('#preview img').getAttribute('data-dooknow-image-src')).toBeNull();
});

it('does not publish a pending old image into a document that rejected its source', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  let oldRequestId: string | undefined;
  let oldEnded = false;
  session.on('Network.requestWillBeSent', (event) => {
    if (event.request.url === origin + '/api/assets/adopted-old') oldRequestId = event.requestId;
  });
  session.on('Network.loadingFinished', (event) => {
    if (event.requestId === oldRequestId) oldEnded = true;
  });
  session.on('Network.loadingFailed', (event) => {
    if (event.requestId === oldRequestId) oldEnded = true;
  });
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.id = 'transferred-image';
    document.body.append(image);
    (window as any).fixture.oldImageStop = (window as any).fixture.trackImageRequest(image, () => ({
      src: '/api/assets/adopted-old',
    }));
  });
  await expect
    .poll(() => requestedPaths.filter((path) => path === '/api/assets/adopted-old').length)
    .toBe(1);
  await expect.poll(() => oldRequestId, { timeout: 1000 }).toBeDefined();
  expect(await page.locator('#transferred-image').getAttribute('src')).toBe(null);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'image-document';
    document.body.append(frame);
    const nextDocument = frame.contentDocument!;
    const image = nextDocument.adoptNode(
      document.querySelector<HTMLImageElement>('#transferred-image')!,
    );
    nextDocument.body.append(image);
    (window as any).fixture.trackImageRequest(image, () => ({ src: null }));
  });
  // Let the real HTTP body finish. The old constant getter remains valid, so
  // an old display task cannot be made safe merely by re-reading that getter.
  await expect.poll(() => oldEnded, { timeout: 5000 }).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await session.detach();
  expect(await page.frameLocator('#image-document').locator('img').getAttribute('src')).toBe(null);
  expect(
    await page
      .frameLocator('#image-document')
      .locator('img')
      .getAttribute('data-dooknow-image-src'),
  ).toBe(null);
  expect(
    await page
      .frameLocator('#image-document')
      .locator('img')
      .evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBe(0);
});

it('revokes the last old image URL after its element moves to another document', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.id = 'transferred-image';
    document.body.append(image);
    (window as any).fixture.trackImageRequest(image, () => ({ src: '/api/assets/adopted-old' }));
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLImageElement>('#transferred-image')?.naturalWidth === 1,
  );
  const oldUrl = await page.locator('#transferred-image').getAttribute('src');
  expect(oldUrl).toMatch(/^blob:/);
  expect(await page.evaluate(async (url) => (await fetch(url!)).ok, oldUrl)).toBe(true);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'image-document';
    document.body.append(frame);
    const nextDocument = frame.contentDocument!;
    const image = nextDocument.adoptNode(
      document.querySelector<HTMLImageElement>('#transferred-image')!,
    );
    nextDocument.body.append(image);
    (window as any).fixture.trackImageRequest(image, () => ({ src: null }));
  });
  await expect
    .poll(() =>
      page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return true;
        } catch {
          return false;
        }
      }, oldUrl),
    )
    .toBe(false);
});

it.each(['dispose', 'refresh'] as const)(
  'keeps a new document image source when an old document %s runs',
  async (action) => {
    await page.evaluate(() => (window as any).fixture.editor.destroy());
    await expect.poll(() => active.size).toBe(0);
    await page.evaluate((action) => {
      const image = document.createElement('img');
      image.id = 'transferred-image';
      document.body.append(image);
      let oldSource = '/api/assets/adopted-old';
      const stopOld = (window as any).fixture.trackImageRequest(image, () => ({ src: oldSource }));
      const frame = document.createElement('iframe');
      frame.id = 'image-document';
      document.body.append(frame);
      const nextDocument = frame.contentDocument!;
      nextDocument.body.append(nextDocument.adoptNode(image));
      (window as any).fixture.trackImageRequest(image, () => ({ src: '/api/assets/adopted-new' }));
      if (action === 'dispose') stopOld();
      else {
        oldSource = '/api/assets/stale-after-move';
        stopOld.refresh();
      }
    }, action);
    await expect
      .poll(() =>
        page.frameLocator('#image-document').locator('img').getAttribute('data-dooknow-image-src'),
      )
      .toBe('/api/assets/adopted-new');
    await page
      .frameLocator('#image-document')
      .locator('img')
      .evaluate((image) => {
        if ((image as HTMLImageElement).naturalWidth === 1) return;
        return new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(Error('new document image failed')), {
            once: true,
          });
        });
      });
    expect(
      await page
        .frameLocator('#image-document')
        .locator('img')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(1);
  },
);

it('retains a shared image URL until its final owner in the original document is removed', async () => {
  await page.evaluate(() => (window as any).fixture.editor.destroy());
  await expect.poll(() => active.size).toBe(0);
  await page.evaluate(() => {
    for (const id of ['transferred-image', 'retained-image']) {
      const image = document.createElement('img');
      image.id = id;
      document.body.append(image);
      (window as any).fixture.trackImageRequest(image, () => ({
        src: '/api/assets/shared-doc-image',
      }));
    }
  });
  await page.waitForFunction(() =>
    ['transferred-image', 'retained-image'].every(
      (id) => document.querySelector<HTMLImageElement>('#' + id)?.naturalWidth === 1,
    ),
  );
  const oldUrl = await page.locator('#retained-image').getAttribute('src');
  expect(oldUrl).toMatch(/^blob:/);
  expect(await page.locator('#transferred-image').getAttribute('src')).toBe(oldUrl);
  expect(requestedPaths.filter((path) => path === '/api/assets/shared-doc-image').length).toBe(1);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'image-document';
    document.body.append(frame);
    const nextDocument = frame.contentDocument!;
    const image = nextDocument.adoptNode(
      document.querySelector<HTMLImageElement>('#transferred-image')!,
    );
    nextDocument.body.append(image);
    (window as any).fixture.trackImageRequest(image, () => ({ src: null }));
  });
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(await page.locator('#retained-image').getAttribute('src')).toBe(oldUrl);
  expect(
    await page
      .locator('#retained-image')
      .evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBe(1);
  expect(await page.evaluate(async (url) => (await fetch(url!)).ok, oldUrl)).toBe(true);
  expect(await page.frameLocator('#image-document').locator('img').getAttribute('src')).toBe(null);
  await page.locator('#retained-image').evaluate((image) => image.remove());
  await expect
    .poll(() =>
      page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return true;
        } catch {
          return false;
        }
      }, oldUrl),
    )
    .toBe(false);
});
