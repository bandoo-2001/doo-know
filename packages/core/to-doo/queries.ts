import {
  TO_DOO_COLLECTIONS,
  toDooFilterSchema,
  type ToDooFilterGroup,
  type ToDooFilterCondition,
  type ToDooSnapshot,
  type ToDooQuery,
  type ToDooEntityKind,
  type ToDooStatistics,
  type ToDooStatisticsAuthorization,
  type ToDooEntity,
  type ToDooFilter,
  type ToDooDateTime,
  type ToDooEntityMap,
} from '../../../shared/to-doo-contracts.js';
import type { createToDooStore } from './store.js';
import { toDooError, toDooHash, canonical, parseEntity } from './store.js';
import { dateTimeInstant, addDays, localDate } from './recurrence.js';
import { aggregateToDooStatistics } from './statistics.js';
export { focusMinutes } from './statistics.js';
type Store = ReturnType<typeof createToDooStore>;
const queryConnections = new WeakSet<Store['db']>();
function installQueryFunctions(db: Store['db']) {
  if (queryConnections.has(db)) return;
  db.function('to_doo_timestamp_ms', { deterministic: true }, (value) => {
    if (typeof value !== 'string') return null;
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? instant : null;
  });
  db.function('to_doo_display_date', { deterministic: true }, (json, timeZone) => {
    if (typeof json !== 'string' || typeof timeZone !== 'string') return null;
    const value = JSON.parse(json) as ToDooDateTime;
    return value.time === null ? value.date : localDate(dateTimeInstant(value), timeZone);
  });
  db.function(
    'to_doo_interval_overlap',
    { deterministic: true },
    (json, from, to, rangeStart, rangeEnd) => {
      if (
        typeof json !== 'string' ||
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        typeof rangeStart !== 'number' ||
        typeof rangeEnd !== 'number'
      )
        return 0;
      const value = JSON.parse(json) as
        | ToDooEntityMap['timeBlock']
        | ToDooEntityMap['calendarEvent'];
      if (value.allDay) {
        const end =
          'durationMinutes' in value
            ? (value.dateEndExclusive ??
              addDays(value.start.date, Math.max(1, Math.ceil(value.durationMinutes / 1440))))
            : (value.end?.date ?? addDays(value.start.date, 1));
        return value.start.date <= to && end > from && end > value.start.date ? 1 : 0;
      }
      const start = dateTimeInstant(value.start, '00:00').getTime();
      const end =
        'durationMinutes' in value
          ? start + value.durationMinutes * 60000
          : value.end
            ? dateTimeInstant(value.end, '00:00').getTime()
            : start + 30 * 60000;
      return start < rangeEnd && end > rangeStart && end > start ? 1 : 0;
    },
  );
  queryConnections.add(db);
}
function recentAtSql(kind: ToDooEntityKind) {
  const field =
    kind === 'reminderEvent'
      ? "COALESCE(json_extract(e.data,'$.firstRaisedAt'),json_extract(e.data,'$.scheduledAt'))"
      : "json_extract(e.data,'$." +
        (kind === 'focusSession'
          ? 'segments[0].start'
          : kind === 'record'
            ? 'occurredAt'
            : kind === 'review'
              ? 'capturedAt'
              : kind === 'habitEntry'
                ? 'localDate'
                : 'createdAt') +
        "')";
  return (
    'COALESCE(to_doo_timestamp_ms(' +
    field +
    "),to_doo_timestamp_ms(json_extract(e.data,'$.createdAt')))"
  );
}
function queryFingerprint(store: Store, query: ToDooQuery) {
  return toDooHash(
    canonical({
      ...(query.sort === 'recent' ? { datasetId: store.datasetId } : {}),
      ...query,
      cursor: undefined,
    }),
  );
}
function unreadReminders(
  store: Store,
  q: ToDooQuery = {},
  authorization?: ToDooStatisticsAuthorization,
) {
  const timeZone = store.entities('settings', 1)[0]?.timeZone ?? 'UTC';
  const scoped = where(
    'reminderEvent',
    { listIds: q.listIds ?? q.filter?.listIds, from: q.from, to: q.to, raisedOnly: true },
    q.from ?? '0001-01-01',
    q.to ?? '9998-12-31',
    timeZone,
  );
  const sql = scoped.sql + " AND json_extract(e.data,'$.userState')='unread'";
  if (!authorization)
    return Number(
      (
        store.db
          .prepare('SELECT COUNT(*) n FROM todo_entities e WHERE ' + sql)
          .get(...scoped.params) as { n: number }
      ).n,
    );
  return (
    store.db.prepare('SELECT e.data FROM todo_entities e WHERE ' + sql).all(...scoped.params) as {
      data: string;
    }[]
  ).filter((row) =>
    authorization.canRead('reminderEvent', parseEntity('reminderEvent', JSON.parse(row.data))),
  ).length;
}
export function statistics(
  store: Store,
  q: ToDooQuery = {},
  authorization?: ToDooStatisticsAuthorization,
): ToDooStatistics {
  installQueryFunctions(store.db);
  if (q.from && q.to && q.from > q.to) toDooError('日期区间无效', 400);
  const listIds = q.listIds ?? q.filter?.listIds;
  const selected = new Map<ToDooEntityKind, Set<string>>();
  function selectedKind(kind: ToDooEntityKind) {
    if (!listIds) return undefined;
    if (!selected.has(kind)) {
      const sql = listIds.length
        ? listIdentitySql(kind) + ' IN (' + listIds.map(() => '?').join(',') + ')'
        : '0';
      selected.set(
        kind,
        new Set(
          (
            store.db
              .prepare('SELECT e.id FROM todo_entities e WHERE e.kind=? AND ' + sql)
              .all(kind, ...listIds) as { id: string }[]
          ).map((row) => row.id),
        ),
      );
    }
    return selected.get(kind)!;
  }
  const now = new Date();
  const timeZone = store.entities('settings', 1)[0]?.timeZone ?? 'UTC';
  const result = aggregateToDooStatistics(
    {
      tasks: store.entities('task'),
      occurrences: store.entities('occurrence'),
      focusSessions: store.entities('focusSession'),
      habits: store.entities('habit'),
      habitEntries: store.entities('habitEntry'),
      outcomes: store.entities('outcome'),
    },
    q,
    {
      now,
      timeZone,
      canRead(kind, entity) {
        // Habit entries inherit the selected habit's scope in the core aggregator.
        return (
          (kind === 'habitEntry' || !listIds || selectedKind(kind)!.has(entity.id)) &&
          (!authorization || authorization.canRead(kind, entity))
        );
      },
    },
  );
  const revision =
    (
      store.db.prepare('SELECT id FROM todo_transactions ORDER BY sequence DESC LIMIT 1').get() as
        | { id: string }
        | undefined
    )?.id ?? 'empty';
  return {
    ...result,
    unreadReminders: unreadReminders(store, q, authorization),
    asOf: now.toISOString(),
    timeZone,
    revision,
  };
}
function listSql(kind: ToDooEntityKind): string {
  switch (kind) {
    case 'list':
      return 'e.id';
    case 'task':
    case 'section':
    case 'habit':
    case 'focusTopic':
      return "json_extract(e.data,'$.listId')";
    case 'occurrence':
      return "(SELECT json_extract(t.data,'$.listId') FROM todo_entities t WHERE t.kind='task' AND t.id=json_extract(e.data,'$.taskId'))";
    case 'timeBlock':
      return "(SELECT json_extract(t.data,'$.listId') FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.occurrenceId'))";
    case 'outcome':
    case 'record':
    case 'focusSession':
    case 'review':
      return "COALESCE(json_extract(e.data,'$.listId'),(SELECT json_extract(t.data,'$.listId') FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.occurrenceId')))";
    default:
      return 'NULL';
  }
}
/** Public list selectors use the inbox identity; stored task list IDs use SQL NULL. */
function listIdentitySql(kind: ToDooEntityKind): string {
  const taskList = "COALESCE(json_extract(t.data,'$.listId'),'inbox')";
  const fromTask = `(SELECT ${taskList} FROM todo_entities t WHERE t.kind='task' AND t.id=json_extract(e.data,'$.taskId'))`;
  const fromOccurrence = `(SELECT ${taskList} FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.occurrenceId'))`;
  switch (kind) {
    case 'task':
    case 'section':
      return "COALESCE(json_extract(e.data,'$.listId'),'inbox')";
    case 'habitEntry':
      return "(SELECT json_extract(h.data,'$.listId') FROM todo_entities h WHERE h.kind='habit' AND h.id=json_extract(e.data,'$.habitId'))";
    case 'activity':
      return `COALESCE(${fromOccurrence},(SELECT ${taskList} FROM todo_entities t WHERE t.kind='task' AND t.id=json_extract(e.data,'$.entityId')),(SELECT ${taskList} FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.entityId')))`;
    case 'reminderEvent':
      return "CASE json_extract(e.data,'$.sourceType') WHEN 'task' THEN (SELECT COALESCE(json_extract(t.data,'$.listId'),'inbox') FROM todo_entities t WHERE t.kind='task' AND t.id=json_extract(e.data,'$.sourceId')) WHEN 'habit' THEN (SELECT json_extract(h.data,'$.listId') FROM todo_entities h WHERE h.kind='habit' AND h.id=json_extract(e.data,'$.sourceId')) ELSE NULL END";
    case 'occurrence':
      return fromTask;
    case 'timeBlock':
      return fromOccurrence;
    case 'outcome':
    case 'record':
    case 'focusSession':
    case 'review':
      // Missing task/occurrence references remain NULL rather than becoming Inbox.
      return `COALESCE(json_extract(e.data,'$.listId'),${fromTask},${fromOccurrence})`;
    default:
      return listSql(kind);
  }
}
function compileFilterGroup(
  kind: ToDooEntityKind,
  group: ToDooFilterGroup,
): { sql: string; params: unknown[] } {
  const pieces = group.conditions.map((condition) =>
    'field' in condition ? compileFilterLeaf(kind, condition) : compileFilterGroup(kind, condition),
  );
  return {
    sql: pieces.length
      ? '(' + pieces.map((p) => p.sql).join(group.operator === 'and' ? ' AND ' : ' OR ') + ')'
      : group.operator === 'and'
        ? '1'
        : '0',
    params: pieces.flatMap((p) => p.params),
  };
}
function compileFilterLeaf(
  kind: ToDooEntityKind,
  leaf: ToDooFilterCondition,
): { sql: string; params: unknown[] } {
  const op = leaf.operator,
    value = leaf.value,
    field = leaf.field;
  let sql = '',
    params: unknown[] = [];
  const taskJson =
    kind === 'task'
      ? 'e.data'
      : kind === 'occurrence'
        ? "(SELECT t.data FROM todo_entities t WHERE t.kind='task' AND t.id=json_extract(e.data,'$.taskId'))"
        : "(SELECT t.data FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.occurrenceId'))";
  function compare(expression: string): string {
    if (op === 'is_empty') return expression + ' IS NULL';
    if (op === 'not_empty') return expression + ' IS NOT NULL';
    if (op === 'between') {
      params.push(...(value as string[]));
      return expression + ' BETWEEN ? AND ?';
    }
    if (op === 'before' || op === 'on' || op === 'after') {
      params.push(value);
      return expression + { before: '<', on: '=', after: '>' }[op] + '?';
    }
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) return '0';
    params.push(...values);
    return expression + ' IN (' + values.map(() => '?').join(',') + ')';
  }
  if (field === 'query') {
    params.push(
      '%' +
        String(value)
          .toLowerCase()
          .replace(/[\\%_]/g, '\\$&') +
        '%',
    );
    sql = 'LOWER(COALESCE(' + taskJson + ",'')||e.data) LIKE ? ESCAPE '\\'";
  } else if (field === 'listId') sql = compare(listSql(kind));
  else if (field === 'tagId')
    sql =
      'EXISTS(SELECT 1 FROM json_each(json_extract(' +
      taskJson +
      ",'$.tagIds')) j WHERE " +
      compare('j.value') +
      ')';
  else if (field === 'priority' || field === 'importance')
    sql = compare('json_extract(' + taskJson + ",'$." + field + "')");
  else if (field === 'status')
    sql =
      kind === 'task'
        ? "EXISTS(SELECT 1 FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id AND json_extract(o.data,'$.deletedAt') IS NULL AND " +
          compare("json_extract(o.data,'$.status')") +
          ')'
        : compare("json_extract(e.data,'$.status')");
  else if (field === 'hasEvidence')
    sql =
      "EXISTS(SELECT 1 FROM todo_entities a WHERE a.kind='outcome' AND json_extract(a.data,'$.deletedAt') IS NULL AND json_array_length(json_extract(a.data,'$.evidenceRefs'))>0 AND " +
      (kind === 'task'
        ? "json_extract(a.data,'$.occurrenceId') IN (SELECT o.id FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id)"
        : "json_extract(a.data,'$.occurrenceId')=e.id") +
      ')';
  else if (field === 'isLeaf')
    sql =
      "NOT EXISTS(SELECT 1 FROM todo_entities t WHERE t.kind='task' AND json_extract(t.data,'$.parentTaskId')=" +
      (kind === 'task' ? 'e.id' : "json_extract(e.data,'$.taskId')") +
      " AND json_extract(t.data,'$.deletedAt') IS NULL)";
  else if (field === 'isUnscheduled')
    sql =
      "NOT EXISTS(SELECT 1 FROM todo_entities b WHERE b.kind='timeBlock' AND json_extract(b.data,'$.deletedAt') IS NULL AND " +
      (kind === 'task'
        ? "json_extract(b.data,'$.occurrenceId') IN (SELECT o.id FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id)"
        : "json_extract(b.data,'$.occurrenceId')=e.id") +
      ')';
  else {
    let expression =
      field === 'dueDate'
        ? "json_extract(e.data,'$.due.date')"
        : field === 'plannedDate'
          ? "json_extract(e.data,'$.start.date')"
          : "substr(json_extract(e.data,'$." +
            (field === 'createdDate' ? 'createdAt' : 'completedAt') +
            "'),1,10)";
    let relation: string | null = null,
      relatedExpression = '';
    if (kind === 'task' && (field === 'dueDate' || field === 'completedDate')) {
      relation =
        "SELECT 1 FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id AND json_extract(o.data,'$.deletedAt') IS NULL AND ";
      relatedExpression =
        field === 'dueDate'
          ? "json_extract(o.data,'$.due.date')"
          : "substr(json_extract(o.data,'$.completedAt'),1,10)";
    }
    if (field === 'plannedDate' && (kind === 'task' || kind === 'occurrence')) {
      relation =
        "SELECT 1 FROM todo_entities b WHERE b.kind='timeBlock' AND json_extract(b.data,'$.deletedAt') IS NULL AND " +
        (kind === 'task'
          ? "json_extract(b.data,'$.occurrenceId') IN (SELECT o.id FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id)"
          : "json_extract(b.data,'$.occurrenceId')=e.id") +
        ' AND ';
      relatedExpression = "json_extract(b.data,'$.start.date')";
    }
    if (relation) {
      sql =
        'EXISTS(' +
        relation +
        (op === 'is_empty' ? relatedExpression + ' IS NOT NULL' : compare(relatedExpression)) +
        ')';
      if (op === 'is_empty') sql = 'NOT ' + sql;
    } else sql = compare(expression);
  }
  if (
    op === 'is_not' ||
    op === 'not_in' ||
    op === 'not_contains' ||
    (['hasEvidence', 'isLeaf', 'isUnscheduled'].includes(field) && value === false)
  )
    sql = 'NOT (' + sql + ')';
  return { sql, params };
}
function taskSearch(
  kind: 'task' | 'occurrence' | 'timeBlock',
  query: string,
): { sql: string; params: unknown[] } {
  const taskId =
    kind === 'task'
      ? 'e.id'
      : kind === 'occurrence'
        ? "json_extract(e.data,'$.taskId')"
        : "(SELECT json_extract(o.data,'$.taskId') FROM todo_entities o WHERE o.kind='occurrence' AND o.id=json_extract(e.data,'$.occurrenceId'))";
  const pattern = '%' + query.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
  // Search the task once for every collection, so execution context does not
  // disappear merely because its own JSON does not repeat the task's text.
  let sql =
    taskId +
    " IN (SELECT t.id FROM todo_entities t WHERE t.kind='task' AND (" +
    "LOWER(COALESCE(json_extract(t.data,'$.title'),'')||' '||COALESCE(json_extract(t.data,'$.description'),'')||' '||COALESCE(json_extract(t.data,'$.criteria'),'')) LIKE ? ESCAPE '\\'" +
    " OR EXISTS(SELECT 1 FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=t.id AND json_extract(o.data,'$.deletedAt') IS NULL AND LOWER(json_extract(o.data,'$.titleOverride')) LIKE ? ESCAPE '\\')))";
  const params = [pattern, pattern];
  if (kind === 'timeBlock') {
    sql = '(' + sql + " OR LOWER(json_extract(e.data,'$.title')) LIKE ? ESCAPE '\\')";
    params.push(pattern);
  }
  return { sql, params };
}
function where(
  kind: ToDooEntityKind,
  q: ToDooQuery,
  from: string,
  to: string,
  timeZone: string,
): { sql: string; params: unknown[] } {
  const clauses = ['e.kind=?'],
    params: unknown[] = [kind];
  const inside = (expression: string, values: unknown[]) => {
    if (values.length) {
      clauses.push(expression + ' IN (' + values.map(() => '?').join(',') + ')');
      params.push(...values);
    } else clauses.push('0');
  };
  if (q.ids) inside('e.id', q.ids);
  if (q.taskIds) {
    const marks = q.taskIds.map(() => '?').join(',');
    let expression: string | null = null;
    if (kind === 'task') expression = 'e.id';
    else if (kind === 'occurrence' || kind === 'exception')
      expression = "json_extract(e.data,'$.taskId')";
    else if (
      kind === 'timeBlock' ||
      kind === 'outcome' ||
      kind === 'focusSession' ||
      kind === 'record' ||
      kind === 'activity'
    ) {
      const direct =
        kind === 'activity'
          ? "json_extract(e.data,'$.entityId')"
          : "json_extract(e.data,'$.taskId')";
      clauses.push(
        '(' +
          direct +
          ' IN (' +
          marks +
          ") OR json_extract(e.data,'$.occurrenceId') IN (SELECT id FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId') IN (" +
          marks +
          ')))',
      );
      params.push(...q.taskIds, ...q.taskIds);
    } else if (kind !== 'list' && kind !== 'tag' && kind !== 'section') clauses.push('0');
    if (expression) inside(expression, q.taskIds);
  }
  const f = q.filter ?? {};
  if (f.group) {
    const group = compileFilterGroup(kind, f.group);
    clauses.push(group.sql);
    params.push(...group.params);
  }
  const scopedLists = q.listIds ?? f.listIds;
  if (scopedLists) {
    if (kind === 'view' || kind === 'plan') {
      if (!scopedLists.length) clauses.push('0');
      else {
        const marks = scopedLists.map(() => '?').join(',');
        if (kind === 'view')
          clauses.push(
            `json_array_length(json_extract(e.data,'$.filter.listIds'))>0 AND NOT EXISTS(SELECT 1 FROM json_each(e.data,'$.filter.listIds') v WHERE v.value NOT IN (${marks}))`,
          );
        else
          clauses.push(
            `json_array_length(json_extract(e.data,'$.changes'))>0 AND NOT EXISTS(SELECT 1 FROM json_each(e.data,'$.changes') pc LEFT JOIN todo_entities o ON o.kind='occurrence' AND o.id=json_extract(pc.value,'$.occurrenceId') LEFT JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') LEFT JOIN todo_entities b ON b.kind='timeBlock' AND b.id=json_extract(pc.value,'$.blockId') WHERE o.id IS NULL OR t.id IS NULL OR COALESCE(json_extract(t.data,'$.listId'),'inbox') NOT IN (${marks}) OR (json_extract(pc.value,'$.blockId') IS NOT NULL AND (b.id IS NULL OR json_extract(b.data,'$.occurrenceId') IS NOT o.id)))`,
          );
        params.push(...scopedLists);
        if (kind === 'plan') {
          const referenceList =
            'CASE r.kind ' +
            (['task', 'occurrence', 'timeBlock'] as const)
              .map(
                (target) =>
                  `WHEN '${target}' THEN ${listIdentitySql(target).replaceAll('e.', 'r.')}`,
              )
              .join(' ') +
            ' END';
          clauses.push(
            `NOT EXISTS(SELECT 1 FROM json_each(e.data,'$.expectedRevisions') pv WHERE NOT EXISTS(SELECT 1 FROM todo_entities r WHERE r.kind=substr(pv.key,1,instr(pv.key,':')-1) AND r.id=substr(pv.key,instr(pv.key,':')+1) AND (${referenceList}) IN (${marks})))`,
          );
          params.push(...scopedLists);
        }
      }
    } else inside(listIdentitySql(kind), scopedLists);
  }
  if (f.query && !['list', 'section', 'tag', 'view'].includes(kind)) {
    if (kind === 'task' || kind === 'occurrence' || kind === 'timeBlock') {
      const search = taskSearch(kind, f.query);
      clauses.push(search.sql);
      params.push(...search.params);
    } else {
      const text =
        kind === 'record'
          ? "json_extract(e.data,'$.content')"
          : kind === 'outcome'
            ? "json_extract(e.data,'$.summary')"
            : 'e.data';
      clauses.push('LOWER(' + text + ") LIKE ? ESCAPE '\\'");
      params.push('%' + f.query.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%');
    }
  }
  if (!f.includeDeleted && !q.all) clauses.push("json_extract(e.data,'$.deletedAt') IS NULL");
  if (kind === 'reminderEvent' && q.raisedOnly) {
    clauses.push(
      "(json_extract(e.data,'$.firstRaisedAt') IS NOT NULL OR to_doo_timestamp_ms(json_extract(e.data,'$.scheduledAt'))<=?)",
    );
    params.push(Date.now());
  }
  if (!f.includeArchived && !f.includeDeleted && !q.all)
    clauses.push("json_extract(e.data,'$.archivedAt') IS NULL");
  if (kind === 'reminderEvent' && q.reminderStates)
    inside("json_extract(e.data,'$.userState')", q.reminderStates);
  if (kind === 'task') {
    if (f.priorities) inside("json_extract(e.data,'$.priority')", f.priorities);
    if (f.importance) {
      clauses.push("json_extract(e.data,'$.importance')=?");
      params.push(f.importance);
    }
    if (f.tagIds?.length) {
      clauses.push(
        "EXISTS(SELECT 1 FROM json_each(json_extract(e.data,'$.tagIds')) j WHERE j.value IN (" +
          f.tagIds.map(() => '?').join(',') +
          '))',
      );
      params.push(...f.tagIds);
    }
    if (f.leafOnly)
      clauses.push(
        "NOT EXISTS(SELECT 1 FROM todo_entities c WHERE c.kind='task' AND json_extract(c.data,'$.parentTaskId')=e.id AND json_extract(c.data,'$.deletedAt') IS NULL)",
      );
    if (f.statuses) {
      clauses.push(
        "EXISTS(SELECT 1 FROM todo_entities o WHERE o.kind='occurrence' AND json_extract(o.data,'$.taskId')=e.id AND json_extract(o.data,'$.status') IN (" +
          f.statuses.map(() => '?').join(',') +
          '))',
      );
      params.push(...f.statuses);
    }
  }
  if (kind === 'occurrence') {
    if (f.statuses) inside("json_extract(e.data,'$.status')", f.statuses);
    if (!q.all && !q.ids && !q.taskIds) {
      clauses.push(
        "(json_extract(e.data,'$.scheduledDate') IS NULL OR json_extract(e.data,'$.scheduledDate') BETWEEN ? AND ? OR json_extract(e.data,'$.status') IN ('todo','doing','blocked'))",
      );
      params.push(f.from ?? q.from ?? from, f.to ?? q.to ?? to);
    }
    if (f.dueBefore) {
      clauses.push("to_doo_display_date(json_extract(e.data,'$.due'),?)<=?");
      params.push(timeZone, f.dueBefore);
    }
    if (f.unscheduled)
      clauses.push(
        "NOT EXISTS(SELECT 1 FROM todo_entities b WHERE b.kind='timeBlock' AND json_extract(b.data,'$.occurrenceId')=e.id AND json_extract(b.data,'$.deletedAt') IS NULL)",
      );
    if (f.hasEvidence !== undefined)
      clauses.push(
        (f.hasEvidence ? '' : 'NOT ') +
          "EXISTS(SELECT 1 FROM todo_entities a WHERE a.kind='outcome' AND json_extract(a.data,'$.occurrenceId')=e.id AND json_extract(a.data,'$.deletedAt') IS NULL)",
      );
  }
  if (!q.all && !q.ids && !q.taskIds && (kind === 'timeBlock' || kind === 'calendarEvent')) {
    clauses.push('to_doo_interval_overlap(e.data,?,?,?,?)=1');
    params.push(
      from,
      to,
      dateTimeInstant({ date: from, time: '00:00', timeZone }).getTime(),
      dateTimeInstant({ date: addDays(to, 1), time: '00:00', timeZone }).getTime(),
    );
  }
  if (!q.all && (q.from || q.to)) {
    const timestampField =
      kind === 'outcome' ? 'createdAt' : kind === 'record' ? 'occurredAt' : undefined;
    if (timestampField || kind === 'reminderEvent') {
      const expression =
        kind === 'reminderEvent'
          ? recentAtSql(kind)
          : `to_doo_timestamp_ms(json_extract(e.data,'$.${timestampField}'))`;
      if (q.from) {
        clauses.push(expression + '>=?');
        params.push(dateTimeInstant({ date: q.from, time: '00:00', timeZone }).getTime());
      }
      if (q.to) {
        clauses.push(expression + '<?');
        params.push(dateTimeInstant({ date: addDays(q.to, 1), time: '00:00', timeZone }).getTime());
      }
    } else if (kind === 'habitEntry') {
      if (q.from) {
        clauses.push("json_extract(e.data,'$.localDate')>=?");
        params.push(q.from);
      }
      if (q.to) {
        clauses.push("json_extract(e.data,'$.localDate')<=?");
        params.push(q.to);
      }
    } else if (kind === 'review') {
      if (q.from) {
        clauses.push("json_extract(e.data,'$.to')>=?");
        params.push(q.from);
      }
      if (q.to) {
        clauses.push("json_extract(e.data,'$.from')<=?");
        params.push(q.to);
      }
    }
  }
  return { sql: clauses.join(' AND '), params };
}
export function buildToDooSnapshot(store: Store, q: ToDooQuery = {}): ToDooSnapshot {
  installQueryFunctions(store.db);
  store.refresh();
  if (q.filter) {
    const validated = toDooFilterSchema.safeParse(q.filter);
    if (!validated.success)
      toDooError('过滤条件无效：' + validated.error.issues.map((x) => x.message).join('; '), 400);
    q = { ...q, filter: validated.data };
  }
  if (q.taskIds && q.includeTree) {
    const ids = new Set(q.taskIds);
    const tree = store.db
      .prepare(
        "SELECT id,json_extract(data,'$.parentTaskId') parent FROM todo_entities WHERE kind='task'",
      )
      .all() as { id: string; parent: string | null }[];
    let change = true;
    while (change) {
      change = false;
      for (const row of tree) {
        if (ids.has(row.id) && row.parent && !ids.has(row.parent)) {
          ids.add(row.parent);
          change = true;
        }
        if (row.parent && ids.has(row.parent) && !ids.has(row.id)) {
          ids.add(row.id);
          change = true;
        }
      }
    }
    q = { ...q, taskIds: [...ids] };
  }
  const settings = store.entities('settings', 1)[0];
  if (!settings) toDooError('To Doo 设置缺失');
  const today = localDate(new Date(), settings.timeZone),
    from = q.from ?? addDays(today, -30),
    to = q.to ?? addDays(today, 90);
  if (from > to) toDooError('日期区间无效', 400);
  const limit = q.all ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, q.limit ?? 200));
  const fingerprint = queryFingerprint(store, q);
  let offset = 0,
    after: { at: number; id: string } | undefined;
  if (q.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
      if (cursor.fingerprint !== fingerprint) throw Error();
      if (q.sort === 'recent') {
        if (
          !Number.isSafeInteger(cursor.after?.at) ||
          typeof cursor.after?.id !== 'string' ||
          !cursor.after.id
        )
          throw Error();
        after = cursor.after;
      } else {
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw Error();
        offset = cursor.offset;
      }
    } catch {
      toDooError('分页游标无效', 400);
    }
  }
  const summary = statistics(store, q);
  const result: any = {
    datasetId: store.datasetId,
    version: '',
    settings,
    statistics: summary,
    reminderUnreadCount:
      q.listIds || q.filter?.listIds || q.from || q.to
        ? unreadReminders(store)
        : summary.unreadReminders,
    warnings: [],
    collectionPages: {},
    now: new Date().toISOString(),
  };
  const counts: Record<string, number> = {};
  let pageTotal = 0,
    pageNext: string | null = null,
    truncated = false;
  for (const kind of Object.keys(TO_DOO_COLLECTIONS) as (keyof typeof TO_DOO_COLLECTIONS)[]) {
    const name = TO_DOO_COLLECTIONS[kind];
    const requested =
      (!q.kind || q.kind === kind) &&
      (!q.kinds || q.kinds.includes(kind)) &&
      (kind !== 'operation' || q.kind === 'operation' || q.all === true);
    if (!requested) {
      result[name] = [];
      counts[kind] = Number(
        (
          store.db.prepare('SELECT COUNT(*) n FROM todo_entities WHERE kind=?').get(kind) as {
            n: number;
          }
        ).n,
      );
      continue;
    }
    const w = where(kind, q, from, to, settings.timeZone);
    const total = Number(
      (
        store.db
          .prepare('SELECT COUNT(*) n FROM todo_entities e WHERE ' + w.sql)
          .get(...w.params) as { n: number }
      ).n,
    );
    counts[kind] = total;
    const rowLimit = q.all
      ? total
      : kind === 'occurrence' && !q.kind
        ? Math.max(limit, 500)
        : limit;
    const collectionOffset = q.kind || q.kinds || kind === 'task' ? offset : 0;
    const sortAt = recentAtSql(kind);
    const cursorForKind = q.kind || q.kinds || kind === 'task' ? after : undefined;
    const candidates =
      q.sort === 'recent'
        ? store.db
            .prepare(
              'SELECT e.data,e.id sortId,' +
                sortAt +
                ' sortAt FROM todo_entities e WHERE ' +
                w.sql +
                (cursorForKind ? ' AND (' + sortAt + '<? OR (' + sortAt + '=? AND e.id<?))' : '') +
                ' ORDER BY sortAt DESC,e.id DESC LIMIT ?',
            )
            .all(
              ...w.params,
              ...(cursorForKind ? [cursorForKind.at, cursorForKind.at, cursorForKind.id] : []),
              rowLimit + 1,
            )
        : store.db
            .prepare(
              'SELECT e.data FROM todo_entities e WHERE ' +
                w.sql +
                ' ORDER BY rowid LIMIT ? OFFSET ?',
            )
            .all(...w.params, rowLimit, collectionOffset);
    const rows = (q.sort === 'recent' ? candidates.slice(0, rowLimit) : candidates) as {
      data: string;
      sortAt?: number;
      sortId?: string;
    }[];
    result[name] = rows.map((row) => parseEntity(kind, JSON.parse(row.data)));
    const collectionTruncated =
      q.sort === 'recent' ? candidates.length > rowLimit : collectionOffset + rows.length < total;
    const collectionQuery = { ...q, kind, kinds: undefined, limit: rowLimit, cursor: undefined };
    const collectionFingerprint = queryFingerprint(store, collectionQuery);
    const lastRow = rows.at(-1);
    const next = (key: string) =>
      collectionTruncated
        ? Buffer.from(
            JSON.stringify(
              q.sort === 'recent'
                ? { fingerprint: key, after: { at: lastRow!.sortAt, id: lastRow!.sortId } }
                : { offset: collectionOffset + rowLimit, fingerprint: key },
            ),
          ).toString('base64url')
        : null;
    result.collectionPages[kind] = {
      kind,
      total,
      limit: rowLimit,
      nextCursor: next(collectionFingerprint),
      truncated: collectionTruncated,
      counts,
      from,
      to,
    };
    if (collectionTruncated) truncated = true;
    if (q.kind === kind || (!q.kind && kind === 'task')) {
      pageTotal = total;
      pageNext = next(fingerprint);
    }
  }
  const last = store.db
    .prepare('SELECT id FROM todo_transactions ORDER BY sequence DESC LIMIT 1')
    .get() as { id: string } | undefined;
  result.version = last?.id ?? 'empty';
  result.page = {
    kind: q.kind ?? null,
    total: pageTotal,
    limit,
    nextCursor: pageNext,
    truncated,
    counts,
    from,
    to,
  };
  return result as ToDooSnapshot;
}
