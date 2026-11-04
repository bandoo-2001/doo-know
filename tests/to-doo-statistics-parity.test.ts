import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { toDooQuickFilter } from '../apps/web/to-doo-presentation';
import { deriveToDooItems } from '../apps/web/to-doo-workbench';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';

let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
let access = {
  listIds: [] as string[],
  domains: ['statistics'],
  resourceListIds: undefined as string[] | undefined,
};
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const port = () =>
  createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'statistics-fixture',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => access,
    canReadNote: () => false,
  });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  root = await mkdtemp(join(tmpdir(), 'to-doo-statistics-parity-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'statistics-fixture-only',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
  access = { listIds: [], domains: ['statistics'], resourceListIds: undefined };
});
afterEach(async () => {
  service?.close();
  if (db?.open) db.close();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('HTTP snapshot and MCP count clipped cross-day, interrupted, corrected and live focus equally', async () => {
  const rows = [
    {
      id: 'cross-day',
      status: 'finished',
      start: '2026-10-29T23:50:00Z',
      end: '2026-10-30T00:10:00Z',
    },
    {
      id: 'interrupted',
      status: 'interrupted',
      start: '2026-10-30T00:20:00Z',
      end: '2026-10-30T00:30:00Z',
    },
    { id: 'paused', status: 'paused', start: '2026-10-30T00:30:00Z', end: '2026-10-30T00:35:00Z' },
    { id: 'live', status: 'running', start: '2026-10-30T11:50:00Z', end: null },
    {
      id: 'corrected-before',
      status: 'finished',
      start: '2026-10-29T08:00:00Z',
      end: '2026-10-29T08:30:00Z',
      correctedMinutes: 99,
    },
    {
      id: 'corrected-today',
      status: 'finished',
      start: '2026-10-30T08:00:00Z',
      end: '2026-10-30T08:30:00Z',
      correctedMinutes: 7,
    },
    {
      id: 'cancelled',
      status: 'cancelled',
      start: '2026-10-30T08:00:00Z',
      end: '2026-10-30T09:00:00Z',
    },
    {
      id: 'rest',
      status: 'finished',
      start: '2026-10-30T08:00:00Z',
      end: '2026-10-30T09:00:00Z',
      mode: 'break',
    },
  ];
  for (const { start, end, ...fields } of rows)
    command('save_entity', {
      kind: 'focusSession',
      entity: { mode: 'stopwatch', ...fields, segments: [{ start, end }] },
    });
  const range = { from: '2026-10-30', to: '2026-10-30' };
  expect(service.snapshot({ ...range, limit: 1 }).statistics.focusMinutes).toBe(42);
  expect((await port().query({ kind: 'statistics', ...range })).items[0].entity.focusMinutes).toBe(
    42,
  );
});

it('both transports use the local DST day boundary when a focus segment starts the previous day', async () => {
  const settings = service.snapshot().settings;
  command('save_entity', {
    kind: 'settings',
    entity: { ...settings, timeZone: 'America/New_York' },
    expectedRevision: settings.revision,
  });
  command('save_entity', {
    kind: 'focusSession',
    entity: {
      mode: 'stopwatch',
      status: 'finished',
      segments: [{ start: '2026-11-01T03:50:00Z', end: '2026-11-01T07:10:00Z' }],
    },
  });
  const range = { from: '2026-11-01', to: '2026-11-01' };
  expect(service.snapshot(range).statistics.focusMinutes).toBe(190);
  expect((await port().query({ kind: 'statistics', ...range })).items[0].entity.focusMinutes).toBe(
    190,
  );
});

it('statistics count the same leaf task graph and use the deadline before the scheduled date', async () => {
  command('create_task', { id: 'parent', title: 'Parent' });
  command('create_task', {
    id: 'child',
    title: 'Child',
    parentTaskId: 'parent',
    due: { date: '2026-10-30', time: null, timeZone: 'UTC' },
  });
  command('create_task', { title: 'Undated' });
  const child = service.snapshot({ all: true }).occurrences.find((row) => row.taskId === 'child')!;
  command('save_entity', {
    kind: 'occurrence',
    entity: { ...child, scheduledDate: '2026-10-29' },
    expectedRevision: child.revision,
  });
  const range = { from: '2026-10-30', to: '2026-10-30' };
  expect(service.snapshot(range).statistics.pending).toBe(1);
  expect((await port().query({ kind: 'statistics', ...range })).items[0].entity.pending).toBe(1);
  expect(service.snapshot().statistics.pending).toBe(2);
  expect((await port().query({ kind: 'statistics' })).items[0].entity.pending).toBe(2);
});

it('a complete range trend includes late days and all completions independently of row pagination', () => {
  for (const [id, at] of [
    ['first', '2026-08-01T12:00:00Z'],
    ['last', '2026-10-30T12:00:00Z'],
  ] as const) {
    command('create_task', { id, title: id });
    const row = service.snapshot({ all: true }).occurrences.find((value) => value.taskId === id)!;
    command('set_occurrence_status', {
      id: row.id,
      expectedRevision: row.revision,
      status: 'done',
      at,
    });
  }
  const stats = service.snapshot({ from: '2026-08-01', to: '2026-10-30', limit: 1 }).statistics;
  expect(stats.completed).toBe(2);
  expect(stats).toMatchObject({ completedByDay: { '2026-08-01': 1, '2026-10-30': 1 } });
});

it('scoped aggregate totals do not expose another list and change after resource access is revoked', async () => {
  for (const listId of ['allowed', 'hidden']) {
    command('save_entity', { kind: 'list', entity: { id: listId, name: listId } });
    command('save_entity', {
      kind: 'focusSession',
      entity: {
        listId,
        mode: 'stopwatch',
        status: 'finished',
        segments: [{ start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:10:00Z' }],
      },
    });
  }
  access.resourceListIds = ['allowed'];
  const adapter = port();
  expect((await adapter.query({ kind: 'statistics' })).items[0].entity.focusMinutes).toBe(10);
  expect(JSON.stringify(await adapter.query({ kind: 'statistics' }))).not.toContain('hidden');
  access.resourceListIds = [];
  expect((await adapter.query({ kind: 'statistics' })).items[0].entity.focusMinutes).toBe(0);
});

it('counts a list named constructor without treating an inherited object property as a counter', () => {
  const before = Object.getOwnPropertyDescriptor(Object, 'total');
  const completedBefore = Object.getOwnPropertyDescriptor(Object, 'completed');
  try {
    command('save_entity', { kind: 'list', entity: { id: 'constructor', name: '自定义标识清单' } });
    command('create_task', { title: '应独立计数', listId: 'constructor' });
    expect(service.snapshot().statistics.byList.constructor).toEqual({ total: 1, completed: 0 });
    expect(Object.getOwnPropertyDescriptor(Object, 'total')).toEqual(before);
  } finally {
    if (before) Object.defineProperty(Object, 'total', before);
    else Reflect.deleteProperty(Object, 'total');
    if (completedBefore) Object.defineProperty(Object, 'completed', completedBefore);
    else Reflect.deleteProperty(Object, 'completed');
  }
});

it('filters review details on the server before paging and gives MCP the same dated records', async () => {
  command('import_entities', {
    entities: [
      ...Array.from({ length: 205 }, (_, index) => ({
        kind: 'record',
        entity: {
          id: 'old-record-' + index,
          content: '旧记录',
          occurredAt: '2026-08-01T09:00:00Z',
        },
      })),
      {
        kind: 'record',
        entity: { id: 'today-record', content: '本期记录', occurredAt: '2026-10-30T09:00:00Z' },
      },
      {
        kind: 'outcome',
        entity: { id: 'old-outcome', summary: '旧成果', createdAt: '2026-08-01T09:00:00Z' },
      },
      {
        kind: 'outcome',
        entity: { id: 'today-outcome', summary: '本期成果', createdAt: '2026-10-30T09:00:00Z' },
      },
      {
        kind: 'review',
        entity: {
          id: 'old-review',
          name: '旧复盘',
          from: '2026-08-01',
          to: '2026-08-07',
          capturedAt: '2026-08-07T09:00:00Z',
        },
      },
      {
        kind: 'review',
        entity: {
          id: 'overlapping-review',
          name: '本期复盘',
          from: '2026-10-29',
          to: '2026-11-01',
          capturedAt: '2026-10-30T09:00:00Z',
        },
      },
    ],
  });
  access.domains = ['records'];
  for (const [kind, collection, id] of [
    ['record', 'records', 'today-record'],
    ['outcome', 'outcomes', 'today-outcome'],
    ['review', 'reviews', 'overlapping-review'],
  ] as const) {
    const query = { kind, from: '2026-10-30', to: '2026-10-30', limit: 1 };
    const state = service.snapshot(query);
    expect(state[collection].map((row) => row.id)).toEqual([id]);
    expect(state.page.total).toBe(1);
    const remote = await port().query(query);
    expect(remote.items.map((row) => row.entity.id)).toEqual([id]);
    expect(remote.total).toBe(1);
  }
});

it('captures a review from its submitted interval instead of retaining stale displayed metrics', () => {
  command('create_task', { id: 'done-today', title: '今日完成' });
  const occurrence = service.snapshot().occurrences.find((row) => row.taskId === 'done-today')!;
  command('set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  const saved = command('save_entity', {
    kind: 'review',
    captureMetrics: true,
    entity: {
      name: '三月复盘',
      from: '2026-03-07',
      to: '2026-03-10',
      capturedAt: '2026-10-30T12:00:00Z',
      metrics: { completed: 999 },
    },
  });
  expect(service.getEntity('review', saved.ids[0])).toMatchObject({
    from: '2026-03-07',
    to: '2026-03-10',
    metrics: { completed: 0, focusMinutes: 0, outcomes: 0 },
  });
});

it('MCP review capture requires statistics rights and applies its live list resource scope', async () => {
  for (const listId of ['allowed', 'hidden']) {
    command('save_entity', { kind: 'list', entity: { id: listId, name: listId } });
    command('create_task', { id: listId + '-task', title: listId, listId });
    const occurrence = service
      .snapshot()
      .occurrences.find((row) => row.taskId === listId + '-task')!;
    command('set_occurrence_status', {
      id: occurrence.id,
      expectedRevision: occurrence.revision,
      status: 'done',
    });
  }
  let domains = ['records'];
  const adapter = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'review-capture',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], resourceListIds: ['allowed'], domains }),
    canReadNote: () => false,
  });
  const input = {
    requestId: 'capture-scoped-review',
    action: 'save_entity',
    payload: {
      kind: 'review',
      captureMetrics: true,
      entity: {
        id: 'scoped-review',
        name: '授权内复盘',
        listId: 'allowed',
        from: '2026-10-30',
        to: '2026-10-30',
        capturedAt: '2026-10-30T12:00:00Z',
      },
    },
  } as const;
  await expect(adapter.command(input)).rejects.toMatchObject({ statusCode: 403 });
  expect(service.getEntity('review', 'scoped-review')).toBeUndefined();
  domains = ['records', 'statistics'];
  await adapter.command(input);
  expect(service.getEntity('review', 'scoped-review')).toMatchObject({
    metrics: { completed: 1, focusMinutes: 0, outcomes: 0 },
  });
});

