import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname, delimiter } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { webPrincipal } from '../packages/core/knowledge/core';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { renderPreparedDiagramDocument, diagramRendererVersions } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
import { portableDeliveryService } from '../packages/core/portable-delivery/service';
import { extractArchive } from '../apps/server/platform/archive';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
it('reads real relocated delivery in a plain Markdown browser with the source library offline and no DooKnow requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-offline-acceptance-')),
    config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'http://localhost',
      secret: 'fixture-only',
    };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    assets = assetService(config, db, notes),
    primary = primaryDiagramService(config, db, notes, assets, webPrincipal),
    delivery = portableDeliveryService(config, db, notes);
  let server: ReturnType<typeof createServer> | undefined,
    browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const ids: string[] = [];
    for (const type of ['whiteboard', 'mindmap', 'flowchart'] as const) {
      const intent = diagramCreationService(config, db, webPrincipal).reserve({
          path: `00-Inbox/${type}.md`,
          type,
          requestId: randomUUID(),
        }),
        source =
          type === 'whiteboard'
            ? JSON.stringify(emptyWhiteboard())
            : type === 'mindmap'
              ? '- 离线脑图节点\n'
              : 'flowchart TD\n A[开始] --> B[完成]\n';
      const prepared = primary.prepare({
        target: { kind: 'creation', intentId: intent.id },
        type,
        title: type + ' 中文标题',
        source,
        sourceHash: sha256(source),
        renderer: diagramRendererVersions[type],
        config: {},
        pngBase64: png.toString('base64'),
        requestId: randomUUID(),
      });
      primary.commit({
        preparedId: prepared.id,
        markdown: renderPreparedDiagramDocument({
          prepared,
          title: prepared.title,
          source,
          description: '离线阅读正文。\n',
        }),
        requestId: randomUUID(),
      });
      ids.push(intent.noteId);
    }
    const output = await delivery.create(webPrincipal, {
        selection: { kind: 'multiple', noteIds: ids },
        requestId: randomUUID(),
      }),
      stream = await delivery.download(webPrincipal, output.id),
      archive = join(root, 'complete.tar.gz');
    const { pipeline } = await import('node:stream/promises'),
      { createWriteStream } = await import('node:fs');
    await pipeline(stream, createWriteStream(archive));
    const extracted = join(root, 'extracted');
    await mkdir(extracted);
    await extractArchive(archive, extracted);
    const moved = join(root, '另一个目录 空格 (offline)');
    await rename(extracted, moved);
    await rename(config.knowledgeRoot, join(root, 'inactive-source-library'));
    const parser = new MarkdownIt({ html: true });
    server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url || '/', 'http://offline.invalid').pathname),
          file = resolve(moved, '.' + path);
        if (!file.startsWith(moved + '/')) {
          res.writeHead(403).end();
          return;
        }
        const bytes = await readFile(file);
        res.setHeader(
          'Content-Type',
          extname(file) === '.md'
            ? 'text/html; charset=utf-8'
            : extname(file) === '.png'
              ? 'image/png'
              : 'application/octet-stream',
        );
        res.end(
          extname(file) === '.md'
            ? `<!doctype html><meta charset="utf-8"><title>离线</title>${parser.render(bytes.toString('utf8'))}`
            : bytes,
        );
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((yes) => server!.listen(0, '127.0.0.1', yes));
    const port = (server.address() as any).port,
      origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env },
      libs = resolve('.local/browser-deps/root/usr/lib/x86_64-linux-gnu');
    if (existsSync(libs))
      env.LD_LIBRARY_PATH = libs + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
    browser = await chromium.launch({ env });
    const context = await browser.newContext(),
      blocked: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith('/api/')) {
        blocked.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    for (const name of await readdir(join(moved, '00-Inbox'))) {
      if (!name.endsWith('.md')) continue;
      await page.goto(origin + '/00-Inbox/' + encodeURIComponent(name));
      expect(await page.locator('body').innerText()).toContain('离线阅读正文');
      expect(await page.locator('img').count()).toBeGreaterThan(0);
      await expect
        .poll(() =>
          page
            .locator('img')
            .evaluateAll((images) =>
              images.every(
                (img) =>
                  (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      expect(await page.locator('script').count()).toBe(0);
    }
    expect(blocked).toEqual([]);
    expect(existsSync(join(moved, 'dooknow-portable.json'))).toBe(true);
    await context.close();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>((yes) => server!.close(() => yes()));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
