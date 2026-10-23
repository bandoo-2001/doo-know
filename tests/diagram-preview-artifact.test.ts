import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { diagramFences } from '../shared/diagram-fences';
import {
  hashDiagramSource,
  assertGeneratedSvgSafe,
  preparePreview,
  previewDimensions,
} from '../apps/web/diagrams/preview-artifact';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3b82f6"/></svg>';

it('records the exact SVG fence line while retaining ordinary code fences', () => {
  const md = new MarkdownIt().use(diagramFences);
  const html = md.render('正文\n\n```svg\n' + svg + '\n```\n\n```text\nordinary\n```');
  expect(html).toContain('data-diagram="svg"');
  expect(html).toContain('data-source-line="3"');
  expect(html).toContain(encodeURIComponent(svg + '\n'));
  expect(html).toContain('<pre><code class="language-text">ordinary\n</code></pre>');
});

it('rejects dimensions before allocating an oversized preview canvas', () => {
  expect(previewDimensions(80.2, 40.1)).toEqual({ width: 81, height: 41 });
  expect(previewDimensions(8192, 2048)).toEqual({ width: 8192, height: 2048 });
  expect(previewDimensions(4096, 4096)).toEqual({ width: 4096, height: 4096 });
  for (const [width, height] of [
    [0, 40],
    [80, -1],
    [NaN, 20],
    [Infinity, 40],
    [8193, 1],
    [4097, 4097],
  ])
    expect(() => previewDimensions(width, height)).toThrow(/尺寸|像素/);
});

