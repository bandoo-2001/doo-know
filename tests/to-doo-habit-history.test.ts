import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';

let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });

it('allows a zero skipped record through shared commands while rejecting zero ordinary quantities', async () => {
  command('save_entity', {
    kind: 'habit',
    entity: { id: 'skip-habit', name: 'Read', startDate: '2025-01-01' },
  });
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'habit-fixture',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], domains: ['habits'] }),
    canReadNote: () => false,
  });
  const request = {
    requestId: randomUUID(),
    action: 'checkin_habit' as const,
    payload: { habitId: 'skip-habit', localDate: '2026-10-30', amount: 0, skipped: true },
  };
  const result = await port.command(request);
  expect((await port.command(request)).ids).toEqual(result.ids);
  expect(service.getEntity('habitEntry', result.ids[0])).toMatchObject({
    amount: 0,
    skipped: true,
  });
  await expect(
    port.command({
      ...request,
      requestId: randomUUID(),
      payload: { ...request.payload, skipped: false },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    port.command({
      ...request,
      requestId: randomUUID(),
      payload: { ...request.payload, amount: -1 },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(() =>
    command('save_entity', {
      kind: 'habitEntry',
      entity: {
        ...service.getEntity('habitEntry', result.ids[0]),
        id: 'ordinary-zero',
        skipped: false,
      },
    }),
  ).toThrow();
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-habit-history-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'habit-history-fixture-only',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
});
afterEach(async () => {
  service?.close();
  if (db?.open) db.close();
  await rm(root, { recursive: true, force: true });
});

it('saves ordinary check-ins once per day while legacy quantities remain additive', () => {
  for (const [id, mode] of [
    ['ordinary', 'checkin'],
    ['legacy', undefined],
  ] as const)
    command('save_entity', {
      kind: 'habit',
      entity: { id, name: id, startDate: '2026-10-26', ...(mode ? { goalMode: mode } : {}) },
    });
  const check = (habitId: string, amount = 1) =>
    command('checkin_habit', {
      habitId,
      localDate: '2026-10-30',
      amount,
    });
  const first = check('ordinary');
  expect(check('ordinary').ids).toEqual(first.ids);
  expect(
    service.snapshot({ all: true }).habitEntries.filter((e) => e.habitId === 'ordinary'),
  ).toHaveLength(1);
  expect(() => check('ordinary', 2)).toThrow(/打卡/);
  check('legacy', 10);
  check('legacy', 20);
  expect(
    service
      .snapshot({ all: true })
      .habitEntries.filter((e) => e.habitId === 'legacy')
      .reduce((sum, e) => sum + e.amount, 0),
  ).toBe(30);
});

it('applies mode and interval edits from their effective date without reinterpreting older quantities', () => {
  const created = command('save_entity', {
    kind: 'habit',
    entity: { id: 'versioned-mode', name: '阅读', startDate: '2026-10-26', target: 20, unit: '页' },
  });
  command('checkin_habit', { habitId: created.ids[0], localDate: '2026-10-30', amount: 10 });
  const original = toDooEntitySchemas.habit.parse(service.getEntity('habit', created.ids[0]));
  command('save_entity', {
    kind: 'habit',
    expectedRevision: original.revision,
    entity: {
      ...original,
      goalMode: 'checkin',
      target: 1,
      unit: '次',
      intervalDays: 2,
      effectiveFrom: '2026-11-01',
    },
  });
  command('checkin_habit', { habitId: created.ids[0], localDate: '2026-10-30', amount: 10 });
  expect(() =>
    command('checkin_habit', { habitId: created.ids[0], localDate: '2026-11-02', amount: 1 }),
  ).toThrow(/无需/);
  command('checkin_habit', { habitId: created.ids[0], localDate: '2026-11-03', amount: 1 });
  const stored = toDooEntitySchemas.habit.parse(service.getEntity('habit', created.ids[0]));
  expect(stored.ruleVersions).toHaveLength(2);
  expect(stored.ruleVersions[0].goalMode).toBeUndefined();
  expect(stored.ruleVersions[1]).toMatchObject({ goalMode: 'checkin', intervalDays: 2 });
});

it('filters habit local dates before counts and paging and keeps MCP resource restrictions', async () => {
  for (const id of ['visible', 'hidden']) {
    command('save_entity', { kind: 'list', entity: { id, name: id } });
    command('save_entity', {
      kind: 'habit',
      entity: { id: id + '-habit', name: id, listId: id, startDate: '2025-01-01' },
    });
  }
  command('import_entities', {
    entities: Array.from({ length: 455 }, (_, i) => ({
      kind: 'habitEntry',
      entity: {
        id: 'habit-entry-' + i,
        habitId: (i < 450 ? 'visible' : 'hidden') + '-habit',
        localDate: i < 200 ? '2025-01-01' : '2026-10-30',
        occurredAt: '2026-10-29T18:00:00Z',
        amount: 1,
      },
    })),
  });
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const snapshot = service.snapshot({
      kind: 'habitEntry',
      listIds: ['visible'],
      from: '2026-10-30',
      to: '2026-10-30',
      limit: 200,
      cursor,
    });
    expect(snapshot.page.total).toBe(250);
    expect(
      snapshot.habitEntries.every(
        (entry) => entry.localDate === '2026-10-30' && entry.habitId === 'visible-habit',
      ),
    ).toBe(true);
    ids.push(...snapshot.habitEntries.map((entry) => entry.id));
    cursor = snapshot.page.nextCursor || undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(250);
  let allowed = ['visible'];
  const port = createToDooAgentPort(service, {
    authorize: () => ({
      id: 'owner',
      clientId: 'habit-fixture',
      scopes: ['to-doo:read'],
      allowedPrefixes: [],
    }),
    access: () => ({ listIds: [], resourceListIds: allowed, domains: ['habits'] }),
    canReadNote: () => false,
  });
  const result = await port.query({
    kind: 'habitEntry',
    from: '2026-10-30',
    to: '2026-10-30',
    limit: 5,
  });
  expect(result.total).toBe(250);
  expect(
    result.items.every(
      (row) => row.entity.habitId === 'visible-habit' && row.entity.localDate === '2026-10-30',
    ),
  ).toBe(true);
  allowed = [];
  expect(
    (await port.query({ kind: 'habitEntry', from: '2026-10-30', to: '2026-10-30', limit: 5 }))
      .items,
  ).toEqual([]);
});
