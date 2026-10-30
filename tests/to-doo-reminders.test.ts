import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createECDH, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import { canonical, toDooHash } from '../packages/core/to-doo/store.js';
import {
  createToDooNotifications,
  reminderEventId,
} from '../packages/core/to-doo/notifications.js';
import { createToDooNetwork } from '../packages/core/to-doo/network.js';
import { registerToDooPushRoutes } from '../apps/server/to-doo/push-routes.js';
import type { ToDooEntityMap } from '../shared/to-doo-contracts.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-reminders-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'https://app.example',
    secret: 'test-only-secret',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const service = createToDooService(config, db, noteService(config, db));
  let clock = new Date('2026-10-30T09:00:00Z');
  const runtime = createToDooNotifications(service, {
    db,
    dataRoot: config.dataRoot,
    installationId: 'reminder-test',
    origin: config.origin,
    now: () => clock,
    network: createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => ({ status: 201, headers: {}, body: Buffer.alloc(0) }),
    }),
  });
  const app = Fastify();
  // The clock is a dependency of the reminder domain, not the HTTP transport.
  registerToDooPushRoutes(
    app,
    () => runtime,
    () => service,
    { db, now: () => clock },
  );
  cleanup.push(async () => {
    await app.close();
    await runtime.close();
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  function save<K extends keyof ToDooEntityMap>(
    kind: K,
    entity: Record<string, unknown>,
    expectedRevision?: string,
  ): ToDooEntityMap[K] {
    const result = service.command({
      requestId: randomUUID(),
      action: 'save_entity',
      payload: { kind, entity, expectedRevision },
    });
    return service.getEntity(kind, result.ids[0]) as ToDooEntityMap[K];
  }
  function task(
    title = 'Task',
    scheduledAt = '2026-10-30T08:59:00Z',
    extra: Record<string, unknown> = {},
  ) {
    const result = service.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: {
        title,
        reminders: [{ id: 'absolute', anchor: 'absolute', at: scheduledAt }],
        ...extra,
      },
    });
    return service.getEntity('task', result.ids[0]) as ToDooEntityMap['task'];
  }
  const events = () => service.snapshot({ all: true }).reminderEvents;
  return {
    app,
    db,
    service,
    runtime,
    save,
    task,
    events,
    adoptDataset: () => {
      const { digest: _digest, ...checkpoint } = service.exportCheckpoint();
      const replacement = {
        ...checkpoint,
        datasetId: randomUUID(),
        entities: [],
        transactions: [],
        receipts: [],
        assets: [],
      };
      service.importCheckpoint(
        { ...replacement, digest: toDooHash(canonical(replacement)) },
        randomUUID(),
      );
      return service.snapshot().datasetId;
    },
    setClock: (value: string) => {
      clock = new Date(value);
    },
    pending: () => app.inject('/api/to-doo/reminders/pending'),
    get: (id: string) => app.inject('/api/to-doo/reminders/' + id),
    complete: (event: ToDooEntityMap['reminderEvent'], requestId: string, amount?: number) =>
      app.inject({
        method: 'POST',
        url: `/api/to-doo/reminders/${event.id}/complete`,
        payload: {
          requestId,
          expectedRevision: event.revision,
          ...(amount === undefined ? {} : { amount }),
        },
      }),
  };
}

