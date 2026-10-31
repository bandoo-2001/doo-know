import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';

let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown, requestId: string = randomUUID()) =>
  service.command({ requestId, action, payload });
const event = (id: string, sourceId: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  sourceType: 'task',
  sourceId,
  occurrenceKey: 'once',
  ruleId: 'rule',
  scheduleRevision: 'schedule',
  scheduledAt: at,
  firstRaisedAt: at,
  title: id,
  ...extra,
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  root = await mkdtemp(join(tmpdir(), 'to-doo-notification-query-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'notification-query-fixture-only',
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

it('queries recent raised notifications before paging and continues stably after a new arrival', () => {
  command('create_task', { id: 'source', title: '来源任务' });
  const start = Date.parse('2026-10-29T00:00:00Z');
  command('import_entities', {
    entities: [
      ...Array.from({ length: 205 }, (_, index) => ({
        kind: 'reminderEvent',
        entity: event(
          'old-' + String(index).padStart(3, '0'),
          'source',
          new Date(start + index * 60000).toISOString(),
        ),
      })),
      { kind: 'reminderEvent', entity: event('latest', 'source', '2026-10-30T11:00:00Z') },
      {
        kind: 'reminderEvent',
        entity: event('not-raised', 'source', '2026-10-31T11:00:00Z', { firstRaisedAt: null }),
      },
    ],
  });
  const query = {
    kind: 'reminderEvent' as const,
    sort: 'recent' as const,
    raisedOnly: true,
    limit: 3,
  };
  const first = service.snapshot(query);
  expect(first.reminderEvents.map((row) => row.id)).toEqual(['latest', 'old-204', 'old-203']);
  expect(first.page.total).toBe(206);
  expect(first.reminderUnreadCount).toBe(206);
  command('save_entity', {
    kind: 'reminderEvent',
    entity: event('new-arrival', 'source', '2026-10-30T11:59:00Z'),
  });
  const next = service.snapshot({ ...query, cursor: first.page.nextCursor! });
  expect(next.reminderEvents.map((row) => row.id)).toEqual(['old-202', 'old-201', 'old-200']);
});

it('bulk read is idempotent and preserves snoozed, handled and future notifications', () => {
  for (const [id, state] of [
    ['unread', 'unread'],
    ['handled', 'acknowledged'],
    ['later', 'snoozed'],
  ] as const)
    command('save_entity', {
      kind: 'reminderEvent',
      entity: event(id, 'source', '2026-10-30T10:00:00Z', { userState: state }),
    });
  command('save_entity', {
    kind: 'reminderEvent',
    entity: event('future', 'source', '2026-10-31T10:00:00Z', { firstRaisedAt: null }),
  });
  const input = {
    ids: ['unread', 'handled', 'later', 'future'],
    datasetId: service.snapshot().datasetId,
  };
  const first = command('read_reminders', input, 'read-batch-once');
  expect(first.ids).toEqual(['unread']);
  expect(service.getEntity('reminderEvent', 'unread')).toMatchObject({ userState: 'read' });
  expect(service.getEntity('reminderEvent', 'handled')).toMatchObject({
    userState: 'acknowledged',
  });
  expect(service.getEntity('reminderEvent', 'later')).toMatchObject({ userState: 'snoozed' });
  expect(service.getEntity('reminderEvent', 'future')).toMatchObject({ userState: 'unread' });
  const revision = service.getEntity('reminderEvent', 'unread')!.revision;
  expect(command('read_reminders', input, 'read-batch-once').replayed).toBe(true);
  expect(service.getEntity('reminderEvent', 'unread')!.revision).toBe(revision);
  expect(() => command('read_reminders', { ids: ['future'], datasetId: 'other-dataset' })).toThrow(
    /数据集/,
  );
});

it('MCP reminder queries, counts and bulk actions use task source IDs and live list resources', async () => {
  for (const listId of ['allowed', 'hidden']) {
    command('save_entity', { kind: 'list', entity: { id: listId, name: listId } });
    command('create_task', { id: listId + '-task', title: listId, listId });
    command('save_entity', {
      kind: 'reminderEvent',
      entity: event(listId + '-notice', listId + '-task', '2026-10-30T10:00:00Z'),
    });
  }
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'notice-scope',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    }),
    access: () => ({
      listIds: [],
      resourceListIds: ['allowed'],
      domains: ['records', 'statistics'],
    }),
    canReadNote: () => false,
  });
  const query = await port.query({ kind: 'reminderEvent', sort: 'recent', raisedOnly: true });
  expect(query.items.map((row) => row.entity.id)).toEqual(['allowed-notice']);
  expect(query.total).toBe(1);
  expect((await port.query({ kind: 'statistics' })).items[0].entity.unreadReminders).toBe(1);
  await expect(
    port.command({
      requestId: 'deny-mixed-read',
      action: 'read_reminders',
      payload: { ids: ['allowed-notice', 'hidden-notice'] },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(service.getEntity('reminderEvent', 'allowed-notice')).toMatchObject({
    userState: 'unread',
  });
  await port.command({
    requestId: 'read-allowed',
    action: 'read_reminders',
    payload: { ids: ['allowed-notice'] },
  });
  expect(service.getEntity('reminderEvent', 'allowed-notice')).toMatchObject({ userState: 'read' });
  expect(service.getEntity('reminderEvent', 'hidden-notice')).toMatchObject({
    userState: 'unread',
  });
});

it('resolves a handled task reminder to its original cycle without turning it into a pending reminder', async () => {
  command('create_task', {
    id: 'recurring-source',
    title: '重复来源',
    recurrence: {
      id: 'source-series',
      frequency: 'daily',
      anchorDate: '2026-10-28',
      until: '2026-10-29',
      time: '10:00',
      timeZone: 'UTC',
    },
  });
  const occurrence = service
    .snapshot({ all: true })
    .occurrences.find(
      (row) => row.taskId === 'recurring-source' && row.scheduledDate === '2026-10-29',
    )!;
  command('save_entity', {
    kind: 'reminderEvent',
    entity: event('handled-source', 'recurring-source', '2026-10-29T10:00:00Z', {
      occurrenceKey: occurrence.cycleKey,
      userState: 'acknowledged',
    }),
  });
  expect(service.reminderSource('handled-source')).toMatchObject({
    section: 'tasks',
    taskId: 'recurring-source',
    occurrenceId: occurrence.id,
  });
  let domains = ['records'];
  const adapter = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'source-read',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], domains }),
    canReadNote: () => false,
  });
  await expect(
    adapter.query({ kind: 'reminderEvent', ids: ['handled-source'], sourceContext: true }),
  ).rejects.toMatchObject({ statusCode: 403 });
  domains = ['records', 'tasks'];
  await expect(
    adapter.query({
      kind: 'reminderEvent',
      ids: ['handled-source'],
      sourceContext: true,
      expectedRevision: 'old-revision',
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const result = await adapter.query({
    kind: 'reminderEvent',
    ids: ['handled-source'],
    sourceContext: true,
  });
  expect(result.items[0].entity.sourceContext).toMatchObject({
    taskId: 'recurring-source',
    occurrenceId: occurrence.id,
  });
});
