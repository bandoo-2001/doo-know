import type { ToDooCollections, ToDooQuery, ToDooStatistics, ToDooStatisticsAuthorization } from '../../../shared/to-doo-contracts.js';
import { addDays, dateTimeInstant, localDate } from './recurrence.js';

type StatisticsData = Pick<
  ToDooCollections,
  'tasks' | 'occurrences' | 'focusSessions' | 'habits' | 'habitEntries' | 'outcomes'
>;
type FocusDuration = Pick<
  ToDooCollections['focusSessions'][number],
  'mode' | 'status' | 'correctedMinutes' | 'segments'
>;

/** Actual segments are clipped to local-day boundaries. Corrections belong to the first segment's day. */
export function focusMinutes(
  session: FocusDuration,
  now = new Date(),
  start = -Infinity,
  end = Infinity,
) {
  if (session.mode === 'break' || session.status === 'cancelled') return 0;
  if (session.correctedMinutes !== null) {
    const first = Date.parse(session.segments[0]?.start ?? '');
    return first >= start && first < end ? session.correctedMinutes : 0;
  }
  return session.segments.reduce((total, part) => {
    const a = Math.max(start, Date.parse(part.start));
    const b = Math.min(
      end,
      Date.parse(part.end ?? (session.status === 'running' ? now.toISOString() : part.start)),
    );
    return total + Math.max(0, b - a) / 60000;
  }, 0);
}

/** Callers must supply their live read scope before aggregates are calculated. */
export function aggregateToDooStatistics(
  data: StatisticsData,
  query: ToDooQuery,
  scope: ToDooStatisticsAuthorization & { now: Date; timeZone: string },
): ToDooStatistics {
  const period = !!(query.from || query.to);
  const from = query.from ?? '0001-01-01',
    to = query.to ?? '9998-12-31';
  const start = period
    ? dateTimeInstant({ date: from, time: '00:00', timeZone: scope.timeZone }).getTime()
    : -Infinity;
  const end = period
    ? dateTimeInstant({ date: addDays(to, 1), time: '00:00', timeZone: scope.timeZone }).getTime()
    : Infinity;
  const within = (day: string | null | undefined) => !period || (!!day && day >= from && day <= to);
  const tasks = data.tasks.filter(
    (row) => !row.deletedAt && !row.archivedAt && scope.canRead('task', row),
  );
  const parents = new Set(tasks.map((row) => row.parentTaskId).filter(Boolean));
  const leafTasks = new Map(
    tasks.filter((row) => !parents.has(row.id)).map((row) => [row.id, row]),
  );
  const occurrences = data.occurrences.filter(
    (row) => !row.deletedAt && leafTasks.has(row.taskId) && scope.canRead('occurrence', row),
  );
  const completedByDay: Record<string, number> = Object.create(null);
  const result: ToDooStatistics = {
    scope: period ? 'period' : 'library',
    ...(period ? { from, to } : {}),
    completed: 0,
    pending: 0,
    overdue: 0,
    focusMinutes: 0,
    habitAmount: 0,
    outcomes: 0,
    byList: Object.create(null),
    ...(period ? { completedByDay } : {}),
  };
  for (const row of occurrences) {
    if (!['cancelled', 'skipped'].includes(row.status)) {
      const listId = leafTasks.get(row.taskId)!.listId ?? 'inbox';
      const progress = (result.byList[listId] ??= { total: 0, completed: 0 });
      progress.total++;
      if (row.status === 'done') progress.completed++;
    }
    if (row.status === 'done' && row.completedAt) {
      const day = localDate(new Date(row.completedAt), scope.timeZone);
      if (within(day)) {
        result.completed++;
        if (period) completedByDay[day] = (completedByDay[day] ?? 0) + 1;
      }
    } else if (['todo', 'doing', 'blocked'].includes(row.status)) {
      const day = row.due
        ? row.due.time === null
          ? row.due.date
          : localDate(dateTimeInstant(row.due), scope.timeZone)
        : row.scheduledDate;
      if (within(day)) {
        result.pending++;
        if (
          row.due &&
          dateTimeInstant(row.due).getTime() + (row.due.time === null ? 59999 : 0) <
            scope.now.getTime()
        )
          result.overdue++;
      }
    }
  }
  for (const row of data.focusSessions)
    if (!row.deletedAt && scope.canRead('focusSession', row))
      result.focusMinutes += focusMinutes(row, scope.now, start, end);
  result.focusMinutes = Math.round(result.focusMinutes * 100) / 100;
  const habits = new Set(
    data.habits.filter((row) => !row.deletedAt && scope.canRead('habit', row)).map((row) => row.id),
  );
  for (const row of data.habitEntries)
    if (
      !row.deletedAt &&
      !row.skipped &&
      habits.has(row.habitId) &&
      scope.canRead('habitEntry', row) &&
      within(row.localDate)
    )
      result.habitAmount += row.amount;
  for (const row of data.outcomes)
    if (
      !row.deletedAt &&
      scope.canRead('outcome', row) &&
      (!period || (Date.parse(row.createdAt) >= start && Date.parse(row.createdAt) < end))
    )
      result.outcomes++;
  return result;
}