it('preserves archived historical leaf completions while current pending and list denominators exclude them', async () => {
  command('save_entity', {
    kind: 'list',
    entity: { id: 'history-goal', name: 'History', kind: 'goal' },
  });
  command('create_task', { id: 'history-parent', title: 'Parent', listId: 'history-goal' });
  for (const [id, done] of [
    ['archived-done', true],
    ['archived-pending', false],
  ] as const) {
    command('create_task', {
      id,
      title: id,
      parentTaskId: 'history-parent',
      listId: 'history-goal',
      due: { date: '2026-10-29', time: null, timeZone: 'UTC' },
    });
    if (done) {
      const row = service.snapshot({ all: true }).occurrences.find((o) => o.taskId === id)!;
      command('set_occurrence_status', {
        id: row.id,
        expectedRevision: row.revision,
        status: 'done',
        at: '2026-10-29T10:00:00Z',
      });
    }
  }
  const range = { from: '2026-10-29', to: '2026-10-30' };
  const saved = command('save_entity', {
    kind: 'review',
    captureMetrics: true,
    entity: { name: 'Saved', ...range, capturedAt: '2026-10-30T12:00:00Z' },
  });
  const savedMetrics = structuredClone(
    service.snapshot({ all: true }).reviews.find((row) => row.id === saved.ids[0])!.metrics,
  );
  expect(service.snapshot(range).statistics).toMatchObject({
    completed: 1,
    pending: 1,
    overdue: 1,
  });
  for (const id of ['history-parent', 'archived-done', 'archived-pending']) {
    const row = service.getEntity('task', id)!;
    command('save_entity', {
      kind: 'task',
      entity: { ...row, archivedAt: '2026-10-30T12:00:00Z' },
      expectedRevision: row.revision,
    });
  }
  for (const stats of [
    service.snapshot({ ...range, limit: 1 }).statistics,
    (await port().query({ kind: 'statistics', ...range })).items[0].entity,
  ]) {
    expect(stats).toMatchObject({ completed: 1, pending: 0, overdue: 0 });
  }
  expect(service.snapshot(range).statistics.completedByDay).toEqual({ '2026-10-29': 1 });
  expect(service.snapshot(range).statistics.byList['history-goal']).toBeUndefined();
  expect(service.snapshot().statistics.completed).toBe(1);
  expect(
    service.snapshot({ all: true }).reviews.find((row) => row.id === saved.ids[0])!.metrics,
  ).toEqual(savedMetrics);
  access.resourceListIds = [];
  expect((await port().query({ kind: 'statistics', ...range })).items[0].entity.completed).toBe(0);
});

