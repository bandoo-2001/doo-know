import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { extractArchive } from '../apps/server/platform/archive';
import { emptyWhiteboard } from '../shared/whiteboard';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=', 'base64');
const svg = '<?xml version="1.0"?>\r\n<!-- 导出必须保留原始设计 -->\r\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><path d="M0 0H64V32Z"/></svg>';
const mermaid = 'flowchart TD\r\nA[设计源] --> B[PNG]\r\n';

describe('portable diagram artifact transfers', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let serial = 0;
  beforeAll(async () => { f = await createFixture(); headers = await loginFixtureOwner(f); });
  afterAll(async () => f?.close());
  const post = (url: string, payload: unknown) => f.app.inject({ method: 'POST', url, headers, payload: payload as any });
  async function settle(id: string) {
    for (let n = 0; n < 200; n++) {
      const task = (await f.app.inject({ url: '/api/manage/tasks/' + id, headers })).json();
      if (!['queued', 'running'].includes(task.state)) return task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('transfer did not settle');
  }
  it.each([
    ['svg', svg],
    ['mermaid', mermaid],
    ['excalidraw', JSON.stringify({ ...emptyWhiteboard(), dooknow: { id: '01234567-1234-1234-1234-0123456789ab' } }, null, 2)],
  ])('exports and reimports %s source and PNG with collision-renamed relative references', async (kind, source) => {
    const folderPath = `00-Inbox/portable-${++serial}`;
    await mkdir(join(f.knowledgeRoot, folderPath));
    const created = await post('/api/notes', { folderPath, fileName: 'parent.md', content: '# 可携带图形' });
    expect(created.statusCode, created.body).toBe(201);
    const n = created.json();
    const prepared = await post(`/api/notes/${n.id}/diagram-artifacts`, {
      kind, source, sourceHash: createHash('sha256').update(source).digest('hex'),
      pngBase64: png.toString('base64'), requestId: randomUUID(),
    });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const group = prepared.json();
    const markdown = `# 可携带图形\r\n\r\n![预览](${group.preview.markdownPath})\r\n\r\n[设计源](${group.source.markdownPath})\r\n`;
    await writeFile(join(f.knowledgeRoot, n.relativePath), markdown);
    const started = await post('/api/manage/export', { folderPath, requestId: randomUUID() });
    expect(started.statusCode, started.body).toBe(202);
    const exported = await settle(started.json().id);
    expect(exported.state, JSON.stringify(exported)).toBe('succeeded');
    expect(exported.result).toMatchObject({ notes: 1, assets: 2, warnings: [] });
    const download = await f.app.inject({ url: `/api/manage/tasks/${exported.id}/download`, headers });
    expect(download.statusCode).toBe(200);
    const archive = join(f.root, `portable-${serial}.tar.gz`), output = join(f.root, `portable-${serial}`);
    await writeFile(archive, download.rawPayload);
    await mkdir(output);
    await extractArchive(archive, output);
    expect(await readFile(join(output, n.relativePath), 'utf8')).toBe(markdown);
    expect(await readFile(join(output, group.source.relativePath), 'utf8')).toBe(source);
    expect((await readFile(join(output, group.preview.relativePath))).equals(png)).toBe(true);
    const entries = await Promise.all([n.relativePath, group.source.relativePath, group.preview.relativePath].map(async path => ({
      path: posix.relative(folderPath, path), encoding: 'base64',
      content: (await readFile(join(output, path))).toString('base64'),
    })));
    const request = { folderPath, entries, collision: 'rename', requestId: randomUUID() };
    const preview = await post('/api/manage/import/preview', request);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().items.filter((item: any) => item.kind === 'asset')).toHaveLength(2);
    const importStarted = await post('/api/manage/import', request);
    expect(importStarted.statusCode, importStarted.body).toBe(202);
    const imported = await settle(importStarted.json().id);
    expect(imported.state, JSON.stringify(imported)).toBe('succeeded');
    expect(imported.result).toMatchObject({ notes: 1, assets: 2 });
    const parent = imported.items.find((item: any) => item.kind === 'note');
    const copiedSource = imported.items.find((item: any) => item.path === group.source.markdownPath);
    const copiedPng = imported.items.find((item: any) => item.path === group.preview.markdownPath);
    expect(parent.targetPath).toBe(folderPath + '/parent (2).md');
    expect(copiedSource.kind).toBe('asset');
    expect(copiedSource).not.toHaveProperty('noteId');
    const copiedMarkdown = await readFile(join(f.knowledgeRoot, parent.targetPath), 'utf8');
    for (const item of [copiedSource, copiedPng]) {
      expect(item.targetPath).toContain(' (2).');
      const relative = posix.relative(posix.dirname(parent.targetPath), item.targetPath).split('/').map(encodeURIComponent).join('/');
      expect(copiedMarkdown).toContain(`](${relative})`);
    }
    expect(await readFile(join(f.knowledgeRoot, copiedSource.targetPath), 'utf8')).toBe(source);
    expect((await readFile(join(f.knowledgeRoot, copiedPng.targetPath))).equals(png)).toBe(true);
    expect(await readFile(join(f.knowledgeRoot, group.source.relativePath), 'utf8')).toBe(source);
  });

  it.each([
    ['assets/bad.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
    ['assets/remote.svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.test/x.png"/></svg>'],
    ['assets/bad.excalidraw', '{}'],
    ['assets/bad.mmd', '\u0000not textual'],
    ['assets/remote.mmd', 'flowchart TD\nA@{img: "https://invalid.test/x.png"}'],
    ['assets/../escape.excalidraw', JSON.stringify(emptyWhiteboard())],
  ])('rejects unsafe or incorrectly typed imported source %s before queueing', async (path, content) => {
    const response = await post('/api/manage/import', {
      folderPath: '00-Inbox', collision: 'rename', requestId: randomUUID(),
      entries: [{ path, encoding: 'utf8', content }],
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('resumes an already written SVG source using original bytes rather than its presentation', async () => {
    const folderPath = `00-Inbox/queued-${++serial}`;
    await mkdir(join(f.knowledgeRoot, folderPath));
    const response = await post('/api/manage/import', {
      folderPath, collision: 'rename', requestId: randomUUID(),
      entries: [{ path: 'assets/source.svg', encoding: 'utf8', content: svg }],
    });
    expect(response.statusCode, response.body).toBe(202);
    // Reproduce a crash after the immutable file write but before task progress persisted.
    mkdirSync(join(f.knowledgeRoot, folderPath, 'assets'), { recursive: true });
    writeFileSync(join(f.knowledgeRoot, folderPath, 'assets/source.svg'), svg, { flag: 'wx' });
    const completed = await settle(response.json().id);
    expect(completed.state, JSON.stringify(completed)).toBe('succeeded');
    expect(completed.result).toMatchObject({ notes: 0, assets: 1 });
    expect(await readFile(join(f.knowledgeRoot, folderPath, 'assets/source.svg'), 'utf8')).toBe(svg);
  });
});
