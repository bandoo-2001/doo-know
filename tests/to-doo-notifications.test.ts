import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createECDH } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppDatabase } from '../packages/core/db.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import {
  createToDooNotifications,
  notificationPlans,
  quietHoursEnd,
  backfillHabitReminders,
  type NotificationDomainPort,
} from '../packages/core/to-doo/notifications.js';
import { createToDooNetwork } from '../packages/core/to-doo/network.js';
import { toDooEntitySchemas, type ToDooSnapshot } from '../shared/to-doo-contracts.js';

const databases: Database.Database[] = [];
const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
  for (const db of databases.splice(0)) db.close();
});
function fixture(send?: (call: number) => Promise<number>) {
  const db = new Database(':memory:');
  databases.push(db);
  let clock = new Date('2026-10-29T09:00:00.000Z');
  const events: Record<string, any> = {};
  const plans = [
    {
      sourceType: 'task' as const,
      sourceId: 'task',
      occurrenceKey: 'single',
      scheduleRevision: 'schedule1',
      ruleId: 'rule1',
      scheduledAt: '2026-10-29T08:59:00.000Z',
      title: 'Private title',
      message: 'Private detail',
    },
  ];
  let active = true;
  const port: NotificationDomainPort = {
    due: () => (active ? plans : []),
    events: () => Object.values(events),
    valid: (event) => active && event.scheduleRevision === 'schedule1',
    save: (entity, requestId, expectedRevision) => {
      const old = events[String(entity.id)];
      if (old && old.revision !== expectedRevision) throw new Error('revision conflict');
      const saved = { ...entity, revision: 'r' + (Number(old?.revision?.slice(1) ?? 0) + 1) };
      events[String(entity.id)] = saved;
      return saved as any;
    },
    quietHours: () => null,
  };
  let sent = 0;
  let response = 201;
  const network = createToDooNetwork({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    send: async () => {
      sent++;
      return { status: send ? await send(sent) : response, headers: {}, body: Buffer.alloc(0) };
    },
  });
  const options = {
    db: db as AppDatabase,
    dataRoot: '/unused',
    installationId: 'installation-one',
    origin: 'https://app.example',
    network,
    now: () => clock,
  };
  const runtime = createToDooNotifications(port, options);
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = {
    endpoint: 'https://push.example/subscription',
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 1).toString('base64url'),
    },
  };
  return {
    runtime,
    options,
    events,
    port,
    subscription,
    get sent() {
      return sent;
    },
    setResponse: (value: number) => {
      response = value;
    },
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60000);
    },
    cancel: () => {
      active = false;
    },
  };
}
// Pause one actual runtime send while queue actions or another worker run against the same DB.
function pausedDeliveryFixture() {
  let started!: () => void, release!: (status: number) => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const result = new Promise<number>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (call) => {
    if (call === 1) {
      started();
      return result;
    }
    return 201;
  });
  return { f, sending, release };
}
async function habitDomain() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-habit-rules-')),
    config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'https://app.example',
      secret: 'test-only-secret',
    };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  resources.push(async () => {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service };
}
describe('persistent notification outbox', () => {
  it('persists station events before delivery and deduplicates across restart', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Test device' });
    await f.runtime.process();
    expect(Object.keys(f.events)).toHaveLength(1);
    expect(f.sent).toBe(1);
    f.runtime.close();
    const restarted = createToDooNotifications(f.port, f.options);
    await restarted.process();
    expect(f.sent).toBe(1);
    restarted.close();
  });
  it('sends a new snooze generation but never redelivers the same one', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Test device' });
    await f.runtime.process();
    const event = Object.values(f.events)[0];
    f.runtime.action(event.id, {
      action: 'snooze',
      until: '2026-10-29T09:05:00.000Z',
      requestId: 'snooze-1',
      expectedRevision: event.revision,
    });
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.advance(6);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    f.runtime.close();
  });
  it.each(['acknowledge', 'dismiss', 'snooze'] as const)(
    'restores %s to unread without a new delivery generation or replaying its delivery',
    async (action) => {
      const f = fixture();
      await f.runtime.configure({ enabled: true });
      await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
      await f.runtime.process();
      const original = Object.values(f.events)[0];
      const handled = f.runtime.action(original.id, {
        action,
        ...(action === 'snooze' ? { until: '2026-10-29T09:30:00.000Z' } : {}),
        requestId: 'handle-once',
        expectedRevision: original.revision,
      });
      const input = {
        action: 'unread' as const,
        requestId: 'restore-once',
        expectedRevision: handled.revision,
      };
      const restored = f.runtime.action(original.id, input);
      expect(restored).toMatchObject({
        userState: 'unread',
        snoozedUntil: null,
        deliveryGeneration: handled.deliveryGeneration,
      });
      expect(f.runtime.action(original.id, input)).toEqual(restored);
      expect(() => f.runtime.action(original.id, { ...input, action: 'dismiss' })).toThrow(
        /请求标识/,
      );
      await f.runtime.process();
      const sentAfterRestore = f.sent;
      await f.runtime.process();
      expect(f.sent).toBe(sentAfterRestore);
      expect(f.sent).toBe(1);
      await f.runtime.close();
    },
  );
  it('restores an invalid source to unread history without permitting execution or delivery', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
    await f.runtime.process();
    const event = Object.values(f.events)[0];
    const ignored = f.runtime.action(event.id, {
      action: 'dismiss',
      requestId: 'ignore-invalid',
      expectedRevision: event.revision,
    });
    f.cancel();
    const restored = f.runtime.action(event.id, {
      action: 'unread',
      requestId: 'restore-invalid',
      expectedRevision: ignored.revision,
    });
    expect(restored.userState).toBe('unread');
    expect(() =>
      f.runtime.action(event.id, {
        action: 'snooze',
        until: '2026-10-29T09:30:00.000Z',
        requestId: 'invalid-snooze',
        expectedRevision: restored.revision,
      }),
    ).toThrow(/来源/);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    await f.runtime.close();
  });
  it('still delivers an ordinary due event to a new device and drains an existing send retry', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
    f.setResponse(503);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.setResponse(201);
    f.advance(1);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.subscribe({
      subscription: { ...f.subscription, endpoint: 'https://push.example/second-device' },
      deviceName: 'Second',
    });
    await f.runtime.process();
    expect(f.sent).toBe(3);
    await f.runtime.process();
    expect(f.sent).toBe(3);
    await f.runtime.close();
  });
  it('allows a new explicit snooze generation after restoring an undelivered snooze', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
    await f.runtime.process();
    const event = Object.values(f.events)[0];
    const snoozed = f.runtime.action(event.id, {
      action: 'snooze',
      until: '2026-10-29T09:30:00.000Z',
      requestId: 'later-first',
      expectedRevision: event.revision,
    });
    const restored = f.runtime.action(event.id, {
      action: 'unread',
      requestId: 'restore-first',
      expectedRevision: snoozed.revision,
    });
    await f.runtime.process();
    expect(f.sent).toBe(1);
    const later = f.runtime.action(event.id, {
      action: 'snooze',
      until: '2026-10-29T09:05:00.000Z',
      requestId: 'later-second',
      expectedRevision: restored.revision,
    });
    expect(later.deliveryGeneration).toBe(2);
    f.advance(6);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.close();
  });
  it('does not dispatch later claimed devices after unread restoration during the first device send', async () => {
    const { f, sending, release } = pausedDeliveryFixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
    await f.runtime.subscribe({
      subscription: { ...f.subscription, endpoint: 'https://push.example/second' },
      deviceName: 'Second',
    });
    const processing = f.runtime.process();
    await sending;
    const event = Object.values(f.events)[0];
    const dismissed = f.runtime.action(event.id, {
      action: 'dismiss',
      requestId: 'during-dismiss',
      expectedRevision: event.revision,
    });
    f.runtime.action(event.id, {
      action: 'unread',
      requestId: 'during-restore',
      expectedRevision: dismissed.revision,
    });
    release(201);
    await processing;
    expect(f.sent).toBe(1);
    expect(f.options.db.prepare('SELECT state FROM to_doo_push_outbox').all()).toEqual([
      { state: 'cancelled' },
      { state: 'cancelled' },
    ]);
    f.advance(1);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    await f.runtime.close();
  });

  it('does not resurrect a cancelled in-flight failure into a retry after restoring unread', async () => {
    const { f, sending, release } = pausedDeliveryFixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
    const processing = f.runtime.process();
    await sending;
    const event = Object.values(f.events)[0];
    f.runtime.action(event.id, {
      action: 'unread',
      requestId: 'cancel-inflight',
      expectedRevision: event.revision,
    });
    release(503);
    await processing;
    expect(f.options.db.prepare('SELECT state FROM to_doo_push_outbox').get()).toEqual({
      state: 'cancelled',
    });
    f.advance(1);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    await f.runtime.close();
  });

  it('does not overwrite a newer worker settlement after an expired in-flight lease fails', async () => {
    const { f, sending, release } = pausedDeliveryFixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
    const original = f.runtime.process();
    await sending;
    f.advance(2);
    const worker = createToDooNotifications(f.port, f.options);
    await worker.process();
    expect(f.sent).toBe(2);
    release(503);
    await original;
    expect(
      f.options.db.prepare('SELECT state,attempts,lease_until FROM to_doo_push_outbox').get(),
    ).toEqual({ state: 'sent', attempts: 1, lease_until: 0 });
    f.advance(1);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await worker.close();
    await f.runtime.close();
  });

  it('reclaims expired later-device leases on the next batch instead of dispatching an old cached claim', async () => {
    const { f, sending, release } = pausedDeliveryFixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
    await f.runtime.subscribe({
      subscription: { ...f.subscription, endpoint: 'https://push.example/second' },
      deviceName: 'Second',
    });
    const processing = f.runtime.process();
    await sending;
    f.advance(2);
    release(201);
    await processing;
    expect(f.sent).toBe(1);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.close();
  });

  it('preserves quiet-hour deferral for a later claimed device after the first send finishes', async () => {
    const { f, sending, release } = pausedDeliveryFixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
    await f.runtime.subscribe({
      subscription: { ...f.subscription, endpoint: 'https://push.example/second' },
      deviceName: 'Second',
    });
    const processing = f.runtime.process();
    await sending;
    f.port.quietHours = () => ({ enabled: true, start: '09:00', end: '10:00', timeZone: 'UTC' });
    release(201);
    await processing;
    expect(f.sent).toBe(1);
    expect(
      f.options.db.prepare("SELECT next_at FROM to_doo_push_outbox WHERE state='pending'").get(),
    ).toEqual({ next_at: Date.parse('2026-10-29T10:00:00Z') });
    f.advance(61);
    await f.runtime.process();
    expect(f.sent).toBe(2);
    await f.runtime.close();
  });

  it.each(['acknowledge', 'dismiss'] as const)(
    'still blocks later devices after %s during an in-flight send',
    async (action) => {
      const { f, sending, release } = pausedDeliveryFixture();
      await f.runtime.configure({ enabled: true });
      await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'First' });
      await f.runtime.subscribe({
        subscription: { ...f.subscription, endpoint: 'https://push.example/second' },
        deviceName: 'Second',
      });
      const processing = f.runtime.process();
      await sending;
      const event = Object.values(f.events)[0];
      f.runtime.action(event.id, {
        action,
        requestId: 'handle-inflight',
        expectedRevision: event.revision,
      });
      release(503);
      await processing;
      f.advance(1);
      await f.runtime.process();
      expect(f.sent).toBe(1);
      await f.runtime.close();
    },
  );

  it('rejects snoozing when the source is already invalid rather than promising an undeliverable reminder', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.process();
    const event = Object.values(f.events)[0];
    f.cancel();
    expect(() =>
      f.runtime.action(event.id, {
        action: 'snooze',
        until: '2026-10-29T09:05:00.000Z',
        requestId: 'invalid-source-snooze',
        expectedRevision: event.revision,
      }),
    ).toThrow(/来源/);
    expect(f.events[event.id].userState).toBe('unread');
    f.runtime.close();
  });
  it('does not turn an already delivered unread reminder into repeated missed summaries', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.advance(30);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.advance(1440);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    await f.runtime.close();
  });
  it('cancels stale source delivery and expires revoked push subscriptions', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Test device' });
    f.setResponse(503);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.cancel();
    f.advance(2);
    await f.runtime.process();
    expect(f.sent).toBe(1);
    f.runtime.close();
    const expired = fixture();
    await expired.runtime.configure({ enabled: true });
    await expired.runtime.subscribe({ subscription: expired.subscription, deviceName: 'Expired' });
    expired.setResponse(410);
    await expired.runtime.process();
    expect(expired.runtime.status().devices[0].status).toBe('expired');
    expired.runtime.close();
  });
  it('keeps restored installations inactive and never returns subscription secrets', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await f.runtime.subscribe({ subscription: f.subscription, deviceName: 'Device' });
    f.runtime.close();
    const restored = createToDooNotifications(f.port, { ...f.options, restored: true });
    await restored.process();
    expect(f.sent).toBe(0);
    expect(restored.status()).toMatchObject({ enabled: false, ready: false });
    expect(JSON.stringify(restored.status())).not.toContain('push.example');
    restored.close();
  });
  it('rejects private subscription endpoints before persisting a device', async () => {
    const f = fixture();
    await f.runtime.configure({ enabled: true });
    await expect(
      f.runtime.subscribe({
        subscription: { ...f.subscription, endpoint: 'https://127.0.0.1/push' },
        deviceName: 'Unsafe',
      }),
    ).rejects.toThrow(/address|destination/i);
    expect(f.runtime.status().devices).toHaveLength(0);
    f.runtime.close();
  });
  it('schedules lunar anniversaries and measures a weekly habit over its whole period', () => {
    const at = '2026-10-29T09:00:00.000Z',
      base = { revision: 'r1', createdAt: at, updatedAt: at };
    const snapshot = {
      settings: toDooEntitySchemas.settings.parse({ ...base, id: 'settings' }),
      tasks: [],
      occurrences: [],
      timeBlocks: [],
      habits: [
        toDooEntitySchemas.habit.parse({
          ...base,
          id: 'habit',
          name: 'Weekly',
          frequency: 'weekly',
          target: 2,
          startDate: '2026-01-01',
          reminders: [{ id: 'h-rule' }],
        }),
      ],
      habitEntries: [
        toDooEntitySchemas.habitEntry.parse({
          ...base,
          id: 'entry',
          habitId: 'habit',
          localDate: '2026-10-27',
          occurredAt: at,
          amount: 2,
        }),
      ],
      anniversaries: [
        toDooEntitySchemas.anniversary.parse({
          ...base,
          id: 'ann',
          name: 'Lunar new year',
          calendar: 'lunar',
          date: '2020-01-01',
          reminders: [{ id: 'a-rule', offsetMinutes: -1440 }],
        }),
      ],
    } as unknown as ToDooSnapshot;
    const plans = notificationPlans(snapshot, new Date('2026-02-16T09:00:00.000Z'));
    expect(plans.find((p) => p.sourceType === 'anniversary')?.occurrenceKey).toBe('2026-02-17');
    expect(
      notificationPlans(snapshot, new Date(at)).filter((p) => p.sourceType === 'habit'),
    ).toHaveLength(0);
  });
  it('defers a quiet-hour delivery across the local midnight boundary', () => {
    expect(
      quietHoursEnd(new Date('2026-10-29T17:00:00Z'), {
        enabled: true,
        start: '22:00',
        end: '08:00',
        timeZone: 'Asia/Shanghai',
      })?.toISOString(),
    ).toBe('2026-10-30T00:00:00.000Z');
  });
  it('materializes a due repeat beyond its original preview window without an open browser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'to-doo-notifications-'));
    const config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'https://app.example',
      secret: 'test-only-secret',
    };
    await mkdir(config.knowledgeRoot);
    const db = openDatabase(config.dataRoot),
      service = createToDooService(config, db, noteService(config, db));
    const runtime = createToDooNotifications(service, {
      db,
      dataRoot: config.dataRoot,
      installationId: 'test-installation',
      origin: config.origin,
      now: () => new Date('2026-10-29T09:00:00Z'),
    });
    resources.push(async () => {
      await runtime.close();
      service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    });
    const created = service.command({
      requestId: 'repeat-for-scheduler',
      action: 'create_task',
      payload: {
        title: 'Background repeat',
        recurrence: {
          id: 'weekly-rule',
          frequency: 'weekly',
          anchorDate: '2026-01-01',
          time: '09:00',
          weekdays: [4],
        },
        reminders: [{ id: 'due-rule', anchor: 'due' }],
      },
    });
    expect(
      service.snapshot({ all: true }).occurrences.some((o) => o.scheduledDate === '2026-10-29'),
    ).toBe(false);
    await runtime.process();
    const state = service.snapshot({ all: true });
    expect(
      state.occurrences.some(
        (o) => o.taskId === created.ids[0] && o.scheduledDate === '2026-10-29',
      ),
    ).toBe(true);
    expect(state.reminderEvents.some((event) => event.occurrenceKey.endsWith('2026-10-29'))).toBe(
      true,
    );
  });
  it('uses an instance reminder override instead of its series defaults', () => {
    const at = '2026-10-29T09:00:00.000Z',
      base = { revision: 'r1', createdAt: at, updatedAt: at };
    const snapshot = {
      settings: toDooEntitySchemas.settings.parse({ ...base, id: 'settings' }),
      tasks: [
        toDooEntitySchemas.task.parse({
          ...base,
          id: 'task',
          title: 'Override',
          reminders: [{ id: 'template', anchor: 'due', offsetMinutes: -30 }],
        }),
      ],
      occurrences: [
        toDooEntitySchemas.occurrence.parse({
          ...base,
          id: 'occ',
          taskId: 'task',
          cycleKey: 'once',
          scheduleRevision: 'sched',
          due: { date: '2026-10-29', time: '10:00', timeZone: 'UTC' },
          reminders: [{ id: 'own', anchor: 'absolute', at }],
        }),
      ],
      timeBlocks: [],
      habits: [],
      habitEntries: [],
      anniversaries: [],
    } as unknown as ToDooSnapshot;
    expect(notificationPlans(snapshot, new Date(at)).map((p) => p.ruleId)).toEqual(['own']);
  });
  it('invalidates logical schedules when a habit time zone changes', () => {
    const at = '2026-10-29T09:00:00.000Z',
      base = { revision: 'r1', createdAt: at, updatedAt: at };
    const snapshot = {
      settings: toDooEntitySchemas.settings.parse({ ...base, id: 'settings' }),
      tasks: [],
      occurrences: [],
      timeBlocks: [],
      habitEntries: [],
      anniversaries: [],
      habits: [
        toDooEntitySchemas.habit.parse({
          ...base,
          id: 'h',
          name: 'Zone',
          startDate: '2026-01-01',
          reminders: [{ id: 'rule' }],
        }),
      ],
    } as unknown as ToDooSnapshot;
    const before = notificationPlans(snapshot, new Date(at))[0];
    snapshot.habits[0].timeZone = 'Asia/Shanghai';
    expect(notificationPlans(snapshot, new Date(at))[0].scheduleRevision).not.toBe(
      before.scheduleRevision,
    );
  });
  it('backfills bounded station-only habit summaries and records estimated uncovered history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'to-doo-habit-history-')),
      config = {
        knowledgeRoot: join(root, 'knowledge'),
        dataRoot: join(root, 'data'),
        origin: 'https://app.example',
        secret: 'test-only-secret',
      };
    await mkdir(config.knowledgeRoot);
    const db = openDatabase(config.dataRoot),
      service = createToDooService(config, db, noteService(config, db));
    resources.push(async () => {
      service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    });
    const habit = service.command({
      requestId: 'history-habit',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Daily walk',
          startDate: '2026-01-01',
          pausedDates: ['2026-10-27'],
          reminders: [{ id: 'morning', anchor: 'occurrence', allDayTime: '09:00' }],
        },
      },
    }).ids[0];
    const legacy = service.getEntity('habit', habit)!;
    service.command({
      requestId: 'legacy-no-rule-history',
      action: 'import_entities',
      payload: {
        entities: [
          {
            kind: 'habit',
            entity: { ...legacy, ruleVersions: [] },
            expectedRevision: legacy.revision,
          },
        ],
      },
    });
    service.command({
      requestId: 'history-checkin',
      action: 'checkin_habit',
      payload: { habitId: habit, localDate: '2026-10-28', amount: 1 },
    });
    backfillHabitReminders(service, new Date('2026-10-29T08:00:00Z'), { days: 3 });
    let state = service.snapshot({ all: true });
    const summary = state.reminderEvents.find((event) => event.ruleId.startsWith('history_'));
    expect(summary?.message).toMatch(/2026-10-26/);
    expect(summary?.message).toMatch(/1/);
    expect(summary?.message).toMatch(/当前(?:可用)?规则估计/);
    expect(summary?.message).toMatch(/not covered|未覆盖/);
    expect(state.habits[0].reminderCheckpoint).toMatchObject({
      throughDate: '2026-10-28',
      coveredFrom: '2026-10-26',
      estimated: true,
      uncoveredBefore: '2026-10-26',
    });
    backfillHabitReminders(service, new Date('2026-10-29T08:00:00Z'), { days: 3 });
    expect(
      service
        .snapshot({ all: true })
        .reminderEvents.filter((event) => event.ruleId.startsWith('history_')),
    ).toHaveLength(1);
    let sent = 0;
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => {
        sent++;
        return { status: 201, headers: {}, body: Buffer.alloc(0) };
      },
    });
    const runtime = createToDooNotifications(service, {
      db,
      dataRoot: config.dataRoot,
      installationId: 'history-install',
      origin: config.origin,
      now: () => new Date('2026-10-29T08:00:00Z'),
      network,
    });
    resources.unshift(async () => {
      await runtime.close();
    });
    await runtime.configure({ enabled: true });
    const key = createECDH('prime256v1');
    key.generateKeys();
    await runtime.subscribe({
      deviceName: 'Controlled device',
      subscription: {
        endpoint: 'https://push.example/history',
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: Buffer.alloc(16, 3).toString('base64url'),
        },
      },
    });
    await runtime.process();
    expect(sent).toBe(0);
  });
  it('does not reinterpret achieved historical days after today increases the habit target', async () => {
    const { service } = await habitDomain();
    const id = service.command({
      requestId: 'exact-daily',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Exact daily',
          startDate: '2026-10-26',
          target: 1,
          reminders: [{ id: 'daily-rule' }],
        },
      },
    }).ids[0];
    for (const day of ['26', '27', '28'])
      service.command({
        requestId: 'entry-' + day,
        action: 'checkin_habit',
        payload: { habitId: id, localDate: '2026-10-' + day, amount: 1 },
      });
    const before = service.getEntity('habit', id)!;
    service.command({
      requestId: 'today-target',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: { ...before, target: 2, effectiveFrom: '2026-10-29' },
        expectedRevision: before.revision,
      },
    });
    backfillHabitReminders(service, new Date('2026-10-29T08:00:00Z'), { days: 3 });
    const state = service.snapshot({ all: true });
    expect(
      state.reminderEvents.filter((event) => event.ruleId.startsWith('history_')),
    ).toHaveLength(0);
    expect(state.habits[0].reminderCheckpoint).toMatchObject({
      estimated: false,
      throughDate: '2026-10-28',
    });
  });
  it('uses a habit-specific weekly boundary for reminders rather than the display week start', () => {
    const at = '2026-10-27T09:00:00.000Z',
      base = { revision: 'r1', createdAt: at, updatedAt: at };
    const habit = toDooEntitySchemas.habit.parse({
      ...base,
      id: 'weekly-sunday',
      name: 'Sunday week',
      frequency: 'weekly',
      weekStartsOn: 0,
      target: 2,
      startDate: '2026-10-01',
      reminders: [{ id: 'weekly-rule' }],
    });
    const state = {
      settings: toDooEntitySchemas.settings.parse({ ...base, id: 'settings', weekStartsOn: 1 }),
      tasks: [],
      occurrences: [],
      timeBlocks: [],
      anniversaries: [],
      habits: [habit],
      habitEntries: ['25', '26'].map((day) =>
        toDooEntitySchemas.habitEntry.parse({
          ...base,
          id: 'entry-' + day,
          habitId: habit.id,
          localDate: '2026-10-' + day,
          occurredAt: at,
          amount: 1,
        }),
      ),
    } as unknown as ToDooSnapshot;
    expect(
      notificationPlans(state, new Date(at)).filter((plan) => plan.sourceType === 'habit'),
    ).toHaveLength(0);
  });
  it('checks a completed historical month against its old target and counts one pending weekly period once', async () => {
    const { service } = await habitDomain();
    const monthly = service.command({
      requestId: 'exact-monthly',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Month',
          frequency: 'monthly',
          target: 3,
          startDate: '2026-10-01',
          reminders: [{ id: 'monthly-rule' }],
        },
      },
    }).ids[0];
    service.command({
      requestId: 'month-one',
      action: 'checkin_habit',
      payload: { habitId: monthly, localDate: '2026-10-02', amount: 1 },
    });
    service.command({
      requestId: 'month-two',
      action: 'checkin_habit',
      payload: { habitId: monthly, localDate: '2026-10-30', amount: 2 },
    });
    const old = service.getEntity('habit', monthly)!;
    service.command({
      requestId: 'new-month-target',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: { ...old, target: 10, effectiveFrom: '2026-11-01' },
        expectedRevision: old.revision,
      },
    });
    backfillHabitReminders(service, new Date('2026-11-01T08:00:00Z'), { days: 31 });
    expect(
      service.snapshot({ all: true }).reminderEvents.filter((event) => event.sourceId === monthly),
    ).toHaveLength(0);
    const weekly = service.command({
      requestId: 'pending-week',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Pending week',
          frequency: 'weekly',
          target: 2,
          startDate: '2026-10-19',
          endDate: '2026-10-25',
          reminders: [{ id: 'pending-rule' }],
        },
      },
    }).ids[0];
    backfillHabitReminders(service, new Date('2026-10-26T08:00:00Z'), { days: 7 });
    const summary = service
      .snapshot({ all: true })
      .reminderEvents.find((event) => event.sourceId === weekly);
    expect(summary?.message).toMatch(/1 个计划周期/);
    expect(summary?.message).toMatch(/历史生效规则/);
    expect(
      service.snapshot({ all: true }).habits.find((habit) => habit.id === weekly)
        ?.reminderCheckpoint?.estimated,
    ).toBe(false);
  });
  it('excludes an explicitly skipped exempt historical period from missed reminders', async () => {
    const { service } = await habitDomain();
    const id = service.command({
      requestId: 'exempt-period',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Exempt week',
          frequency: 'weekly',
          target: 2,
          weekdays: [1, 3, 5],
          skipPolicy: 'exempt',
          startDate: '2026-10-19',
          endDate: '2026-10-25',
          reminders: [{ id: 'exempt-rule' }],
        },
      },
    }).ids[0];
    for (const day of ['19', '21', '23'])
      service.command({
        requestId: 'skip-' + day,
        action: 'checkin_habit',
        payload: { habitId: id, localDate: '2026-10-' + day, skipped: true },
      });
    backfillHabitReminders(service, new Date('2026-10-26T08:00:00Z'), { days: 7 });
    const state = service.snapshot({ all: true });
    expect(state.reminderEvents.filter((event) => event.sourceId === id)).toHaveLength(0);
    expect(state.habits[0].reminderCheckpoint?.estimated).toBe(false);
  });
  it('does not remind again today when a larger target takes effect tomorrow', async () => {
    const { service } = await habitDomain();
    const id = service.command({
      requestId: 'future-target-habit',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          name: 'Future target',
          target: 1,
          startDate: '2026-10-29',
          reminders: [{ id: 'future-rule' }],
        },
      },
    }).ids[0];
    service.command({
      requestId: 'today-achieved',
      action: 'checkin_habit',
      payload: { habitId: id, localDate: '2026-10-29', amount: 1 },
    });
    const old = service.getEntity('habit', id)!;
    service.command({
      requestId: 'tomorrow-target',
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: { ...old, target: 2, effectiveFrom: '2026-10-30' },
        expectedRevision: old.revision,
      },
    });
    expect(
      notificationPlans(service.snapshot({ all: true }), new Date('2026-10-29T10:00:00Z')).filter(
        (plan) => plan.sourceType === 'habit' && plan.sourceId === id,
      ),
    ).toHaveLength(0);
  });
});
