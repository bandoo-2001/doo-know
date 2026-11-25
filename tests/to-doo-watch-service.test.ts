import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { readWatchState, runWatchCommand } from '../packages/core/to-doo/watch';

let root: string,
  db: ReturnType<typeof openDatabase>,
  service: ReturnType<typeof createToDooService>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-watch-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-secret',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-16T17:01Z');
});
afterEach(async () => {
  vi.useRealTimers();
  service.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const write = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const save = (kind: string, entity: Record<string, unknown>) =>
  write('save_entity', { kind, entity }).ids[0];
const watch = (action: string, payload: unknown) => ({ requestId: randomUUID(), action, payload });

it('returns only open task occurrences in the chosen live list, with paged results and no note data', () => {
  const list = save('list', { name: '工作' });
  const archived = save('list', { name: '隐藏清单', archivedAt: new Date().toISOString() });
  write('create_task', { title: '分组任务', description: 'private content', listId: list });
  write('create_task', { title: '隐藏任务', listId: archived });
  for (let i = 0; i < 13; i++)
    write('create_task', { title: 'Inbox ' + String(i).padStart(2, '0') });
  const state = readWatchState(service, { listId: list });
  expect(state.lists.map((l) => l.name)).toEqual(['收集箱', '工作']);
  expect(state.tasks).toHaveLength(1);
  expect(JSON.stringify(state)).not.toMatch(/private content|隐藏/);
  const first = readWatchState(service, { listId: 'inbox' });
  expect(first.tasks).toHaveLength(12);
  expect(first.hasMore.tasks).toBe(true);
  const last = readWatchState(service, { listId: 'inbox', taskOffset: '12' });
  expect(last.tasks.map((t) => t.title)).toEqual(['Inbox 12']);
  expect(last.hasMore.tasks).toBe(false);
  const task = state.tasks[0];
  const done = watch('set_occurrence_status', {
    id: task.id,
    expectedRevision: task.revision,
    status: 'done',
  });
  expect(runWatchCommand(service, done)).toEqual({ ok: true, replayed: false });
  expect(runWatchCommand(service, done)).toEqual({ ok: true, replayed: true });
  expect(readWatchState(service, { listId: list }).tasks).toHaveLength(0);
  expect(() =>
    runWatchCommand(service, watch('delete_entity', { kind: 'task', id: task.id })),
  ).toThrow();
  expect(() => readWatchState(service, { all: true })).toThrow();
});

it('checks in on the habit’s local day and replays a quantity tap even after midnight', () => {
  const fields = { startDate: '2026-11-01', timeZone: 'Asia/Shanghai' };
  const daily = save('habit', { ...fields, name: '阅读', goalMode: 'checkin' });
  const quantity = save('habit', {
    ...fields,
    name: '饮水',
    goalMode: 'quantity',
    unit: '杯',
    target: 8,
  });
  save('habit', { ...fields, name: '暂停', goalMode: 'checkin', pausedDates: ['2026-11-17'] });
  const current = readWatchState(service);
  expect(current.habits).toHaveLength(2);
  expect(current.habits.map((h) => h.date)).toEqual(['2026-11-17', '2026-11-17']);
  for (let i = 0; i < 2; i++)
    runWatchCommand(
      service,
      watch('checkin_habit', { habitId: daily, localDate: '2026-11-17', amount: 1 }),
    );
  const tap = watch('checkin_habit', { habitId: quantity, localDate: '2026-11-17', amount: 2.5 });
  runWatchCommand(service, tap);
  expect(runWatchCommand(service, tap).replayed).toBe(true);
  const habits = readWatchState(service).habits;
  expect(habits.find((h) => h.id === daily)).toMatchObject({ amount: 1, checked: true });
  expect(habits.find((h) => h.id === quantity)).toMatchObject({
    amount: 2.5,
    checked: true,
    unit: '杯',
  });
  vi.setSystemTime('2026-11-17T17:01Z');
  expect(runWatchCommand(service, tap).replayed).toBe(true);
  expect(() => runWatchCommand(service, { ...tap, requestId: randomUUID() })).toThrow(/日期/);
  expect(() =>
    runWatchCommand(service, { ...tap, payload: { ...(tap.payload as object), amount: 3 } }),
  ).toThrow(/相同请求/);
  expect(readWatchState(service).habits.find((h) => h.id === daily)).toMatchObject({
    amount: 0,
    checked: false,
  });
});

it('uses the same focus clock as the web client and rejects stale or unsupported actions', () => {
  write('create_task', { title: '写报告' });
  const task = readWatchState(service).tasks[0];
  runWatchCommand(
    service,
    watch('start_focus', { mode: 'pomodoro', targetMinutes: 15, occurrenceId: task.id }),
  );
  vi.setSystemTime('2026-11-16T17:03Z');
  const active = readWatchState(service).focus!;
  expect(active).toMatchObject({
    title: '写报告',
    status: 'running',
    elapsedSeconds: 120,
    targetMinutes: 15,
  });
  const control = (operation: string, revision = active.revision) =>
    watch('control_focus', {
      id: active.id,
      expectedRevision: revision,
      operation,
    });
  runWatchCommand(service, control('pause'));
  vi.setSystemTime('2026-11-16T17:09Z');
  const paused = readWatchState(service).focus!;
  expect(paused).toMatchObject({ status: 'paused', elapsedSeconds: 120 });
  expect(() => runWatchCommand(service, control('finish'))).toThrow(/版本/);
  expect(() => runWatchCommand(service, control('correct', paused.revision))).toThrow();
  runWatchCommand(service, control('resume', paused.revision));
  runWatchCommand(service, control('finish', readWatchState(service).focus!.revision));
  expect(readWatchState(service).focus).toBeNull();
  expect(service.focusHistory().items[0].status).toBe('finished');
});

it('matches today by local scheduled dates, deadlines and timed plans, without adding unscheduled or tomorrow tasks', () => {
  const date = '2026-11-16';
  write('create_task', { title: '无日期' });
  write('create_task', { title: '今天到期', due: { date, time: null, timeZone: 'UTC' } });
  write('create_task', {
    title: '今天的计划',
    plan: { date: '2026-11-17', time: '00:30', timeZone: 'Asia/Shanghai' },
  });
  write('create_task', {
    title: '明天的计划',
    plan: { date: '2026-11-17', time: null, timeZone: 'UTC' },
  });
  const state = readWatchState(service, { today: '1' });
  expect(state.tasks.map((t) => t.title).sort()).toEqual(['今天到期', '今天的计划'].sort());
});

it('matches floating deadlines and plans by their wall date on the watch', () => {
  const fixed = { date: '2026-11-17', time: '00:30', timeZone: 'Asia/Shanghai' };
  const floating = { ...fixed, timeMode: 'floating' };
  write('create_task', { title: 'Fixed deadline', due: fixed });
  write('create_task', { title: 'Floating deadline', due: floating });
  write('create_task', { title: 'Fixed plan', plan: fixed });
  write('create_task', { title: 'Floating plan', plan: floating });

  const all = readWatchState(service).tasks;
  expect(all.find((row) => row.title === 'Fixed deadline')?.dueDate).toBe('2026-11-16');
  expect(all.find((row) => row.title === 'Floating deadline')?.dueDate).toBe('2026-11-17');
  const today = readWatchState(service, { today: '1' });
  expect(today.tasks.map((row) => row.title).sort()).toEqual(['Fixed deadline', 'Fixed plan']);
});

it('paginates materialized repetitions beyond the default snapshot limit', () => {
  const id = write('create_task', {
    title: '每日练习',
    recurrence: {
      id: 'daily-series',
      frequency: 'daily',
      anchorDate: '2026-01-01',
      count: 1010,
    },
  }).ids[0];
  write('materialize_occurrences', { taskId: id, from: '2026-01-01', to: '2028-10-10' });
  const final = readWatchState(service, { taskOffset: '1008' });
  expect(final.tasks).toHaveLength(2);
  expect(final.tasks.every((t) => t.title === '每日练习')).toBe(true);
  expect(final.hasMore.tasks).toBe(false);
});
