import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function multipart(
  files: [string, string][],
  requestId = randomUUID(),
  folderPath = '00-Inbox/imported',
) {
  const boundary = 'portable-' + randomUUID();
  const fields = [
    ['requestId', requestId],
    ['folderPath', folderPath],
  ].map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    contentType: 'multipart/form-data; boundary=' + boundary,
    payload:
      fields.join('') +
      files
        .map(
          ([path, content]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`,
        )
        .join('') +
      `--${boundary}--\r\n`,
  };
}
function bundle() {
  const content = '# Whole directory\n';
  const manifest = JSON.stringify({
    format: 'dooknow-portable',
    version: 1,
    files: [
      {
        path: 'notes/a.md',
        kind: 'document',
        sizeBytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
    selected: ['notes/a.md'],
  });
  return [
    ['dooknow-portable.json', manifest],
    ['notes/a.md', content],
  ] as [string, string][];
}
it('uploads a whole directory, persists its completed receipt and replays the actual request id', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f),
    requestId = randomUUID(),
    body = multipart(bundle(), requestId);
  const submit = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/portable-deliveries/import-directory',
      headers: { ...headers, 'content-type': body.contentType },
      payload: body.payload,
    });
  const response = await submit();
  expect(response.statusCode).toBe(201);
  const result = response.json();
  expect(result.notes).toHaveLength(1);
  expect((await submit()).json()).toEqual(result);
  const list = await f.app.inject({ url: '/api/portable-jobs', headers });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual([
    expect.objectContaining({ requestId, kind: 'import-directory', state: 'completed', result }),
  ]);
  const read = await f.app.inject({ url: '/api/portable-jobs/' + list.json()[0].id, headers });
  expect(read.json().result).toEqual(result);
  expect((await f.app.inject({ url: '/api/portable-jobs' })).statusCode).toBe(401);
});
it.each(['../escape.md', '/absolute.md', 'notes/../escape.md', 'notes\\escape.md', 'notes/A.md'])(
  'rejects unsafe or normalized-duplicate upload path %s without publishing notes',
  async (path) => {
    const f = await createFixture();
    closes.push(f.close);
    const headers = await loginFixtureOwner(f),
      body = multipart([...bundle(), [path, 'bad']]);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/portable-deliveries/import-directory',
      headers: { ...headers, 'content-type': body.contentType },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(
      (await f.app.inject({ url: '/api/tree', headers }))
        .json()
        .flatMap((x: any) => x.children || []),
    ).toEqual([]);
    const staging = join(f.dataRoot, 'portable-staging');
    expect(await readdir(staging).catch(() => [])).toEqual([]);
  },
);
it('keeps failed imports unresolved and requires the original upload for retry', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f),
    files = bundle();
  files[1][1] = 'tampered';
  const requestId = randomUUID(),
    body = multipart(files, requestId);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries/import-directory',
    headers: { ...headers, 'content-type': body.contentType },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(400);
  const list = (await f.app.inject({ url: '/api/portable-jobs', headers })).json();
  expect(list[0]).toMatchObject({
    requestId,
    state: 'failed',
    needsSource: true,
    error: 'PORTABLE_DIGEST_MISMATCH',
  });
  const retry = await f.app.inject({
    method: 'POST',
    url: '/api/portable-jobs/' + list[0].id + '/retry',
    headers,
    payload: {},
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json().code).toBe('PORTABLE_SOURCE_REQUIRED');
});
it('streams an actual HTTP directory upload and cancels then resumes its original request without duplicate notes', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address() as { port: number },
    url = 'http://127.0.0.1:' + address.port,
    requestId = randomUUID();
  const files = Array.from({ length: 80 }, (_, i) => ({
    path: 'notes/' + i + '.md',
    content: '# Note ' + i + '\n',
  }));
  const manifest = JSON.stringify({
    format: 'dooknow-portable',
    version: 1,
    files: files.map((file) => ({
      path: file.path,
      kind: 'document',
      sizeBytes: Buffer.byteLength(file.content),
      sha256: createHash('sha256').update(file.content).digest('hex'),
    })),
    selected: [files[0].path],
  });
  const body = () => {
    const data = new FormData();
    data.append('requestId', requestId);
    data.append('folderPath', '00-Inbox/resume');
    data.append('dooknow-portable.json', new Blob([manifest]), 'dooknow-portable.json');
    for (const file of files)
      data.append(file.path, new Blob([file.content]), file.path.split('/').at(-1)!);
    return data;
  };
  const pending = fetch(url + '/api/portable-deliveries/import-directory', {
    method: 'POST',
    headers,
    body: body(),
  });
  let job: any;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(url + '/api/portable-jobs', { headers });
    job = (await response.json()).find((job: any) => job.requestId === requestId);
    if (job?.state === 'running' && job.result?.notes.length > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(job?.state).toBe('running');
  expect(job.result.notes.length).toBeGreaterThan(0);
  const partialIds = job.result.notes.map((note: any) => note.noteId);
  const cancelled = await fetch(url + '/api/portable-jobs/' + job.id + '/cancel', {
    method: 'POST',
    headers,
  });
  expect(cancelled.status).toBe(200);
  expect((await pending).status).toBe(409);
  const receipt = await (await fetch(url + '/api/portable-jobs/' + job.id, { headers })).json();
  expect(receipt.state).toBe('cancelled');
  expect(receipt.needsSource).toBe(true);
  const retry = await fetch(url + '/api/portable-deliveries/import-directory', {
    method: 'POST',
    headers,
    body: body(),
  });
  expect(retry.status).toBe(201);
  const result = await retry.json();
  expect(result.notes).toHaveLength(80);
  expect(new Set(result.notes.map((n: any) => n.noteId)).size).toBe(80);
  expect(result.notes.map((note: any) => note.noteId)).toEqual(expect.arrayContaining(partialIds));
  expect(
    (await (await fetch(url + '/api/portable-jobs/' + job.id, { headers })).json()).state,
  ).toBe('completed');
}, 30000);

it('recovers completed and interrupted owner receipts after reopening the server', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f),
    body = multipart(bundle(), randomUUID());
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries/import-directory',
    headers: { ...headers, 'content-type': body.contentType },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(201);
  const job = (await f.app.inject({ url: '/api/portable-jobs', headers })).json()[0];
  const exported = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries',
    headers,
    payload: {
      selection: { kind: 'single', noteId: response.json().notes[0].noteId },
      requestId: randomUUID(),
    },
  });
  expect(exported.statusCode).toBe(201);
  const exportJob = (await f.app.inject({ url: '/api/portable-jobs', headers }))
    .json()
    .find((item: any) => item.kind === 'export');
  await f.app.close();
  const { openDatabase } = await import('../packages/core/db');
  const db = openDatabase(f.dataRoot);
  db.prepare(
    "UPDATE portable_owner_jobs SET state='running',result=NULL,pid=0,process_start='' WHERE id=?",
  ).run(job.id);
  db.prepare(
    "UPDATE portable_owner_jobs SET state='running',result=NULL,pid=0,process_start='' WHERE id=?",
  ).run(exportJob.id);
  const interruptedId = randomUUID();
  db.prepare(
    "INSERT INTO portable_owner_jobs SELECT ?,owner,?,'import-directory',input,'running',NULL,NULL,?,0,'',NULL FROM portable_owner_jobs WHERE id=?",
  ).run(interruptedId, randomUUID(), Date.now(), job.id);
  db.close();
  const { createApp } = await import('../apps/server/app');
  const reopened = await createApp(f.config);
  closes.push(() => reopened.close());
  const list = (await reopened.inject({ url: '/api/portable-jobs', headers })).json();
  expect(list.find((item: any) => item.id === job.id)).toMatchObject({
    state: 'completed',
    result: response.json(),
  });
  expect(list.find((item: any) => item.id === exportJob.id)).toMatchObject({
    state: 'completed',
    result: exported.json(),
  });
  expect(list.find((item: any) => item.id === interruptedId)).toMatchObject({
    state: 'interrupted',
    needsSource: true,
    error: 'PORTABLE_INTERRUPTED',
  });
});
it('serves only the actual owner fixed portable source and prepares its private matching preview without editing notes', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f);
  const { portablePreviewRegistry } = await import('../packages/core/portable-delivery/previews');
  const { webPrincipal } = await import('../packages/core/knowledge/core');
  const { openDatabase } = await import('../packages/core/db'),
    db = openDatabase(f.dataRoot);
  closes.push(async () => {
    db.close();
  });
  const owner = db.prepare('SELECT id FROM user LIMIT 1').get() as { id: string },
    p = { ...webPrincipal, id: owner.id, clientId: 'portable-owner' },
    registry = portablePreviewRegistry(f.config, db),
    source = '{"type":"excalidraw","elements":[]}',
    hash = createHash('sha256').update(source).digest('hex');
  const need = registry.fix(p, {
    direction: 'export',
    requestId: 'owner-native',
    contextHash: hash,
    document: '00-Inbox/board.md',
    role: 'primary',
    source,
    type: 'whiteboard',
    title: 'board',
    renderer: 'excalidraw@0.18.1+dooknow@1',
    config: {},
    permissions: ['00-Inbox/board.md'],
    proofs: [],
  });
  const response = await f.app.inject({ url: '/api/portable-previews/' + need.previewId, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ source, sourceHash: hash });
  expect(response.body).not.toContain(f.config.dataRoot);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
  const prepare = await f.app.inject({
    method: 'POST',
    url: '/api/portable-previews/' + need.previewId + '/prepare',
    headers,
    payload: { sourceHash: hash, pngBase64: png, requestId: 'owner-render' },
  });
  expect(prepare.statusCode).toBe(200);
  expect(registry.prepared(p, need.previewId)).toBeDefined();
  const injected = await f.app.inject({
    method: 'POST',
    url: '/api/portable-previews/' + need.previewId + '/prepare',
    headers,
    payload: {
      sourceHash: hash,
      pngBase64: png,
      requestId: 'owner-render',
      source: 'client-chosen',
    },
  });
  expect(injected.statusCode).toBe(400);
  expect(
    db.prepare('SELECT count(*) n FROM notes WHERE path=?').get('00-Inbox/board.md'),
  ).toMatchObject({ n: 0 });
});
it('review: streams a file-first 252 MiB owner archive across data/knowledge filesystems with its export retained', async () => {
  const { mkdtemp, mkdir, open, rm, stat } = await import('node:fs/promises'),
    { createReadStream, statSync } = await import('node:fs'),
    { Readable } = await import('node:stream'),
    { randomFillSync } = await import('node:crypto');
  const knowledge = await mkdtemp(join(process.cwd(), '.local/portable-owner-cross-'));
  closes.push(() => rm(knowledge, { recursive: true, force: true }));
  await mkdir(join(knowledge, '00-Inbox/_doo-assets'), { recursive: true });
  const f = await createFixture({ knowledgeRoot: knowledge });
  closes.push(f.close);
  const headers = await loginFixtureOwner(f),
    { openDatabase } = await import('../packages/core/db'),
    db = openDatabase(f.dataRoot);
  closes.push(async () => {
    db.close();
  });
  const { noteService } = await import('../packages/core/notes'),
    { mutationCore, webPrincipal } = await import('../packages/core/knowledge/core'),
    { portableDeliveryService } = await import('../packages/core/portable-delivery/service'),
    notes = noteService(f.config, db),
    core = portableDeliveryService(f.config, db, notes),
    owner = (db.prepare('SELECT id FROM user LIMIT 1').get() as { id: string }).id,
    p = { ...webPrincipal, id: owner, clientId: 'portable-owner' };
  const size = 126 * 1024 ** 2,
    chunk = Buffer.alloc(65536);
  for (const name of ['owner-a.wav', 'owner-b.wav']) {
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(size - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(size - 44, 40);
    const file = await open(join(knowledge, '00-Inbox/_doo-assets', name), 'wx');
    try {
      await file.write(header);
      for (let at = 44; at < size; at += chunk.length)
        await file.write(randomFillSync(chunk.subarray(0, Math.min(chunk.length, size - at))));
    } finally {
      await file.close();
    }
  }
  const note = mutationCore(f.config, db).create(
      p,
      '00-Inbox',
      'owner-max.md',
      '[a](_doo-assets/owner-a.wav)\n[b](_doo-assets/owner-b.wav)',
      randomUUID(),
    ),
    delivery = await core.create(p, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
    archive = (
      db.prepare('SELECT artifact FROM portable_deliveries WHERE id=?').get(delivery.id) as {
        artifact: string;
      }
    ).artifact;
  expect(delivery.sizeBytes).toBeGreaterThan(252 * 1024 ** 2);
  expect(delivery.sizeBytes).toBeLessThan(256 * 1024 ** 2);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (f.app.server.address() as { port: number }).port,
    folder = '00-Inbox/owner-cross',
    requestId = randomUUID(),
    boundary = 'owner-large-' + randomUUID(),
    prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="documents.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    ),
    suffix = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="folderPath"\r\n\r\n${folder}\r\n--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId}\r\n--${boundary}--\r\n`,
    );
  let peak = 0,
    sawTargetStage = false;
  const observer = setInterval(() => {
    const staged = (
        db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any
      ).n,
      retained = (
        db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries').get() as any
      ).n;
    peak = Math.max(peak, staged + retained);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='portable_staging_locations'").get())
      return;
    for (const row of db.prepare('SELECT directory FROM portable_staging_locations').all() as {
      directory: string;
    }[]) {
      try {
        expect(row.directory.startsWith(join(knowledge, folder) + '/')).toBe(true);
        expect(statSync(row.directory).dev).toBe(statSync(knowledge).dev);
        sawTargetStage = true;
      } catch (error) {
        if ((error as any).code !== 'ENOENT') throw error;
      }
    }
  }, 5);
  try {
    async function* body() {
      yield prefix;
      for await (const bytes of createReadStream(archive)) yield bytes;
      yield suffix;
    }
    const response = await fetch(
        `http://127.0.0.1:${port}/api/portable-deliveries/import?folderPath=${encodeURIComponent(folder)}&requestId=${requestId}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'content-length': String(prefix.length + delivery.sizeBytes + suffix.length),
          },
          body: Readable.from(body()),
          duplex: 'half',
        } as any,
      ),
      result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result).toMatchObject({
      assets: 2,
      notes: expect.arrayContaining([
        expect.objectContaining({ sourcePath: '00-Inbox/owner-max.md' }),
      ]),
    });
  } finally {
    clearInterval(observer);
  }
  expect(sawTargetStage).toBe(true);
  expect(peak).toBeLessThanOrEqual(512 * 1024 ** 2);
  expect(core.validate(p, delivery.id).sha256).toBe(delivery.sha256);
  expect(db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({ n: 0 });
  expect(db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
    n: 0,
  });
  const { hashFile } = await import('../packages/core/portable-delivery/manifest');
  for (const name of ['owner-a.wav', 'owner-b.wav'])
    expect(await hashFile(join(knowledge, folder, '00-Inbox/_doo-assets', name))).toBe(
      await hashFile(join(knowledge, '00-Inbox/_doo-assets', name)),
    );
}, 90000);
it('review: preserves legacy small file-first archive uploads and rejects mismatched early context before publication', async () => {
  const f = await createFixture();
  closes.push(f.close);
  const headers = await loginFixtureOwner(f),
    { mkdir, writeFile, readFile } = await import('node:fs/promises'),
    { create } = await import('tar'),
    root = join(f.root, 'small-archive');
  await mkdir(join(root, 'notes'), { recursive: true });
  for (const [path, content] of bundle()) await writeFile(join(root, path), content);
  const archive = join(f.root, 'small.tar.gz');
  await create({ file: archive, cwd: root, gzip: true }, ['notes/a.md', 'dooknow-portable.json']);
  const bytes = await readFile(archive),
    boundary = 'legacy-' + randomUUID(),
    requestId = randomUUID(),
    folder = '00-Inbox/legacy-file-first',
    head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="documents.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    ),
    tail = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="folderPath"\r\n\r\n${folder}\r\n--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId}\r\n--${boundary}--\r\n`,
    ),
    payload = Buffer.concat([head, bytes, tail]);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries/import',
    headers: { ...headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(response.json().notes).toHaveLength(1);
  const mismatch = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries/import?folderPath=00-Inbox%2Fother&requestId=' + requestId,
    headers: { ...headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload,
  });
  expect(mismatch.statusCode).toBe(400);
  const tree = (await f.app.inject({ url: '/api/tree', headers })).json();
  expect(JSON.stringify(tree)).not.toContain('00-Inbox/other');
});
