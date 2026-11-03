import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { createToDooInterop } from '../packages/core/to-doo/interop';

let root: string;
let config: { knowledgeRoot: string; dataRoot: string; origin: string; secret: string };
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const save = (kind: string, entity: Record<string, unknown>, expectedRevision?: string) =>
  command('save_entity', { kind, entity, expectedRevision });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  root = await mkdtemp(join(tmpdir(), 'to-doo-focus-history-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'focus-history-fixture-only',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
});
afterEach(async () => {
  service?.close();
  if (db?.open) db.close();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('aggregates a complete project week independently of history filters, pagination and other projects', () => {
  for (const id of ['trend-a', 'trend-b']) save('focusTopic', { id, name: id });
  for (const [id, topicId, mode, status, minutes] of [
    ['first', 'trend-a', 'stopwatch', 'finished', 30],
    ['second', 'trend-a', 'pomodoro', 'finished', 60],
    ['other', 'trend-b', 'pomodoro', 'finished', 90],
    ['rest', 'trend-a', 'break', 'finished', 20],
    ['cancel', 'trend-a', 'pomodoro', 'cancelled', 20],
  ] as const)
    save('focusSession', {
      id,
      topicId,
      mode,
      status,
      segments: [
        {
          start: '2026-10-30T08:00:00Z',
          end: new Date(Date.parse('2026-10-30T08:00:00Z') + minutes * 60000).toISOString(),
        },
      ],
    });
  const result = service.focusHistory({
    topicId: 'trend-a',
    limit: 1,
    trendPeriod: 'week',
    trendDate: '2026-10-30',
  });
  expect(result.page.hasMore).toBe(true);
  expect(result.items).toHaveLength(1);
  expect(result.trend).toMatchObject({
    period: 'week',
    from: '2026-10-26',
    to: '2026-11-01',
    bucket: 'day',
    totalMinutes: 90,
  });
  expect(result.trend?.points).toEqual([
    { date: '2026-10-26', minutes: 0 },
    { date: '2026-10-27', minutes: 0 },
    { date: '2026-10-28', minutes: 0 },
    { date: '2026-10-29', minutes: 0 },
    { date: '2026-10-30', minutes: 90 },
    { date: '2026-10-31', minutes: 0 },
    { date: '2026-11-01', minutes: 0 },
  ]);
  const differentHistory = service.focusHistory({
    topicId: 'trend-a',
    from: '2025-01-01',
    to: '2025-01-01',
    trendPeriod: 'week',
    trendDate: '2026-10-30',
  });
  expect(differentHistory.items).toEqual([]);
  expect(differentHistory.trend).toEqual(result.trend);
});

it('fills leap-month dates and attributes corrected time only to its starting day', () => {
  save('focusSession', {
    id: 'corrected-leap',
    mode: 'stopwatch',
    status: 'finished',
    correctedMinutes: 45,
    segments: [{ start: '2024-02-28T23:50:00Z', end: '2024-02-29T00:10:00Z' }],
  });
  save('focusSession', {
    id: 'split-leap',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2024-02-28T23:50:00Z', end: '2024-02-29T00:10:00Z' }],
  });
  const trend = service.focusHistory({ trendPeriod: 'month', trendDate: '2024-02-15' }).trend;
  expect(trend).toMatchObject({ from: '2024-02-01', to: '2024-02-29', totalMinutes: 65 });
  expect(trend?.points).toHaveLength(29);
  expect(trend?.points.slice(-2)).toEqual([
    { date: '2024-02-28', minutes: 55 },
    { date: '2024-02-29', minutes: 10 },
  ]);
});

it('groups a year into twelve months and includes archived projects without leaking unauthorized or deleted time', () => {
  save('focusTopic', {
    id: 'archived-trend',
    name: '历史项目',
    archivedAt: '2025-01-01T00:00:00Z',
  });
  for (const [id, date, minutes] of [
    ['jan', '2024-01-15', 30],
    ['feb', '2024-02-29', 60],
    ['private', '2024-02-29', 90],
    ['deleted', '2024-03-01', 90],
    ['before', '2023-12-31', 20],
    ['after', '2025-01-01', 20],
  ] as const)
    save('focusSession', {
      id,
      topicId: 'archived-trend',
      mode: 'stopwatch',
      status: 'finished',
      ...(id === 'deleted' ? { deletedAt: '2025-01-01T00:00:00Z' } : {}),
      segments: [
        {
          start: date + 'T08:00:00Z',
          end: new Date(Date.parse(date + 'T08:00:00Z') + minutes * 60000).toISOString(),
        },
      ],
    });
  const trend = service.focusHistory(
    { topicId: 'archived-trend', trendPeriod: 'year', trendDate: '2024-02-29' },
    { canRead: (_kind, entity) => entity.id !== 'private' },
  ).trend;
  expect(trend).toMatchObject({
    period: 'year',
    from: '2024-01-01',
    to: '2024-12-31',
    bucket: 'month',
    totalMinutes: 90,
  });
  expect(trend?.points).toHaveLength(12);
  expect(trend?.points.slice(0, 3)).toEqual([
    { date: '2024-01-01', minutes: 30 },
    { date: '2024-02-01', minutes: 60 },
    { date: '2024-03-01', minutes: 0 },
  ]);
});

it('uses the configured local week and real elapsed time across daylight saving transitions', () => {
  const settings = service.getEntity('settings', 'settings')!;
  save(
    'settings',
    { ...settings, timeZone: 'America/New_York', weekStartsOn: 0 },
    settings.revision,
  );
  save('focusSession', {
    id: 'dst-fall',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-11-01T05:30:00Z', end: '2026-11-01T07:30:00Z' }],
  });
  save('focusSession', {
    id: 'local-midnight',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-11-02T04:50:00Z', end: '2026-11-02T05:10:00Z' }],
  });
  const trend = service.focusHistory({ trendPeriod: 'week', trendDate: '2026-11-01' }).trend;
  expect(trend).toMatchObject({ from: '2026-11-01', to: '2026-11-07', totalMinutes: 140 });
  expect(trend?.points.slice(0, 2)).toEqual([
    { date: '2026-11-01', minutes: 130 },
    { date: '2026-11-02', minutes: 10 },
  ]);
});

it('defaults to the current local period, supports unassigned scope, and validates trend inputs', () => {
  const settings = service.getEntity('settings', 'settings')!;
  save('settings', { ...settings, timeZone: 'Asia/Shanghai' }, settings.revision);
  vi.setSystemTime(new Date('2026-10-31T17:00:00Z'));
  const trend = service.focusHistory({ unassigned: true, trendPeriod: 'month' }).trend;
  expect(trend).toMatchObject({ from: '2026-11-01', to: '2026-11-30', totalMinutes: 0 });
  expect(trend?.points).toHaveLength(30);
  expect(service.focusHistory()).not.toHaveProperty('trend');
  expect(() => service.focusHistory({ trendPeriod: 'day' as any })).toThrow();
  expect(() => service.focusHistory({ trendPeriod: 'year', trendDate: '2026-02-31' })).toThrow();
  expect(() => service.focusHistory({ trendDate: '2026-10-30' })).toThrow();
});

it('recommends breaks from authorized finished pomodoros independently of history filters and preserves zero', async () => {
  const settings = service.getEntity('settings', 'settings')!;
  save(
    'settings',
    { ...settings, shortBreakMinutes: 3, longBreakMinutes: 7, longBreakAfter: 4 },
    settings.revision,
  );
  for (const id of ['allowed', 'hidden']) save('list', { id, name: id });
  for (let i = 0; i < 4; i++)
    save('focusSession', {
      id: 'cycle-' + i,
      listId: i === 3 ? 'hidden' : 'allowed',
      mode: 'pomodoro',
      status: 'finished',
      segments: [{ start: '2026-10-01T08:00:00Z', end: '2026-10-01T08:25:00Z' }],
    });
  for (const [id, mode, status] of [
    ['stopwatch-cycle', 'stopwatch', 'finished'],
    ['rest-cycle', 'break', 'finished'],
    ['cancelled-cycle', 'pomodoro', 'cancelled'],
  ])
    save('focusSession', {
      id,
      mode,
      status,
      listId: 'allowed',
      segments: [{ start: '2026-10-01T09:00:00Z', end: '2026-10-01T09:25:00Z' }],
    });
  expect(
    service.focusHistory({ ids: [], from: '2026-10-30', limit: 1 }).overview.nextBreak,
  ).toEqual({ kind: 'long', minutes: 7 });
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'break-fixture',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], resourceListIds: ['allowed'], domains: ['focus', 'statistics'] }),
    canReadNote: () => false,
  });
  expect((await port.query({ kind: 'focusOverview' })).items[0].entity.nextBreak).toEqual({
    kind: 'short',
    minutes: 3,
  });
  const latest = service.getEntity('settings', 'settings')!;
  save('settings', { ...latest, longBreakMinutes: 0 }, latest.revision);
  expect(service.focusHistory().overview.nextBreak).toEqual({ kind: 'long', minutes: 0 });
});

