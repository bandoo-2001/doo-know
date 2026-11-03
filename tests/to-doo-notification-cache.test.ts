import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import {
  createToDooNotifications,
  notificationDomainPort,
  notificationPlans,
  reminderEventId,
} from '../packages/core/to-doo/notifications';
import { createToDooNetwork } from '../packages/core/to-doo/network';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-notification-cache-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'https://fixture.example',
    secret: 'fixture-only-notification-cache-secret',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const service = createToDooService(config, db, noteService(config, db));
  cleanup.push(async () => {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = () => new Date('2026-10-31T08:00:00Z');
  let id = 0;
  const command = (action: string, payload: Record<string, unknown>) =>
    service.command({
      requestId: 'cache-test-' + ++id,
      action,
      payload,
    });
  const options = {
    db,
    dataRoot: config.dataRoot,
    origin: config.origin,
    installationId: 'fixture',
    now,
  };
  return { service, db, now, command, options, config };
}

it('invalidates a warmed snapshot after another database connection commits a legal source change', async () => {
  const f = await fixture();
  const task = f.command('create_task', {
    title: 'Cross-connection source',
    reminders: [{ id: 'cross-rule', anchor: 'absolute', at: '2026-10-31T07:59:00Z' }],
  }).ids[0];
  const port = notificationDomainPort(f.service, f.now);
  const plan = port.due(f.now()).find((row) => row.sourceId === task)!;
  const event = port.save(
    { ...plan, id: reminderEventId(plan), firstRaisedAt: f.now().toISOString() },
    'cross-event',
  );
  expect(port.valid(event)).toBe(true);
  const before = f.service.getVersion!();
  const secondDb = openDatabase(f.config.dataRoot);
  const second = createToDooService(f.config, secondDb, noteService(f.config, secondDb));
  cleanup.push(async () => {
    second.close();
    secondDb.close();
  });
  const current = second.getEntity('task', task)!;
  second.command({
    requestId: 'cross-change',
    action: 'update_task',
    payload: {
      id: task,
      expectedRevision: current.revision,
      patch: { reminders: [] },
    },
  });
  // No event-loop turn or file watcher callback occurs between the commit/read.
  expect(f.service.getVersion!()).not.toBe(before);
  expect(port.valid(event)).toBe(false);
});

it('recomputes habit dates across local midnight without rebuilding an unchanged entity snapshot', async () => {
  const f = await fixture();
  f.command('save_entity', {
    kind: 'habit',
    entity: {
      id: 'midnight-habit',
      name: '跨午夜习惯',
      startDate: '2026-10-30',
      timeZone: 'Asia/Shanghai',
      reminders: [{ id: 'midnight-rule', allDayTime: '09:00' }],
    },
  });
  let time = new Date('2026-10-31T15:59:00Z');
  const port = notificationDomainPort(f.service, () => time);
  const snapshot = vi.spyOn(f.service, 'snapshot');
  const first = port.due(time).find((row) => row.sourceId === 'midnight-habit')!;
  expect(first.occurrenceKey).toBe('2026-10-31');
  const version = f.service.getVersion!();
  const reads = snapshot.mock.calls.length;
  time = new Date('2026-10-31T16:01:00Z');
  const next = port.due(time).find((row) => row.sourceId === 'midnight-habit')!;
  expect(next.occurrenceKey).toBe('2026-11-01');
  expect(next.scheduledAt).not.toBe(first.scheduledAt);
  expect(f.service.getVersion!()).toBe(version);
  expect(snapshot.mock.calls.length).toBe(reads);
});

it('validates every stale reminder with a bounded number of full snapshots even when desktop push is off', async () => {
  const f = await fixture();
  const task = f.command('create_task', { title: 'A task whose old reminder rule was removed' })
    .ids[0];
  f.command('import_entities', {
    entities: [
      ...Array.from({ length: 1205 }, (_, i) => ({
        kind: 'focusSession',
        entity: {
          id: 'history-' + i,
          mode: 'stopwatch',
          status: 'finished',
          segments: [{ start: '2025-01-01T08:00:00Z', end: '2025-01-01T08:25:00Z' }],
        },
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        kind: 'reminderEvent',
        entity: {
          id: 'stale-' + i,
          sourceType: 'task',
          sourceId: task,
          occurrenceKey: 'single',
          ruleId: 'removed-rule',
          scheduleRevision: 'old-source',
          scheduledAt: '2026-10-31T07:59:00Z',
          firstRaisedAt: '2026-10-31T07:59:00Z',
          title: 'Old reminder',
        },
      })),
    ],
  });
  const runtime = createToDooNotifications(f.service, f.options);
  cleanup.push(() => runtime.close());
  const insert = f.db.prepare(
    "INSERT INTO to_doo_push_outbox(id,event_id,generation,device_id,state,next_at) VALUES(?,?,0,'old-device','pending',0)",
  );
  for (let i = 0; i < 200; i++) insert.run('queue-' + i, 'stale-' + i);
  const snapshot = vi.spyOn(f.service, 'snapshot');
  await runtime.process();
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM to_doo_push_outbox WHERE state='cancelled'").get(),
  ).toEqual({ count: 200 });
  expect(f.service.getEntity('reminderEvent', 'stale-199')).toMatchObject({ userState: 'unread' });
  expect(snapshot.mock.calls.length).toBeLessThan(10);
});

