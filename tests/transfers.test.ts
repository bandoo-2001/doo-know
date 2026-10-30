import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import { platformRuntime } from '../apps/server/platform/runtime.js';
import { registerTransferRoutes } from '../apps/server/platform/transfers.js';
import { restorePlatformBackup } from '../apps/server/platform/backups.js';
import { extractArchive } from '../apps/server/platform/archive.js';
import { rewriteImportReferences } from '../apps/server/platform/transfer-import.js';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'transfer-test-'));
  const config = {
    dataRoot: join(root, 'data'),
    knowledgeRoot: join(root, 'knowledge'),
    origin: 'http://localhost:3010',
    secret: 'fixture-transfer-secret-at-least-thirty-two-characters',
    indexing: { enabled: false, watch: false },
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  await initializeOwner(config, 'owner', testPassword);
  const db = openDatabase(config.dataRoot);
  const platform = platformRuntime(config, db);
  await platform.activate();
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 10 * 1024 ** 2, files: 1, fields: 0 } });
  app.addHook('onRequest', async (req) => {
    if (req.headers.authorization === 'fixture')
      (req as any).ownerId = (db.prepare('SELECT id FROM user').get() as any).id;
  });
  registerTransferRoutes(app, config, db, platform);
  const headers = { authorization: 'fixture' };
  const post = async (url: string, payload: any) =>
    app.inject({ method: 'POST', url, headers, payload });
  const get = async (url: string) => app.inject({ url, headers });
  const settle = async (id: string) => {
    for (let n = 0; n < 500; n++) {
      const task = (await get('/api/manage/tasks/' + id)).json();
      if (!['queued', 'running'].includes(task.state)) return task;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('timeout');
  };
  return {
    root,
    config,
    app,
    db,
    platform,
    post,
    get,
    settle,
    close: async () => {
      await app.close();
      await platform.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const body = (entries: any[], extra: any = {}) => ({
  entries,
  collision: 'rename',
  requestId: randomUUID(),
  ...extra,
});
const note = (path: string, content = '# Import') => ({ path, encoding: 'utf8', content });

describe('owner managed transfers', () => {
  it('validates every relative path and collision without overwriting; import replay is durable', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ url: '/api/manage/tasks' })).statusCode).toBe(401);
      for (const path of [
        '../escape.md',
        '%2e%2e/escape.md',
        '/tmp/escape.md',
        'foo\\bar.md',
        'a/../../escape.md',
      ])
        expect((await f.post('/api/manage/import/preview', body([note(path)]))).statusCode).toBe(
          400,
        );
      const request = body([note('first.md')]);
      const created = await f.post('/api/manage/import', request);
      expect(created.statusCode).toBe(202);
      const task = await f.settle(created.json().id);
      expect(task.state).toBe('succeeded');
      expect(task.items[0].targetPath).toBe('00-Inbox/first.md');
      expect((await f.post('/api/manage/import', request)).json().id).toBe(task.id);
      const changed = await f.post('/api/manage/import', {
        ...request,
        entries: [note('first.md', 'changed')],
      });
      expect(changed.statusCode).toBe(409);
      const preview = (await f.post('/api/manage/import/preview', body([note('first.md')]))).json();
      expect(preview.items[0]).toMatchObject({
        decision: 'rename',
        targetPath: '00-Inbox/first (2).md',
      });
      const skipped = await f.post(
        '/api/manage/import',
        body([note('first.md', 'NO')], { collision: 'skip' }),
      );
      expect((await f.settle(skipped.json().id)).items[0].state).toBe('skipped');
      expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/first.md'), 'utf8')).toBe(
        '# Import',
      );
      expect(
        (await f.post('/api/manage/export', { folderPath: '../', requestId: randomUUID() }))
          .statusCode,
      ).toBe(400);
    } finally {
      await f.close();
    }
  });
  it('preserves attachment and renamed note references in a portable bounded export', async () => {
    const f = await fixture();
    try {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const request = body([
        note('one.md', '![pic](assets/pic.png)\n[other](two.md)'),
        note('two.md'),
        { path: 'assets/pic.png', encoding: 'base64', content: png.toString('base64') },
      ]);
      let task = await f.post('/api/manage/import', request);
      expect((await f.settle(task.json().id)).state).toBe('succeeded');
      task = await f.post('/api/manage/import', body(request.entries));
      expect((await f.settle(task.json().id)).state).toBe('succeeded');
      expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/one (2).md'), 'utf8')).toContain(
        'assets/pic%20(2).png',
      );
      expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/one (2).md'), 'utf8')).toContain(
        'two%20(2).md',
      );
      const exported = await f.post('/api/manage/export', {
        folderPath: '00-Inbox',
        requestId: randomUUID(),
      });
      const done = await f.settle(exported.json().id);
      expect(done.state).toBe('succeeded');
      expect(done.result).toMatchObject({ notes: 4, assets: 2 });
      const download = await f.get('/api/manage/tasks/' + done.id + '/download');
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/gzip');
      const archive = join(f.root, 'portable.tar.gz'),
        extracted = join(f.root, 'exported');
      await writeFile(archive, download.rawPayload);
      await mkdir(extracted);
      await extractArchive(archive, extracted);
      expect(await readFile(join(extracted, '00-Inbox/assets/pic.png'))).toEqual(png);
      expect(await readFile(join(extracted, '00-Inbox/one (2).md'), 'utf8')).toContain(
        'assets/pic%20(2).png',
      );
      const manifest = JSON.parse(await readFile(join(extracted, 'dooknow-export.json'), 'utf8'));
      expect(manifest).toMatchObject({ notes: 4, assets: 2, scope: '00-Inbox' });
      expect(manifest.files.every((p: string) => !p.includes('sqlite'))).toBe(true);
      await symlink(f.root, join(f.config.knowledgeRoot, '00-Inbox', 'linked'));
      expect(
        (await f.post('/api/manage/import/preview', body([note('linked/escape.md')]))).statusCode,
      ).toBe(400);
    } finally {
      await f.close();
    }
  });
  it('cancels queued work and retries only unfinished items; records survive restart', async () => {
    const f = await fixture();
    try {
      const response = await f.post(
        '/api/manage/import',
        body(Array.from({ length: 60 }, (_, n) => note(n + '.md'))),
      );
      const cancelled = (
        await f.post('/api/manage/tasks/' + response.json().id + '/cancel', {})
      ).json();
      expect(cancelled.cancellable).toBe(false);
      let task = await f.settle(response.json().id);
      expect(task.state).toBe('cancelled');
      expect((await f.post('/api/manage/tasks/' + task.id + '/retry', {})).statusCode).toBe(202);
      task = await f.settle(task.id);
      expect(task.state).toBe('succeeded');
      expect(new Set(task.items.map((x: any) => x.targetPath)).size).toBe(60);
      expect(
        (await readdir(join(f.config.knowledgeRoot, '00-Inbox'))).filter((x) => x.endsWith('.md')),
      ).toHaveLength(60);
      await f.app.close();
      const second = Fastify();
      second.addHook('onRequest', async (req) => {
        (req as any).ownerId = (f.db.prepare('SELECT id FROM user').get() as any).id;
      });
      registerTransferRoutes(second, f.config, f.db, f.platform);
      expect((await second.inject({ url: '/api/manage/tasks/' + task.id })).json().state).toBe(
        'succeeded',
      );
      await second.close();
    } finally {
      await f.close();
    }
  });
  it('creates encrypted backups, requires password for binary key, restores verified isolated copies', async () => {
    const f = await fixture();
    try {
      await f.settle(
        (
          await f.post(
            '/api/manage/import',
            body([note('private.md', '# PRIVATE_FIXTURE_TRANSFER')]),
          )
        ).json().id,
      );
      const response = await f.post('/api/manage/backups', { requestId: randomUUID() });
      const backup = await f.settle(response.json().id);
      expect(backup.state).toBe('succeeded');
      const record = (await f.get('/api/manage/backups')).json().items[0];
      expect(record.encrypted).toBe(true);
      const download = await f.get('/api/manage/backups/' + record.id + '/download');
      expect(download.rawPayload.subarray(0, 10).toString()).toBe('DOOKNOWBK1');
      expect(download.rawPayload.includes(Buffer.from('PRIVATE_FIXTURE_TRANSFER'))).toBe(false);
      expect(
        (await f.post('/api/manage/backups/key', { currentPassword: 'wrong' })).statusCode,
      ).toBe(403);
      const key = await f.post('/api/manage/backups/key', { currentPassword: testPassword });
      expect(key.headers['content-type']).toContain('application/octet-stream');
      expect(key.body).toContain('PRIVATE KEY');
      const managedRoot = join(
        f.root,
        (await readdir(f.root)).find((p) => p.startsWith('.doo-know-transfers-'))!,
      );
      await expect(
        restorePlatformBackup({
          source: join(managedRoot, 'jobs', record.taskId, 'snapshot.dkb'),
          keyFile: join(managedRoot, 'keys/backup-key.pem'),
          target: {
            dataRoot: join(f.root, 'quota-copy/data'),
            knowledgeRoot: join(f.root, 'quota-copy/knowledge'),
            profileFile: join(f.root, 'quota-copy/config/profile.json'),
          },
          maxBytes: 1,
        }),
      ).rejects.toThrow('配额');
      const liveId = (f.db.prepare('SELECT id FROM notes WHERE active=1').get() as any).id;
      const restored = await f.post('/api/manage/restores', {
        backupId: record.id,
        requestId: randomUUID(),
      });
      const done = await f.settle(restored.json().id);
      expect(done.state).toBe('succeeded');
      expect(done.result.verification).toMatchObject({
        verified: true,
        notes: 1,
        activationRequired: true,
        sessionsRevoked: true,
      });
      expect(done.result.verification.dataRoot).not.toBe(f.config.dataRoot);
      expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/private.md'), 'utf8')).toContain(
        'PRIVATE_FIXTURE_TRANSFER',
      );
      expect((f.db.prepare('SELECT id FROM notes WHERE active=1').get() as any).id).toBe(liveId);
      const restoredDb = openDatabase(done.result.verification.dataRoot);
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
      restoredDb.close();
    } finally {
      await f.close();
    }
  }, 30000);
});