it('binds the preview to the exact UTF-8 source using an asynchronous SHA-256 digest', async () => {
  expect(await hashDiagramSource('hello')).toBe(
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  expect(await hashDiagramSource('hello\n')).not.toBe(await hashDiagramSource('hello\r\n'));
});

it('refuses unsafe SVG before touching the browser rasterizer', async () => {
  await expect(
    preparePreview({
      kind: 'svg',
      source:
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://outside.invalid/pixel"/></svg>',
    }),
  ).rejects.toThrow(/SVG/);
});

it('refuses Mermaid image directives before its renderer can fetch a resource', async () => {
  await expect(
    preparePreview({
      kind: 'mermaid',
      source: 'flowchart LR\nA@{ img: "https://outside.invalid/pixel" }',
      svg,
    }),
  ).rejects.toThrow(/资源|安全|不支持/);
});

it.each([
  '<image href="https://outside.invalid/pixel"/>',
  '<a href="//outside.invalid"><text>link</text></a>',
  '<style>.node{fill:url(https://outside.invalid/pixel)}</style>',
  '<style>@import "https://outside.invalid/font.css";</style>',
  '<style>.node{fill:u\\72l(https://outside.invalid/pixel)}</style>',
  '<rect style="fill: url(&quot;https://outside.invalid/pixel&quot;)"/>',
  '<g xml:base="https://outside.invalid"><use href="#picture"/></g>',
  '<style>.node{fill:u<![CDATA[rl]]>(/outside/pixel)}</style>',
  '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>',
  '<script>alert(1)</script>',
])('refuses rendered Mermaid resources before creating an image: %s', async (body) => {
  await expect(
    preparePreview({
      kind: 'mermaid',
      source: 'graph TD\nA-->B',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">${body}</svg>`,
    }),
  ).rejects.toThrow(/资源|安全|不支持/);
});

it('allows self-contained generated font data without treating base64 slashes as an outside URL', () => {
  expect(
    assertGeneratedSvgSafe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><style>@font-face{font-family:Board;src:url(data:font/woff2;base64,////)}</style></svg>',
      true,
    ),
  ).toEqual({ width: 80, height: 40 });
});

describe('real browser preview preparation and diagram lifecycle', () => {
  let server: ViteDevServer, browser: Browser, page: Page, origin: string, cache: string;
  beforeAll(async () => {
    cache = await mkdtemp('/var/tmp/dooknow-editor-improvements/diagram-fixture-');
    server = await createServer({
      configFile: false,
      root: process.cwd(),
      cacheDir: join(cache, 'cache'),
      plugins: [
        vue(),
        {
          name: 'diagram-test-page',
          resolveId(id) {
            if (id === 'virtual:diagram-fixture') return '\0diagram-fixture';
          },
          load(id) {
            if (id !== '\0diagram-fixture') return;
            return `
              import {createApp, reactive, h} from 'vue';
              import DiagramPreview from '/apps/web/components/DiagramPreview.vue';
              import WhiteboardWorkspace from '/apps/web/components/WhiteboardWorkspace.vue';
              import * as artifacts from '/apps/web/diagrams/preview-artifact.ts';
              const props=reactive({kind:'svg',code:${JSON.stringify(svg)},noteId:'fixture-note',readOnly:false,editable:true,shareToken:undefined});
              const events=[];
              window.addEventListener('dooknow-portable-diagram',e=>events.push(e.detail));
              window.addEventListener('dooknow-edit-diagram-source',e=>events.push(e.detail));
              window.addEventListener('dooknow-portable-whiteboard',e=>events.push(e.detail));
              const app=createApp({render:()=>h(DiagramPreview,props)});app.mount('#app');
              window.fixture={props,artifacts,events,dispose:()=>app.unmount(),
                mountBoard(id){app.unmount();createApp(WhiteboardWorkspace,{boardId:id}).mount('#app');}};
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/__diagram_fixture', (_request, response) => {
              response.setHeader('content-type', 'text/html');
              response.end(
                '<!doctype html><html><body><div id="app"></div><script type="module" src="/@id/__x00__diagram-fixture"></script></body></html>',
              );
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null },
      optimizeDeps: {
        entries: [],
        noDiscovery: true,
        include: [
          'vue',
          'dompurify',
          'saxes',
          'ant-design-vue',
          'react',
          'react-dom/client',
          '@excalidraw/excalidraw',
          'mermaid',
          '@excalidraw/mermaid-to-excalidraw',
        ],
      },
      logLevel: 'error',
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Diagram fixture did not bind a port');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (cache) await rm(cache, { recursive: true, force: true });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    page.setDefaultTimeout(6000);
    await page.goto(origin + '/__diagram_fixture', { timeout: 30_000 });
    try {
      await page.waitForFunction(() => !!(window as any).fixture);
    } catch (error) {
      throw Error(`${(error as Error).message}\n${errors.join('\n')}`);
    }
  });
  afterEach(async () => {
    await page?.close();
  });

  it('exports a real PNG from validated SVG with matching dimensions and source hash', async () => {
    const result = await page.evaluate(async () => {
      const f = (window as any).fixture;
      const artifact = await f.artifacts.preparePreview({ kind: 'svg', source: f.props.code });
      const bitmap = await createImageBitmap(artifact.preview);
      return {
        kind: artifact.kind,
        hash: artifact.sourceHash,
        type: artifact.preview.type,
        signature: [...new Uint8Array(await artifact.preview.arrayBuffer()).slice(0, 8)],
        width: bitmap.width,
        height: bitmap.height,
      };
    });
    expect(result).toMatchObject({
      kind: 'svg',
      type: 'image/png',
      width: 80,
      height: 40,
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
    });
    expect(result.hash).toBe(await hashDiagramSource(svg));
  });

  it('revokes the rasterizer URL when PNG encoding fails', async () => {
    const result = await page.evaluate(async () => {
      const f = (window as any).fixture;
      const original = HTMLCanvasElement.prototype.toBlob;
      const revoke = URL.revokeObjectURL.bind(URL);
      const revoked: string[] = [];
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        revoke(url);
      };
      HTMLCanvasElement.prototype.toBlob = function () {
        throw new DOMException('tainted', 'SecurityError');
      };
      let message = '';
      try {
        await f.artifacts.preparePreview({ kind: 'svg', source: f.props.code });
      } catch (error) {
        message = (error as Error).message;
      } finally {
        HTMLCanvasElement.prototype.toBlob = original;
        URL.revokeObjectURL = revoke;
      }
      return { message, revoked };
    });
    expect(result.message).toMatch(/PNG|预览|tainted/);
    expect(result.revoked).toHaveLength(1);
    expect(result.revoked[0]).toMatch(/^blob:/);
  });

  it('renders Mermaid and exports its generated self-contained SVG to PNG', async () => {
    await page.evaluate(() => {
      Object.assign((window as any).fixture.props, {
        kind: 'mermaid',
        code: 'flowchart LR\nA[开始] --> B[完成]',
      });
    });
    await browserExpect(page.locator('.diagram-image > svg')).toBeVisible({ timeout: 30_000 });
    await browserExpect(page.locator('.diagram-image')).toContainText('开始');
    await browserExpect(
      page.getByRole('button', { name: '转换为白板', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '生成通用预览', exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => (window as any).fixture.events.length))
      .toBe(1);
    expect(await page.evaluate(() => (window as any).fixture.events[0].png.type)).toBe('image/png');
  }, 60_000);

  it('exports an Excalidraw scene through its own PNG exporter and keeps its source JSON', async () => {
    const content = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'rectangle', type: 'rectangle', x: 0, y: 0, width: 80, height: 40 }],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    });
    await page.evaluate((source) => {
      Object.assign((window as any).fixture.props, {
        kind: 'excalidraw',
        code: 'board.excalidraw\n',
        scene: source,
      });
    }, content);
    await browserExpect(page.locator('.diagram-image > svg')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '生成通用预览', exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => (window as any).fixture.events.length))
      .toBe(1);
    expect(
      await page.evaluate(() => {
        const event = (window as any).fixture.events[0];
        return {
          kind: event.kind,
          code: event.code,
          sourceContent: event.sourceContent,
          type: event.png.type,
        };
      }),
    ).toEqual({
      kind: 'excalidraw',
      code: 'board.excalidraw\n',
      sourceContent: content,
      type: 'image/png',
    });
  }, 60_000);

  it('prepares a standalone whiteboard snapshot without saving or closing its workspace', async () => {
    const boardId = '10000000-0000-4000-8000-000000000001';
    const source = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [],
      appState: {},
      files: {},
    });
    const writes: string[] = [];
    await page.route('**/api/notes/**', async (route) => {
      if (route.request().method() !== 'GET') {
        writes.push(route.request().method());
        return route.abort();
      }
      return route.fulfill({
        json: {
          id: boardId,
          title: '设计',
          relativePath: '设计.excalidraw',
          content: source,
          modifiedAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:00.000Z',
          documentType: 'whiteboard',
        },
      });
    });
    await page.evaluate((id) => (window as any).fixture.mountBoard(id), boardId);
    const workspace = page.getByTestId('whiteboard-workspace');
    await browserExpect(workspace.locator('.whiteboard-status')).toHaveText('已保存', {
      timeout: 30_000,
    });
    await workspace.getByRole('button', { name: '生成 Markdown 预览笔记', exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => (window as any).fixture.events.length))
      .toBe(1);
    const result = await page.evaluate(() => {
      const event = (window as any).fixture.events[0];
      return { boardId: event.boardId, type: event.png.type, scene: JSON.parse(event.content) };
    });
    expect(result).toMatchObject({
      boardId,
      type: 'image/png',
      scene: { type: 'excalidraw', elements: [] },
    });
    await browserExpect(workspace).toBeVisible();
    await browserExpect(workspace.locator('.whiteboard-status')).toHaveText('已保存');
    expect(writes).toEqual([]);
  }, 60_000);

  it('keeps source view separate and exposes explicit editing and preview events', async () => {
    await page.evaluate(() => {
      Object.assign((window as any).fixture.props, { sourceId: 'fence-two', sourceLine: 17 });
    });
    await browserExpect(page.locator('.diagram-image')).toBeVisible();
    await page.getByRole('button', { name: '源码', exact: true }).click();
    expect(await page.locator('.diagram-source').textContent()).toBe(svg);
    await page.getByRole('button', { name: '编辑源码', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixture.events[0])).toEqual({
      kind: 'svg',
      code: svg,
      noteId: 'fixture-note',
      sourceId: 'fence-two',
      sourceLine: 17,
    });
    await page.getByRole('button', { name: '生成通用预览', exact: true }).click();
    await expect
      .poll(async () => page.evaluate(() => (window as any).fixture.events.length))
      .toBe(2);
    const event = await page.evaluate(async () => {
      const event = (window as any).fixture.events[1];
      return { ...event, png: { type: event.png.type, size: event.png.size } };
    });
    expect(event).toMatchObject({
      kind: 'svg',
      code: svg,
      noteId: 'fixture-note',
      sourceId: 'fence-two',
      sourceLine: 17,
      png: { type: 'image/png' },
    });
    expect(event.png.size).toBeGreaterThan(8);
    expect(event).not.toHaveProperty('sourceContent');
  });

  it('keeps rejected SVG as source without starting outside requests', async () => {
    const outside: string[] = [];
    await page.route('**/outside.invalid/**', (route) => {
      outside.push(route.request().url());
      return route.abort();
    });
    const unsafe =
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://outside.invalid/pixel"/></svg>';
    await page.evaluate((code) => {
      (window as any).fixture.props.code = code;
    }, unsafe);
    await browserExpect(page.getByRole('alert')).toContainText(/SVG/);
    await page.getByRole('button', { name: '源码', exact: true }).click();
    expect(await page.locator('.diagram-source').textContent()).toBe(unsafe);
    expect(outside).toEqual([]);
    await browserExpect(page.getByRole('button', { name: '编辑源码', exact: true })).toBeEnabled();
  });

  it('hides write actions for both read-only notes and public shares', async () => {
    await page.evaluate(() => {
      (window as any).fixture.props.editable = false;
    });
    await browserExpect(
      page.getByRole('button', { name: '生成通用预览', exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).fixture.props.readOnly = true;
    });
    await browserExpect(page.getByRole('button', { name: '编辑源码', exact: true })).toHaveCount(0);
    await browserExpect(
      page.getByRole('button', { name: '生成通用预览', exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => {
      Object.assign((window as any).fixture.props, { readOnly: false, shareToken: 'public-share' });
    });
    await browserExpect(page.getByRole('button', { name: '编辑源码', exact: true })).toHaveCount(0);
    await browserExpect(
      page.getByRole('button', { name: '生成通用预览', exact: true }),
    ).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: '源码', exact: true })).toBeVisible();
  });

  it('releases the displayed SVG Blob URL when its card is disposed', async () => {
    const result = await page.evaluate(() => {
      const src = document.querySelector('.diagram-image img')!.getAttribute('src');
      const original = URL.revokeObjectURL.bind(URL),
        revoked: string[] = [];
      URL.revokeObjectURL = (value) => {
        revoked.push(value);
        original(value);
      };
      (window as any).fixture.dispose();
      return { src, revoked };
    });
    expect(result.src).toMatch(/^blob:/);
    expect(result.revoked).toContain(result.src);
  });

  it('drops an old PNG completion when the fence changes during encoding', async () => {
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      (window as any).releasePng = undefined;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        const canvas = this;
        (window as any).releasePng = () => original.call(canvas, callback, type, quality);
      };
    });
    await page.getByRole('button', { name: '生成通用预览', exact: true }).click();
    await page.waitForFunction(() => !!(window as any).releasePng);
    await page.evaluate(() => {
      (window as any).fixture.props.code =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>';
    });
    await page.locator('.diagram-image').waitFor();
    await page.evaluate(() => (window as any).releasePng());
    await browserExpect(
      page.getByRole('button', { name: '生成通用预览', exact: true }),
    ).toBeEnabled();
    expect(await page.evaluate(() => (window as any).fixture.events)).toEqual([]);
  });
});