it('keeps the live session inside authorization even when a caller changes the list filter', async () => {
  for (const listId of ['allowed', 'hidden']) save('list', { id: listId, name: listId });
  save('focusSession', {
    id: 'allowed-paused',
    mode: 'pomodoro',
    status: 'paused',
    listId: 'allowed',
    segments: [{ start: '2026-10-30T10:00:00Z', end: '2026-10-30T10:10:00Z' }],
  });
  save('focusSession', {
    id: 'hidden-running',
    mode: 'pomodoro',
    status: 'running',
    listId: 'hidden',
    note: 'PRIVATE_LIVE_SESSION',
    segments: [{ start: '2026-10-30T11:00:00Z', end: null }],
  });
  let access: { listIds: string[]; resourceListIds?: string[]; domains: string[] } = {
    listIds: ['allowed'],
    domains: ['focus', 'statistics'],
  };
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'live-filter-fixture',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => access,
    canReadNote: () => false,
  });
  const empty = await port.query({ kind: 'focusOverview', listIds: [] });
  expect(empty.items[0].entity.active).toHaveProperty('id', 'allowed-paused');
  expect(JSON.stringify(empty)).not.toContain('PRIVATE_LIVE_SESSION');
  access = {
    listIds: [],
    resourceListIds: ['allowed', 'hidden'],
    domains: ['focus', 'statistics'],
  };
  expect(
    (await port.query({ kind: 'focusOverview', listIds: ['allowed'] })).items[0].entity.active,
  ).toHaveProperty('id', 'hidden-running');
});

