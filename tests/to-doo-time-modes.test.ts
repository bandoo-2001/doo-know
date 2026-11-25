import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import {
  createToDooNotifications,
  notificationPlans,
  reminderEventId,
  reminderSourceValid,
} from '../packages/core/to-doo/notifications.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import type { ToDooOccurrence } from '../shared/to-doo-contracts.js';

let root: string, dataRoot: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const occurrenceFor = (taskId: string) =>
  service.snapshot({ taskIds: [taskId], kind: 'occurrence' }).occurrences[0]!;

function setTimeZone(timeZone: string) {
  const settings = service.snapshot().settings;
  command('save_entity', {
    kind: 'settings',
    entity: { ...settings, timeZone },
    expectedRevision: settings.revision,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-time-modes-'));
  dataRoot = join(root, 'data');
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot,
    origin: 'http://127.0.0.1:5173',
    secret: 'isolated-time-mode-test',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(dataRoot);
  service = createToDooService(config, db, noteService(config, db));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T13:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  service.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

it('recalculates deadline filters and totals from the workspace zone without moving fixed tasks', () => {
  const due = { date: '2026-10-30', time: '09:00', timeZone: 'UTC' };
  const fixed = command('create_task', { title: 'Fixed', due }).ids[0];
  const floating = command('create_task', {
    title: 'Floating',
    due: { ...due, timeMode: 'floating' },
  }).ids[0];
  const occurrence = occurrenceFor(floating);
  const overdue = () =>
    service.snapshot({ kind: 'occurrence', filter: { overdue: true } }).occurrences.map(
      (row) => row.taskId,
    );
  expect(overdue()).toEqual([fixed, floating]);
  setTimeZone('America/Los_Angeles');
  expect(overdue()).toEqual([fixed]);
  expect(service.statistics().overdue).toBe(1);
  expect(occurrenceFor(floating)).toEqual(occurrence);

  const boardDate = { date: '2026-10-31', time: '01:00', timeZone: 'UTC' };
  const nextFixed = command('create_task', { title: 'Fixed next day', due: boardDate }).ids[0];
  command('create_task', {
    title: 'Floating next day',
    due: { ...boardDate, timeMode: 'floating' },
  });
  expect(
    service.snapshot({ kind: 'occurrence', filter: { dueBefore: '2026-10-30' } })
      .occurrences.map((row) => row.taskId),
  ).toEqual([fixed, floating, nextFixed]);
});

it('materializes floating recurrence in wall time and computes completion successors in the workspace zone', () => {
  setTimeZone('Asia/Shanghai');
  const rule = {
    id: 'daily-rule',
    frequency: 'daily',
    anchorDate: '2026-10-29',
    time: '10:00',
    timeZone: 'UTC',
    timeMode: 'floating',
  };
  const daily = command('create_task', { title: 'Daily', recurrence: rule }).ids[0];
  const day = () =>
    service.snapshot({ kind: 'occurrence', taskIds: [daily] }).occurrences.find(
      (row) => row.scheduledDate === '2026-10-30',
    )!;
  expect(day().due).toEqual({
    date: '2026-10-30', time: '10:00', timeZone: 'UTC', timeMode: 'floating',
  });
  const dailyId = day().id;
  setTimeZone('Pacific/Kiritimati');
  command('materialize_occurrences', { taskId: daily, from: '2026-10-30', to: '2026-10-31' });
  expect(day().id).toBe(dailyId);

  const repeat = command('create_task', {
    title: 'Repeat after completion',
    recurrence: { ...rule, id: 'after-rule', frequency: 'after_completion' },
  }).ids[0];
  const first = occurrenceFor(repeat);
  command('set_occurrence_status', {
    id: first.id,
    expectedRevision: first.revision,
    status: 'done',
    at: '2026-10-29T22:30:00.000Z',
  });
  expect(
    service.snapshot({ kind: 'occurrence', taskIds: [repeat] }).occurrences.find(
      (row) => row.predecessorId === first.id,
    ),
  ).toMatchObject({
    scheduledDate: '2026-10-31',
    due: { date: '2026-10-31', time: '10:00', timeZone: 'UTC', timeMode: 'floating' },
  });
});

it('restores fixed and floating recurring schedules from a library copy into a fresh database', async () => {
  setTimeZone('America/Los_Angeles');
  const original = (['fixed', 'floating'] as const).map((timeMode) => {
    const taskId = command('create_task', {
      title: timeMode,
      recurrence: {
        id: `daily-${timeMode}`,
        frequency: 'daily',
        anchorDate: '2026-10-30',
        count: 1,
        time: '09:00',
        timeZone: 'UTC',
        timeMode,
      },
    }).ids[0];
    return { taskId, timeMode, occurrenceId: occurrenceFor(taskId).id };
  });
  const cloneConfig = {
    knowledgeRoot: join(root, 'cloned-knowledge'),
    dataRoot: join(root, 'cloned-data'),
    origin: 'http://127.0.0.1:5173',
    secret: 'isolated-time-mode-clone-test',
  };
  await cp(join(root, 'knowledge'), cloneConfig.knowledgeRoot, { recursive: true });
  const cloneDb = openDatabase(cloneConfig.dataRoot);
  let clone: ReturnType<typeof createToDooService> | undefined;
  try {
    clone = createToDooService(cloneConfig, cloneDb, noteService(cloneConfig, cloneDb));
    const state = clone.snapshot({ all: true });
    expect(state.datasetId).toBe(service.snapshot().datasetId);
    expect(state.settings.timeZone).toBe('America/Los_Angeles');
    for (const { taskId, timeMode, occurrenceId } of original) {
      expect(state.tasks.find((task) => task.id === taskId)?.recurrence).toMatchObject({
        time: '09:00', timeZone: 'UTC', timeMode,
      });
      expect(state.occurrences.find((row) => row.id === occurrenceId)?.due).toEqual({
        date: '2026-10-30', time: '09:00', timeZone: 'UTC', timeMode,
      });
    }
    expect(
      clone.snapshot({ kind: 'occurrence', filter: { overdue: true } }).occurrences.map(
        (row) => row.id,
      ),
    ).toEqual([original[0]!.occurrenceId]);
  } finally {
    clone?.close();
    cloneDb.close();
  }
});

it('uses the workspace zone for calendar intervals and plan conflicts', () => {
  setTimeZone('Asia/Shanghai');
  const task = command('create_task', { title: 'Floating block' }).ids[0];
  const item = occurrenceFor(task);
  const start = { date: '2026-10-30', time: '00:30', timeZone: 'UTC', timeMode: 'floating' };
  command('save_entity', {
    kind: 'timeBlock',
    entity: { occurrenceId: item.id, start, durationMinutes: 60 },
  });
  const calendar = (date: string) =>
    service.snapshot({ kind: 'timeBlock', from: date, to: date }).timeBlocks;
  expect(calendar('2026-10-30')).toHaveLength(1);

  const other = occurrenceFor(command('create_task', { title: 'Fixed block' }).ids[0]);
  const preview = () =>
    command('preview_plan', {
      name: 'Proposed fixed UTC block',
      changes: [{
        occurrenceId: other.id,
        expectedRevision: other.revision,
        start: { date: '2026-10-29', time: '17:00', timeZone: 'UTC' },
        durationMinutes: 15,
      }],
    }).preview;
  expect(preview()?.conflicts).not.toHaveLength(0);
  setTimeZone('UTC');
  expect(preview()?.conflicts).toHaveLength(0);
});

it('keeps one reminder identity when a workspace zone change changes the earliest plan block', () => {
  const task = command('create_task', {
    title: 'Mixed plan blocks',
    reminders: [{ id: 'start-reminder', anchor: 'plan' }],
  }).ids[0];
  const occurrenceId = occurrenceFor(task).id;
  for (const start of [
    { date: '2026-10-30', time: '08:00', timeZone: 'UTC', timeMode: 'floating' },
    { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
  ])
    command('save_entity', {
      kind: 'timeBlock',
      entity: { occurrenceId, start, durationMinutes: 30 },
    });
  const plan = () => notificationPlans(service.snapshot({ all: true }), new Date())[0]!;
  const before = plan();
  expect(before.scheduledAt).toBe('2026-10-30T08:00:00.000Z');
  setTimeZone('America/Los_Angeles');
  expect(plan().scheduledAt).toBe('2026-10-30T09:00:00.000Z');
  expect(reminderEventId(plan())).toBe(reminderEventId(before));
});

it('moves an unraised floating reminder in place and avoids replay after the workspace zone changes again', async () => {
  vi.setSystemTime(new Date('2026-10-30T08:00:00.000Z'));
  const task = command('create_task', {
    title: 'Floating reminder',
    due: { date: '2026-10-30', time: '09:00', timeZone: 'UTC', timeMode: 'floating' },
    reminders: [{ id: 'morning', anchor: 'due' }],
  }).ids[0];
  const planFor = () =>
    notificationPlans(service.snapshot({ all: true }), new Date()).find(
      (plan) => plan.sourceId === task,
    )!;
  const plan = planFor(), id = reminderEventId(plan);
  command('save_entity', { kind: 'reminderEvent', entity: { ...plan, id } });
  const pending = () => service.snapshot({ all: true }).reminderEvents.find((event) => event.id === id)!;
  const notifications = createToDooNotifications(service, {
    db,
    dataRoot,
    installationId: 'test-install',
    origin: 'http://127.0.0.1:5173',
  });
  try {
    expect(pending()).toMatchObject({ scheduledAt: '2026-10-30T09:00:00.000Z', firstRaisedAt: null });
    setTimeZone('America/Los_Angeles');
    vi.setSystemTime(new Date('2026-10-30T09:30:00.000Z'));
    expect(reminderEventId(planFor())).toBe(id);
    expect(reminderSourceValid(service.snapshot({ all: true }), pending(), new Date())).toBe(false);
    await notifications.process();
    expect(pending()).toMatchObject({ scheduledAt: '2026-10-30T16:00:00.000Z', firstRaisedAt: null });

    vi.setSystemTime(new Date('2026-10-30T16:00:00.000Z'));
    await notifications.process();
    const raised = pending();
    expect(raised.firstRaisedAt).toBe('2026-10-30T16:00:00.000Z');
    setTimeZone('UTC');
    await notifications.process();
    expect(service.snapshot({ all: true }).reminderEvents).toEqual([raised]);
    expect(reminderSourceValid(service.snapshot({ all: true }), raised, new Date())).toBe(true);
    expect((service.getEntity('occurrence', occurrenceFor(task).id) as ToDooOccurrence).due?.timeMode)
      .toBe('floating');
  } finally {
    await notifications.close();
  }
});