it('rewrites Unicode and reference-definition targets after rename while preserving link fragments', () => {
  const mapping = new Map([
    ['assets/照片.png', '00-Inbox/assets/照片 (2).png'],
    ['two.md', '00-Inbox/two (2).md'],
  ]);
  const source =
    '![照片](assets/照片.png)\n[second](two.md#part)\n![ref][picture]\n\n[picture]: assets/照片.png "title"';
  const content = rewriteImportReferences(source, 'one.md', '00-Inbox/one (2).md', mapping);
  expect(content).toContain('assets/%E7%85%A7%E7%89%87%20(2).png');
  expect(content).toContain('two%20(2).md#part');
  expect(content).toContain('[picture]: assets/%E7%85%A7%E7%89%87%20(2).png "title"');
});

it('restores independently uploaded encrypted backups without retaining uploaded keys', async () => {
  const f = await fixture();
  try {
    const task = await f.settle(
      (await f.post('/api/manage/backups', { requestId: randomUUID() })).json().id,
    );
    const encrypted = await f.get('/api/manage/backups/' + task.result.backupId + '/download');
    const key = await f.post('/api/manage/backups/key', { currentPassword: testPassword });
    const boundary = 'fixture-' + randomUUID();
    const rid = randomUUID();
    const chunks = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${rid}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="backup.dkb"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      encrypted.rawPayload,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="key"; filename="recovery.pem"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      key.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const uploaded = await f.app.inject({
      method: 'POST',
      url: '/api/manage/restores/upload',
      headers: {
        authorization: 'fixture',
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload: Buffer.concat(chunks),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    const restored = await f.settle(uploaded.json().id);
    expect(restored.state, JSON.stringify(restored)).toBe('succeeded');
    const records = (await f.get('/api/manage/backups')).json().items;
    const external = records.find((r: any) => r.external);
    expect(external.keyFingerprint).toHaveLength(64);
    expect(external.knowledgeIncluded).toBeUndefined();
    const storage = join(
      f.root,
      (await readdir(f.root)).find((p) => p.startsWith('.doo-know-transfers-'))!,
    );
    await expect(
      readFile(join(storage, 'jobs', restored.id, 'uploaded-key.pem')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const replay = await f.app.inject({
      method: 'POST',
      url: '/api/manage/restores/upload',
      headers: {
        authorization: 'fixture',
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload: Buffer.concat(chunks),
    });
    expect(replay.json().id).toBe(restored.id);
    const listing = (await f.get('/api/manage/tasks')).body;
    expect(listing).not.toContain('PRIVATE KEY');
    expect(listing).not.toContain('currentPassword');
  } finally {
    await f.close();
  }
}, 30000);

it('retries only failed import items and marks interrupted persisted jobs on startup', async () => {
  const f = await fixture();
  try {
    const request = body([note('already.md'), note('retry.md')]);
    const posted = await f.post('/api/manage/import', request);
    // Competing filesystem activity after preview must never be overwritten.
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox/retry.md'), '# Competing write');
    let task = await f.settle(posted.json().id);
    expect(task.state).toBe('failed');
    expect(task.items.map((i: any) => i.state)).toEqual(['succeeded', 'failed']);
    const succeededId = task.items[0].noteId;
    await rm(join(f.config.knowledgeRoot, '00-Inbox/retry.md'));
    // Watchers are disabled; reconcile the externally removed competing note before retry.
    f.platform.get().notes.scan();
    await f.post('/api/manage/tasks/' + task.id + '/retry', {});
    task = await f.settle(task.id);
    expect(task.state).toBe('succeeded');
    expect(task.items[0].noteId).toBe(succeededId);
    await f.app.close();
    f.db
      .prepare("UPDATE managed_transfer_jobs SET state='running',cancellable=1 WHERE id=?")
      .run(task.id);
    const second = Fastify();
    second.addHook('onRequest', async (req) => {
      (req as any).ownerId = (f.db.prepare('SELECT id FROM user').get() as any).id;
    });
    registerTransferRoutes(second, f.config, f.db, f.platform);
    const interrupted = (await second.inject({ url: '/api/manage/tasks/' + task.id })).json();
    expect(interrupted).toMatchObject({ state: 'interrupted', cancellable: false });
    await second.close();
  } finally {
    await f.close();
  }
});

it('enforces actual application owner, CSRF and origin checks on transfer and key endpoints', async () => {
  const { createFixture, loginFixtureOwner } = await import('./support/fixture.js');
  const f = await createFixture();
  try {
    expect((await f.app.inject({ url: '/api/manage/tasks' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/backups',
          headers: { cookie: headers.cookie, origin: headers.origin },
          payload: { requestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/import',
          headers: { ...headers, origin: 'https://other.invalid' },
          payload: body([note('forbidden.md')]),
        })
      ).statusCode,
    ).toBe(403);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/manage/import',
      headers,
      payload: body([note('allowed.md')]),
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(
      (await f.app.inject({ url: '/api/manage/tasks/' + response.json().id, headers })).statusCode,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

it('changes actual Markdown destinations while preserving fenced, indented and inline code examples byte for byte', () => {
  const source =
    '# Guide\n\n![real](assets/x.png)\n\n```md\n![example](assets/x.png)\n[picture]: assets/x.png\n```\n\n`[literal](assets/x.png)`\n\n    ![indented](assets/x.png)\n\nEscaped \\[example](assets/x.png)\n\n![reference][picture]\n\n[picture]: assets/x.png "caption"\n';
  const rewritten = rewriteImportReferences(
    source,
    'note.md',
    '00-Inbox/note.md',
    new Map([['assets/x.png', '00-Inbox/assets/x (2).png']]),
  );
  const expected = source
    .replace('![real](assets/x.png)', '![real](assets/x%20(2).png)')
    .replace('[picture]: assets/x.png "caption"', '[picture]: assets/x%20(2).png "caption"');
  expect(rewritten).toBe(expected);
});

it('clears an uploaded recovery key before publishing preparation failures', async () => {
  const { generateKeyPairSync, createHash } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  const f = await fixture();
  try {
    const key = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    const boundary = 'early-failure-fixture',
      rid = randomUUID();
    const payload = Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n' +
          rid +
          '\r\n--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="backup"; filename="backup.dkb"\r\nContent-Type: application/octet-stream\r\n\r\nDOOKNOWBK1-disposable-invalid-encrypted-fixture\r\n--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="key"; filename="recovery.pem"\r\nContent-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.from(key),
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/manage/restores/upload',
      headers: {
        authorization: 'fixture',
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(202);
    const taskDir = join(
      f.root,
      '.doo-know-transfers-' +
        createHash('sha256').update(f.config.dataRoot).digest('hex').slice(0, 16),
      'jobs',
      response.json().id,
    );
    writeFileSync(join(taskDir, 'restored'), 'disposable preparation obstruction');
    const failed = await f.settle(response.json().id);
    expect(failed.state).toBe('failed');
    await expect(readFile(join(taskDir, 'uploaded-key.pem'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await f.close();
  }
});

it('rewrites nested-parenthesis, Unicode, multiline and quoted/list/table destinations with source formatting intact', () => {
  const source = [
    '> - ![real](assets/x(1).png "literal [example](assets/x(1).png)")',
    '>   ' +
      String.fromCharCode(96, 96) +
      '[literal](assets/x(1).png)' +
      String.fromCharCode(96, 96),
    '',
    '| A | B |',
    '| --- | --- |',
    '| a\\|b ![one](assets/x(1).png) | ![two](assets/x(1).png) |',
    '',
    '![line](',
    '  <assets/照片.png>',
    '  "caption")',
    '',
    '> ![ref][photo]',
    '>',
    '> [photo]:',
    '>   <assets/照片.png> "caption"',
    '',
  ].join('\r\n');
  const mapping = new Map([
    ['assets/x(1).png', '00-Inbox/assets/x(1) (2).png'],
    ['assets/照片.png', '00-Inbox/assets/照片 (2).png'],
  ]);
  const rewritten = rewriteImportReferences(source, 'note.md', '00-Inbox/note.md', mapping);
  const expected = source
    .replace('![real](assets/x(1).png', '![real](assets/x(1)%20(2).png')
    .replace('![one](assets/x(1).png)', '![one](assets/x(1)%20(2).png)')
    .replace('![two](assets/x(1).png)', '![two](assets/x(1)%20(2).png)')
    .replaceAll('<assets/照片.png>', '<assets/%E7%85%A7%E7%89%87%20(2).png>');
  expect(rewritten).toBe(expected);
});

it('imports a collision-renamed attachment without changing code examples in the stored note', async () => {
  const f = await fixture();
  try {
    const png = {
      path: 'assets/x.png',
      encoding: 'base64',
      content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    };
    const tick = String.fromCharCode(96),
      fence = tick.repeat(3);
    const source =
      '![real](assets/x.png)\n\n' +
      fence +
      'md\n![example](assets/x.png)\n' +
      fence +
      '\n\n' +
      tick +
      '[literal](assets/x.png)' +
      tick +
      '\n';
    await f.settle((await f.post('/api/manage/import', body([note('first.md'), png]))).json().id);
    const task = await f.settle(
      (await f.post('/api/manage/import', body([note('guide.md', source), png]))).json().id,
    );
    expect(task.state).toBe('succeeded');
    expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/guide.md'), 'utf8')).toBe(
      source.replace('![real](assets/x.png)', '![real](assets/x%20(2).png)'),
    );
  } finally {
    await f.close();
  }
});

it('retains escaped table filename semantics when replacing its physical destination span', () => {
  const source = '| A |\n| --- |\n| ![one](assets/x\\|1.png) |';
  const content = rewriteImportReferences(
    source,
    'note.md',
    '00-Inbox/note.md',
    new Map([['assets/x|1.png', '00-Inbox/assets/x|1 (2).png']]),
  );
  expect(content).toBe('| A |\n| --- |\n| ![one](assets/x%7C1%20(2).png) |');
});

it('releases successful import payloads while keeping receipts and request fingerprints', async () => {
  const f = await fixture();
  try {
    const request = body([note('large.md', 'x'.repeat(512 * 1024))]);
    const created = (await f.post('/api/manage/import', request)).json();
    const task = await f.settle(created.id);
    expect(task.state).toBe('succeeded');
    const stored = f.db.prepare('SELECT payload,fingerprint FROM managed_transfer_jobs WHERE id=?').get(task.id) as any;
    expect(stored.payload).toBe('{}');
    expect(stored.fingerprint).toHaveLength(64);
    expect((await f.post('/api/manage/import', request)).json()).toEqual(task);
    expect((await f.post('/api/manage/import', {...request,entries:[note('large.md','changed')]})).statusCode).toBe(409);
    expect(await readFile(join(f.config.knowledgeRoot,'00-Inbox/large.md'),'utf8')).toBe(request.entries[0].content);
  } finally { await f.close(); }
});

it('reads only public task fields for list, detail and pagination cursor validation', async () => {
  const f = await fixture(); let view = false;
  try {
    const task = await f.settle((await f.post('/api/manage/import',body([note('query.md')]))).json().id);
    f.db.function('reject_private_payload', (_payload: string) => { throw Error('public query materialized the private payload'); });
    f.db.exec('ALTER TABLE managed_transfer_jobs RENAME TO transfer_query_fixture');
    const columns = (f.db.prepare('PRAGMA table_info(transfer_query_fixture)').all() as {name:string}[]).map(c => c.name==='payload' ? 'reject_private_payload(payload) AS payload' : c.name);
    f.db.exec('CREATE VIEW managed_transfer_jobs AS SELECT rowid,'+columns.join(',')+' FROM transfer_query_fixture'); view=true;
    for(const url of ['/api/manage/tasks','/api/manage/tasks/'+task.id,'/api/manage/tasks?cursor='+task.id]) {
      const response=await f.get(url);expect(response.statusCode,response.body).toBe(200);
    }
  } finally {
    if(view)f.db.exec('DROP VIEW managed_transfer_jobs; ALTER TABLE transfer_query_fixture RENAME TO managed_transfer_jobs');
    await f.close();
  }
});

it('retains only unfinished import bodies on failure and cancellation while allowing retry', async () => {
  const f=await fixture();
  try {
    const request=body([note('done.md','done-body'.repeat(1000)),note('remaining.md','retry-body'.repeat(1000))]);
    const posted=await f.post('/api/manage/import',request);
    await writeFile(join(f.config.knowledgeRoot,'00-Inbox/remaining.md'),'competing write');
    let task=await f.settle(posted.json().id);expect(task.state).toBe('failed');
    const payload=JSON.parse((f.db.prepare('SELECT payload FROM managed_transfer_jobs WHERE id=?').get(task.id) as any).payload);
    expect(payload.entries[0].content).toBe('');expect(payload.entries[1].content).toBe(request.entries[1].content);
    await rm(join(f.config.knowledgeRoot,'00-Inbox/remaining.md'));
    f.platform.get().notes.scan();
    await f.post('/api/manage/tasks/'+task.id+'/retry',{});task=await f.settle(task.id);expect(task.state).toBe('succeeded');
    expect(await readFile(join(f.config.knowledgeRoot,'00-Inbox/remaining.md'),'utf8')).toBe(request.entries[1].content);
    const cancelledRequest=body(Array.from({length:50},(_,n)=>note('cancel-'+n+'.md','cancel-body'.repeat(100))));
    const pending=(await f.post('/api/manage/import',cancelledRequest)).json();
    for(let i=0;i<100;i++){
      const progress=(await f.get('/api/manage/tasks/'+pending.id)).json();
      if(progress.items.some((x:any)=>x.state==='succeeded'))break;
      await new Promise<void>(yes=>setImmediate(yes));
    }
    await f.post('/api/manage/tasks/'+pending.id+'/cancel',{});
    const cancelled=await f.settle(pending.id);expect(cancelled.state).toBe('cancelled');
    expect(cancelled.items.some((x:any)=>x.state==='succeeded')).toBe(true);
    const compact=JSON.parse((f.db.prepare('SELECT payload FROM managed_transfer_jobs WHERE id=?').get(pending.id) as any).payload);
    for(const [i,item] of cancelled.items.entries())expect(compact.entries[i].content).toBe(item.state==='succeeded'?'':cancelledRequest.entries[i].content);
    await f.post('/api/manage/tasks/'+pending.id+'/retry',{});expect((await f.settle(pending.id)).state).toBe('succeeded');
  }finally{await f.close();}
});

it('gradually clears legacy successful payloads without changing receipts or failed retry inputs',async()=>{
  const f=await fixture();let second:ReturnType<typeof Fastify>|undefined;
  try{
    const request=body([note('legacy.md')]);
    const task=await f.settle((await f.post('/api/manage/import',request)).json().id);
    await f.app.close();
    f.db.prepare('UPDATE managed_transfer_jobs SET payload=? WHERE id=?').run(JSON.stringify(request),task.id);
    const insert=f.db.prepare("INSERT INTO managed_transfer_jobs(id,owner,kind,request_id,fingerprint,state,created_at,updated_at,cancellable,progress,items,payload) SELECT ?,owner,kind,?,fingerprint,?,created_at,updated_at,0,progress,items,? FROM managed_transfer_jobs WHERE id=?");
    for(let i=0;i<18;i++)insert.run(randomUUID(),'legacy-'+i,'succeeded','not-json-legacy-content',task.id);
    const failedId=randomUUID();insert.run(failedId,'legacy-failed','failed',JSON.stringify(request),task.id);
    second=Fastify();second.addHook('onRequest',async (req: import('fastify').FastifyRequest)=>{(req as any).ownerId=(f.db.prepare('SELECT id FROM user').get() as any).id;});
    registerTransferRoutes(second,f.config,f.db,f.platform);
    for(let i=0;i<100;i++){
      if(!(f.db.prepare("SELECT count(*) n FROM managed_transfer_jobs WHERE state='succeeded' AND payload<>'{}'").get() as any).n)break;
      await new Promise<void>(yes=>setImmediate(yes));
    }
    expect((f.db.prepare("SELECT count(*) n FROM managed_transfer_jobs WHERE state='succeeded' AND payload<>'{}'").get() as any).n).toBe(0);
    expect((await second.inject({url:'/api/manage/tasks/'+task.id})).json()).toEqual(task);
    expect((f.db.prepare('SELECT payload FROM managed_transfer_jobs WHERE id=?').get(failedId) as any).payload).toBe(JSON.stringify(request));
    expect((await second.inject({method:'POST',url:'/api/manage/import',payload:request})).json().id).toBe(task.id);
  }finally{await second?.close();await f.close();}
});

it('keeps minimal original whiteboard identities for failed note retries after discarding completed scenes',async()=>{
  const {emptyWhiteboard}=await import('../shared/whiteboard.js');
  const f=await fixture();
  try{
    const originalId=randomUUID();
    const request=body([
      note('board.excalidraw',JSON.stringify({...emptyWhiteboard(),dooknow:{id:originalId}})),
      note('ref.md','```excalidraw\n'+originalId+'\n```\n'),
    ]);
    const posted=await f.post('/api/manage/import',request);
    await writeFile(join(f.config.knowledgeRoot,'00-Inbox/ref.md'),'competing write');
    let task=await f.settle(posted.json().id);expect(task.items.map((i:any)=>i.state)).toEqual(['succeeded','failed']);
    const stored=JSON.parse((f.db.prepare('SELECT payload FROM managed_transfer_jobs WHERE id=?').get(task.id) as any).payload);
    expect(JSON.parse(stored.entries[0].content)).toEqual({dooknow:{id:originalId}});
    const boardId=task.items[0].noteId;expect(boardId).not.toBe(originalId);
    await rm(join(f.config.knowledgeRoot,'00-Inbox/ref.md'));
    f.platform.get().notes.scan();
    await f.post('/api/manage/tasks/'+task.id+'/retry',{});task=await f.settle(task.id);expect(task.state).toBe('succeeded');
    expect(await readFile(join(f.config.knowledgeRoot,'00-Inbox/ref.md'),'utf8')).toBe('```excalidraw\n'+boardId+'\n```\n');
  }finally{await f.close();}
});