it('retains topic and task names after renaming, archiving and restarting without completing the task', () => {
  expect(() => save('focusTopic', { id: 'reading', name: '原专注项目' })).not.toThrow();
  command('create_task', { id: 'task', title: '原任务名称' });
  const occurrence = service
    .snapshot({ all: true })
    .occurrences.find((row) => row.taskId === 'task')!;
  const started = command('start_focus', {
    mode: 'stopwatch',
    topicId: 'reading',
    occurrenceId: occurrence.id,
    at: '2026-10-30T11:30:00Z',
  });
  const running = service.getEntity('focusSession', started.ids[0])!;
  command('control_focus', {
    id: running.id,
    expectedRevision: running.revision,
    operation: 'finish',
    at: '2026-10-30T11:55:00Z',
  });
  const task = service.getEntity('task', 'task')!;
  command('update_task', {
    id: task.id,
    expectedRevision: task.revision,
    patch: { title: '新的任务名称' },
  });
  const topic = service.getEntity('focusTopic', 'reading')!;
  save(
    'focusTopic',
    { ...topic, name: '新的项目名称', archivedAt: '2026-10-30T12:00:00Z' },
    topic.revision,
  );
  expect(service.getEntity('occurrence', occurrence.id)).toMatchObject({ status: 'todo' });
  expect(service.focusHistory().items[0]).toMatchObject({
    topicId: 'reading',
    topicName: '原专注项目',
    taskTitle: '原任务名称',
    status: 'finished',
  });
  expect(service.focusHistory().overview.lifetime).toMatchObject({ completed: 1, minutes: 25 });
  const finished = service.getEntity('focusSession', running.id)!;
  save('focusSession', { id: finished.id, note: '补充历史记录' }, finished.revision);
  expect(service.focusHistory().items[0]).toMatchObject({
    topicName: '原专注项目',
    taskTitle: '原任务名称',
    note: '补充历史记录',
  });
  service.close();
  service = createToDooService(config, db, noteService(config, db));
  expect(service.focusHistory().items[0]).toMatchObject({
    topicName: '原专注项目',
    taskTitle: '原任务名称',
  });
  expect(
    service
      .exportCheckpoint()
      .entities.some((row) => row.kind === 'focusTopic' && row.entity.id === 'reading'),
  ).toBe(true);
  expect(() => command('start_focus', { mode: 'stopwatch', topicId: 'reading' })).toThrow(/归档/);
});

