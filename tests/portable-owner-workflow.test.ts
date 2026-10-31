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
    "INSERT INTO portable_owner_jobs SELECT ?,owner,?,'import-directory',input,'running',NULL,NULL,?,0,'' FROM portable_owner_jobs WHERE id=?",
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
