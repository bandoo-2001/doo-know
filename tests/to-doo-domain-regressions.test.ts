import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import {
  notificationPlans,
  reminderEventId,
  reminderSourceValid,
} from '../packages/core/to-doo/notifications';
import { toDooEntitySchemas, type ToDooOccurrence } from '../shared/to-doo-contracts';
import { expandRecurrence } from '../packages/core/to-doo/recurrence';
import { toDooRecurrenceSchema } from '../shared/to-doo-contracts';

let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-domain-regressions-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'test-only-secret',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
});

afterEach(async () => {
  vi.useRealTimers();
  service?.close();
  if (db?.open) db.close();
  await rm(root, { recursive: true, force: true });
});

it('retains the generated completion timestamp when a complete occurrence draft is saved', () => {
  command('create_task', { title: 'Save completion' });
  const original = service.snapshot({ all: true }).occurrences[0];
  command('save_entity', {
    kind: 'occurrence',
    entity: { ...original, status: 'done', resultSummary: 'Delivered' },
    expectedRevision: original.revision,
  });
  const saved = service.getEntity('occurrence', original.id)! as ToDooOccurrence;
  expect(saved).toMatchObject({ status: 'done', resultSummary: 'Delivered' });
  expect(saved.completedAt).toEqual(expect.any(String));
  const day = saved.completedAt!.slice(0, 10);
  expect(service.snapshot({ from: day, to: day }).statistics.completed).toBe(1);
});

it('clears the old completion timestamp when a complete occurrence draft is reopened', () => {
  command('create_task', { title: 'Reopen completion' });
  let original = service.snapshot({ all: true }).occurrences[0];
  command('set_occurrence_status', {
    id: original.id,
    expectedRevision: original.revision,
    status: 'done',
    at: '2026-10-29T10:00:00.000Z',
  });
  original = service.getEntity('occurrence', original.id)! as ToDooOccurrence;
  command('save_entity', {
    kind: 'occurrence',
    entity: { ...original, status: 'todo' },
    expectedRevision: original.revision,
  });
  expect(service.getEntity('occurrence', original.id)).toMatchObject({
    status: 'todo',
    completedAt: null,
  });
});

it('invalidates a raised reminder after the same rule is rescheduled in a task batch', () => {
  command('create_task', {
    title: 'Batch reminder edit',
    due: { date: '2026-10-30', time: '10:00', timeZone: 'UTC' },
    reminders: [{ id: 'same-rule', anchor: 'due', offsetMinutes: -60 }],
  });
  const before = service.snapshot({ all: true });
  const plan = notificationPlans(before, new Date('2026-10-30T09:00:00.000Z'))[0];
  const event = toDooEntitySchemas.reminderEvent.parse({
    ...plan,
    id: reminderEventId(plan),
    revision: 'raised-reminder',
    createdAt: '2026-10-30T09:00:00.000Z',
    updatedAt: '2026-10-30T09:00:00.000Z',
  });
  expect(reminderSourceValid(before, event, new Date('2026-10-30T09:00:00.000Z'))).toBe(true);
  const task = before.tasks[0];
  command('batch_tasks', {
    ids: [task.id],
    expectedRevisions: { [task.id]: task.revision },
    operation: 'patch',
    patch: { reminders: [{ id: 'same-rule', anchor: 'due', offsetMinutes: 0 }] },
    includeDescendants: false,
  });
  const after = service.snapshot({ all: true });
  const replacement = notificationPlans(after, new Date('2026-10-30T09:00:00.000Z'))[0];
  expect(reminderEventId(replacement)).not.toBe(event.id);
  expect(reminderSourceValid(after, event, new Date('2026-10-30T09:00:00.000Z'))).toBe(false);
});

it('applies the recurrence result limit to additional dates as well as regular dates', () => {
  const rule = toDooRecurrenceSchema.parse({
    id: 'extra-dates',
    frequency: 'daily',
    anchorDate: '2026-10-29',
    count: 1,
    additionalDates: ['2026-10-30', '2026-10-31'],
  });
  expect(() => expandRecurrence(rule, '2026-10-29', '2026-10-31', 2)).toThrow(/上限/);
});

