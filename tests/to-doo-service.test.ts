import { resolveToDooStatusSelection, type ToDooSnapshot } from '../shared/to-doo-contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
let root: string,
  config: any,
  db: ReturnType<typeof openDatabase>,
  service: ReturnType<typeof createToDooService>;
const connections: ReturnType<typeof openDatabase>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-service-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-secret',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
  connections.push(db);
  service = createToDooService(config, db, noteService(config, db));
});
afterEach(async () => {
  service?.close();
  for (const d of connections.splice(0)) if (d.open) d.close();
  await rm(root, { recursive: true, force: true });
});
const cmd = (action: string, payload: unknown, requestId = randomUUID()) =>
  service.command({ requestId, action, payload });
const list = () =>
  cmd('save_entity', { kind: 'list', entity: { name: 'Project', kind: 'goal' } }).ids[0];
const task = (title: string, extra: Record<string, unknown> = {}) =>
  cmd('create_task', { title, ...extra }).ids[0];

const freezeBatch = (
  state: ToDooSnapshot,
  ids: string[],
  scope: 'current' | 'range' | 'all_materialized' = 'current',
) => {
  const selection = resolveToDooStatusSelection(state, {
    taskIds: ids,
    includeDescendants: true,
    scope,
    status: 'done',
  });
  return { occurrenceIds: selection.occurrenceIds, expectedRevisions: selection.expectedRevisions };
};
const freezeCascade = (state: ToDooSnapshot, id: string, status: 'done' | 'todo' = 'done') => {
  const selection = resolveToDooStatusSelection(state, { occurrenceId: id, cascade: true, status });
  return {
    expectedOccurrenceIds: selection.occurrenceIds,
    expectedRevisions: selection.expectedRevisions,
  };
};
it('rejects a duplicate task ID without changing its content, occurrences, or receipt', () => {
  const request = {
    requestId: randomUUID(),
    action: 'create_task',
    payload: { id: 'existing-task', title: 'Original', description: 'Keep this content' },
  };
  const created = service.command(request);
  const original = service.getEntity('task', 'existing-task');
  const occurrences = service.snapshot({ all: true }).occurrences;
  const collision = {
    ...request,
    requestId: randomUUID(),
    payload: { ...request.payload, title: 'Overwrite' },
  };
  expect(() => service.command(collision)).toThrow();
  expect(service.getEntity('task', 'existing-task')).toEqual(original);
  expect(service.snapshot({ all: true }).occurrences).toEqual(occurrences);
  expect(service.getReceipt(collision.requestId)).toBeUndefined();
  expect(service.command(request)).toMatchObject({
    replayed: true,
    transactionId: created.transactionId,
  });

  cmd('delete_entity', { kind: 'task', id: original!.id, expectedRevision: original!.revision });
  const deleted = service.getEntity('task', original!.id);
  expect(() => service.command(collision)).toThrow();
  expect(service.getEntity('task', original!.id)).toEqual(deleted);
});

it('rejects an outcome ID collision before completing an occurrence and allows versioned edits', () => {
  const first = task('First'),
    second = task('Second');
  const occurrences = service.snapshot({ all: true }).occurrences;
  const source = occurrences.find((o) => o.taskId === first)!;
  const destination = occurrences.find((o) => o.taskId === second)!;
  const request = {
    requestId: randomUUID(),
    action: 'save_outcome',
    payload: {
      occurrenceId: source.id,
      expectedRevision: source.revision,
      outcome: { id: 'existing-outcome', summary: 'Original' },
    },
  };
  const created = service.command(request);
  const original = service.getEntity('outcome', 'existing-outcome')!;
  const collision = {
    requestId: randomUUID(),
    action: 'save_outcome',
    payload: {
      occurrenceId: destination.id,
      expectedRevision: destination.revision,
      outcome: { id: original.id, summary: 'Overwrite' },
      complete: true,
    },
  };
  expect(() => service.command(collision)).toThrow();
  expect(service.getEntity('outcome', original.id)).toEqual(original);
  expect(service.getEntity('occurrence', destination.id)).toEqual(destination);
  expect(service.getReceipt(collision.requestId)).toBeUndefined();
  expect(service.command(request)).toMatchObject({
    replayed: true,
    transactionId: created.transactionId,
  });
  expect(() =>
    cmd('save_entity', { kind: 'outcome', entity: { id: original.id, summary: 'Unversioned' } }),
  ).toThrow();
  cmd('save_entity', {
    kind: 'outcome',
    entity: { ...original, summary: 'Reviewed' },
    expectedRevision: original.revision,
  });
  expect(service.getEntity('outcome', original.id)).toMatchObject({
    summary: 'Reviewed',
    occurrenceId: source.id,
  });
  expect(() =>
    cmd('save_entity', {
      kind: 'outcome',
      entity: { ...original, summary: 'Stale' },
      expectedRevision: original.revision,
    }),
  ).toThrow();
  expect(service.getEntity('outcome', original.id)).toMatchObject({ summary: 'Reviewed' });
});

