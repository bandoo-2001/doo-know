import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, cp, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
const roots: string[] = [],
  dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) if (d.open) d.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
it('recovers a committed batch on a fresh machine even when projected entity files were not copied', async () => {
  const r = await mkdtemp(join(tmpdir(), 'todo-store-'));
  roots.push(r);
  const c = {
    knowledgeRoot: join(r, 'k'),
    dataRoot: join(r, 'd'),
    origin: 'http://localhost:3010',
    secret: 'fixture',
  };
  await mkdir(c.knowledgeRoot);
  const d = openDatabase(c.dataRoot);
  dbs.push(d);
  const s = createToDooService(c, d, noteService(c, d));
  s.command({
    requestId: 'create-task-once',
    action: 'create_task',
    payload: { title: 'Durable task' },
  });
  const task = s.snapshot().tasks[0];
  const copy = { ...c, knowledgeRoot: join(r, 'copy'), dataRoot: join(r, 'other') };
  await cp(c.knowledgeRoot, copy.knowledgeRoot, { recursive: true });
  const files = await readdir(join(copy.knowledgeRoot, '_data/apps/to-doo/tasks'));
  for (const f of files) await unlink(join(copy.knowledgeRoot, '_data/apps/to-doo/tasks', f));
  const fd = openDatabase(copy.dataRoot);
  dbs.push(fd);
  const restored = createToDooService(copy, fd, noteService(copy, fd));
  expect(restored.snapshot().tasks[0].title).toBe('Durable task');
  expect(restored.snapshot().tasks[0].id).toBe(task.id);
  expect(
    restored.command({
      requestId: 'create-task-once',
      action: 'create_task',
      payload: { title: 'Durable task' },
    }).replayed,
  ).toBe(true);
});

it('recovers a committed batch after a real entity write failure and replays its request', async () => {
  const { vi } = await import('vitest');
  const io = await import('../packages/core/knowledge-data');
  const r = await mkdtemp(join(tmpdir(), 'todo-torn-write-'));
  roots.push(r);
  const config = {
    knowledgeRoot: join(r, 'k'),
    dataRoot: join(r, 'd'),
    origin: 'http://localhost:3010',
    secret: 'fixture',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  dbs.push(db);
  let service = createToDooService(config, db, noteService(config, db));
  const first = service.command({
    requestId: 'first-task',
    action: 'create_task',
    payload: { title: 'First' },
  }).ids[0];
  const second = service.command({
    requestId: 'second-task',
    action: 'create_task',
    payload: { title: 'Second' },
  }).ids[0];
  const state = service.snapshot();
  const request = {
    requestId: 'batch-durable-write',
    action: 'batch_tasks',
    payload: {
      ids: [first, second],
      expectedRevisions: Object.fromEntries(state.tasks.map((t) => [t.id, t.revision])),
      operation: 'patch',
      patch: { priority: 'high' },
      includeDescendants: false,
    },
  };
  const real = io.writeKnowledgeDataFile;
  let failed = false;
  const spy = vi.spyOn(io, 'writeKnowledgeDataFile').mockImplementation((root, path, ...args) => {
    if (!failed && path.endsWith('/' + second + '.json')) {
      failed = true;
      throw new Error('disk write interrupted');
    }
    return real(root, path, ...args);
  });
  try {
    expect(() => service.command(request)).toThrow('disk write interrupted');
  } finally {
    spy.mockRestore();
    service.close();
  }
  service = createToDooService(config, db, noteService(config, db));
  expect(service.snapshot().tasks.map((t) => t.priority)).toEqual(['high', 'high']);
  expect(service.command(request).replayed).toBe(true);
  service.close();
});

it('validates legacy after-images before applying new schema defaults', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const r = await mkdtemp(join(tmpdir(), 'todo-legacy-default-'));
  roots.push(r);
  const config = {
    knowledgeRoot: join(r, 'k'),
    dataRoot: join(r, 'd'),
    origin: 'http://localhost:3010',
    secret: 'fixture',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  dbs.push(db);
  const service = createToDooService(config, db, noteService(config, db));
  const id = service.command({
    requestId: 'legacy-create',
    action: 'create_task',
    payload: { title: 'Before attachment defaults' },
  }).ids[0];
  const copy = { ...config, knowledgeRoot: join(r, 'copy'), dataRoot: join(r, 'fresh') };
  await cp(config.knowledgeRoot, copy.knowledgeRoot, { recursive: true });
  const dir = join(copy.knowledgeRoot, '_data/apps/to-doo/transactions');
  for (const file of await readdir(dir)) {
    const tx = JSON.parse(await readFile(join(dir, file), 'utf8'));
    for (const member of tx.members) {
      if (member.kind !== 'task') continue;
      delete member.after.data.attachments;
      member.afterHash = createHash('sha256')
        .update(JSON.stringify(member.after, null, 2) + '\n')
        .digest('hex');
    }
    await writeFile(join(dir, file), JSON.stringify(tx, null, 2) + '\n');
  }
  const path = join(copy.knowledgeRoot, '_data/apps/to-doo/tasks', id + '.json');
  const entity = JSON.parse(await readFile(path, 'utf8'));
  delete entity.data.attachments;
  await writeFile(path, JSON.stringify(entity, null, 2) + '\n');
  const fresh = openDatabase(copy.dataRoot);
  dbs.push(fresh);
  const restored = createToDooService(copy, fresh, noteService(copy, fresh));
  expect(restored.snapshot().tasks[0].attachments).toEqual([]);
  const task = restored.snapshot().tasks[0];
  expect(() =>
    restored.command({
      requestId: 'legacy-update',
      action: 'update_task',
      payload: { id, expectedRevision: task.revision, patch: { title: 'Defaults retained' } },
    }),
  ).not.toThrow();
  restored.close();
  service.close();
});
