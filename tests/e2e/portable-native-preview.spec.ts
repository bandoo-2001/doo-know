import { test, expect } from '../support/browser-test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, extname, isAbsolute, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import MarkdownIt from 'markdown-it';
import { emptyWhiteboard } from '../../shared/whiteboard';
import {
  renderPreparedDiagramDocument,
  diagramRendererVersions,
} from '../../shared/diagram-primary';
import { parseDiagramDocument } from '../../shared/diagram-document';
import { extractArchive } from '../../apps/server/platform/archive';
import { exportOwnerWhiteboardPng } from '../support/owner-whiteboard-png';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
test.setTimeout(120000);
test('owner resumes a persisted native portable preview, reads it offline without DooKnow, and reimports the complete directory', async ({
  page,
  context,
  browser,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = (await (await page.request.get('/api/security/csrf')).json()).token,
    origin = new URL(page.url()).origin,
    headers = { origin, 'x-csrf-token': csrf };
  async function post(url: string, data: unknown) {
    const response = await page.request.post(url, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const name = 'portable-native-' + randomUUID(),
    child = await post('/api/notes', {
      folderPath: '00-Inbox',
      fileName: name + '-child.md',
      content: '# Offline native target\n',
      requestId: randomUUID(),
    }),
    intent = await post('/api/diagram-documents/intents', {
      path: '00-Inbox/' + name + '.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    });
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [
      {
        id: 'native-link',
        type: 'rectangle',
        x: 20,
        y: 20,
        width: 200,
        height: 90,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: '#dbeafe',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: 'a0',
        roundness: { type: 3 },
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: origin + '/?note=' + child.id + '#target',
        locked: false,
      },
    ],
  });
  const renderBoard = await post('/api/notes', {
    folderPath: '00-Inbox',
    fileName: name + '-render.excalidraw',
    content: source,
    requestId: randomUUID(),
  });
  const pngBase64 = (await exportOwnerWhiteboardPng(page, renderBoard.id)).toString('base64');
  const removed = await page.request.delete('/api/notes/' + renderBoard.id, {
    headers,
    data: { expectedModifiedAt: renderBoard.modifiedAt, requestId: randomUUID() },
  });
  expect(removed.ok(), await removed.text()).toBe(true);
  const prepared = await post('/api/diagram-documents/prepare', {
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source,
      sourceHash: hash(source),
      title: 'Native portable',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64,
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({
      prepared,
      title: 'Native portable',
      source,
      description: 'Portable native offline description\n',
    }),
    note = await post('/api/diagram-documents/commit', {
      preparedId: prepared.id,
      markdown,
      requestId: randomUUID(),
    });
  await page.goto('/?note=' + note.id);
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  // Lose one preparation request: the owner must recover from persisted structured needs.
  await page.route('**/api/portable-previews/*/prepare', (route) => route.abort('failed'));
  const failedPrepare = page.waitForEvent('requestfailed', (request) =>
    /\/api\/portable-previews\/[^/]+\/prepare$/.test(new URL(request.url()).pathname),
  );
  await workspace.getByRole('button', { name: '导出便携文件', exact: true }).click();
  await failedPrepare;
  await page.unroute('**/api/portable-previews/*/prepare');
  await page.goto('/?view=settings&section=library');
  const receipts = page.getByRole('region', { name: '便携任务与结果' });
  await expect(receipts).toContainText('待生成 1 张便携图形预览');
  const article = receipts.locator('article').first();
  await expect(article).toContainText(name + '.md');
  await article.getByRole('button', { name: '生成预览并继续导出', exact: true }).click();
  await expect(article).toContainText('已完成', { timeout: 60000 });
  const pending = page.waitForEvent('download');
  await article.getByRole('link', { name: '下载便携结果' }).click();
  const download = await pending,
    artifacts = resolve('.local/markdown-diagrams/portable-native-desktop');
  await mkdir(artifacts, { recursive: true });
  const archive = join(artifacts, 'native-export.tar.gz');
  await download.saveAs(archive);
  const temporary = await mkdtemp(join(tmpdir(), 'portable-native-offline-')),
    directory = join(temporary, 'standalone');
  await mkdir(directory);
  await extractArchive(archive, directory);
  let server: ReturnType<typeof createServer> | undefined,
    offlineContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const exported = await readFile(join(directory, note.relativePath), 'utf8'),
      parsed = parseDiagramDocument(exported);
    expect(parsed.status).toBe('diagram');
    if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw')
      throw Error('native document');
    const sourcePath = posix.normalize(
        posix.join(
          posix.dirname(note.relativePath),
          decodeURIComponent(parsed.primary.source.path),
        ),
      ),
      finalSource = await readFile(join(directory, sourcePath), 'utf8'),
      link = JSON.parse(finalSource).elements[0].link;
    expect(finalSource).not.toContain(child.id);
    expect(link).toContain(name + '-child.md#target');
    expect(parsed.primary.binding.sourceHash).toBe(hash(finalSource));
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(markdown);
    const vanilla = new MarkdownIt({ html: true });
    server = createServer(async (req, res) => {
      try {
        const path = resolve(
            directory,
            '.' + decodeURIComponent(new URL(req.url!, 'http://offline.invalid').pathname),
          ),
          part = relative(directory, path);
        if (!part || part.startsWith('..') || isAbsolute(part)) {
          res.writeHead(403).end();
          return;
        }
        const bytes = await readFile(path),
          extension = extname(path);
        res.setHeader(
          'Content-Type',
          extension === '.md'
            ? 'text/html; charset=utf-8'
            : extension === '.png'
              ? 'image/png'
              : 'application/octet-stream',
        );
        res.end(
          extension === '.md'
            ? '<!doctype html><meta charset="utf-8"><body>' + vanilla.render(bytes.toString())
            : bytes,
        );
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((yes) => server!.listen(0, '127.0.0.1', yes));
    const offlineOrigin = 'http://127.0.0.1:' + (server.address() as any).port;
    offlineContext = await browser.newContext({ serviceWorkers: 'block' });
    const forbidden: string[] = [];
    await offlineContext.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== offlineOrigin || url.pathname.startsWith('/api/')) {
        forbidden.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    const offline = await offlineContext.newPage();
    await offline.goto(offlineOrigin + '/' + note.relativePath);
    await expect(offline.locator('body')).toContainText('Portable native offline description');
    await expect
      .poll(() =>
        offline
          .locator('img')
          .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 10),
      )
      .toBe(true);
    await expect(offline.locator('script')).toHaveCount(0);
    await offline.screenshot({ path: join(artifacts, 'plain-reader.png'), fullPage: true });
    const nativeTarget = posix.normalize(posix.join(posix.dirname(sourcePath), link.split('#')[0]));
    await offline.goto(offlineOrigin + '/' + nativeTarget);
    await expect(offline.locator('body')).toContainText('Offline native target');
    expect(forbidden).toEqual([]);
    await page.getByRole('button', { name: '导入便携包', exact: true }).click();
    await page.locator('#portable-directory').setInputFiles(directory);
    const destination = '00-Inbox/reimport-native-' + Date.now();
    await page.locator('#portable-archive-folder').fill(destination);
    await page.getByRole('button', { name: '导入整包', exact: true }).click();
    await expect(page.getByText('导入完成：2 篇笔记，2 个附件。')).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: join(artifacts, 'owner-reimport.png'), fullPage: true });
    const jobs = await (await page.request.get('/api/portable-jobs')).json(),
      imported = jobs.find(
        (job: any) => job.kind === 'import-directory' && job.folderPath === destination,
      );
    expect(imported.state).toBe('completed');
    const importedMain = imported.result.notes.find(
      (item: any) => item.sourcePath === note.relativePath,
    );
    const resource = await (
      await page.request.get('/api/notes/' + importedMain.noteId + '/diagram')
    ).json();
    expect(resource.source.hash).toBe(hash(finalSource));
    expect(resource.preview.state).toBe('ready');
    await info.attach('portable-native-offline', {
      body: JSON.stringify({
        sourceHash: hash(finalSource),
        main: note.relativePath,
        nativeTarget,
        importedId: importedMain.noteId,
        forbiddenRequests: forbidden,
      }),
      contentType: 'application/json',
    });
  } finally {
    await offlineContext?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((yes) => server!.close(() => yes()));
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
