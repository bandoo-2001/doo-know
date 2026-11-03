import { toDooFocusQuerySchema, type ToDooFocusQuery, type ToDooFocusHistory, type ToDooFocusTotals, type ToDooFocusTrend, type ToDooEntityMap, type ToDooStatisticsAuthorization } from '../../../shared/to-doo-contracts.js';
import type { createToDooStore } from './store.js';
import { canonical, toDooHash, toDooError } from './store.js';
import { addDays, dateTimeInstant, localDate } from './recurrence.js';
import { focusMinutes } from './statistics.js';

type Store = ReturnType<typeof createToDooStore>;
const started = (session: ToDooEntityMap['focusSession']) =>
  Date.parse(session.segments[0]?.start ?? session.createdAt);
const keyOf = (session: ToDooEntityMap['focusSession']) => new Date(started(session)).toISOString();

/** Full totals and the live session are computed before history selection or keyset paging. */
export function readToDooFocusHistory(
  store: Store,
  raw: ToDooFocusQuery = {},
  authorization?: ToDooStatisticsAuthorization,
): ToDooFocusHistory {
  const parsed = toDooFocusQuerySchema.safeParse(raw);
  if (!parsed.success) toDooError(parsed.error.issues[0]?.message ?? '专注查询无效', 400);
  const query = parsed.data;
  const settings = store.entities('settings', 1)[0];
  const timeZone = settings?.timeZone ?? 'UTC';
  const now = new Date(),
    today = localDate(now, timeZone);
  const midnight = (date: string) => dateTimeInstant({ date, time: '00:00', timeZone }).getTime();
  const dayStart = midnight(today),
    dayEnd = midnight(addDays(today, 1));
  const rangeStart = query.from ? midnight(query.from) : -Infinity;
  const rangeEnd = query.to ? midnight(addDays(query.to, 1)) : Infinity;
  const readable = store
    .entities('focusSession')
    .filter(
      (session) =>
        !session.deletedAt && (!authorization || authorization.canRead('focusSession', session)),
    );
  const active =
    readable
      .filter((session) => ['running', 'paused'].includes(session.status))
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.id.localeCompare(a.id),
      )[0] ?? null;
  const tasks = new Map(store.entities('task').map((task) => [task.id, task]));
  const occurrences = new Map(
    store.entities('occurrence').map((occurrence) => [occurrence.id, occurrence]),
  );
  const listIdentity = (session: ToDooEntityMap['focusSession']) => {
    if (session.listId) return session.listId;
    const occurrence = session.occurrenceId ? occurrences.get(session.occurrenceId) : undefined;
    const task = occurrence ? tasks.get(occurrence.taskId) : undefined;
    return task ? (task.listId ?? 'inbox') : undefined;
  };
  const listScope = query.listIds
    ? readable.filter((session) => {
        const list = listIdentity(session);
        return !!list && query.listIds!.includes(list);
      })
    : readable;
  const selected = listScope.filter(
    (session) =>
      (!query.ids || query.ids.includes(session.id)) &&
      (!query.topicId || session.topicId === query.topicId) &&
      (!query.unassigned || !session.topicId),
  );
  const completedPomodoros = listScope.filter(
    (session) => session.mode === 'pomodoro' && session.status === 'finished',
  ).length;
  const longBreak =
    completedPomodoros > 0 && completedPomodoros % (settings?.longBreakAfter ?? 4) === 0;
  const totals = (
    sessions: typeof readable,
    start = -Infinity,
    end = Infinity,
  ): ToDooFocusTotals => ({
    completed: sessions.filter(
      (session) =>
        session.mode !== 'break' &&
        session.status === 'finished' &&
        started(session) >= start &&
        started(session) < end,
    ).length,
    minutes:
      Math.round(
        sessions.reduce((sum, session) => sum + focusMinutes(session, now, start, end), 0) * 100,
      ) / 100,
  });
  const byTopic: ToDooFocusHistory['overview']['byTopic'] = Object.create(null);
  const topicGroups = new Map<string, typeof readable>();
  for (const session of listScope) {
    if (!session.topicId) continue;
    const key = session.topicId;
    const values = topicGroups.get(key) ?? [];
    values.push(session);
    topicGroups.set(key, values);
  }
  for (const [id, sessions] of topicGroups)
    byTopic[id] = { today: totals(sessions, dayStart, dayEnd), lifetime: totals(sessions) };
  const inRange = (session: ToDooEntityMap['focusSession']) => {
    if (!query.from && !query.to) return true;
    if (!session.segments.length || session.correctedMinutes !== null)
      return started(session) >= rangeStart && started(session) < rangeEnd;
    return session.segments.some((part) => {
      const start = Date.parse(part.start);
      const end = Date.parse(
        part.end ?? (session.status === 'running' ? now.toISOString() : part.start),
      );
      return (start >= rangeStart && start < rangeEnd) || (start < rangeEnd && end > rangeStart);
    });
  };
  const history = selected
    .filter(inRange)
    .sort((a, b) => keyOf(b).localeCompare(keyOf(a)) || b.id.localeCompare(a.id));
  const fingerprint = toDooHash(
    canonical({
      datasetId: store.datasetId,
      scope: authorization?.key ?? 'owner',
      ...query,
      cursor: undefined,
      listIds: query.listIds ? [...query.listIds].sort() : undefined,
    }),
  );
  let after: { at: string; id: string } | undefined;
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (
        cursor.fingerprint !== fingerprint ||
        typeof cursor.at !== 'string' ||
        typeof cursor.id !== 'string'
      )
        throw Error();
      after = cursor;
    } catch {
      toDooError('专注分页游标无效，请重新载入记录', 400);
    }
  }
  const remaining = after
    ? history.filter(
        (session) =>
          keyOf(session).localeCompare(after!.at) < 0 ||
          (keyOf(session) === after!.at && session.id.localeCompare(after!.id) < 0),
      )
    : history;
  const items = remaining.slice(0, query.limit),
    last = items.at(-1);
  const hasMore = remaining.length > items.length;
  const revision =
    (
      store.db.prepare('SELECT id FROM todo_transactions ORDER BY sequence DESC LIMIT 1').get() as
        | { id: string }
        | undefined
    )?.id ?? 'empty';
  let trend: ToDooFocusTrend | undefined;
  if (query.trendPeriod) {
    const period = query.trendPeriod,
      anchor = query.trendDate ?? today,
      round = (minutes: number) => Math.round(minutes * 100) / 100,
      nextMonth = (date: string) => {
        const value = new Date(date + 'T00:00:00Z');
        value.setUTCDate(1);
        value.setUTCMonth(value.getUTCMonth() + 1);
        return value.toISOString().slice(0, 10);
      };
    const from =
      period === 'week'
        ? addDays(
            anchor,
            -(
              (new Date(anchor + 'T00:00:00Z').getUTCDay() - (settings?.weekStartsOn ?? 1) + 7) %
              7
            ),
          )
        : period === 'month'
          ? anchor.slice(0, 7) + '-01'
          : anchor.slice(0, 4) + '-01-01';
    const end =
      period === 'week'
        ? addDays(from, 7)
        : period === 'month'
          ? nextMonth(from)
          : String(Number(from.slice(0, 4)) + 1).padStart(4, '0') + '-01-01';
    const points: ToDooFocusTrend['points'] = [];
    for (let date = from; date < end; ) {
      const next = period === 'year' ? nextMonth(date) : addDays(date, 1),
        startAt = midnight(date),
        endAt = midnight(next);
      points.push({
        date,
        minutes: round(
          selected.reduce((sum, session) => sum + focusMinutes(session, now, startAt, endAt), 0),
        ),
      });
      date = next;
    }
    trend = {
      period,
      from,
      to: addDays(end, -1),
      bucket: period === 'year' ? 'month' : 'day',
      totalMinutes: round(points.reduce((sum, point) => sum + point.minutes, 0)),
      points,
    };
  }
  return {
    datasetId: store.datasetId,
    revision,
    now: now.toISOString(),
    timeZone,
    items,
    active,
    ...(trend ? { trend } : {}),
    overview: {
      today: totals(selected, dayStart, dayEnd),
      lifetime: totals(selected),
      filtered: totals(selected, rangeStart, rangeEnd),
      byTopic,
      nextBreak: {
        kind: longBreak ? 'long' : 'short',
        minutes: longBreak
          ? (settings?.longBreakMinutes ?? 15)
          : (settings?.shortBreakMinutes ?? 5),
      },
    },
    page: {
      total: history.length,
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ fingerprint, at: keyOf(last), id: last.id })).toString(
              'base64url',
            )
          : null,
    },
  };
}