it('persists tasks and idempotent updates before checking stale revisions', async () => {
  const id = task('Read design');
  const original = service.snapshot().tasks.find((t) => t.id === id)!;
  const request = {
    requestId: randomUUID(),
    action: 'update_task',
    payload: { id, expectedRevision: original.revision, patch: { title: 'Draw architecture' } },
  };
  const updated = service.command(request);
  expect(updated.snapshot.tasks.find((t) => t.id === id)?.title).toBe('Draw architecture');
  expect(service.command(request).replayed).toBe(true);
  expect(() =>
    cmd('update_task', {
      id,
      expectedRevision: original.revision,
      patch: { title: 'Lost update' },
    }),
  ).toThrow(/变化|版本|冲突/);
  const destination = {
    ...config,
    knowledgeRoot: join(root, 'copy'),
    dataRoot: join(root, 'fresh-data'),
  };
  await cp(config.knowledgeRoot, destination.knowledgeRoot, { recursive: true });
  const fresh = openDatabase(destination.dataRoot);
  connections.push(fresh);
  const migrated = createToDooService(destination, fresh, noteService(destination, fresh));
  expect(migrated.snapshot().tasks.find((t) => t.id === id)?.title).toBe('Draw architecture');
  expect(migrated.command(request).replayed).toBe(true);
  migrated.close();
});
it('moves, completes and restores entire task subtrees atomically', () => {
  const first = list(),
    second = cmd('save_entity', { kind: 'list', entity: { name: 'Second' } }).ids[0];
  const parent = task('Parent', { listId: first }),
    child = task('Child', { listId: first, parentTaskId: parent });
  let s = service.snapshot();
  const expected = Object.fromEntries(
    [...s.tasks, ...s.occurrences].map((e) => [e.id, e.revision]),
  );
  cmd('batch_tasks', {
    ids: [parent],
    expectedRevisions: expected,
    operation: 'move',
    listId: second,
    includeDescendants: true,
  });
  s = service.snapshot();
  expect(s.tasks.filter((t) => [parent, child].includes(t.id)).map((t) => t.listId)).toEqual([
    second,
    second,
  ]);
  const occurrence = s.occurrences.find((o) => o.taskId === parent)!;
  cmd('set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
    cascade: true,
    ...freezeCascade(s, occurrence.id),
  });
  expect(service.snapshot().occurrences.every((o) => o.status === 'done')).toBe(true);
  s = service.snapshot();
  cmd('delete_entity', {
    kind: 'task',
    id: parent,
    expectedRevision: s.tasks.find((t) => t.id === parent)!.revision,
    cascade: true,
  });
  expect(service.snapshot().tasks).toHaveLength(0);
  s = service.snapshot({ all: true });
  expect(s.tasks.every((t) => t.deletedAt !== null)).toBe(true);
  cmd('delete_entity', {
    kind: 'task',
    id: parent,
    expectedRevision: s.tasks.find((t) => t.id === parent)!.revision,
    restore: true,
    cascade: true,
  });
  expect(service.snapshot().tasks.every((t) => t.deletedAt === null)).toBe(true);
});
it('rejects cycles and rejects an entire stale batch without editing siblings', () => {
  const l = list(),
    a = task('A', { listId: l }),
    b = task('B', { listId: l, parentTaskId: a });
  const s = service.snapshot();
  expect(() =>
    cmd('update_task', {
      id: a,
      expectedRevision: s.tasks.find((t) => t.id === a)!.revision,
      patch: { parentTaskId: b },
    }),
  ).toThrow(/循环|层级/);
  expect(() =>
    cmd('batch_tasks', {
      ids: [a, b],
      expectedRevisions: { [a]: s.tasks.find((t) => t.id === a)!.revision, [b]: 'stale' },
      operation: 'patch',
      patch: { title: 'Unexpected' },
      includeDescendants: false,
    }),
  ).toThrow();
  expect(service.snapshot().tasks.map((t) => t.title)).toEqual(['A', 'B']);
});
it('keeps an externally edited entity intact and exposes a conflict', async () => {
  const id = task('Original');
  const path = join(config.knowledgeRoot, '_data/apps/to-doo/tasks', id + '.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.data.title = 'External version';
  await writeFile(path, JSON.stringify(envelope));
  expect(() =>
    cmd('update_task', {
      id,
      expectedRevision: service.snapshot().tasks.find((t) => t.id === id)!.revision,
      patch: { title: 'Overwrite' },
    }),
  ).toThrow();
  expect(await readFile(path, 'utf8')).toContain('External version');
});
it('pages a selected collection and keeps total counts beyond the page', () => {
  for (let i = 0; i < 7; i++) task('Task ' + i);
  const a = service.snapshot({ kind: 'task', limit: 3 });
  expect(a.tasks).toHaveLength(3);
  expect(a.page.total).toBe(7);
  expect(a.page.nextCursor).toBeTruthy();
  const b = service.snapshot({ kind: 'task', limit: 3, cursor: a.page.nextCursor! });
  expect(b.tasks).toHaveLength(3);
  expect(new Set([...a.tasks, ...b.tasks].map((t) => t.id)).size).toBe(6);
});
it('restores a checkpoint and recognizes requests originally committed on another host', async () => {
  const request = {
    requestId: randomUUID(),
    action: 'create_task',
    payload: { title: 'Portable receipt' },
  };
  const id = service.command(request).ids[0],
    checkpoint = service.exportCheckpoint();
  const dest = {
    ...config,
    knowledgeRoot: join(root, 'import-k'),
    dataRoot: join(root, 'import-d'),
  };
  await mkdir(dest.knowledgeRoot);
  const fresh = openDatabase(dest.dataRoot);
  connections.push(fresh);
  const imported = createToDooService(dest, fresh, noteService(dest, fresh));
  imported.importCheckpoint(checkpoint, 'import-checkpoint-once');
  expect(imported.snapshot().tasks.filter((t) => t.id === id)).toHaveLength(1);
  expect(imported.command(request).replayed).toBe(true);
  expect(imported.snapshot().tasks).toHaveLength(1);
  imported.close();
});
it('loads a detail query with its instances, records and blocks outside the default window', () => {
  const id = task('Long ago', { due: { date: '2020-01-01', time: null, timeZone: 'UTC' } }),
    other = task('Other');
  const occurrence = service.snapshot({ all: true }).occurrences.find((o) => o.taskId === id)!;
  cmd('save_entity', {
    kind: 'record',
    entity: { taskId: id, content: 'Evidence', occurredAt: '2020-01-01T10:00:00.000Z' },
  });
  cmd('save_entity', {
    kind: 'timeBlock',
    entity: {
      occurrenceId: occurrence.id,
      start: { date: '2020-01-01', time: '09:00', timeZone: 'UTC' },
    },
  });
  const detail = service.snapshot({ taskIds: [id] });
  expect(detail.tasks.map((t) => t.id)).toEqual([id]);
  expect(detail.tasks.some((t) => t.id === other)).toBe(false);
  expect(detail.records[0].content).toBe('Evidence');
  expect(detail.timeBlocks[0].occurrenceId).toBe(occurrence.id);
});
it('restores an unfinished focus as interrupted instead of charging time on a new machine', async () => {
  cmd('start_focus', { mode: 'stopwatch', at: '2026-10-29T10:00:00.000Z' });
  const dest = {
    ...config,
    knowledgeRoot: join(root, 'focus-copy'),
    dataRoot: join(root, 'focus-copy-data'),
  };
  await cp(config.knowledgeRoot, dest.knowledgeRoot, { recursive: true });
  const fresh = openDatabase(dest.dataRoot);
  connections.push(fresh);
  const recovered = createToDooService(dest, fresh, noteService(dest, fresh));
  expect(recovered.snapshot().focusSessions[0].status).toBe('interrupted');
  recovered.close();
});
it('interrupts imported focus drafts while generating their entity metadata normally', () => {
  const request = {
    requestId: randomUUID(),
    action: 'import_entities',
    payload: {
      entities: [
        {
          kind: 'focusSession',
          entity: {
            id: 'imported-focus',
            mode: 'stopwatch',
            status: 'running',
            segments: [{ start: '2026-10-01T09:00:00.000Z', end: null }],
          },
        },
      ],
    },
  };
  const result = service.command(request);
  expect(service.getEntity('focusSession', 'imported-focus')).toMatchObject({
    status: 'interrupted',
    revision: expect.any(String),
    segments: [{ start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T09:00:00.000Z' }],
  });
  expect(service.command(request)).toMatchObject({
    replayed: true,
    transactionId: result.transactionId,
  });
});
it('keeps the original dataset identity on a full restore into an empty application', async () => {
  task('Dataset identity');
  const checkpoint = service.exportCheckpoint(),
    dest = {
      ...config,
      knowledgeRoot: join(root, 'dataset-copy'),
      dataRoot: join(root, 'dataset-copy-data'),
    };
  await mkdir(dest.knowledgeRoot);
  const database = openDatabase(dest.dataRoot);
  connections.push(database);
  const restored = createToDooService(dest, database, noteService(dest, database));
  restored.importCheckpoint(checkpoint, 'identity-import');
  expect(restored.snapshot().datasetId).toBe(checkpoint.datasetId);
  restored.close();
});
it('includes verified app assets in a checkpoint and restores their bytes', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('portable evidence');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const assetDir = join(config.knowledgeRoot, '_data/apps/to-doo/assets');
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, hash), bytes);
  const checkpoint = service.exportCheckpoint();
  expect(checkpoint.assets.map((a) => a.hash)).toEqual([hash]);
  const dest = {
    ...config,
    knowledgeRoot: join(root, 'assets-copy'),
    dataRoot: join(root, 'assets-db'),
  };
  await mkdir(dest.knowledgeRoot);
  const database = openDatabase(dest.dataRoot);
  connections.push(database);
  const restored = createToDooService(dest, database, noteService(dest, database));
  restored.importCheckpoint(checkpoint, 'asset-import');
  expect(await readFile(join(dest.knowledgeRoot, '_data/apps/to-doo/assets', hash))).toEqual(bytes);
  restored.close();
});
it('replays attachment commands after later task edits but rejects a changed attachment body', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('proof'),
    hash = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(config.knowledgeRoot, '_data/apps/to-doo/assets'), { recursive: true });
  await writeFile(join(config.knowledgeRoot, '_data/apps/to-doo/assets', hash), bytes);
  const id = task('Attach evidence'),
    base = service.getEntity('task', id)!;
  const request = {
    requestId: 'attach-stable-command',
    action: 'attach_asset',
    payload: {
      taskId: id,
      expectedRevision: base.revision,
      attachment: { hash, name: 'evidence.txt', mime: 'text/plain', size: 5 },
    },
  };
  service.command(request);
  const updated = service.getEntity('task', id)!;
  cmd('update_task', {
    id,
    expectedRevision: updated.revision,
    patch: { title: 'Changed afterwards' },
  });
  expect(service.command(request).replayed).toBe(true);
  expect((service.getEntity('task', id) as any).attachments).toHaveLength(1);
  expect(() =>
    service.command({
      ...request,
      payload: {
        ...request.payload,
        attachment: { ...request.payload.attachment, name: 'other.txt' },
      },
    }),
  ).toThrow(/相同请求|不同内容/);
  const current = service.getEntity('task', id)!;
  cmd('detach_asset', { taskId: id, expectedRevision: current.revision, hash });
  expect((service.getEntity('task', id) as any).attachments).toHaveLength(0);
});
it('uses the default page for active tasks and exposes tombstones through the recycle query', () => {
  const deleted = task('Deleted first'),
    base = service.getEntity('task', deleted)!;
  cmd('delete_entity', {
    kind: 'task',
    id: deleted,
    expectedRevision: base.revision,
    cascade: true,
  });
  const active = task('Active after deletion');
  expect(service.snapshot({ limit: 1 }).tasks.map((t) => t.id)).toEqual([active]);
  expect(
    service
      .snapshot({ kind: 'task', filter: { includeDeleted: true } })
      .tasks.some((t) => t.id === deleted && t.deletedAt !== null),
  ).toBe(true);
});

