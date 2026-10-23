import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createApp } from '../apps/server/app';
import { openDatabase } from '../packages/core/db';
import { emptyWhiteboard } from '../shared/whiteboard';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const svg = '<?xml version="1.0"?>\r\n<!-- 源稿 -->\r\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><path d="M0 0H64V32Z"/></svg>';
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
const body = (kind = 'svg', source = svg, preview = png, requestId = randomUUID()) => ({
  kind, source, sourceHash: hash(source), pngBase64: preview.toString('base64'), requestId,
});

describe('immutable diagram source and PNG groups', () => {
  let f: Fixture;
  let app: Awaited<ReturnType<typeof createApp>>;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let serial = 0;
  beforeAll(async () => {
    f = await createFixture();
    app = f.app;
    headers = await loginFixtureOwner(f);
  });
  afterAll(async () => {
    if (app !== f.app) await app.close();
    await f?.close();
  });
  async function note(whiteboard = false) {
    const folderPath = `00-Inbox/group-${++serial}`;
    await mkdir(join(f.knowledgeRoot, folderPath));
    const response = await app.inject({
      method: 'POST', url: '/api/notes', headers,
      payload: { folderPath, fileName: whiteboard ? 'working.excalidraw' : 'parent.md',
        content: whiteboard ? JSON.stringify(emptyWhiteboard()) : '# 未提交的父笔记不应被修改\r\n' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }
  const post = (id: string, payload: unknown) => app.inject({
    method: 'POST', url: `/api/notes/${id}/diagram-artifacts`, headers, payload: payload as any,
  });
  const get = async (id: string) => (await app.inject({ url: `/api/notes/${id}`, headers })).json();

  it.each([
    ['svg', svg, '.svg', 'image/svg+xml'],
    ['mermaid', 'flowchart TD\r\n  A[原始设计] --> B[PNG]\r\n', '.mmd', 'text/plain'],
    ['excalidraw', JSON.stringify(emptyWhiteboard(), null, 2), '.excalidraw', 'application/vnd.excalidraw+json'],
  ])('prepares %s source bytes and PNG without saving the parent or working design', async (kind, source, ext, mime) => {
    const n = await note(kind === 'excalidraw');
    const before = await get(n.id);
    const response = await post(n.id, body(kind, source));
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json();
    expect(result.sourceHash).toBe(hash(source));
    expect(result.preview).toMatchObject({ mime: 'image/png' });
    expect(result.source).toMatchObject({ mime });
    expect(result.source.markdownPath).toMatch(new RegExp('^assets/[^/]+\\' + ext + '$'));
    expect(await readFile(join(f.knowledgeRoot, result.source.relativePath), 'utf8')).toBe(source);
    expect((await readFile(join(f.knowledgeRoot, result.preview.relativePath))).equals(png)).toBe(true);
    expect(await get(n.id)).toEqual(before);
    const download = await app.inject({ url: `/api/assets/${result.source.id}?download=1`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(download.rawPayload.equals(Buffer.from(source))).toBe(true);
    if (kind !== 'svg') {
      const sourceResponse = await app.inject({ url: `/api/assets/${result.source.id}`, headers });
      expect(sourceResponse.headers['content-disposition']).toMatch(/^attachment;/);
      expect(sourceResponse.headers['content-type']).toBe('application/octet-stream');
    }
  });

  it('replays receipts across restart and refuses changed source or PNG for the same request', async () => {
    const n = await note(), input = body();
    const first = await post(n.id, input);
    expect(first.statusCode, first.body).toBe(201);
    expect((await post(n.id, input)).json()).toEqual(first.json());
    expect((await post(n.id, body('svg', svg.replace('64V32', '32V32'), png, input.requestId))).statusCode).toBe(409);
    const changedPng = Buffer.concat([png, Buffer.from('different')]);
    expect((await post(n.id, body('svg', svg, changedPng, input.requestId))).statusCode).toBe(409);
    await app.close();
    app = await createApp(f.config);
    const replay = await post(n.id, input);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect((await app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json()).toHaveLength(2);
  });

  it('retains partial immutable files and completes the original request after a failed registration and restart', async () => {
    const n = await note(), input = body(), before = await get(n.id);
    const db = openDatabase(f.dataRoot);
    db.exec("CREATE TRIGGER fixture_png_failure BEFORE INSERT ON assets WHEN NEW.path LIKE '%.png' BEGIN SELECT RAISE(FAIL, 'fixture png registration failure'); END");
    const failed = await post(n.id, input);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).not.toHaveProperty('preview');
    expect(await get(n.id)).toEqual(before);
    const assetsPath = join(f.knowledgeRoot, n.relativePath.replace(/[^/]+$/, 'assets'));
    const prepared = await readdir(assetsPath);
    expect(prepared.filter(path => path.endsWith('.svg'))).toHaveLength(1);
    expect(prepared.filter(path => path.endsWith('.png'))).toHaveLength(1);
    db.exec('DROP TRIGGER fixture_png_failure');
    db.close();
    await app.close();
    app = await createApp(f.config);
    const completed = await post(n.id, input);
    expect(completed.statusCode, completed.body).toBe(201);
    expect(await readdir(assetsPath)).toEqual(prepared);
    expect((await post(n.id, input)).json()).toEqual(completed.json());
    expect(await get(n.id)).toEqual(before);
  });

  it('refuses a completed receipt whose source file was externally changed without overwriting it', async () => {
    const n = await note(), input = body();
    const first = await post(n.id, input);
    expect(first.statusCode, first.body).toBe(201);
    const changed = svg.replace('64V32', '16V32');
    const path = join(f.knowledgeRoot, first.json().source.relativePath);
    await writeFile(path, changed);
    const retry = await post(n.id, input);
    expect(retry.statusCode, retry.body).toBe(409);
    expect(await readFile(path, 'utf8')).toBe(changed);
  });

  it('rebases replayed artifact references when the parent moved before inserting its references', async () => {
    const n = await note(), input = body(), before = await get(n.id);
    const first = await post(n.id, input);
    expect(first.statusCode, first.body).toBe(201);
    const original = first.json(), folderPath = `00-Inbox/moved-${++serial}`;
    await mkdir(join(f.knowledgeRoot, folderPath));
    const moved = await app.inject({
      method: 'POST', url: `/api/notes/${n.id}/move`, headers,
      payload: { folderPath, fileName: 'parent.md', expectedModifiedAt: before.modifiedAt, requestId: randomUUID() },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const movedNote = await get(n.id);
    const replay = await post(n.id, input);
    expect(replay.statusCode, replay.body).toBe(201);
    const group = replay.json();
    for (const key of ['source', 'preview']) {
      expect(group[key]).toMatchObject({ id: original[key].id, relativePath: original[key].relativePath });
      expect(group[key].markdownPath).toBe(posix.relative(folderPath, original[key].relativePath));
    }
    expect((await readFile(join(f.knowledgeRoot, folderPath, group.preview.markdownPath))).equals(png)).toBe(true);
    expect(await readFile(join(f.knowledgeRoot, folderPath, group.source.markdownPath), 'utf8')).toBe(input.source);
    expect(await get(n.id)).toEqual(movedNote);
    const content = `${movedNote.content}\n\n![preview](${group.preview.markdownPath})\n\n[source](${group.source.markdownPath})\n`;
    const saved = await app.inject({ method: 'PUT', url: `/api/notes/${n.id}`, headers,
      payload: { content, expectedModifiedAt: movedNote.modifiedAt, requestId: randomUUID() } });
    expect(saved.statusCode, saved.body).toBe(200);
    const token = (await app.inject({ method: 'POST', url: `/api/notes/${n.id}/share`, headers, payload: {} })).json().token;
    for (const asset of [group.source, group.preview])
      expect((await app.inject({ url: `/api/public/shares/${token}/assets/${asset.id}` })).statusCode).toBe(200);
  });

  it.each([
    ['unbound hash', () => ({ ...body(), sourceHash: '0'.repeat(64) }), 400],
    ['script SVG', () => body('svg', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 400],
    ['remote SVG', () => body('svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.test/a.png"/></svg>'), 400],
    ['remote Mermaid image', () => body('mermaid', 'flowchart TD\nA@{ img: "https://invalid.test/a.png" }'), 400],
    ['long Mermaid', () => body('mermaid', 'A'.repeat(50_001)), 413],
    ['invalid whiteboard', () => body('excalidraw', '{"type":"excalidraw","elements":[]}'), 400],
    ['remote whiteboard file', () => body('excalidraw', JSON.stringify({ ...emptyWhiteboard(), files: { x: { id: 'x', mimeType: 'image/png', dataURL: 'https://invalid.test/a.png' } } })), 400],
    ['fake PNG', () => body('svg', svg, Buffer.from('not PNG')), 400],
    ['signature without IHDR', () => body('svg', svg, png.subarray(0, 8)), 400],
    ['truncated PNG', () => body('svg', svg, png.subarray(0, -12)), 400],
    ['zero-width PNG', () => { const bytes = Buffer.from(png); bytes.writeUInt32BE(0, 16); return body('svg', svg, bytes); }, 400],
    ['invalid PNG color type', () => { const bytes = Buffer.from(png); bytes[25] = 255; return body('svg', svg, bytes); }, 400],
    ['wide PNG', () => { const bytes = Buffer.from(png); bytes.writeUInt32BE(8193, 16); return body('svg', svg, bytes); }, 400],
    ['large PNG area', () => { const bytes = Buffer.from(png); bytes.writeUInt32BE(8192, 16); bytes.writeUInt32BE(8192, 20); return body('svg', svg, bytes); }, 400],
    ['over-limit PNG', () => body('svg', svg, Buffer.concat([png, Buffer.alloc(10 * 1024 ** 2)])), 413],
    ['bad base64', () => ({ ...body(), pngBase64: 'not base64!' }), 400],
    ['unknown kind', () => body('html', '<script/>'), 400],
  ])('rejects %s without publishing files or changing the parent', async (_name, input, status) => {
    const n = await note(), before = await get(n.id);
    const response = await post(n.id, input());
    expect(response.statusCode, response.body).toBe(status);
    expect(await get(n.id)).toEqual(before);
    expect((await app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json()).toEqual([]);
  });

  it('requires login, origin and CSRF for artifact creation', async () => {
    const n = await note();
    for (const [requestHeaders, status] of [
      [{}, 401],
      [{ cookie: headers.cookie, origin: headers.origin }, 403],
      [{ ...headers, origin: 'https://invalid.test' }, 403],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/notes/${n.id}/diagram-artifacts`, headers: requestHeaders, payload: body() });
      expect(response.statusCode).toBe(status);
    }
  });

  it('authorizes source and PNG only through current saved public references and survives an offline directory copy', async () => {
    const n = await note(), input = body('excalidraw', JSON.stringify(emptyWhiteboard()));
    const response = await post(n.id, input);
    expect(response.statusCode, response.body).toBe(201);
    const group = response.json();
    const share = async (reset = false) => (await app.inject({ method: 'POST', url: `/api/notes/${n.id}/share${reset ? '/reset' : ''}`, headers, payload: {} })).json().token;
    const token = await share();
    for (const asset of [group.preview, group.source]) {
      expect((await app.inject({ url: `/api/assets/${asset.id}` })).statusCode).toBe(401);
      expect((await app.inject({ url: `/api/public/shares/${token}/assets/${asset.id}` })).statusCode).toBe(404);
    }
    const markdown = `# 兼容设计\n\n![预览](${group.preview.markdownPath})\n\n[源文件](${group.source.markdownPath})\n`;
    await writeFile(join(f.knowledgeRoot, n.relativePath), markdown);
    for (const asset of [group.preview, group.source])
      expect((await app.inject({ url: `/api/public/shares/${token}/assets/${asset.id}` })).statusCode).toBe(200);
    const copy = join(f.root, 'offline-copy');
    await cp(join(f.knowledgeRoot, n.relativePath.replace(/\/[^/]+$/, '')), copy, { recursive: true });
    expect(await readFile(join(copy, 'parent.md'), 'utf8')).toBe(markdown);
    expect((await readFile(join(copy, group.preview.markdownPath))).equals(png)).toBe(true);
    expect(await readFile(join(copy, group.source.markdownPath), 'utf8')).toBe(input.source);
    const replacement = await share(true);
    for (const asset of [group.preview, group.source])
      expect((await app.inject({ url: `/api/public/shares/${token}/assets/${asset.id}` })).statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/api/notes/${n.id}/share`, headers });
    for (const asset of [group.preview, group.source])
      expect((await app.inject({ url: `/api/public/shares/${replacement}/assets/${asset.id}` })).statusCode).toBe(404);
  });
});