it('reads recent history and its active session after 1205 records and keeps keyset paging stable after an insertion', () => {
  const first = Date.parse('2026-10-29T00:00:00Z');
  command('import_entities', {
    entities: Array.from({ length: 1205 }, (_, index) => ({
      kind: 'focusSession',
      entity: {
        id: 'history-' + String(index).padStart(4, '0'),
        mode: 'stopwatch',
        status: 'finished',
        segments: [
          {
            start: new Date(first + index * 60000).toISOString(),
            end: new Date(first + (index + 1) * 60000).toISOString(),
          },
        ],
      },
    })),
  });
  command('start_focus', { mode: 'stopwatch' });
  const before = service.focusHistory({ limit: 5 });
  expect(before.active?.status).toBe('running');
  expect(before.items.map((row) => row.id)).toEqual([
    before.active!.id,
    'history-1204',
    'history-1203',
    'history-1202',
    'history-1201',
  ]);
  expect(before.page).toMatchObject({ total: 1206, hasMore: true });
  expect(before.overview.lifetime).toMatchObject({ completed: 1205, minutes: 1205 });
  save('focusSession', {
    id: 'newly-inserted',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-10-30T11:58:00Z', end: '2026-10-30T11:59:00Z' }],
  });
  const next = service.focusHistory({ limit: 5, cursor: before.page.nextCursor! });
  expect(next.items.map((row) => row.id)).toEqual([
    'history-1200',
    'history-1199',
    'history-1198',
    'history-1197',
    'history-1196',
  ]);
  expect(next.active?.id).toBe(before.active?.id);
  expect(next.overview.lifetime).toMatchObject({ completed: 1206, minutes: 1206 });
});

it('filters by local day and topic while preserving the unrelated active session and full topic totals', () => {
  save('focusTopic', { id: 'a', name: '项目 A' });
  save('focusTopic', { id: 'b', name: '项目 B' });
  save('focusSession', {
    topicId: 'a',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-10-29T23:50:00Z', end: '2026-10-30T00:10:00Z' }],
  });
  save('focusSession', {
    topicId: 'b',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-10-30T01:00:00Z', end: '2026-10-30T01:30:00Z' }],
  });
  command('start_focus', { mode: 'stopwatch', topicId: 'b' });
  const result = service.focusHistory({
    topicId: 'a',
    from: '2026-10-30',
    to: '2026-10-30',
    limit: 1,
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0].topicId).toBe('a');
  expect(result.overview.filtered.minutes).toBe(10);
  expect(result.overview.lifetime.minutes).toBe(20);
  expect(result.overview.byTopic.a.lifetime.minutes).toBe(20);
  expect(result.active?.topicId).toBe('b');
  expect(() =>
    service.focusHistory({ topicId: 'b', limit: 1, cursor: result.page.nextCursor ?? 'invalid' }),
  ).toThrow(/游标/);
});

it('MCP recent history and focus overview respect list resources and revoked access', async () => {
  for (const listId of ['allowed', 'hidden']) {
    save('list', { id: listId, name: listId });
    save('focusTopic', { id: listId + '-topic', name: listId + ' topic', listId });
    save('focusSession', {
      topicId: listId + '-topic',
      listId,
      mode: 'stopwatch',
      status: 'finished',
      segments: [{ start: '2026-10-30T11:00:00Z', end: '2026-10-30T11:10:00Z' }],
    });
  }
  let resourceListIds = ['allowed'];
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'focus-fixture',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], resourceListIds, domains: ['focus', 'statistics'] }),
    canReadNote: () => false,
  });
  const history = await port.query({ kind: 'focusSession', sort: 'recent' });
  const projects = await port.query({ kind: 'focusTopic' });
  expect(projects.items.map((row) => row.entity.id)).toEqual(['allowed-topic']);
  expect(history.items).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain('hidden');
  expect((await port.query({ kind: 'focusOverview' })).items[0].entity.lifetime).toMatchObject({
    completed: 1,
    minutes: 10,
  });
  await expect(
    port.query({ kind: 'focusSession', sort: 'recent', topicId: 'hidden-topic' }),
  ).rejects.toMatchObject({ statusCode: 403 });
  resourceListIds = [];
  expect((await port.query({ kind: 'focusOverview' })).items[0].entity.lifetime).toMatchObject({
    completed: 0,
    minutes: 0,
  });
  expect((await port.query({ kind: 'focusSession', sort: 'recent' })).items).toHaveLength(0);
});

