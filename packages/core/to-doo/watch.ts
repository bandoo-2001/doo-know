import { z } from 'zod';
import {
  toDooDate,
  toDooId,
  type ToDooDateTime,
  type ToDooEntityMap,
  type ToDooService,
  type ToDooSnapshot,
} from '../../../shared/to-doo-contracts.js';
import {
  getHabitGoalMode,
  getHabitPeriod,
  summarizeHabitPeriod,
} from '../../../shared/to-doo-habits.js';
import { HttpError } from '../errors.js';
import { dateTimeInstant, localDate } from './recurrence.js';

const pageSize = 12;
const offset = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .default(0);
const querySchema = z
  .object({
    listId: toDooId.optional(),
    today: z.literal('1').optional(),
    listOffset: offset,
    taskOffset: offset,
    habitOffset: offset,
  })
  .strict();
const requestId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const revision = { id: toDooId, expectedRevision: toDooId };
const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      requestId,
      action: z.literal('set_occurrence_status'),
      payload: z.object({ ...revision, status: z.literal('done') }).strict(),
    })
    .strict(),
  z
    .object({
      requestId,
      action: z.literal('start_focus'),
      payload: z
        .object({
          mode: z.enum(['pomodoro', 'stopwatch']),
          occurrenceId: toDooId.optional(),
          targetMinutes: z.number().int().positive().max(1440).optional(),
        })
        .strict()
        .refine((p) => p.mode !== 'stopwatch' || p.targetMinutes === undefined),
    })
    .strict(),
  z
    .object({
      requestId,
      action: z.literal('control_focus'),
      payload: z.object({ ...revision, operation: z.enum(['pause', 'resume', 'finish']) }).strict(),
    })
    .strict(),
  z
    .object({
      requestId,
      action: z.literal('checkin_habit'),
      payload: z
        .object({
          habitId: toDooId,
          localDate: toDooDate,
          amount: z.number().positive().max(1_000_000),
        })
        .strict(),
    })
    .strict(),
]);

type Query = z.output<typeof querySchema>;
type Session = ToDooEntityMap['focusSession'];
const isOpen = (occurrence: ToDooEntityMap['occurrence']) =>
  !occurrence.deletedAt && ['todo', 'doing', 'blocked'].includes(occurrence.status);
const isLive = (entity: { deletedAt: string | null; archivedAt?: string | null } | undefined) =>
  !!entity && !entity.deletedAt && !entity.archivedAt;
const clipped = (title: string) => Array.from(title).slice(0, 80).join('');

function displayDate(value: ToDooDateTime, zone: string) {
  return value.time && value.timeZone !== zone
    ? localDate(dateTimeInstant(value), zone)
    : value.date;
}