it('provides independent cursors for overflowing habit and notification collections', () => {
  const entries = [] as { kind: string; entity: Record<string, unknown> }[];
  for (let i = 0; i < 205; i++) {
    entries.push({
      kind: 'habit',
      entity: { id: 'paged-habit-' + i, name: 'Habit ' + i, startDate: '2026-10-01' },
    });
    entries.push({
      kind: 'reminderEvent',
      entity: {
        id: 'paged-reminder-' + i,
        sourceType: 'habit',
        sourceId: 'paged-habit-' + i,
        occurrenceKey: '2026-10-29',
        ruleId: 'daily-rule',
        scheduleRevision: 'schedule-one',
        scheduledAt: '2026-10-29T10:00:00.000Z',
      },
    });
  }
  cmd('import_entities', { entities: entries });
  const initial = service.snapshot({ limit: 200 });
  const habitPage = (initial as any).collectionPages?.habit,
    notificationPage = (initial as any).collectionPages?.reminderEvent;
  expect(habitPage?.nextCursor).toBeTruthy();
  expect(notificationPage?.nextCursor).toBeTruthy();
  const habits = service.snapshot({
      kind: 'habit',
      limit: habitPage.limit,
      cursor: habitPage.nextCursor,
    }),
    notifications = service.snapshot({
      kind: 'reminderEvent',
      limit: notificationPage.limit,
      cursor: notificationPage.nextCursor,
    });
  expect(habits.habits).toHaveLength(5);
  expect(notifications.reminderEvents).toHaveLength(5);
  expect(new Set([...initial.habits, ...habits.habits].map((e) => e.id)).size).toBe(205);
  expect(habits.page.nextCursor).toBeNull();
});

it('makes every related occurrence reachable when a detail collection exceeds its first page', () => {
  const listId = cmd('save_entity', { kind: 'list', entity: { name: 'Paged periods' } }).ids[0];
  const taskIds = [] as string[];
  for (let i = 0; i < 6; i++)
    taskIds.push(
      task('Daily ' + i, {
        listId,
        recurrence: {
          id: 'paged-repeat-' + i,
          frequency: 'daily',
          anchorDate: '2026-10-29',
          timeZone: 'UTC',
        },
      }),
    );
  const query = { taskIds, limit: 200 };
  let state = service.snapshot(query);
  const seen = new Set(state.occurrences.map((o) => o.id));
  let page = (state as any).collectionPages?.occurrence;
  expect(page?.nextCursor).toBeTruthy();
  for (let i = 0; page?.nextCursor && i < 3; i++) {
    state = service.snapshot({
      ...query,
      kind: 'occurrence',
      limit: page.limit,
      cursor: page.nextCursor,
    });
    for (const occurrence of state.occurrences) seen.add(occurrence.id);
    page = (state as any).collectionPages?.occurrence;
  }
  expect(seen.size).toBe(546);
  expect(page?.nextCursor).toBeNull();
});