describe('actionable reminder context', () => {
  it('isolates completion receipts when the SQLite host adopts another dataset', async () => {
    const f = await fixture();
    const oldHabit = f.save('habit', {
      name: 'Old dataset',
      startDate: '2026-10-30',
      reminders: [{ id: 'old', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const oldEvent = f.events().find((e) => e.sourceId === oldHabit.id)!;
    expect((await f.complete(oldEvent, 'same-request-id')).statusCode).toBe(200);
    const originalDataset = f.service.snapshot().datasetId;
    expect(f.adoptDataset()).not.toBe(originalDataset);
    const currentHabit = f.save('habit', {
      name: 'Current dataset',
      startDate: '2026-10-30',
      reminders: [{ id: 'current', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const currentEvent = f.events().find((e) => e.sourceId === currentHabit.id)!;
    const completed = await f.complete(currentEvent, 'same-request-id');
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ event: { id: currentEvent.id }, replayed: false });
    expect(
      f.service
        .snapshot({ all: true })
        .habitEntries.filter((entry) => entry.habitId === currentHabit.id),
    ).toHaveLength(1);
    expect((await f.complete(currentEvent, 'same-request-id')).json().replayed).toBe(true);
  });

  it('isolates snooze receipts and domain request IDs after adopting another dataset', async () => {
    const f = await fixture();
    const oldHabit = f.save('habit', {
      name: 'Old dataset',
      startDate: '2026-10-30',
      reminders: [{ id: 'old', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const oldEvent = f.events().find((e) => e.sourceId === oldHabit.id)!;
    const action = (event: ToDooEntityMap['reminderEvent']) =>
      f.app.inject({
        method: 'POST',
        url: `/api/to-doo/reminders/${event.id}/action`,
        payload: {
          requestId: 'same-action-id',
          expectedRevision: event.revision,
          action: 'snooze',
          until: '2026-10-30T09:05:00Z',
        },
      });
    expect((await action(oldEvent)).statusCode).toBe(200);
    const originalDataset = f.service.snapshot().datasetId;
    expect(f.adoptDataset()).not.toBe(originalDataset);
    const currentHabit = f.save('habit', {
      name: 'Current dataset',
      startDate: '2026-10-30',
      reminders: [{ id: 'current', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const currentEvent = f.events().find((e) => e.sourceId === currentHabit.id)!;
    const snoozed = await action(currentEvent);
    expect(snoozed.statusCode, snoozed.body).toBe(200);
    expect(snoozed.json()).toMatchObject({
      id: currentEvent.id,
      userState: 'snoozed',
      deliveryGeneration: 1,
    });
    expect((await action(currentEvent)).json().deliveryGeneration).toBe(1);
  });

  it('queues recent unread reminders, counts older misses, and excludes future snoozes and invalid schedules', async () => {
    const f = await fixture();
    const recent = f.task('Recent');
    f.task('Old', '2026-10-30T08:00:00Z');
    f.task('Snoozed');
    const stale = f.task('Invalid');
    await f.runtime.process();
    const snoozed = f.events().find((e) => e.title === 'Snoozed')!;
    f.runtime.action(snoozed.id, {
      action: 'snooze',
      until: '2026-10-30T09:05:00Z',
      requestId: 'snooze',
      expectedRevision: snoozed.revision,
    });
    f.service.command({
      requestId: 'change-schedule',
      action: 'update_task',
      payload: { id: stale.id, expectedRevision: stale.revision, patch: { reminders: [] } },
    });
    const response = await f.pending();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ missedCount: 1, timeZone: 'UTC' });
    expect(response.json().reminders).toHaveLength(1);
    expect(response.json().reminders[0]).toMatchObject({
      taskId: recent.id,
      section: 'tasks',
      completion: 'task',
    });
    f.setClock('2026-10-30T10:00:00Z');
    const delayed = (await f.pending()).json();
    expect(delayed.reminders.map((c: any) => c.event.title)).toEqual(['Snoozed']);
    expect(delayed.missedCount).toBe(2);
  });

  it('suppresses foreground cards and miss summaries during local quiet hours', async () => {
    const f = await fixture();
    f.task();
    await f.runtime.process();
    const settings = f.service.snapshot().settings;
    f.save(
      'settings',
      { ...settings, quietHours: { enabled: true, start: '08:00', end: '10:00', timeZone: 'UTC' } },
      settings.revision,
    );
    expect((await f.pending()).json()).toMatchObject({ reminders: [], missedCount: 0 });
    f.setClock('2026-10-30T10:01:00Z');
    expect((await f.pending()).json()).toMatchObject({ reminders: [], missedCount: 1 });
  });

  it('resolves the exact task cycle and completes only that occurrence', async () => {
    const f = await fixture();
    const task = f.task('Repeat', '2026-10-30T08:59:00Z', {
      recurrence: {
        id: 'daily',
        frequency: 'daily',
        anchorDate: '2026-10-29',
        until: '2026-10-31',
      },
    });
    await f.runtime.process();
    const state = f.service.snapshot({ all: true });
    const target = state.occurrences.find(
      (o) => o.taskId === task.id && o.scheduledDate === '2026-10-30',
    )!;
    const event = f
      .events()
      .find((e) => e.sourceId === task.id && e.occurrenceKey === target.cycleKey)!;
    expect((await f.get(event.id)).json()).toMatchObject({
      occurrenceId: target.id,
      date: '2026-10-30',
      completion: 'task',
    });
    const first = await f.complete(event, 'complete-repeat');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ event: { userState: 'acknowledged' }, replayed: false });
    expect((await f.complete(event, 'complete-repeat')).json()).toMatchObject({ replayed: true });
    const after = f.service.snapshot({ all: true }).occurrences.filter((o) => o.taskId === task.id);
    expect(after.filter((o) => o.status === 'done').map((o) => o.id)).toEqual([target.id]);
    expect((await f.get(event.id)).statusCode).toBe(410);
  });

  it('requires detail handling for a parent or acceptance criteria without cascading', async () => {
    const f = await fixture();
    const parent = f.task('Parent');
    f.task('Child', '2026-10-30T08:59:00Z', { parentTaskId: parent.id });
    const criteria = f.task('Reviewed', '2026-10-30T08:59:00Z', { criteria: 'Review evidence' });
    await f.runtime.process();
    for (const task of [parent, criteria]) {
      const event = f.events().find((e) => e.sourceId === task.id)!;
      expect((await f.get(event.id)).json().completion).toBe('open');
      expect((await f.complete(event, 'complex-' + task.id)).statusCode).toBe(409);
    }
    expect(f.service.snapshot({ all: true }).occurrences.every((o) => o.status === 'todo')).toBe(
      true,
    );
  });

  it('checks in a partial quantity on the reminder date and retries without duplicating progress', async () => {
    const f = await fixture();
    const habit = f.save('habit', {
      name: 'Read',
      startDate: '2026-10-29',
      target: 20,
      unit: '页',
      reminders: [{ id: 'read', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const event = f
      .events()
      .find((e) => e.sourceId === habit.id && e.occurrenceKey === '2026-10-30')!;
    expect((await f.get(event.id)).json()).toMatchObject({
      date: '2026-10-30',
      completion: 'habit',
      habit: { amount: 0, target: 20, unit: '页' },
    });
    f.setClock('2026-10-31T09:00:00Z');
    const response = await f.complete(event, 'partial-habit', 4);
    expect(response.statusCode, response.body).toBe(200);
    expect((await f.complete(event, 'partial-habit', 4)).json().replayed).toBe(true);
    const entries = f.service.snapshot({ all: true }).habitEntries;
    expect(entries.map((e) => [e.localDate, e.amount])).toEqual([['2026-10-30', 4]]);
    expect((await f.complete(event, 'partial-habit', 6)).statusCode).toBe(409);
  });

  it('replays the real habit command after acknowledgement fails without adding another entry', async () => {
    const f = await fixture();
    const habit = f.save('habit', {
      name: 'Walk',
      startDate: '2026-10-30',
      target: 10,
      reminders: [{ id: 'walk', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const event = f
      .events()
      .find((e) => e.sourceId === habit.id && e.occurrenceKey === '2026-10-30')!;
    const original = f.service.command;
    let rejectAcknowledgement = true;
    f.service.command = (input: any, context) => {
      if (
        rejectAcknowledgement &&
        input.action === 'save_entity' &&
        input.payload.kind === 'reminderEvent' &&
        input.payload.entity.userState === 'acknowledged'
      ) {
        rejectAcknowledgement = false;
        throw new Error('Simulated persistence interruption');
      }
      return original(input, context);
    };
    expect((await f.complete(event, 'recover-partial', 3)).statusCode).toBe(500);
    expect(f.service.snapshot({ all: true }).habitEntries).toHaveLength(1);
    expect((await f.complete(event, 'recover-partial', 3)).statusCode).toBe(200);
    expect(f.service.snapshot({ all: true }).habitEntries.map((e) => e.amount)).toEqual([3]);
    expect(f.events().find((e) => e.id === event.id)?.userState).toBe('acknowledged');
  });

  it('does not add a delayed retry when a different action already achieved the habit goal', async () => {
    const f = await fixture();
    const habit = f.save('habit', {
      name: 'Daily',
      startDate: '2026-10-30',
      reminders: [{ id: 'daily', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const event = f.events().find((e) => e.sourceId === habit.id)!;
    const original = f.service.command;
    let interrupt = true;
    f.service.command = (input: any, context) => {
      if (interrupt && input.action === 'checkin_habit') {
        interrupt = false;
        throw new Error('Interrupted before commit');
      }
      return original(input, context);
    };
    expect((await f.complete(event, 'retry-before-commit')).statusCode).toBe(500);
    f.service.command({
      requestId: 'other-achieved',
      action: 'checkin_habit',
      payload: { habitId: habit.id, localDate: '2026-10-30' },
    });
    expect((await f.complete(event, 'retry-before-commit')).statusCode).toBe(200);
    expect(f.service.snapshot({ all: true }).habitEntries).toHaveLength(1);
  });

  it('rechecks required completion details before resuming an interrupted task action', async () => {
    const f = await fixture();
    const task = f.task();
    await f.runtime.process();
    const event = f.events().find((e) => e.sourceId === task.id)!;
    const original = f.service.command;
    let interrupt = true;
    f.service.command = (input: any, context) => {
      if (interrupt && input.action === 'set_occurrence_status') {
        interrupt = false;
        throw new Error('Interrupted before completion');
      }
      return original(input, context);
    };
    expect((await f.complete(event, 'resume-with-new-criteria')).statusCode).toBe(500);
    f.service.command({
      requestId: 'add-criteria',
      action: 'update_task',
      payload: {
        id: task.id,
        expectedRevision: task.revision,
        patch: { criteria: 'Review evidence first' },
      },
    });
    expect((await f.complete(event, 'resume-with-new-criteria')).statusCode).toBe(409);
    expect(
      f.service.snapshot({ all: true }).occurrences.find((o) => o.taskId === task.id)?.status,
    ).toBe('todo');
  });

  it('treats a retried snooze as one generation and preserves a closed card across polling', async () => {
    const f = await fixture();
    f.task();
    await f.runtime.process();
    const event = f.events()[0];
    const payload = {
      requestId: 'stable-snooze',
      expectedRevision: event.revision,
      action: 'snooze',
      until: '2026-10-30T09:05:00Z',
    };
    const snooze = () =>
      f.app.inject({ method: 'POST', url: `/api/to-doo/reminders/${event.id}/action`, payload });
    expect((await snooze()).json().deliveryGeneration).toBe(1);
    const retry = await snooze();
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().deliveryGeneration).toBe(1);
    f.setClock('2026-10-30T09:06:00Z');
    const card = (await f.pending()).json().reminders[0];
    expect(card.event.deliveryGeneration).toBe(1);
    await f.app.inject({
      method: 'POST',
      url: `/api/to-doo/reminders/${event.id}/action`,
      payload: { requestId: 'close-card', expectedRevision: card.event.revision, action: 'read' },
    });
    expect((await f.pending()).json().reminders).toEqual([]);
    expect((await f.pending()).json().reminders).toEqual([]);
  });

  it('does not check in again when the habit period already achieved its goal', async () => {
    const f = await fixture();
    const habit = f.save('habit', {
      name: 'Daily',
      startDate: '2026-10-30',
      reminders: [{ id: 'daily', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const event = f.events().find((e) => e.sourceId === habit.id)!;
    f.service.command({
      requestId: 'other-checkin',
      action: 'checkin_habit',
      payload: { habitId: habit.id, localDate: '2026-10-30' },
    });
    expect((await f.pending()).json().reminders).toEqual([]);
    expect((await f.complete(event, 'already-achieved')).statusCode).toBe(200);
    expect(f.service.snapshot({ all: true }).habitEntries).toHaveLength(1);
  });

  it('rejects stale event revisions, invalid schedules, read confirmations and habit-history actions', async () => {
    const f = await fixture();
    const task = f.task();
    await f.runtime.process();
    const event = f.events().find((e) => e.sourceId === task.id)!;
    expect((await f.complete({ ...event, revision: 'stale' }, 'stale-request')).statusCode).toBe(
      409,
    );
    f.service.command({
      requestId: 'invalidate-task',
      action: 'update_task',
      payload: { id: task.id, expectedRevision: task.revision, patch: { reminders: [] } },
    });
    expect((await f.get(event.id)).statusCode).toBe(410);
    expect((await f.complete(event, 'invalid-request')).statusCode).toBe(410);
    const habit = f.save('habit', {
      name: 'History',
      startDate: '2026-10-01',
      reminders: [{ id: 'h', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const history = f
      .events()
      .find((e) => e.sourceId === habit.id && e.ruleId.startsWith('history_'))!;
    expect(history).toBeDefined();
    expect((await f.pending()).json().reminders.some((c: any) => c.event.id === history.id)).toBe(
      false,
    );
    expect((await f.complete(history, 'history-complete')).statusCode).toBe(409);
  });

  it('acknowledges an anniversary without completing any task', async () => {
    const f = await fixture();
    const anniversary = f.save('anniversary', {
      name: 'Anniversary',
      date: '2020-10-30',
      reminders: [{ id: 'ann', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const event = f.events().find((e) => e.sourceId === anniversary.id)!;
    expect((await f.get(event.id)).json()).toMatchObject({
      section: 'anniversaries',
      completion: 'acknowledge',
      date: '2026-10-30',
    });
    expect((await f.complete(event, 'anniversary-ack')).json()).toMatchObject({
      event: { userState: 'acknowledged' },
    });
  });

  it('treats malformed historical dates as invalid rather than failing the entire reminder feed', async () => {
    const f = await fixture();
    const habit = f.save('habit', {
      name: 'Daily',
      startDate: '2026-10-30',
      reminders: [{ id: 'daily', allDayTime: '09:00' }],
    });
    await f.runtime.process();
    const original = f.events().find((e) => e.sourceId === habit.id)!;
    const malformed = { ...original, occurrenceKey: '2026-99-99' };
    const invalid = f.save('reminderEvent', { ...malformed, id: reminderEventId(malformed) });
    expect((await f.get(invalid.id)).statusCode).toBe(410);
    const feed = await f.pending();
    expect(feed.statusCode, feed.body).toBe(200);
    expect(feed.json().reminders.map((card: any) => card.event.id)).toEqual([original.id]);
  });

  it('looks up the current endpoint by hash without exposing subscription credentials', async () => {
    const f = await fixture();
    await f.runtime.configure({ enabled: true });
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const endpoint = 'https://push.example/current-browser';
    const registered = await f.runtime.subscribe({
      deviceName: 'Browser',
      subscription: {
        endpoint,
        keys: {
          p256dh: ecdh.getPublicKey().toString('base64url'),
          auth: Buffer.alloc(16, 1).toString('base64url'),
        },
      },
    });
    const lookup = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/to-doo/push/device-status',
        payload: { endpoint },
      });
    expect((await lookup()).json()).toEqual({ deviceId: registered.id, status: 'active' });
    f.db.prepare("UPDATE to_doo_push_devices SET status='expired' WHERE id=?").run(registered.id);
    expect((await lookup()).json()).toEqual({ deviceId: registered.id, status: 'expired' });
    f.runtime.revoke(registered.id);
    expect((await lookup()).json()).toEqual({ deviceId: null, status: 'unregistered' });
  });
});
