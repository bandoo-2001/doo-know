import {
  TO_DOO_COLLECTIONS,
  toDooFilterSchema,
  type ToDooFilterGroup,
  type ToDooFilterCondition,
  type ToDooSnapshot,
  type ToDooQuery,
  type ToDooEntityKind,
  type ToDooStatistics,
  type ToDooEntity,
  type ToDooFilter,
} from '../../../shared/to-doo-contracts.js';
import type { createToDooStore } from './store.js';
import { toDooError, toDooHash, canonical, parseEntity } from './store.js';
import { dateTimeInstant, addDays, localDate } from './recurrence.js';
type Store = ReturnType<typeof createToDooStore>;
export function focusMinutes(
  session: {
    mode: string;
    status: string;
    correctedMinutes: number | null;
    segments: { start: string; end: string | null }[];
  },
  now = new Date(),
): number {
  if (session.mode === 'break' || session.status === 'cancelled') return 0;
  if (session.correctedMinutes !== null) return session.correctedMinutes;
  return session.segments.reduce(
    (n, x) =>
      n +
      Math.max(
        0,
        (Date.parse(x.end ?? (session.status === 'running' ? now.toISOString() : x.start)) -
          Date.parse(x.start)) /
          60000,
      ),
    0,
  );
}
export function statistics(store: Store, q: ToDooQuery = {}): ToDooStatistics {
  const db = store.db,
    period = !!(q.from || q.to),
    from = q.from ?? '0001-01-01',
    to = q.to ?? '9998-12-31';
  const settings = store.entities('settings', 1)[0],
    timeZone = settings?.timeZone ?? 'UTC';
  const start = period
    ? dateTimeInstant({ date: from, time: '00:00', timeZone }).toISOString()
    : '0001-01-01T00:00:00.000Z';
  const end = period
    ? dateTimeInstant({ date: addDays(to, 1), time: '00:00', timeZone }).toISOString()
    : '9999-01-01T00:00:00.000Z';
  const listIds = q.listIds ?? q.filter?.listIds;
  function scope(kind: ToDooEntityKind): { sql: string; params: unknown[] } {
    if (!listIds) return { sql: '', params: [] };
    if (!listIds.length) return { sql: ' AND 0', params: [] };
    return {
      sql: ' AND ' + listSql(kind) + ' IN (' + listIds.map(() => '?').join(',') + ')',
      params: listIds,
    };
  }
  function count(kind: ToDooEntityKind, extra: string, params: unknown[] = []): number {
    const scoped = scope(kind);
    return Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) n FROM todo_entities e WHERE e.kind=? AND json_extract(e.data,'$.deletedAt') IS NULL AND " +
              extra +
              scoped.sql,
          )
          .get(kind, ...params, ...scoped.params) as { n: number }
      ).n,
    );
  }
  const dateConstraint = period
    ? " AND COALESCE(json_extract(e.data,'$.due.date'),json_extract(e.data,'$.scheduledDate')) BETWEEN ? AND ?"
    : '';
  const s: ToDooStatistics = {
    scope: period ? 'period' : 'library',
    ...(period ? { from, to } : {}),
    completed: count(
      'occurrence',
      "json_extract(e.data,'$.status')='done'" +
        (period
          ? " AND json_extract(e.data,'$.completedAt')>=? AND json_extract(e.data,'$.completedAt')<?"
          : ''),
      period ? [start, end] : [],
    ),
    pending: count(
      'occurrence',
      "json_extract(e.data,'$.status') IN ('todo','doing','blocked')" + dateConstraint,
      period ? [from, to] : [],
    ),
    overdue: 0,
    focusMinutes: 0,
    habitAmount: 0,
    outcomes: count(
      'outcome',
      '1' +
        (period
          ? " AND json_extract(e.data,'$.createdAt')>=? AND json_extract(e.data,'$.createdAt')<?"
          : ''),
      period ? [start, end] : [],
    ),
    byList: {},
  };
  const overdueScope = scope('occurrence');
  for (const row of db
    .prepare(
      "SELECT e.data FROM todo_entities e WHERE e.kind='occurrence' AND json_extract(e.data,'$.deletedAt') IS NULL AND json_extract(e.data,'$.status') IN ('todo','doing','blocked') AND json_extract(e.data,'$.due.date')<=?" +
        dateConstraint +
        overdueScope.sql,
    )
    .all(
      new Date().toISOString().slice(0, 10),
      ...(period ? [from, to] : []),
      ...overdueScope.params,
    ) as { data: string }[]) {
    const o = JSON.parse(row.data);
    if (o.due && dateTimeInstant(o.due).getTime() + (o.due.time ? 0 : 59999) < Date.now())
      s.overdue++;
  }
  const focusScope = scope('focusSession');
  s.focusMinutes =
    Math.round(
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(CASE WHEN json_extract(e.data,'$.correctedMinutes') IS NOT NULL THEN CASE WHEN json_extract(e.data,'$.segments[0].start')>=? AND json_extract(e.data,'$.segments[0].start')<? THEN json_extract(e.data,'$.correctedMinutes') ELSE 0 END ELSE COALESCE((SELECT SUM(MAX(0,(julianday(MIN(COALESCE(json_extract(j.value,'$.end'),CASE WHEN json_extract(e.data,'$.status')='running' THEN ? ELSE json_extract(j.value,'$.start') END),?))-julianday(MAX(json_extract(j.value,'$.start'),?)))*1440)) FROM json_each(e.data,'$.segments') j),0) END),0) n FROM todo_entities e WHERE e.kind='focusSession' AND json_extract(e.data,'$.deletedAt') IS NULL AND json_extract(e.data,'$.mode')<>'break' AND json_extract(e.data,'$.status')<>'cancelled'" +
                focusScope.sql,
            )
            .get(start, end, new Date().toISOString(), end, start, ...focusScope.params) as {
            n: number;
          }
        ).n,
      ) * 100,
    ) / 100;
  const habitScope = listIds
    ? " AND json_extract(e.data,'$.habitId') IN (SELECT h.id FROM todo_entities h WHERE h.kind='habit' AND json_extract(h.data,'$.listId') IN (" +
      listIds.map(() => '?').join(',') +
      '))'
    : '';
  s.habitAmount = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(json_extract(e.data,'$.amount')),0) n FROM todo_entities e WHERE e.kind='habitEntry' AND json_extract(e.data,'$.deletedAt') IS NULL AND json_extract(e.data,'$.skipped')=0" +
            (period ? " AND json_extract(e.data,'$.localDate') BETWEEN ? AND ?" : '') +
            habitScope,
        )
        .get(...(period ? [from, to] : []), ...(listIds ?? [])) as { n: number }
    ).n,
  );
  const listWhere = listIds
    ? listIds.length
      ? " AND json_extract(t.data,'$.listId') IN (" + listIds.map(() => '?').join(',') + ')'
      : ' AND 0'
    : '';
  for (const row of db
    .prepare(
      "SELECT json_extract(t.data,'$.listId') listId,COUNT(*) total,SUM(CASE WHEN json_extract(o.data,'$.status')='done' THEN 1 ELSE 0 END) completed FROM todo_entities o JOIN todo_entities t ON t.kind='task' AND t.id=json_extract(o.data,'$.taskId') WHERE o.kind='occurrence' AND json_extract(o.data,'$.deletedAt') IS NULL AND json_extract(t.data,'$.deletedAt') IS NULL AND json_extract(o.data,'$.status') NOT IN ('cancelled','skipped') AND NOT EXISTS(SELECT 1 FROM todo_entities c WHERE c.kind='task' AND json_extract(c.data,'$.parentTaskId')=t.id AND json_extract(c.data,'$.deletedAt') IS NULL)" +
        (period
          ? " AND COALESCE(json_extract(o.data,'$.due.date'),json_extract(o.data,'$.scheduledDate'),substr(json_extract(o.data,'$.completedAt'),1,10)) BETWEEN ? AND ?"
          : '') +
        listWhere +
        ' GROUP BY listId',
    )
    .all(...(period ? [from, to] : []), ...(listIds ?? [])) as {
    listId: string | null;
    total: number;
    completed: number;
  }[])
    s.byList[row.listId ?? 'inbox'] = { total: row.total, completed: row.completed };
  return s;
}
function listSql(kind: ToDooEntityKind): string {
  switch (kind) {
    case 'list':
      return 'e.id';
    case 'task':
    case 'section':
    case 'habit':
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
function where(
  kind: ToDooEntityKind,
  q: ToDooQuery,
  from: string,
  to: string,
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
  if (q.listIds ?? f.listIds) inside(listSql(kind), q.listIds ?? f.listIds!);
  if (f.query) {
    clauses.push("LOWER(e.data) LIKE ? ESCAPE '\\'");
    params.push('%' + f.query.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (!f.includeDeleted && !q.all) clauses.push("json_extract(e.data,'$.deletedAt') IS NULL");
  if (!f.includeArchived && !f.includeDeleted && !q.all)
    clauses.push("json_extract(e.data,'$.archivedAt') IS NULL");
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
      clauses.push("json_extract(e.data,'$.due.date')<=?");
      params.push(f.dueBefore);
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
    clauses.push("json_extract(e.data,'$.start.date') BETWEEN ? AND ?");
    params.push(q.from ?? from, q.to ?? to);
  }
  return { sql: clauses.join(' AND '), params };
}
export function buildToDooSnapshot(store: Store, q: ToDooQuery = {}): ToDooSnapshot {
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
  const fingerprint = toDooHash(canonical({ ...q, cursor: undefined }));
  let offset = 0;
  if (q.cursor) {
    try {
      const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
      if (c.fingerprint !== fingerprint || !Number.isSafeInteger(c.offset) || c.offset < 0)
        throw Error();
      offset = c.offset;
    } catch {
      toDooError('分页游标无效', 400);
    }
  }
  const result: any = {
    datasetId: store.datasetId,
    version: '',
    settings,
    statistics: statistics(store, q),
    warnings: [],
    collectionPages: {},
    now: new Date().toISOString(),
  };
  const counts: Record<string, number> = {};
  let pageTotal = 0,
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
    const w = where(kind, q, from, to);
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
    const rows = store.db
      .prepare(
        'SELECT e.data FROM todo_entities e WHERE ' + w.sql + ' ORDER BY rowid LIMIT ? OFFSET ?',
      )
      .all(...w.params, rowLimit, q.kind || q.kinds || kind === 'task' ? offset : 0) as {
      data: string;
    }[];
    result[name] = rows.map((r) => parseEntity(kind, JSON.parse(r.data)));
    const collectionOffset = q.kind || q.kinds || kind === 'task' ? offset : 0;
    const collectionTruncated = collectionOffset + rows.length < total;
    const collectionQuery = { ...q, kind, kinds: undefined, limit: rowLimit, cursor: undefined };
    const collectionFingerprint = toDooHash(canonical(collectionQuery));
    result.collectionPages[kind] = {
      kind,
      total,
      limit: rowLimit,
      nextCursor: collectionTruncated
        ? Buffer.from(
            JSON.stringify({
              offset: collectionOffset + rowLimit,
              fingerprint: collectionFingerprint,
            }),
          ).toString('base64url')
        : null,
      truncated: collectionTruncated,
      counts,
      from,
      to,
    };
    if (collectionTruncated) truncated = true;
    if (q.kind === kind || (!q.kind && kind === 'task')) pageTotal = total;
  }
  const last = store.db
    .prepare('SELECT id FROM todo_transactions ORDER BY sequence DESC LIMIT 1')
    .get() as { id: string } | undefined;
  result.version = last?.id ?? 'empty';
  result.page = {
    kind: q.kind ?? null,
    total: pageTotal,
    limit,
    nextCursor:
      offset + limit < pageTotal
        ? Buffer.from(JSON.stringify({ offset: offset + limit, fingerprint })).toString('base64url')
        : null,
    truncated,
    counts,
    from,
    to,
  };
  return result as ToDooSnapshot;
}