it('refreshes cached reminder state after independent commands and exposes same-turn saves immediately', async () => {
  const f = await fixture();
  const task = f.command('create_task', {
    title: 'Live source',
    reminders: [{ id: 'absolute-rule', anchor: 'absolute', at: '2026-10-31T07:59:00Z' }],
  }).ids[0];
  const port = notificationDomainPort(f.service, f.now);
  const plan = port.due(f.now()).find((row) => row.sourceId === task)!;
  const event = port.save(
    { ...plan, id: reminderEventId(plan), firstRaisedAt: f.now().toISOString() },
    'save-event',
  );
  expect(port.events().find((row) => row.id === event.id)).toMatchObject({
    revision: event.revision,
  });
  expect(port.valid(event)).toBe(true);
  const source = f.service.getEntity('task', task)!;
  f.command('update_task', {
    id: task,
    expectedRevision: source.revision,
    patch: { reminders: [] },
  });
  expect(port.valid(event)).toBe(false);
  const settings = f.service.getEntity('settings', 'settings')!;
  f.command('save_entity', {
    kind: 'settings',
    entity: {
      ...settings,
      quietHours: { enabled: true, start: '23:00', end: '07:00', timeZone: 'UTC' },
    },
    expectedRevision: settings.revision,
  });
  expect(port.quietHours()).toMatchObject({ enabled: true, start: '23:00' });
});

it.each(['change-source', 'revoke-device', 'disable-host'] as const)(
  'rechecks live state after an in-flight delivery: %s',
  async (operation) => {
    const f = await fixture();
    const task = f.command('create_task', {
      title: 'A live delivery',
      reminders: [{ id: 'delivery-rule', anchor: 'absolute', at: '2026-10-31T07:59:00Z' }],
    }).ids[0];
    let release!: () => void,
      entered!: () => void,
      deliveries = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => {
        deliveries++;
        if (deliveries === 1) {
          entered();
          await gate;
        }
        return { status: 201, headers: {}, body: Buffer.alloc(0) };
      },
    });
    const runtime = createToDooNotifications(f.service, { ...f.options, network });
    cleanup.push(() => runtime.close());
    await runtime.configure({ enabled: true });
    const key = createECDH('prime256v1');
    key.generateKeys();
    const subscription = {
      endpoint: 'https://push.example/first',
      keys: {
        p256dh: key.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16, 1).toString('base64url'),
      },
    };
    await runtime.subscribe({ subscription, deviceName: 'first' });
    const second = await runtime.subscribe({
      subscription: { ...subscription, endpoint: 'https://push.example/second' },
      deviceName: 'second',
    });
    // Raising while the host is already active binds the event to this activation.
    const plan = notificationPlans(f.service.snapshot({ all: true }), f.now()).find(
      (row) => row.sourceId === task,
    )!;
    f.command('save_entity', {
      kind: 'reminderEvent',
      entity: { ...plan, id: reminderEventId(plan), firstRaisedAt: f.now().toISOString() },
    });
    const processing = runtime.process();
    await started;
    try {
      if (operation === 'change-source') {
        const current = f.service.getEntity('task', task)!;
        f.command('update_task', {
          id: task,
          expectedRevision: current.revision,
          patch: { reminders: [] },
        });
      } else if (operation === 'revoke-device') runtime.revoke(second.id);
      else await runtime.configure({ enabled: false });
    } finally {
      release();
    }
    await processing;
    expect(deliveries).toBe(1);
  },
);
