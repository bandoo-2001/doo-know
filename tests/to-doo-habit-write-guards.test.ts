import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import { summarizeHabitPeriod } from '../shared/to-doo-habits';
import { backfillHabitReminders } from '../packages/core/to-doo/notifications';
let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown, requestId: string = randomUUID()) =>
  service.command({ requestId, action, payload });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T15:30:00Z'));
  root = await mkdtemp(join(tmpdir(), 'to-doo-habit-write-guards-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'habit-write-guards-fixture-only',
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
function seed(timeZone = 'Asia/Shanghai') {
  command('save_entity', {
    kind: 'habit',
    entity: {
      id: 'habit',
      name: '阅读',
      timeZone,
      startDate: '2026-11-01',
      goalMode: 'quantity',
      target: 20,
      unit: '页',
    },
  });
  return toDooEntitySchemas.habit.parse(service.getEntity('habit', 'habit'));
}
function reminderHabit() {
  const habit = seed('UTC');
  command('save_entity', { kind: 'habit', expectedRevision: habit.revision,
    entity: { ...habit, reminders: [{ id: 'morning', anchor: 'occurrence', allDayTime: '09:00' }] } });
  return toDooEntitySchemas.habit.parse(service.getEntity('habit', habit.id));
}
const habitWrite = (habit: ReturnType<typeof seed>) => ({ habitId: habit.id,
  expectedHabitRevision: habit.revision, localDate: '2026-11-17', amount: 1 });
it('allows a new check-in after undo when only the internal reminder checkpoint advanced', () => {
  const first = seed('UTC');
  command('save_entity', { kind: 'habit', expectedRevision: first.revision,
    entity: { ...first, reminders: [{ id: 'morning', anchor: 'occurrence', allDayTime: '09:00' }] } });
  const habit = toDooEntitySchemas.habit.parse(service.getEntity('habit', first.id));
  const payload = { habitId: habit.id, expectedHabitRevision: habit.revision, localDate: '2026-11-17', amount: 1 };
  const recorded = command('checkin_habit', payload);
  const entry = service.getEntity('habitEntry', recorded.ids[0])!;
  command('delete_entity', { kind: 'habitEntry', id: entry.id, expectedRevision: entry.revision });
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  const advanced = toDooEntitySchemas.habit.parse(service.getEntity('habit', habit.id));
  expect(advanced.revision).not.toBe(habit.revision);
  expect(advanced.reminderCheckpoint?.throughDate).toBe('2026-11-16');
  const semantic = (value: typeof habit) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['revision', 'updatedAt', 'reminderCheckpoint'].includes(key)));
  expect(semantic(advanced)).toEqual(semantic(habit));
  expect(() => command('checkin_habit', payload)).not.toThrow();
  expect(service.snapshot({ kind: 'habitEntry' }).habitEntries).toHaveLength(1);
});
it('accepts multiple internal checkpoints and retains raw receipt idempotency after a later user edit', () => {
  const habit = reminderHabit();
  backfillHabitReminders(service, new Date('2026-11-16T15:30:00Z'));
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  const payload = habitWrite(habit);
  const result = command('checkin_habit', payload, 'checkpoint-acknowledged');
  const current = toDooEntitySchemas.habit.parse(service.getEntity('habit', habit.id));
  command('save_entity', { kind: 'habit', expectedRevision: current.revision,
    entity: { ...current, target: 30 } });
  expect(command('checkin_habit', payload, 'checkpoint-acknowledged')).toMatchObject({ replayed: true, ids: result.ids });
  expect(() => command('checkin_habit', payload)).toThrow(/版本/);
  expect(service.snapshot({ kind: 'habitEntry' }).habitEntries).toHaveLength(1);
});
it.each([
  { target: 30 }, { unit: '分钟' }, { frequency: 'weekly' },
  { pausedDates: ['2026-11-17'] }, { endDate: '2026-11-16' }, { name: '用户改名' },
])('does not accept checkpoint continuation across a user change to %j', patch => {
  const habit = reminderHabit();
  command('save_entity', { kind: 'habit', expectedRevision: habit.revision, entity: { ...habit, ...patch } });
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  expect(() => command('checkin_habit', habitWrite(habit))).toThrow(/版本/);
  expect(service.snapshot({ kind: 'habitEntry' }).habitEntries).toHaveLength(0);
});
it('rejects an ABA user edit even when the final visible fields match the old habit', () => {
  const habit = reminderHabit();
  command('save_entity', { kind: 'habit', expectedRevision: habit.revision, entity: { ...habit, name: '临时改名' } });
  const changed = toDooEntitySchemas.habit.parse(service.getEntity('habit', habit.id));
  command('save_entity', { kind: 'habit', expectedRevision: changed.revision, entity: { ...changed, name: habit.name } });
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  expect(() => command('checkin_habit', habitWrite(habit))).toThrow(/版本/);
});
it('does not trust a client-supplied internal request prefix or accept the internal action through the public command API', () => {
  const habit = reminderHabit();
  command('import_entities', { entities: [{ kind: 'habit', expectedRevision: habit.revision,
    entity: { ...habit, reminderCheckpoint: { throughDate: '2026-11-14', checkedAt: '2026-11-15T12:00:00Z',
      ruleFingerprint: 'client-supplied', coveredFrom: '2026-11-01', uncoveredBefore: null, estimated: false } } }] }, 'habit_backfill_client-controlled');
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  expect(() => command('checkin_habit', habitWrite(habit))).toThrow(/版本/);
  expect(() => command('habit.reminder-checkpoint', {})).toThrow(/请求格式/);
  expect(() => command('checkin_habit', { ...habitWrite(habit), expectedHabitRevision: 'never-recorded' })).toThrow(/版本/);
});
it('fails closed when the requested habit revision is absent from an otherwise valid checkpoint chain', () => {
  const habit = reminderHabit();
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  expect(() => command('checkin_habit', { ...habitWrite(habit), expectedHabitRevision: 'missing-history' })).toThrow(/版本/);
});
it('uses the same checkpoint continuation through the MCP agent boundary', async () => {
  const habit = reminderHabit();
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  const port = createToDooAgentPort(service, {
    authorize: () => ({ id: 'owner', clientId: 'checkpoint-fixture', scopes: ['to-doo:read', 'to-doo:write'], allowedPrefixes: [] }),
    access: () => ({ listIds: [], domains: ['habits'] }), canReadNote: () => false,
  });
  const result = await port.command({ requestId: randomUUID(), action: 'checkin_habit', payload: habitWrite(habit) });
  expect(result.ids).toHaveLength(1);
  expect(service.snapshot({ kind: 'habitEntry' }).habitEntries).toHaveLength(1);
});
it('keeps the checkpoint proof and check-in commit inside the same reserved SQLite write transaction', () => {
  const habit = reminderHabit();
  backfillHabitReminders(service, new Date('2026-11-17T15:30:00Z'));
  const peer = openDatabase(join(root, 'data'));
  peer.pragma('busy_timeout = 0');
  const prepare = db.prepare.bind(db); let observed = false;
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('SELECT t.data FROM todo_transactions t WHERE EXISTS')) {
      observed = true;
      expect(db.inTransaction).toBe(true);
      expect(() => peer.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    }
    return prepare(sql);
  }) as typeof db.prepare);
  try {
    expect(() => command('checkin_habit', habitWrite(habit))).not.toThrow();
    expect(observed).toBe(true);
  } finally { spy.mockRestore(); peer.close(); }
});
it('counts decimal quantities consistently through saved entries and shared attainment rules', () => {
  const first = seed();
  command('save_entity', {
    kind: 'habit',
    expectedRevision: first.revision,
    entity: { ...first, target: 0.8, unit: '升', effectiveFrom: '2026-11-17' },
  });
  const habit = toDooEntitySchemas.habit.parse(service.getEntity('habit', first.id));
  for (const amount of [0.1, 0.7])
    command('checkin_habit', {
      habitId: habit.id,
      expectedHabitRevision: habit.revision,
      localDate: '2026-11-17',
      amount,
    });
  const entries = service.snapshot({ all: true, kind: 'habitEntry' }).habitEntries;
  expect(summarizeHabitPeriod(habit, entries, '2026-11-17')).toMatchObject({
    amount: 0.8,
    status: 'achieved',
  });
  expect(service.snapshot({ all: true }).statistics.habitAmount).toBe(0.8);
});
it('checks the expected habit revision atomically and preserves an acknowledged replay across later rule changes', () => {
  const habit = seed();
  const payload = {
    habitId: habit.id,
    expectedHabitRevision: habit.revision,
    localDate: '2026-11-17',
    amount: 5,
  };
  const first = command('checkin_habit', payload, 'write-acknowledged');
  const stored = service.getEntity('habitEntry', first.ids[0])!;
  expect(stored).not.toHaveProperty('expectedHabitRevision');
  command('save_entity', {
    kind: 'habit',
    expectedRevision: habit.revision,
    entity: { ...habit, target: 30, unit: '分钟', effectiveFrom: '2026-11-17' },
  });
  expect(() => command('checkin_habit', payload)).toThrow(/版本/);
  expect(command('checkin_habit', payload, 'write-acknowledged')).toMatchObject({
    replayed: true,
    ids: first.ids,
  });
  expect(service.snapshot({ all: true, kind: 'habitEntry' }).habitEntries).toHaveLength(1);
});
it('uses the effective rule timezone and trusted clock rather than a supplied recording timestamp', () => {
  seed('Asia/Shanghai');
  const now = { habitId: 'habit', localDate: '2026-11-17', amount: 1 };
  command('checkin_habit', now);
  expect(() =>
    command('checkin_habit', { ...now, localDate: '2026-11-18', at: '2026-11-17T01:00:00Z' }),
  ).toThrow(/未来/);
  expect(() => command('checkin_habit', { ...now, at: '2026-11-18T01:00:00Z' })).toThrow(
    /当前时间/,
  );
  // On Kiritimati it is already the next calendar date, despite UTC still being the 17th.
  command('save_entity', {
    kind: 'habit',
    entity: { id: 'east', name: 'East', timeZone: 'Pacific/Kiritimati', startDate: '2026-11-01' },
  });
  expect(
    command('checkin_habit', { habitId: 'east', localDate: '2026-11-18', amount: 1 }).ids,
  ).toHaveLength(1);
  expect(() =>
    command('checkin_habit', { habitId: 'east', localDate: '2026-11-19', amount: 1 }),
  ).toThrow(/未来/);
});
it('rejects invalid focus references while preserving normal additions and skipped zero records', () => {
  seed();
  const value = { habitId: 'habit', localDate: '2026-11-17', amount: 1 };
  expect(() => command('checkin_habit', { ...value, sourceSessionId: 'missing' })).toThrow(
    /不存在/,
  );
  const focus = command('save_entity', {
    kind: 'focusSession',
    entity: { id: 'focus', mode: 'stopwatch', status: 'finished', segments: [] },
  });
  const session = service.getEntity('focusSession', focus.ids[0])!;
  command('delete_entity', {
    kind: 'focusSession',
    id: session.id,
    expectedRevision: session.revision,
  });
  expect(() => command('checkin_habit', { ...value, sourceSessionId: session.id })).toThrow(
    /已删除/,
  );
  command('checkin_habit', { ...value, skipped: true, amount: 0 });
  expect(service.snapshot({ all: true, kind: 'habitEntry' }).habitEntries).toMatchObject([
    { skipped: true, amount: 0 },
  ]);
});
it('exposes the same revision and future-date guards through the MCP agent boundary', async () => {
  const habit = seed();
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'habit-guard-fixture',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], domains: ['habits'] }),
    canReadNote: () => false,
  });
  await expect(
    port.command({
      requestId: randomUUID(),
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
        expectedHabitRevision: 'stale',
        localDate: '2026-11-17',
        amount: 1,
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    port.command({
      requestId: randomUUID(),
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
        expectedHabitRevision: habit.revision,
        localDate: '2026-11-18',
        amount: 1,
      },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it('keeps skipped and ordinary writes mutually exclusive and reuses a repeated skip without changing historical imports', () => {
  seed();
  const value = { habitId: 'habit', localDate: '2026-11-17', amount: 0, skipped: true };
  const first = command('checkin_habit', value);
  expect(command('checkin_habit', value).ids).toEqual(first.ids);
  expect(() => command('checkin_habit', { ...value, skipped: false, amount: 5 })).toThrow(/先撤销/);
  command('checkin_habit', { ...value, localDate: '2026-11-16', skipped: false, amount: 5 });
  expect(() => command('checkin_habit', { ...value, localDate: '2026-11-16' })).toThrow(/先撤销/);
  command('import_entities', {
    entities: [
      {
        kind: 'habitEntry',
        entity: {
          id: 'legacy-skip',
          habitId: 'habit',
          localDate: '2026-11-15',
          occurredAt: '2026-11-15T00:00:00Z',
          amount: 0,
          skipped: true,
        },
      },
      {
        kind: 'habitEntry',
        entity: {
          id: 'legacy-ordinary',
          habitId: 'habit',
          localDate: '2026-11-15',
          occurredAt: '2026-11-15T01:00:00Z',
          amount: 5,
        },
      },
    ],
  });
  expect(
    service
      .snapshot({ all: true, kind: 'habitEntry' })
      .habitEntries.filter((entry) => entry.localDate === '2026-11-15'),
  ).toHaveLength(2);
});