it.each(['task', 'batch', 'list'] as const)(
  'keeps an independently deleted period deleted when a %s is deleted again and restored',
  (scope) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    const listId = command('save_entity', { kind: 'list', entity: { name: 'Repeat list' } }).ids[0];
    const taskId = command('create_task', {
      title: 'Recurring task',
      listId,
      recurrence: {
        id: 'preserve-period-tombstone',
        frequency: 'daily',
        anchorDate: '2026-10-29',
        count: 2,
      },
    }).ids[0];
    const periods = service.snapshot({ all: true }).occurrences;
    const original = periods[0];
    command('delete_entity', {
      kind: 'occurrence',
      id: original.id,
      expectedRevision: original.revision,
    });
    const deletedPeriod = service.getEntity('occurrence', original.id)!;
    for (const restore of [false, false, true]) {
      if (scope === 'batch') {
        const task = service.getEntity('task', taskId)!;
        command('batch_tasks', {
          ids: [taskId],
          expectedRevisions: { [taskId]: task.revision },
          operation: restore ? 'restore' : 'delete',
          includeDescendants: true,
        });
      } else {
        const kind = scope === 'task' ? 'task' : 'list';
        const entity = service.getEntity(kind, kind === 'task' ? taskId : listId)!;
        command('delete_entity', {
          kind,
          id: entity.id,
          expectedRevision: entity.revision,
          cascade: true,
          restore,
        });
      }
    }
    expect(service.getEntity('occurrence', original.id)).toEqual(deletedPeriod);
    expect(service.snapshot().occurrences.map((period) => period.id)).toEqual([periods[1].id]);
  },
);

it.each(['update', 'batch'] as const)(
  'clears the old section when a task changes lists via %s',
  (action) => {
    const first = command('save_entity', { kind: 'list', entity: { name: 'First' } }).ids[0];
    const second = command('save_entity', { kind: 'list', entity: { name: 'Second' } }).ids[0];
    const sectionId = command('save_entity', {
      kind: 'section',
      entity: { name: 'First section', listId: first },
    }).ids[0];
    const taskId = command('create_task', { title: 'Move lists', listId: first, sectionId }).ids[0];
    const task = service.getEntity('task', taskId)!;
    if (action === 'update')
      command('update_task', {
        id: taskId,
        expectedRevision: task.revision,
        patch: { listId: second },
      });
    else
      command('batch_tasks', {
        ids: [taskId],
        expectedRevisions: { [taskId]: task.revision },
        operation: 'patch',
        patch: { listId: second },
        includeDescendants: false,
      });
    expect(service.getEntity('task', taskId)).toMatchObject({ listId: second, sectionId: null });
  },
);

it('rejects task creation with a section that belongs to another list', () => {
  const first = command('save_entity', { kind: 'list', entity: { name: 'First' } }).ids[0];
  const second = command('save_entity', { kind: 'list', entity: { name: 'Second' } }).ids[0];
  const sectionId = command('save_entity', {
    kind: 'section',
    entity: { name: 'First section', listId: first },
  }).ids[0];
  expect(() =>
    command('create_task', { title: 'Invalid section', listId: second, sectionId }),
  ).toThrow(/分组|清单/);
  expect(service.snapshot({ all: true }).tasks).toHaveLength(0);
});

it('compares dueBefore in the dataset display zone while preserving date-only deadlines', () => {
  const settings = service.snapshot().settings;
  command('save_entity', {
    kind: 'settings',
    entity: { ...settings, timeZone: 'Asia/Shanghai' },
    expectedRevision: settings.revision,
  });
  const included = command('create_task', {
    title: 'Previous display date',
    due: { date: '2026-10-30', time: '00:30', timeZone: 'Pacific/Kiritimati' },
  }).ids[0];
  command('create_task', {
    title: 'Next display date',
    due: { date: '2026-10-29', time: '23:30', timeZone: 'America/Los_Angeles' },
  });
  const allDay = command('create_task', {
    title: 'Date-only deadline',
    due: { date: '2026-10-29', time: null, timeZone: 'Pacific/Honolulu' },
  }).ids[0];
  command('create_task', { title: 'No deadline' });
  const state = service.snapshot({ kind: 'occurrence', filter: { dueBefore: '2026-10-29' } });
  expect(state.occurrences.map((item) => item.taskId)).toEqual([included, allDay]);
  expect(state.page.total).toBe(2);
});