it('does not attach an Inbox task to a focus project scoped to a different list', () => {
  save('list', { id: 'work', name: '工作' });
  save('focusTopic', { id: 'work-topic', name: '工作项目', listId: 'work' });
  command('create_task', { id: 'inbox-task', title: '收集箱任务' });
  const occurrence = service
    .snapshot({ all: true })
    .occurrences.find((row) => row.taskId === 'inbox-task')!;
  expect(() =>
    command('start_focus', {
      mode: 'stopwatch',
      topicId: 'work-topic',
      occurrenceId: occurrence.id,
    }),
  ).toThrow(/清单范围/);
});

it('marks truncated active-session segments in the MCP focus overview', async () => {
  const at = Date.parse('2026-10-30T08:00:00Z');
  save('focusSession', {
    id: 'many-segments',
    mode: 'stopwatch',
    status: 'paused',
    segments: Array.from({ length: 600 }, (_, index) => ({
      start: new Date(at + index * 1000).toISOString(),
      end: new Date(at + (index + 1) * 1000).toISOString(),
    })),
  });
  const adapter = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'focus-budget',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], domains: ['focus', 'statistics'] }),
    canReadNote: () => false,
  });
  const result = await adapter.query({ kind: 'focusOverview' });
  expect(result.items[0].truncatedFields).toContain('active.segments');
  expect((result.items[0].entity.active as any).segments).toHaveLength(30);
  expect(result.items[0].entity.lifetime).toMatchObject({ minutes: 10 });
});

it('keeps an explicitly named unassigned project separate from records without a project', () => {
  save('focusTopic', { id: 'unassigned', name: '自定义项目' });
  for (const [topicId, minutes] of [
    ['unassigned', 10],
    [null, 5],
  ] as const)
    save('focusSession', {
      topicId,
      mode: 'stopwatch',
      status: 'finished',
      segments: [
        {
          start: '2026-10-30T08:00:00Z',
          end: '2026-10-30T08:' + String(minutes).padStart(2, '0') + ':00Z',
        },
      ],
    });
  expect(service.focusHistory().overview.byTopic.unassigned.lifetime.minutes).toBe(10);
  expect(service.focusHistory({ unassigned: true }).overview.lifetime.minutes).toBe(5);
});

it('restores and copies focus projects and their history with their associations intact', async () => {
  save('focusTopic', {
    id: 'portable-topic',
    name: '长期项目',
    archivedAt: '2026-10-30T11:00:00Z',
  });
  save('focusSession', {
    id: 'portable-session',
    topicId: 'portable-topic',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:25:00Z' }],
  });
  const restoreConfig = {
    ...config,
    knowledgeRoot: join(root, 'restore-knowledge'),
    dataRoot: join(root, 'restore-data'),
  };
  await mkdir(restoreConfig.knowledgeRoot);
  const targetDb = openDatabase(restoreConfig.dataRoot);
  const target = createToDooService(restoreConfig, targetDb, noteService(restoreConfig, targetDb));
  const exporter = createToDooInterop(service, { db, dataRoot: config.dataRoot });
  const importer = createToDooInterop(target, {
    db: targetDb,
    dataRoot: restoreConfig.dataRoot,
    importBatchSize: 1,
  });
  try {
    const content = exporter.exportJson();
    const preview = importer.previewImport({ format: 'json', content });
    importer.applyImport({ previewId: preview.id, requestId: 'restore-focus-project' });
    await importer.processImportJobs();
    expect(target.getEntity('focusTopic', 'portable-topic')).toMatchObject({
      name: '长期项目',
      archivedAt: '2026-10-30T11:00:00Z',
    });
    expect(target.focusHistory().items[0]).toMatchObject({
      topicId: 'portable-topic',
      topicName: '长期项目',
    });
    const copy = importer.previewImport({ format: 'json', content, mergeMode: 'copy' });
    importer.applyImport({ previewId: copy.id, requestId: 'copy-focus-project' });
    await importer.processImportJobs();
    const state = target.snapshot({ all: true });
    expect(state.focusTopics).toHaveLength(2);
    const copiedTopic = state.focusTopics.find((row) => row.id !== 'portable-topic')!;
    expect(state.focusSessions.find((row) => row.id !== 'portable-session')).toMatchObject({
      topicId: copiedTopic.id,
      topicName: '长期项目',
    });
    expect(target.focusHistory().overview.lifetime).toMatchObject({ completed: 2, minutes: 50 });
  } finally {
    importer.close();
    exporter.close();
    target.close();
    targetDb.close();
  }
});
