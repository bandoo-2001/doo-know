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