it.each(['timeBlock', 'calendarEvent'] as const)(
  'pages all-day %s spans intersecting the requested dates, excluding the end date',
  (kind) => {
    const ids = [
      ['2026-10-28', '2026-10-30'],
      ['2026-10-28', '2026-10-31'],
      ['2026-10-30', '2026-10-31'],
      ['2026-10-31', '2026-11-01'],
    ].map(
      ([date, end], index) =>
        command('save_entity', {
          kind,
          entity: {
            title: 'All-day span ' + index,
            start: { date, time: null, timeZone: 'Pacific/Kiritimati' },
            allDay: true,
            ...(kind === 'timeBlock'
              ? { dateEndExclusive: end, durationMinutes: 1440 }
              : {
                  uid: 'all-day-' + index,
                  end: { date: end, time: null, timeZone: 'Pacific/Kiritimati' },
                }),
          },
        }).ids[0],
    );
    const query = { kind, from: '2026-10-30', to: '2026-10-30', limit: 1 };
    const first = service.snapshot(query);
    const collection = kind === 'timeBlock' ? 'timeBlocks' : 'calendarEvents';
    expect(first.page.total).toBe(2);
    expect(first[collection].map((item) => item.id)).toEqual([ids[1]]);
    const second = service.snapshot({ ...query, cursor: first.page.nextCursor! });
    expect(second[collection].map((item) => item.id)).toEqual([ids[2]]);
    expect(second.page.nextCursor).toBeNull();
  },
);

it.each(['timeBlock', 'calendarEvent'] as const)(
  'includes timed %s intervals that overlap a day in the display zone',
  (kind) => {
    const settings = service.snapshot().settings;
    command('save_entity', {
      kind: 'settings',
      entity: { ...settings, timeZone: 'Asia/Shanghai' },
      expectedRevision: settings.revision,
    });
    const ids = [
      ['2026-10-29', '15:00', '2026-10-29', '16:00', 60],
      ['2026-10-29', '15:30', '2026-10-29', '17:30', 120],
      ['2026-10-30', '15:30', '2026-10-30', '16:30', 60],
      ['2026-10-30', '16:00', '2026-10-30', '17:00', 60],
    ].map(
      ([date, time, endDate, endTime, durationMinutes], index) =>
        command('save_entity', {
          kind,
          entity: {
            title: 'Timed span ' + index,
            start: { date, time, timeZone: 'UTC' },
            ...(kind === 'timeBlock'
              ? { durationMinutes }
              : { uid: 'timed-' + index, end: { date: endDate, time: endTime, timeZone: 'UTC' } }),
          },
        }).ids[0],
    );
    const state = service.snapshot({ kind, from: '2026-10-30', to: '2026-10-30' });
    const collection = kind === 'timeBlock' ? 'timeBlocks' : 'calendarEvents';
    expect(state[collection].map((item) => item.id)).toEqual([ids[1], ids[2]]);
    expect(state.page.total).toBe(2);
  },
);

it('keeps a calendar interval that crosses a repeated local hour during a DST fallback', () => {
  const settings = service.snapshot().settings;
  command('save_entity', {
    kind: 'settings',
    entity: { ...settings, timeZone: 'America/New_York' },
    expectedRevision: settings.revision,
  });
  const id = command('save_entity', {
    kind: 'calendarEvent',
    entity: {
      uid: 'fallback',
      title: 'Repeated local hour',
      start: { date: '2026-11-01', time: '05:30', timeZone: 'UTC' },
      end: { date: '2026-11-01', time: '06:15', timeZone: 'UTC' },
    },
  }).ids[0];
  const state = service.snapshot({ kind: 'calendarEvent', from: '2026-11-01', to: '2026-11-01' });
  expect(state.calendarEvents.map((event) => event.id)).toEqual([id]);
});