it('overdue quick scope filters exact instants before server pagination and keeps totals true across display zones', () => {
  const settings = service.snapshot().settings;
  command('save_entity', {
    kind: 'settings',
    entity: { ...settings, timeZone: 'Asia/Shanghai' },
    expectedRevision: settings.revision,
  });
  const due = [
    ['past', '2026-10-30', '11:00', 'UTC'],
    ['future', '2026-10-30', '13:00', 'UTC'],
    ['all-day-today', '2026-10-30', null, 'UTC'],
    ['all-day-past', '2026-10-29', null, 'UTC'],
    ['zoned-upcoming', '2026-10-31', '04:00', 'Asia/Tokyo'],
    ['done', '2026-10-30', '08:00', 'UTC'],
    ['cancelled', '2026-10-30', '08:00', 'UTC'],
    ['skipped', '2026-10-30', '08:00', 'UTC'],
  ];
  // 04:00 Tokyo is still in the future at 12:00 UTC; include one past source date rollover.
  due.push(['rollover-past', '2026-10-31', '01:00', 'Pacific/Kiritimati']);
  for (const [id, date, time, timeZone] of due) {
    command('create_task', { id, title: id, due: { date, time, timeZone } });
  }
  for (const status of ['done', 'cancelled', 'skipped']) {
    const occurrence = service
      .snapshot({ all: true })
      .occurrences.find((row) => row.taskId === status)!;
    command('set_occurrence_status', {
      id: occurrence.id,
      status,
      expectedRevision: occurrence.revision,
    });
  }
  const filter = toDooQuickFilter({}, 'overdue', '2026-10-30');
  const first = service.snapshot({ view: 'tasks', filter, limit: 1 });
  expect(first.page.total).toBe(3);
  expect(first.tasks).toHaveLength(1);
  expect(first.page.nextCursor).not.toBeNull();
  const ids = first.tasks.map((row) => row.id);
  let cursor = first.page.nextCursor;
  while (cursor) {
    const page = service.snapshot({ view: 'tasks', filter, limit: 1, cursor });
    expect(page.page.total).toBe(3);
    ids.push(...page.tasks.map((row) => row.id));
    cursor = page.page.nextCursor;
  }
  expect(ids.sort()).toEqual(['all-day-past', 'past', 'rollover-past']);
  expect(
    deriveToDooItems(service.snapshot({ all: true }), filter)
      .map((row) => row.task.id)
      .sort(),
  ).toEqual(ids.sort());
});

it('direct hasEvidence false means no evidence references on server and client, including pagination totals', () => {
  command('create_task', { id: 'no-evidence', title: '仅有文字成果' });
  const occurrence = service.snapshot({ all: true }).occurrences[0]!;
  command('save_outcome', {
    occurrenceId: occurrence.id,
    expectedRevision: occurrence.revision,
    outcome: { summary: '文字不等于证据', evidenceRefs: [] },
  });
  for (const hasEvidence of [false, true]) {
    const expected = hasEvidence ? [] : ['no-evidence'];
    const result = service.snapshot({ view: 'tasks', filter: { hasEvidence }, limit: 1 });
    expect(result.page.total).toBe(expected.length);
    expect(deriveToDooItems(result, { hasEvidence }).map((row) => row.task.id)).toEqual(expected);
  }
});
