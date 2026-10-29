import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import { createToDooAssets } from '../packages/core/to-doo/assets.js';
import { registerToDooAssetRoutes } from '../apps/server/to-doo/asset-routes.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT0AAAAASUVORK5CYII=',
  'base64',
);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-assets-')),
    config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'http://localhost:3010',
      secret: 'test-only-secret',
    };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  const assets = createToDooAssets(service, { knowledgeRoot: config.knowledgeRoot, db });
  cleanups.push(async () => {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = service.command({
    requestId: randomUUID(),
    action: 'create_task',
    payload: { title: 'Attachments' },
  }).snapshot.tasks[0];
  return { root, config, db, service, assets, task };
}
describe('portable task attachments', () => {
  it('hashes content, associates it through CAS, and safely replays the original upload', async () => {
    const f = await fixture();
    const input = {
      taskId: f.task.id,
      name: 'diagram.png',
      mime: 'image/png',
      bytes: png,
      requestId: 'upload-one',
      expectedRevision: f.task.revision,
    };
    const first = f.assets.upload(input);
    const after = f.service.snapshot({ all: true }).tasks[0];
    expect(after.attachments).toEqual([
      { hash: sha(png), name: 'diagram.png', mime: 'image/png', size: png.length },
    ]);
    expect(f.assets.get(f.task.id, sha(png)).bytes).toEqual(png);
    f.service.command({
      requestId: 'later-title',
      action: 'update_task',
      payload: { id: f.task.id, expectedRevision: after.revision, patch: { title: 'Later edit' } },
    });
    expect(f.assets.upload(input)).toMatchObject({
      replayed: true,
      transactionId: first.transactionId,
    });
    expect(f.service.snapshot({ all: true }).tasks[0].attachments).toHaveLength(1);
    expect(() => f.assets.upload({ ...input, name: 'different.png' })).toThrow(
      /different|request|相同|标识|内容/i,
    );
  });
  it('rejects unsafe or oversize uploads without changing the task', async () => {
    const f = await fixture();
    const base = { taskId: f.task.id, requestId: 'bad-upload', expectedRevision: f.task.revision };
    for (const file of [
      { name: 'page.html', mime: 'text/html', bytes: Buffer.from('<html>bad</html>') },
      { name: 'image.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg/>') },
      { name: 'fake.png', mime: 'image/png', bytes: Buffer.from('<svg/>') },
      { name: '../escape.txt', mime: 'text/plain', bytes: Buffer.from('text') },
      { name: 'binary.txt', mime: 'text/plain', bytes: Buffer.from([0, 1, 255]) },
      { name: 'large.txt', mime: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 65) },
    ])
      expect(() => f.assets.upload({ ...base, ...file })).toThrow();
    expect(f.service.snapshot({ all: true }).tasks[0].revision).toBe(f.task.revision);
    expect(f.service.snapshot({ all: true }).tasks[0].attachments).toEqual([]);
  });
  it('accepts verified UTF-8 text aliases and only unlinks an explicitly versioned reference', async () => {
    const f = await fixture();
    const bytes = Buffer.from('安全文本\n'),
      hash = sha(bytes);
    f.assets.upload({
      taskId: f.task.id,
      name: '说明.csv',
      mime: 'text/csv',
      bytes,
      requestId: 'text-attachment',
      expectedRevision: f.task.revision,
    });
    const task = f.service.snapshot({ all: true }).tasks[0];
    expect(task.attachments[0].mime).toBe('text/plain');
    expect(() =>
      f.assets.remove({
        taskId: task.id,
        hash,
        requestId: 'stale-remove',
        expectedRevision: f.task.revision,
      }),
    ).toThrow();
    const removed = f.assets.remove({
      taskId: task.id,
      hash,
      requestId: 'remove-reference',
      expectedRevision: task.revision,
    });
    expect(
      f.assets.remove({
        taskId: task.id,
        hash,
        requestId: 'remove-reference',
        expectedRevision: task.revision,
      }).transactionId,
    ).toBe(removed.transactionId);
    expect(f.service.snapshot({ all: true }).tasks[0].attachments).toEqual([]);
    expect(await readFile(join(f.config.knowledgeRoot, '_data/apps/to-doo/assets', hash))).toEqual(
      bytes,
    );
    expect(() => f.assets.get(task.id, hash)).toThrow();
  });
  it('retains an orphan hash after a stale association and never serves it through an unrelated task', async () => {
    const f = await fixture();
    f.service.command({
      requestId: 'change',
      action: 'update_task',
      payload: { id: f.task.id, expectedRevision: f.task.revision, patch: { title: 'Changed' } },
    });
    expect(() =>
      f.assets.upload({
        taskId: f.task.id,
        name: 'notes.txt',
        mime: 'text/plain',
        bytes: Buffer.from('orphan'),
        requestId: 'stale',
        expectedRevision: f.task.revision,
      }),
    ).toThrow();
    expect(
      await readFile(
        join(f.config.knowledgeRoot, '_data/apps/to-doo/assets', sha(Buffer.from('orphan'))),
        'utf8',
      ),
    ).toBe('orphan');
    expect(() => f.assets.get(f.task.id, sha(Buffer.from('orphan')))).toThrow(/不存在|not found/i);
    expect(() => f.assets.get(f.task.id, '../../etc/passwd')).toThrow();
  });
  it('rejects symlink/corrupt assets and restores validated bytes across a checkpoint', async () => {
    const f = await fixture(),
      g = await fixture();
    f.assets.upload({
      taskId: f.task.id,
      name: 'doc.pdf',
      mime: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7\nfixture'),
      requestId: 'pdf',
      expectedRevision: f.task.revision,
    });
    const hash = sha(Buffer.from('%PDF-1.7\nfixture'));
    g.service.importCheckpoint(f.service.exportCheckpoint(), 'restore-assets');
    expect(g.assets.get(f.task.id, hash).bytes.toString()).toContain('%PDF-1.7');
    const path = join(g.config.knowledgeRoot, '_data/apps/to-doo/assets', hash);
    await writeFile(path, 'corrupted');
    expect(() => g.assets.get(f.task.id, hash)).toThrow(/hash|corrupt|校验|损坏/i);
    await unlink(path);
    const outside = join(g.root, 'outside');
    await writeFile(outside, 'private');
    await symlink(outside, path);
    expect(() => g.assets.get(f.task.id, hash)).toThrow();
  });
  it('requires an authenticated task-scoped route and serves inert downloads', async () => {
    const f = await fixture();
    const app = Fastify();
    await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: 10 * 1024 * 1024 } });
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers.authorization !== 'Bearer owner')
        return reply.code(401).send({ error: 'login required' });
    });
    registerToDooAssetRoutes(app, () => f.assets);
    cleanups.unshift(async () => {
      await app.close();
    });
    const boundary = 'asset-fixture';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\nroute-upload\r\n--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${f.task.revision}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="diagram.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `/api/to-doo/tasks/${f.task.id}/assets`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    const uploaded = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: 'Bearer owner',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect((await app.inject({ url: url + '/' + sha(png) })).statusCode).toBe(401);
    const result = await app.inject({
      url: url + '/' + sha(png),
      headers: { authorization: 'Bearer owner' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-disposition']).toContain('attachment');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.rawPayload).toEqual(png);
    const unrelated = f.service.command({
      requestId: 'other-task',
      action: 'create_task',
      payload: { title: 'Other' },
    }).ids[0];
    expect(
      (
        await app.inject({
          url: `/api/to-doo/tasks/${unrelated}/assets/${sha(png)}`,
          headers: { authorization: 'Bearer owner' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
