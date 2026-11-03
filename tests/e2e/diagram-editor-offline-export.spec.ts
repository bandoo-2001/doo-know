import { test, expect } from '../support/browser-test';
import type { BrowserContext, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { extractArchive } from '../../apps/server/platform/archive';
import type { DiagramDocumentType } from '../../shared/diagram-document';
import type { DiagramResource } from '../../shared/diagram-resource';
import type { NoteDocument } from '../../shared/contracts';
import type { PortableManifest } from '../../packages/core/portable-delivery/manifest';
import { clickNoteAction } from '../support/note-actions';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifacts = resolve('.local/markdown-diagrams/real-editor-offline');
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);

async function createAndEdit(page: Page, type: DiagramDocumentType, label: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建' + label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill('offline-' + type + '-' + randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const id = new URL(page.url()).searchParams.get('note')!;
  const initial = (await (
    await page.request.get('/api/notes/' + id + '/diagram')
  ).json()) as DiagramResource;
  if (type === 'whiteboard') {
    const canvas = workspace.locator('canvas.interactive');
    await expect(canvas).toBeVisible({ timeout: 30000 });
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: 200, y: 180 } });
    await page.keyboard.press('r');
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55 + 110, box.y + box.height * 0.4 + 85, {
      steps: 8,
    });
    await page.mouse.up();
  } else if (type === 'mindmap') {
    const root = workspace.locator('me-root me-tpc');
    await root.click();
    await page.keyboard.press('F2');
    await workspace.locator('#input-box').fill('真实离线脑图根');
    await page.keyboard.press('Enter');
    await root.click();
    await page.keyboard.press('Tab');
    await workspace.locator('#input-box').fill('真实离线脑图子节点');
    await page.keyboard.press('Enter');
    await expect(
      workspace.locator('me-tpc').filter({ hasText: /^真实离线脑图子节点$/ }),
    ).toBeVisible();
  } else {
    await workspace.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('flowchart TD\nA[真实离线开始] --> B[真实离线完成]\n');
  }
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await workspace.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  const description = '真实编辑后离线说明-' + type + '。';
  await page.keyboard.insertText('\n\n' + description + '\n');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const note = (await (await page.request.get('/api/notes/' + id)).json()) as NoteDocument;
  const resource = (await (
    await page.request.get('/api/notes/' + id + '/diagram')
  ).json()) as DiagramResource;
  expect(note.content).toContain(description);
  expect(resource.preview?.state).toBe('ready');
  expect(resource.preview?.hash).not.toBe(initial.preview?.hash);
  if (type === 'whiteboard') {
    const scene = JSON.parse(resource.source.content!);
    expect(
      scene.elements.some(
        (element: any) =>
          element.type === 'rectangle' &&
          !element.isDeleted &&
          element.width > 10 &&
          element.height > 10,
      ),
    ).toBe(true);
  } else if (type === 'mindmap') {
    expect(resource.title).toBe('真实离线脑图根');
    expect(resource.source.content).toContain('真实离线脑图子节点');
  } else expect(resource.source.content).toContain('真实离线开始');
  return { note, resource, description, workspace };
}

async function plainServer(root: string) {
  // Deliberately the vanilla renderer: no DooKnow Markdown plugin or application runtime.
  const markdown = new MarkdownIt({ html: true });
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url || '/', 'http://offline.invalid').pathname,
      );
      const file = resolve(root, '.' + pathname);
      const local = relative(root, file);
      if (!local || local.startsWith('..') || isAbsolute(local)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(file);
      const extension = extname(file).toLowerCase();
      response.setHeader(
        'Content-Type',
        extension === '.md'
          ? 'text/html; charset=utf-8'
          : extension === '.png'
            ? 'image/png'
            : 'application/octet-stream',
      );
      response.end(
        extension === '.md'
          ? '<!doctype html><html><meta charset="utf-8"><title>Standalone plain Markdown</title><body>' +
              markdown.render(bytes.toString('utf8')) +
              '</body></html>'
          : bytes,
      );
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
  return { server, origin: 'http://127.0.0.1:' + (server.address() as AddressInfo).port };
}