function taskRows(state: ToDooSnapshot, listIds: Set<string>, query: Query, date: string) {
  const zone = state.settings.timeZone;
  const plannedToday = new Set<string>();
  if (query.today) {
    for (const block of state.timeBlocks) {
      if (
        block.occurrenceId &&
        !block.deletedAt &&
        (block.allDay ? block.start.date : displayDate(block.start, zone)) === date
      ) {
        plannedToday.add(block.occurrenceId);
      }
    }
  }
  const tasks = new Map(state.tasks.filter(isLive).map((t) => [t.id, t]));
  return state.occurrences
    .flatMap((o) => {
      const task = tasks.get(o.taskId);
      if (!task || !isOpen(o)) return [];
      const listId = task.listId ?? 'inbox';
      if (!listIds.has(listId) || (query.listId && query.listId !== listId)) return [];
      const dueDate = o.due ? displayDate(o.due, zone) : o.scheduledDate;
      if (query.today && dueDate !== date && o.scheduledDate !== date && !plannedToday.has(o.id))
        return [];
      return [
        {
          id: o.id,
          title: clipped(o.titleOverride ?? task.title),
          revision: o.revision,
          listId,
          dueDate,
        },
      ];
    })
    .sort(
      (a, b) =>
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}

function habitRows(state: ToDooSnapshot, listIds: Set<string>, now: Date) {
  const entries = new Map<string, ToDooEntityMap['habitEntry'][]>();
  for (const entry of state.habitEntries) {
    if (entry.deletedAt) continue;
    const group = entries.get(entry.habitId);
    if (group) group.push(entry);
    else entries.set(entry.habitId, [entry]);
  }
  return state.habits
    .flatMap((habit) => {
      if (!isLive(habit) || !listIds.has(habit.listId ?? 'inbox')) return [];
      const date = localDate(now, habit.timeZone);
      const recorded = entries.get(habit.id) ?? [];
      const summary = summarizeHabitPeriod(habit, recorded, date);
      if (!summary.scheduledDates.includes(date)) return [];
      return [
        {
          id: habit.id,
          name: clipped(habit.name),
          date,
          mode: getHabitGoalMode(summary.rule),
          unit: summary.rule.unit,
          checked: recorded.some((e) => e.localDate === date && !e.skipped && e.amount > 0),
          amount: summary.amount,
          target: summary.target,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function focusRow(sessions: Session[], now: Date) {
  const session = sessions
    .filter((s) => !s.deletedAt && (s.status === 'running' || s.status === 'paused'))
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.id.localeCompare(a.id),
    )[0];
  if (!session) return null;
  const elapsedSeconds =
    session.correctedMinutes !== null
      ? session.correctedMinutes * 60
      : session.segments.reduce((seconds, segment) => {
          const start = Date.parse(segment.start);
          const end = segment.end
            ? Date.parse(segment.end)
            : session.status === 'running'
              ? now.getTime()
              : start;
          return seconds + Math.max(0, end - start) / 1000;
        }, 0);
  return {
    id: session.id,
    revision: session.revision,
    title: clipped(
      session.taskTitle || session.topicName || (session.mode === 'break' ? '休息' : '专注'),
    ),
    status: session.status,
    mode: session.mode,
    targetMinutes: session.targetMinutes,
    elapsedSeconds: Math.floor(elapsedSeconds),
  };
}

function projectState(state: ToDooSnapshot, query: Query) {
  const lists = [
    { id: 'inbox', name: '收集箱' },
    ...state.lists
      .filter((l) => l.id !== 'inbox' && isLive(l))
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id))
      .map((list) => ({ id: list.id, name: clipped(list.name) })),
  ];
  const listIds = new Set(lists.map((l) => l.id));
  const now = new Date(state.now);
  const date = localDate(now, state.settings.timeZone);
  const tasks = taskRows(state, listIds, query, date);
  const habits = habitRows(state, listIds, now);
  return {
    date,
    now: state.now,
    lists: lists.slice(query.listOffset, query.listOffset + pageSize),
    tasks: tasks.slice(query.taskOffset, query.taskOffset + pageSize),
    habits: habits.slice(query.habitOffset, query.habitOffset + pageSize),
    focus: focusRow(state.focusSessions, now),
    focusMinutes: state.settings.focusMinutes,
    hasMore: {
      tasks: tasks.length > query.taskOffset + pageSize,
      lists: lists.length > query.listOffset + pageSize,
      habits: habits.length > query.habitOffset + pageSize,
    },
  };
}

export function readWatchState(service: ToDooService, raw: unknown = {}) {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, '手表查询参数无效');
  return projectState(
    service.snapshot({
      all: true,
      kinds: [
        'task',
        'occurrence',
        'list',
        'habit',
        'habitEntry',
        'focusSession',
        ...(parsed.data.today ? ['timeBlock' as const] : []),
      ],
      filter: { statuses: ['todo', 'doing', 'blocked'] },
    }),
    parsed.data,
  );
}

function liveEntity<K extends 'habit' | 'task' | 'list' | 'occurrence' | 'focusSession'>(
  service: ToDooService,
  kind: K,
  id: string,
) {
  const entity = service.getEntity(kind, id) as ToDooEntityMap[K] | undefined;
  if (!entity || !isLive(entity)) throw new HttpError(409, '该项目已变化，请刷新手表');
  return entity;
}

function checkOccurrence(service: ToDooService, id: string) {
  const occurrence = liveEntity(service, 'occurrence', id);
  if (!isOpen(occurrence)) throw new HttpError(409, '任务状态已变化，请刷新手表');
  const task = liveEntity(service, 'task', occurrence.taskId);
  if (task.listId && task.listId !== 'inbox') liveEntity(service, 'list', task.listId);
}

export function runWatchCommand(service: ToDooService, raw: unknown) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, '手表操作参数无效');
  const command = { ...parsed.data, requestId: 'watch-' + parsed.data.requestId };
  // An accepted tap may be retried after the task, focus or calendar day has changed.
  // The core verifies the stored fingerprint before replaying an existing receipt.
  if (!service.getReceipt(command.requestId)) {
    switch (command.action) {
      case 'set_occurrence_status':
        checkOccurrence(service, command.payload.id);
        break;
      case 'start_focus':
        if (command.payload.occurrenceId) checkOccurrence(service, command.payload.occurrenceId);
        break;
      case 'control_focus': {
        const session = liveEntity(service, 'focusSession', command.payload.id);
        if (session.status !== 'running' && session.status !== 'paused')
          throw new HttpError(409, '专注状态已变化，请刷新手表');
        break;
      }
      case 'checkin_habit': {
        const habit = liveEntity(service, 'habit', command.payload.habitId);
        if (habit.listId && habit.listId !== 'inbox') liveEntity(service, 'list', habit.listId);
        const today = localDate(new Date(), habit.timeZone);
        if (command.payload.localDate !== today)
          throw new HttpError(409, '习惯的记录日期已变化，请刷新手表');
        const period = getHabitPeriod(habit, today);
        if (!period.scheduledDates.includes(today))
          throw new HttpError(409, '今天没有安排这个习惯');
        break;
      }
    }
  }
  const result = service.command(command);
  return { ok: true, replayed: result.replayed };
}