for (const [type, label] of [
  ['whiteboard', '白板'],
  ['mindmap', '脑图'],
  ['flowchart', '流程图'],
] as const) {
  test(`真实 ${label} 编辑导出后换目录，在禁止访问DooKnow的普通Markdown浏览器加载正文和原PNG`, async ({
    page,
    browser,
  }, info) => {
    const { note, resource, description, workspace } = await createAndEdit(page, type, label);
    const sourceOrigin = new URL(page.url()).origin;
    const downloading = page.waitForEvent('download');
    await clickNoteAction(page, '下载完整文档');
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/);
    await mkdir(artifacts, { recursive: true });
    const archive = join(artifacts, type + '.tar.gz');
    await download.saveAs(archive);
    const temporary = await mkdtemp(join(tmpdir(), 'dooknow-real-editor-offline-'));
    let server: Server | undefined, context: BrowserContext | undefined;
    try {
      const extracted = join(temporary, 'extracted');
      await mkdir(extracted);
      await extractArchive(archive, extracted);
      const moved = join(temporary, '另一个目录 空格 (relocated)');
      await rename(extracted, moved);
      const manifest = JSON.parse(
        await readFile(join(moved, 'dooknow-portable.json'), 'utf8'),
      ) as PortableManifest;
      expect(manifest.selected).toHaveLength(1);
      const documentPath = manifest.selected[0];
      const markdown = await readFile(join(moved, documentPath), 'utf8');
      expect(markdown).toContain(description);
      const previews = [];
      for (const file of manifest.files.filter(
        (file) => file.kind === 'asset' && file.path.endsWith('.png'),
      )) {
        if (sha256(await readFile(join(moved, file.path))) === resource.preview!.hash)
          previews.push(file.path);
      }
      expect(previews).toHaveLength(1);
      const standalone = await plainServer(moved);
      server = standalone.server;
      context = await browser.newContext({ serviceWorkers: 'block' });
      expect(await context.cookies()).toEqual([]);
      const forbidden: string[] = [],
        sourceRequests: string[] = [];
      context.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin === sourceOrigin || url.pathname.startsWith('/api/'))
          sourceRequests.push(url.href);
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== standalone.origin || url.pathname.startsWith('/api/')) {
          forbidden.push(url.href);
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      const offline = await context.newPage();
      await offline.goto(
        standalone.origin + '/' + documentPath.split('/').map(encodeURIComponent).join('/'),
      );
      await expect(offline.locator('body')).toContainText(description);
      await expect(offline.locator('script')).toHaveCount(0);
      const image = offline.locator('img');
      await expect(image).toHaveCount(1);
      await expect
        .poll(async () =>
          image.evaluate(
            (node: HTMLImageElement) =>
              node.complete && node.naturalWidth > 1 && node.naturalHeight > 1,
          ),
        )
        .toBe(true);
      const dimensions = await image.evaluate((node: HTMLImageElement) => ({
        width: node.naturalWidth,
        height: node.naturalHeight,
        source: node.currentSrc,
      }));
      expect(decodeURIComponent(new URL(dimensions.source).pathname).slice(1)).toBe(previews[0]);
      expect(sourceRequests).toEqual([]);
      expect(forbidden).toEqual([]);
      await offline.screenshot({ path: join(artifacts, type + '.png'), fullPage: true });
      const evidence = {
        type,
        noteId: note.id,
        archivedDocument: documentPath,
        previewHash: resource.preview!.hash,
        loadedPreview: previews[0],
        width: dimensions.width,
        height: dimensions.height,
        description,
        sourceOriginRequests: sourceRequests.length,
        forbiddenOriginOrApiRequests: forbidden.length,
        renderer: 'vanilla markdown-it without DooKnow plugins',
      };
      await writeFile(join(artifacts, type + '.json'), JSON.stringify(evidence, null, 2) + '\n');
      await info.attach('standalone-offline-evidence', {
        body: JSON.stringify(evidence),
        contentType: 'application/json',
      });
    } finally {
      await context?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done, reject) =>
          server!.close((error) => (error ? reject(error) : done())),
        );
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
