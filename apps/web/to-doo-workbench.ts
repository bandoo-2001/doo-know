import { reactive, watch } from 'vue';
import type { ToDooTaskFilter } from './navigation';
import {
  TO_DOO_COLLECTIONS,
  toDooCommandSchema,
  toDooEntitySchemas,
  resolveToDooStatusSelection,
  type ToDooCommand,
  type ToDooCommandResult,
  type ToDooEntity,
  type ToDooEntityKind,
  type ToDooEntityMap,
  type ToDooFilter,
  type ToDooFilterGroup,
  type ToDooFilterCondition,
  type ToDooOccurrence,
  type ToDooQuery,
  type ToDooSnapshot,
  type ToDooTask,
} from '../../shared/to-doo-contracts';
import { mergeToDooTaskDraft, sameToDooDraftValue, type ToDooDraftConflict } from './to-doo-draft-merge';
export type { ToDooDraftConflict } from './to-doo-draft-merge';
export type ToDooRequest = (url: string, method?: string, body?: unknown) => Promise<any>;
export type ToDooSelection = {
  appPage?: string;
  task?: string;
  occurrence?: string;
  list?: string;
  date?: string;
  calendarView?: 'week' | 'month';
  taskFilter?: ToDooTaskFilter;
};
export type ToDooInput = ToDooCommand extends infer C
  ? C extends { requestId: string }
    ? Omit<C, 'requestId'>
    : never
  : never;
export type ToDooTaskDraft = {
  task: ToDooTask;
  occurrence: ToDooOccurrence | null;
  blocks: ToDooEntityMap['timeBlock'][];
};
export type ToDooActionDraft = {
  key: string;
  taskId: string;
  occurrenceId: string;
  title: string;
  kind: 'task' | 'new';
};
export type ToDooCompletionFeedback = {
  title: string;
  taskId: string;
  occurrenceId: string;
  undoable: boolean;
};
export type ToDooCreateSeed = {
  title?: string;
  description?: string;
  listId?: string | null;
  sectionId?: string | null;
  initialStatus?: ToDooOccurrence['status'];
  priority?: ToDooTask['priority'];
  tagIds?: string[];
  planDate?: string;
};
export type ToDooNewTaskDraft = {
  initialStatus: ToDooOccurrence['status'];
  priority: ToDooTask['priority'];
  reminders: ToDooTask['reminders'];
  title: string;
  description: string;
  criteria: string;
  listId: string | null;
  parentTaskId: string | null;
  sectionId?: string | null;
  dueDate: string;
  dueTime: string;
  planDate: string;
  planDateCleared?: boolean;
  planTime: string;
  estimate: number | '';
  tagIds: string[];
  frequency: 'daily' | 'weekly' | null;
  weekdays: number[];
  recurrenceId: string;
};
export function toDooOutcomeResumeInput(
  operation: ToDooEntityMap['operation'],
  revision = operation.expectedRevision,
): Record<string, unknown> {
  return {
    requestId: operation.requestId,
    operationId: operation.id,
    occurrenceId: operation.occurrenceId,
    expectedRevision: revision,
    title: operation.title,
    folderPath: operation.folderPath,
    content: operation.content,
    verification: operation.verification,
    complete: operation.complete,
    criteriaResults: clone(operation.criteriaResults),
  };
}
export function toDooDependencies(
  previous: ToDooTask['dependencies'],
  ids: string[],
): ToDooTask['dependencies'] {
  return ids.map((taskId) => ({
    taskId,
    lagMinutes: previous.find((d) => d.taskId === taskId)?.lagMinutes ?? 0,
  }));
}
export function toDooMoveBlock(
  block: ToDooEntityMap['timeBlock'],
  occurrence: ToDooOccurrence,
  start: ToDooEntityMap['timeBlock']['start'],
) {
  return {
    occurrenceId: occurrence.id,
    expectedRevision: occurrence.revision,
    blockId: block.id,
    expectedBlockRevision: block.revision,
    start,
    durationMinutes: block.durationMinutes,
    allDay: block.allDay,
    dateEndExclusive: block.dateEndExclusive
      ? shiftToDooDate(
          block.dateEndExclusive,
          Math.round(
            (Date.parse(start.date + 'T12:00:00Z') - Date.parse(block.start.date + 'T12:00:00Z')) /
              86400000,
          ),
        )
      : null,
  };
}
export type ToDooItem = {
  key: string;
  task: ToDooTask;
  occurrence: ToDooOccurrence | null;
  blocks: ToDooEntityMap['timeBlock'][];
  list?: ToDooEntityMap['list'];
  title: string;
  status: ToDooOccurrence['status'] | 'unavailable';
  date: string;
  depth: number;
};
export const toDooStatusLabels = {
  todo: '待开始',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
  cancelled: '已取消',
  skipped: '已跳过',
};
export const toDooPriorityLabels = { none: '无优先级', low: '低', normal: '中', high: '高' };
export function parseToDooQuickEntry(
  title: string,
  today: string,
  tags: { id: string; name: string }[] = [],
) {
  let rest = title,
    date: string | null = null,
    time: string | null = null,
    frequency: 'daily' | 'weekly' | null = null,
    weekdays: number[] = [];
  const tagIds: string[] = [];
  let due = false;
  const dateMatch = rest.match(/今天|明天|后天|\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    const token = dateMatch[0],
      candidate =
        token === '今天'
          ? today
          : token === '明天'
            ? shiftToDooDate(today, 1)
            : token === '后天'
              ? shiftToDooDate(today, 2)
              : token;
    const parsed = new Date(candidate + 'T12:00:00Z');
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      date = candidate;
      due = new RegExp('截止\\s*' + token).test(rest);
      rest = rest.replace(new RegExp('(截止\\s*)?' + token), ' ');
    }
  }
  const clock = rest.match(/(?:^|\s)((?:[01]?\d|2[0-3]):[0-5]\d)(?=\s|$)/);
  if (clock) {
    time = clock[1]!.padStart(5, '0');
    rest = rest.replace(clock[0], ' ');
  } else {
    const cn = rest.match(
      /(上午|下午|晚上|中午)(\d{1,2}|十一|十二|[一二三四五六七八九十])点(半|[0-5]?\d分?)?/,
    );
    if (cn) {
      const numbers: Record<string, number> = {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
        十: 10,
        十一: 11,
        十二: 12,
      };
      let hour = numbers[cn[2]!] ?? Number(cn[2]);
      if (hour >= 0 && hour <= 12) {
        if (['下午', '晚上'].includes(cn[1]!) && hour < 12) hour += 12;
        if (cn[1] === '上午' && hour === 12) hour = 0;
        time =
          String(hour).padStart(2, '0') +
          ':' +
          (cn[3] === '半' ? '30' : String(parseInt(cn[3] || '0')).padStart(2, '0'));
        rest = rest.replace(cn[0], ' ');
      }
    }
  }
  const weekly = rest.match(/每周([一二三四五六日天])/);
  if (weekly) {
    frequency = 'weekly';
    weekdays = [{ 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[weekly[1]!]!];
    rest = rest.replace(weekly[0], ' ');
  } else if (rest.includes('每天')) {
    frequency = 'daily';
    rest = rest.replace('每天', ' ');
  }
  rest = rest.replace(/#([^\s#]+)/g, (full, name: string) => {
    const tag = tags.find((t) => t.name === name);
    if (tag) {
      tagIds.push(tag.id);
      return ' ';
    }
    return full;
  });
  const recognized = !!(date || time || frequency || tagIds.length);
  return {
    title: recognized ? rest.replace(/\s+/g, ' ').trim() || title : title,
    date,
    time,
    frequency,
    weekdays,
    tagIds: [...new Set(tagIds)],
    due,
    recognized,
  };
}
export function toDooDisplayTime(
  value: ToDooEntityMap['timeBlock']['start'],
  zone: string,
): ToDooEntityMap['timeBlock']['start'] {
  if (value.time === null) return { ...value, timeZone: zone };
  const parts = (at: number, timeZone: string) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (name: string) => p.find((v) => v.type === name)?.value;
    return {
      date: get('year') + '-' + get('month') + '-' + get('day'),
      time: get('hour') + ':' + get('minute'),
    };
  };
  const target = value.date + 'T' + value.time,
    targetMs = Date.parse(target + ':00Z');
  let guess = targetMs;
  for (let i = 0; i < 5; i++) {
    const local = parts(guess, value.timeZone),
      delta = targetMs - Date.parse(local.date + 'T' + local.time + ':00Z');
    if (!delta) break;
    guess += delta;
  }
  const matches = [-120, -60, 0, 60, 120]
    .map((d) => guess + d * 60000)
    .filter((t) => {
      const local = parts(t, value.timeZone);
      return local.date + 'T' + local.time === target;
    });
  let instant = matches.length ? Math.min(...matches) : undefined;
  if (instant === undefined) {
    let bestLocal: string | undefined;
    for (let d = -180; d <= 180; d++) {
      const candidate = guess + d * 60000,
        p = parts(candidate, value.timeZone),
        key = p.date + 'T' + p.time;
      if (
        key >= target &&
        (!bestLocal || key < bestLocal || (key === bestLocal && candidate < instant!))
      ) {
        instant = candidate;
        bestLocal = key;
      }
    }
  }
  if (instant === undefined) throw Error('无法解释所选当地时间，请调整日期或时区');
  return { ...parts(instant, zone), timeZone: zone };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const fingerprint = (v: unknown) => JSON.stringify(v);
export const toDooLocalDate = (date = new Date(), timeZone?: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
export function shiftToDooDate(date: string, days: number) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function toDooPending(status: ToDooItem['status']) {
  return ['todo', 'doing', 'blocked'].includes(status);
}

/** Plans, deadlines and recurrence dates use the same scope rule in every task view. */
export function toDooItemMatchesDateRange(
  item: ToDooItem,
  from?: string,
  to?: string,
  timeZone = 'UTC',
) {
  const dates = [
    ...item.blocks.map((block) => block.start.date),
    item.occurrence?.due ? toDooDisplayTime(item.occurrence.due, timeZone).date : undefined,
    item.occurrence?.scheduledDate,
  ];
  return dates.some((date) => date && (!from || date >= from) && (!to || date <= to));
}

export function toDooDeadlineOverdue(
  due: ToDooOccurrence['due'] | undefined,
  status: ToDooItem['status'],
  today: string,
  now = Date.now(),
) {
  if (!due || !toDooPending(status)) return false;
  if (!due.time) return due.date < today;
  const utc = toDooDisplayTime(due, 'UTC');
  return Date.parse(utc.date + 'T' + utc.time + ':00Z') < now;
}

export function deriveToDooItems(
  data: ToDooSnapshot,
  filter: ToDooFilter = {},
  sort = 'manual',
): ToDooItem[] {
  const tasks = data.tasks.filter(
    (t) => (!t.deletedAt || filter.includeDeleted) && (!t.archivedAt || filter.includeArchived),
  );
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const rows = tasks
    .flatMap((task) => {
      const occurrences = data.occurrences.filter(
        (o) => o.taskId === task.id && (!o.deletedAt || filter.includeDeleted),
      );
      return (occurrences.length ? occurrences : [null]).map((occurrence) => {
        const blocks = data.timeBlocks
          .filter((b) => !b.deletedAt && b.occurrenceId === occurrence?.id)
          .map((b) => ({
            ...b,
            start: b.allDay ? b.start : toDooDisplayTime(b.start, data.settings.timeZone),
          }))
          .sort((a, b) =>
            (a.start.date + (a.start.time || '')).localeCompare(
              b.start.date + (b.start.time || ''),
            ),
          );
        let depth = 0,
          parent = task.parentTaskId;
        const seen = new Set([task.id]);
        while (parent && taskMap.has(parent) && !seen.has(parent) && depth < 32) {
          seen.add(parent);
          depth++;
          parent = taskMap.get(parent)!.parentTaskId;
        }
        return {
          key: occurrence?.id || task.id,
          task,
          occurrence,
          blocks,
          list: data.lists.find((l) => l.id === task.listId),
          title: occurrence?.titleOverride || task.title,
          status: occurrence?.status || 'unavailable',
          date:
            blocks[0]?.start.date ||
            (occurrence?.due
              ? toDooDisplayTime(occurrence.due, data.settings.timeZone).date
              : '') ||
            occurrence?.scheduledDate ||
            '',
          depth,
        } as ToDooItem;
      });
    })
    .filter((row) => {
      const { task: t, occurrence: o } = row;
      if (
        filter.query &&
        ![
          row.title,
          t.description,
          t.criteria,
          ...data.outcomes.filter((x) => x.occurrenceId === o?.id).map((x) => x.summary),
          ...data.records.filter((x) => x.taskId === t.id).map((x) => x.content),
        ]
          .join(' ')
          .toLowerCase()
          .includes(filter.query.toLowerCase())
      )
        return false;
      if (filter.listIds?.length && (!t.listId || !filter.listIds.includes(t.listId))) return false;
      if (filter.tagIds?.length && !filter.tagIds.every((id) => t.tagIds.includes(id)))
        return false;
      if (
        filter.statuses?.length &&
        (row.status === 'unavailable' || !filter.statuses.includes(row.status))
      )
        return false;
      if (filter.priorities?.length && !filter.priorities.includes(t.priority)) return false;
      if (filter.importance && filter.importance !== t.importance) return false;
      if (filter.unscheduled && row.blocks.length) return false;
      if (filter.leafOnly && tasks.some((child) => child.parentTaskId === t.id)) return false;
      if (
        (filter.from || filter.to) &&
        !toDooItemMatchesDateRange(row, filter.from, filter.to, data.settings.timeZone)
      )
        return false;
      if (
        filter.dueBefore &&
        (!o?.due || toDooDisplayTime(o.due, data.settings.timeZone).date > filter.dueBefore)
      )
        return false;
      if (
        filter.overdue &&
        !toDooDeadlineOverdue(
          o?.due,
          row.status,
          toDooLocalDate(new Date(), data.settings.timeZone),
        )
      )
        return false;
      if (
        filter.hasEvidence !== undefined &&
        data.outcomes.some(
          (x) => !x.deletedAt && x.occurrenceId === o?.id && x.evidenceRefs.length > 0,
        ) !== filter.hasEvidence
      )
        return false;
      function match(condition: ToDooFilterGroup | ToDooFilterCondition): boolean {
        if ('conditions' in condition)
          return condition.operator === 'and'
            ? condition.conditions.every(match)
            : condition.conditions.some(match);
        const { field, operator, value } = condition;
        if (field === 'query') {
          const haystack = [
            row.title,
            t.description,
            t.criteria,
            ...data.records.filter((r) => r.taskId === t.id).map((r) => r.content),
            ...data.outcomes.filter((r) => r.occurrenceId === o?.id).map((r) => r.summary),
          ]
            .join(' ')
            .toLowerCase();
          const has = haystack.includes(String(value).toLowerCase());
          return operator === 'not_contains' ? !has : has;
        }
        if (['hasEvidence', 'isLeaf', 'isUnscheduled'].includes(field)) {
          const result =
            field === 'hasEvidence'
              ? data.outcomes.some(
                  (v) => !v.deletedAt && v.occurrenceId === o?.id && v.evidenceRefs.length,
                )
              : field === 'isLeaf'
                ? !tasks.some((v) => v.parentTaskId === t.id)
                : !row.blocks.length;
          return result === value;
        }
        let values: string[] = [];
        if (field === 'listId') values = t.listId ? [t.listId] : [];
        else if (field === 'tagId') values = t.tagIds;
        else if (field === 'status') values = [row.status];
        else if (field === 'priority') values = [t.priority];
        else if (field === 'importance') values = [t.importance];
        else if (field === 'dueDate')
          values = o?.due ? [toDooDisplayTime(o.due, data.settings.timeZone).date] : [];
        else if (field === 'plannedDate') values = row.blocks.map((b) => b.start.date);
        else if (field === 'createdDate')
          values = [toDooLocalDate(new Date(t.createdAt), data.settings.timeZone)];
        else if (field === 'completedDate')
          values = o?.completedAt
            ? [toDooLocalDate(new Date(o.completedAt), data.settings.timeZone)]
            : [];
        if (operator === 'is_empty') return !values.length;
        if (operator === 'not_empty') return !!values.length;
        const choices = Array.isArray(value) ? value : [String(value)];
        if (operator === 'before') return values.some((v) => v < choices[0]!);
        if (operator === 'after') return values.some((v) => v > choices[0]!);
        if (operator === 'on') return values.includes(choices[0]!);
        if (operator === 'between') return values.some((v) => v >= choices[0]! && v <= choices[1]!);
        const any = values.some((v) => choices.includes(v));
        return operator === 'is_not' || operator === 'not_in' ? !any : any;
      }
      if (filter.group && !match(filter.group)) return false;
      return true;
    });
  const priority = { high: 0, normal: 1, low: 2, none: 3 };
  rows.sort((a, b) =>
    sort === 'due'
      ? (a.occurrence?.due?.date || '9999').localeCompare(b.occurrence?.due?.date || '9999')
      : sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'priority'
          ? priority[a.task.priority] - priority[b.task.priority]
          : sort === 'created'
            ? b.task.createdAt.localeCompare(a.task.createdAt)
            : a.task.orderKey.localeCompare(b.task.orderKey),
  );
  if (sort !== 'manual') return rows;
  const output: ToDooItem[] = [],
    used = new Set<string>();
  const walk = (parent: string | null) =>
    rows
      .filter((r) => r.task.parentTaskId === parent)
      .forEach((r) => {
        if (used.has(r.key)) return;
        used.add(r.key);
        output.push(r);
        walk(r.task.id);
      });
  walk(null);
  rows.forEach((r) => {
    if (!used.has(r.key)) {
      used.add(r.key);
      output.push(r);
    }
  });
  return output;
}
export function focusElapsed(session: ToDooEntityMap['focusSession'], now = Date.now()) {
  return session.correctedMinutes !== null
    ? session.correctedMinutes * 60
    : session.segments.reduce(
        (n, s) =>
          n +
          Math.max(
            0,
            ((s.end
              ? Date.parse(s.end)
              : session.status === 'running'
                ? now
                : Date.parse(s.start)) -
              Date.parse(s.start)) /
              1000,
          ),
        0,
      );
}
export function createToDooWorkbench(request: ToDooRequest, options: { recoveryScope?: string } = {}) {
  const state = reactive({
    snapshot: null as ToDooSnapshot | null,
    selectedTaskId: '',
    selectedOccurrenceId: '',
    drafts: {} as Record<string, ToDooTaskDraft>,
    draftConflicts: [] as ToDooDraftConflict[],
    recoveredDraftKeys: [] as string[],
    unavailableDrafts: {} as Record<string, string>,
    recoveryStatus: 'idle' as 'idle' | 'saved' | 'unavailable',
    newTaskDrafts: {} as Record<string, ToDooNewTaskDraft>,
    pendingMutation: null as ToDooCommand | null,
    pendingOperations: [] as ToDooEntityMap['operation'][],
    operationPage: null as ToDooSnapshot['page'] | null,
    operationLoading: false,
    operationError: '',
    localWarning: '',
    detailPages: {} as Record<string, ToDooSnapshot['page']>,
    detailCollectionPages: {} as Record<string, NonNullable<ToDooSnapshot['collectionPages']>>,
    collectionLoading: false,
    selectedIds: [] as string[],
    collapsedTaskGroups: [] as string[],
    taskAncestors: {} as Record<string, ToDooTask>,
    listCatalog: [] as ToDooEntityMap['list'][],
    filter: {} as ToDooFilter,
    externalDirty: {} as Record<string, boolean>,
    sort: 'manual',
    query: { limit: 200 } as ToDooQuery,
    loading: false,
    busy: false,
    error: '',
    conflict: false,
    conflictDraftKey: '',
    conflictDraftKeys: [] as string[],
    rebasedFields: [] as string[],
    notice: '',
    completionFeedback: null as ToDooCompletionFeedback | null,
    preview: null as ToDooCommandResult['preview'] | null,
  });
  const saved = new Map<string, string>();
  const newSaved = new Map<string, string>();
  let restoringRecovery = false;
  let recoveryReadBlocked = false;
  const recoveryWriteWarning = '浏览器暂时不能保存恢复信息，请在当前页面核对提交结果后再离开。';
  const recoveryReadWarning = '本地恢复信息无法读取，当前服务器内容仍可正常访问。';
  const recoveryKey = (datasetId: string) => 'dooknow.to-doo.recovery:' +
    (options.recoveryScope ? encodeURIComponent(options.recoveryScope) + ':' : '') + datasetId;
  type PlanCheckpoint = {
    draftKey: string;
    datasetId: string;
    submitted: ToDooEntityMap['timeBlock'];
    revision: string;
    occurrenceRevision?: string;
  };
  const pendingPlanCheckpoints = new Map<string, PlanCheckpoint>();
  const pendingStatusReceipts = new Map<
    string,
    {
      datasetId: string;
      revision: string;
      previousRevision?: string;
    }
  >();
  let completionUndo:
    | {
        datasetId: string;
        occurrenceId: string;
        expectedRevision: string;
        previousStatus: ToDooOccurrence['status'];
        title: string;
      }
    | undefined;
  const newDefaults = (parentTaskId: string | null, listId: string | null): ToDooNewTaskDraft => ({
    title: '',
    description: '',
    criteria: '',
    parentTaskId,
    listId,
    dueDate: '',
    dueTime: '',
    planDate: '',
    planTime: '',
    estimate: '',
    initialStatus: 'todo',
    priority: 'none',
    reminders: [],
    tagIds: [],
    frequency: null,
    weekdays: [],
    recurrenceId: crypto.randomUUID(),
  });
  function persistRecovery() {
    if (restoringRecovery || !state.snapshot) return false;
    // Preserve an unreadable/newer recovery record instead of replacing it with empty state.
    if (recoveryReadBlocked) return false;
    try {
      if (typeof localStorage === 'undefined') {
        state.recoveryStatus = 'unavailable';
        return false;
      }
      const edits = Object.fromEntries(Object.entries(state.drafts)
        .filter(([key, value]) => saved.has(key) && saved.get(key) !== fingerprint(value))
        .map(([key, value]) => [key, { draft: value, baseline: JSON.parse(saved.get(key)!),
          conflicts: state.draftConflicts.filter((entry) => entry.draftKey === key),
          updatedAt: new Date().toISOString() }]));
      localStorage.setItem(
        recoveryKey(state.snapshot.datasetId),
        JSON.stringify({ schemaVersion: 2, datasetId: state.snapshot.datasetId,
          scope: options.recoveryScope || '', pending: state.pendingMutation,
          drafts: state.newTaskDrafts, edits,
          planCheckpoints: [...pendingPlanCheckpoints.entries()],
          statusReceipts: [...pendingStatusReceipts.entries()] }),
      );
      state.recoveryStatus = 'saved';
      if (state.localWarning === recoveryWriteWarning || state.localWarning === recoveryReadWarning)
        state.localWarning = '';
      return true;
    } catch {
      state.recoveryStatus = 'unavailable';
      state.localWarning = recoveryWriteWarning;
      return false;
    }
  }
  function restoreRecovery(datasetId: string) {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = JSON.parse(
        localStorage.getItem(recoveryKey(datasetId)) || 'null',
      );
      if (raw && (raw.schemaVersion && raw.schemaVersion !== 2 ||
        raw.datasetId && raw.datasetId !== datasetId ||
        raw.scope && raw.scope !== (options.recoveryScope || '')))
        throw Error('恢复信息版本或资料库不匹配');
      const parsed = toDooCommandSchema.safeParse(raw?.pending);
      if (raw?.pending && !parsed.success) throw Error('未决请求无法读取');
      if (parsed.success) state.pendingMutation = parsed.data;
      for (const [key, value] of Object.entries(raw?.drafts || {})) {
        const d = value as ToDooNewTaskDraft;
        if (
          !d ||
          typeof d.title !== 'string' ||
          d.title.length > 256 ||
          typeof d.description !== 'string' ||
          typeof d.criteria !== 'string' ||
          d.description.length > 65536 ||
          d.criteria.length > 65536
        )
          continue;
        const base = newDefaults(
          typeof d.parentTaskId === 'string' ? d.parentTaskId : null,
          typeof d.listId === 'string' ? d.listId : null,
        );
        base.recurrenceId = typeof d.recurrenceId === 'string' ? d.recurrenceId : base.recurrenceId;
        newSaved.set(key, fingerprint(base));
        state.newTaskDrafts[key] = { ...base, ...d };
      }
      for (const [draftKey, entry] of Object.entries(raw?.edits || {})) {
        const item = entry as { draft?: unknown; baseline?: unknown; conflicts?: ToDooDraftConflict[] };
        const readDraft = (input: unknown, editable = false): ToDooTaskDraft | null => {
          if (!input || typeof input !== 'object') return null;
          const value = input as ToDooTaskDraft;
          const task = toDooEntitySchemas.task.safeParse(editable && value.task ? {
            ...value.task, title: value.task.title === '' ? '恢复中的任务' : value.task.title,
            recurrence: value.task.recurrence ? { ...value.task.recurrence,
              time: value.task.recurrence.time || null, until: value.task.recurrence.until || null,
              count: value.task.recurrence.count || null } : null,
          } : value.task);
          const occurrence = value.occurrence === null ? null : toDooEntitySchemas.occurrence.safeParse(value.occurrence);
          if (!task.success || occurrence && !occurrence.success || !Array.isArray(value.blocks) ||
            value.blocks.length > 10000) return null;
          const blocks = value.blocks.map((block) => toDooEntitySchemas.timeBlock.safeParse(
            editable && block.revision === '' ? { ...block, revision: 'unsaved' } : block));
          if (blocks.some((block) => !block.success)) return null;
          const result = { task: { ...task.data, ...(editable && value.task.title === '' ? { title: '' } : {}) },
            occurrence: occurrence?.success ? occurrence.data : null,
            blocks: blocks.filter((block) => block.success).map((block, index) => ({ ...block.data!,
              ...(editable && value.blocks[index]?.revision === '' ? { revision: '' } : {}) })) };
          if (result.occurrence && result.occurrence.taskId !== result.task.id ||
            result.blocks.some((block) => block.occurrenceId !== result.occurrence?.id)) return null;
          return result;
        };
        const local = readDraft(item?.draft, true), baseline = readDraft(item?.baseline);
        if (!local || !baseline || local.task.id !== baseline.task.id ||
          local.occurrence?.id !== baseline.occurrence?.id ||
          draftKey !== local.task.id + '@' + (local.occurrence?.id || '')) {
          recoveryReadBlocked = true;
          state.localWarning = recoveryReadWarning;
          continue;
        }
        state.drafts[draftKey] = local;
        saved.set(draftKey, fingerprint(baseline));
        state.recoveredDraftKeys.push(draftKey);
        for (const conflict of Array.isArray(item.conflicts) ? item.conflicts : []) {
          const kind = conflict?.kind, entityId = conflict?.entityId, field = conflict?.field;
          if (!['task', 'occurrence', 'timeBlock'].includes(kind) || typeof entityId !== 'string' ||
            typeof field !== 'string' || ['__proto__', 'prototype', 'constructor', 'id', 'revision',
              'createdAt', 'updatedAt', 'scheduleRevision'].includes(field)) continue;
          const mine = conflictEntity(local, kind, entityId), theirs = conflictEntity(baseline, kind, entityId);
          if ((!mine && !theirs) || field === '$entity' && kind !== 'timeBlock' ||
            field !== '$entity' && !Object.hasOwn(mine || theirs || {}, field)) continue;
          state.draftConflicts.push({ id: [draftKey, kind, entityId, field].join('\0'),
            draftKey, kind, entityId, field, label: typeof conflict.label === 'string'
              ? conflict.label.slice(0, 128) : '待比较的字段',
            local: conflictValue(local, kind, entityId, field),
            remote: conflictValue(baseline, kind, entityId, field) });
        }
      }
      for (const pair of raw?.planCheckpoints || []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, entry] = pair as [string, PlanCheckpoint];
        if (typeof id !== 'string' || !entry || entry.datasetId !== datasetId ||
          !state.drafts[entry.draftKey] || typeof entry.revision !== 'string') continue;
        const submitted = toDooEntitySchemas.timeBlock.safeParse(entry.submitted && {
          ...entry.submitted, revision: entry.submitted.revision || 'unsaved' });
        if (submitted.success && id === entry.draftKey + '\0' + submitted.data.id)
          pendingPlanCheckpoints.set(id, { ...entry, submitted: { ...submitted.data,
            revision: entry.submitted.revision } });
      }
      for (const pair of raw?.statusReceipts || []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, entry] = pair;
        if (typeof id === 'string' && entry?.datasetId === datasetId && typeof entry.revision === 'string')
          pendingStatusReceipts.set(id, entry);
      }
      state.recoveryStatus = recoveryReadBlocked ? 'unavailable' : 'saved';
    } catch {
      recoveryReadBlocked = true;
      state.recoveryStatus = 'unavailable';
      state.localWarning = recoveryReadWarning;
    }
  }
  function newTaskDraft(parent?: string, list?: string | null, seed?: ToDooCreateSeed) {
    const listId =
        list !== undefined
          ? list || null
          : seed?.listId !== undefined
            ? seed.listId
            : state.snapshot?.tasks.find((t) => t.id === parent)?.listId || null,
      key = (parent || '') + '@' + (listId || '');
    if (!state.newTaskDrafts[key]) {
      const value = { ...newDefaults(parent || null, listId), ...clone(seed || {}), listId };
      newSaved.set(key, fingerprint(value));
      state.newTaskDrafts[key] = value;
    } else if (
      seed &&
      newSaved.get(key) === fingerprint(state.newTaskDrafts[key]) &&
      Object.entries(seed).some(
        ([field, value]) =>
          fingerprint(state.newTaskDrafts[key][field as keyof ToDooNewTaskDraft]) !==
          fingerprint(value),
      )
    ) {
      // Quick capture eagerly creates an untouched placeholder. Context may seed that
      // placeholder, while edited and recovered drafts keep every user choice.
      Object.assign(state.newTaskDrafts[key], clone(seed), { listId });
      newSaved.set(key, fingerprint(state.newTaskDrafts[key]));
    }
    return state.newTaskDrafts[key]!;
  }
  function clearNewTaskDraft(parent?: string, list?: string | null) {
    const listId =
        list !== undefined
          ? list || null
          : state.snapshot?.tasks.find((t) => t.id === parent)?.listId || null,
      key = (parent || '') + '@' + (listId || '');
    delete state.newTaskDrafts[key];
    newSaved.delete(key);
    persistRecovery();
  }
  function retainedNewTaskDrafts() {
    return Object.entries(state.newTaskDrafts)
      .filter(([key, value]) => newSaved.get(key) !== fingerprint(value))
      .map(([key, draft]) => {
        // Recovery keys retain the original context when the editable destination changes.
        const [parentTaskId, listId] = key.split('@');
        return { key, draft, parentTaskId: parentTaskId || null, listId: listId || null };
      });
  }
  watch(() => [state.newTaskDrafts, state.pendingMutation, state.drafts, state.draftConflicts],
    persistRecovery, { deep: true });
  let generation = 0;
  const key = () => state.selectedTaskId + '@' + state.selectedOccurrenceId;
  const draft = () => state.drafts[key()];
  const dirty = (id?: string) =>
    id
      ? Object.entries(state.drafts).some(
          ([k, v]) => v.task.id === id && saved.get(k) !== fingerprint(v),
        )
      : !!draft() && saved.get(key()) !== fingerprint(draft());
  function syncSelectedConflict() {
    state.conflict = state.conflictDraftKeys.includes(key()) ||
      state.draftConflicts.some((entry) => entry.draftKey === key());
    state.conflictDraftKey = state.conflict ? key() : '';
  }
  function markDraftConflict(draftKey: string) {
    if (state.drafts[draftKey] && !state.conflictDraftKeys.includes(draftKey))
      state.conflictDraftKeys.push(draftKey);
    syncSelectedConflict();
  }
  // Detail saves use several commands; retain every committed revision if a later step fails.
  function checkpointSavedEntity(
    draftKey: string,
    submitted: object,
    remote: ToDooEntity | undefined,
    kind: 'task' | 'occurrence' | 'timeBlock',
    baseline: ToDooTaskDraft,
    relatedOccurrence?: ToDooOccurrence,
  ) {
    const current = state.drafts[draftKey];
    if (!remote || !current) return;
    let target =
      kind === 'timeBlock' ? current.blocks.find((b) => b.id === remote.id) : current[kind];
    if (kind === 'timeBlock' && !target) {
      // Removing a new block while its save is in flight still means remove it.
      const block = remote as ToDooEntityMap['timeBlock'];
      target = { ...clone(block), deletedAt: block.deletedAt || new Date().toISOString() };
      current.blocks.push(target);
    }
    if (target) {
      const input = submitted as unknown as Record<string, unknown>,
        output = target as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(remote)) {
        if (
          ['id', 'revision', 'createdAt', 'updatedAt'].includes(field) ||
          (field === 'deletedAt' && kind !== 'timeBlock') ||
          fingerprint(output[field]) === fingerprint(input[field])
        )
          output[field] = clone(value);
      }
    }
    if (kind === 'task') baseline.task = clone(remote as ToDooTask);
    else if (kind === 'occurrence') baseline.occurrence = clone(remote as ToDooOccurrence);
    else {
      const index = baseline.blocks.findIndex((b) => b.id === remote.id);
      if (index < 0) baseline.blocks.push(clone(remote as ToDooEntityMap['timeBlock']));
      else baseline.blocks[index] = clone(remote as ToDooEntityMap['timeBlock']);
      const occurrenceId = (remote as ToDooEntityMap['timeBlock']).occurrenceId;
      if (baseline.occurrence?.id === occurrenceId) {
        checkpointSavedEntity(
          draftKey,
          clone(baseline.occurrence),
          relatedOccurrence || state.snapshot?.occurrences.find((o) => o.id === occurrenceId),
          'occurrence',
          baseline,
        );
      }
    }
    saved.set(draftKey, fingerprint(baseline));
    persistRecovery();
  }
  async function resumePlanCheckpoint(entry: PlanCheckpoint, baseline: ToDooTaskDraft) {
    const entryKey = entry.draftKey + '\0' + entry.submitted.id;
    if (state.snapshot?.datasetId !== entry.datasetId || !state.drafts[entry.draftKey]) {
      pendingPlanCheckpoints.delete(entryKey);
      return false;
    }
    let block = state.snapshot.timeBlocks.find((row) => row.id === entry.submitted.id);
    let occurrence = state.snapshot.occurrences.find(
      (row) => row.id === entry.submitted.occurrenceId,
    );
    if (
      block?.revision !== entry.revision ||
      (entry.occurrenceRevision && occurrence?.revision !== entry.occurrenceRevision)
    ) {
      const ticket = generation;
      const query = new URLSearchParams({
        kinds: 'timeBlock,occurrence',
        ids: [entry.submitted.id, entry.submitted.occurrenceId].filter(Boolean).join(','),
        filter: JSON.stringify({ includeDeleted: true, includeArchived: true }),
        limit: '500',
      });
      try {
        const data = (await request('/api/to-doo/state?' + query.toString())) as ToDooSnapshot;
        if (data.datasetId !== entry.datasetId || state.snapshot?.datasetId !== entry.datasetId)
          throw Error('资料库已变化，请重新载入后核对计划');
        block = data.timeBlocks.find((row) => row.id === entry.submitted.id);
        occurrence = data.occurrences.find((row) => row.id === entry.submitted.occurrenceId);
        if (
          block?.revision !== entry.revision ||
          (entry.occurrenceRevision && occurrence?.revision !== entry.occurrenceRevision)
        )
          throw Object.assign(Error('计划版本已变化，请核对最新内容；当前输入仍保留。'), {
            status: 409,
          });
        if (ticket === generation) adoptDetail(data);
      } catch (cause) {
        state.error =
          (cause as { status?: number }).status === 409
            ? (cause as Error).message
            : '计划已保存，但最新版本暂时无法读取。请重试保存，当前输入仍保留。';
        if ((cause as { status?: number }).status === 409) markDraftConflict(entry.draftKey);
        return false;
      }
    }
    checkpointSavedEntity(
      entry.draftKey,
      entry.submitted,
      block,
      'timeBlock',
      baseline,
      occurrence,
    );
    pendingPlanCheckpoints.delete(entryKey);
    persistRecovery();
    return true;
  }
  async function checkpointCommittedPlan(
    draftKey: string,
    block: ToDooEntityMap['timeBlock'],
    baseline: ToDooTaskDraft,
    result: ToDooCommandResult,
  ) {
    const revision = result.changed.find(
      (row) => row.kind === 'timeBlock' && row.id === block.id,
    )?.revision;
    if (!revision) {
      checkpointSavedEntity(
        draftKey,
        block,
        state.snapshot?.timeBlocks.find((row) => row.id === block.id),
        'timeBlock',
        baseline,
      );
      return true;
    }
    const entry: PlanCheckpoint = {
      draftKey,
      datasetId: result.snapshot.datasetId,
      submitted: clone(block),
      revision,
      occurrenceRevision: result.changed.find(
        (row) => row.kind === 'occurrence' && row.id === block.occurrenceId,
      )?.revision,
    };
    pendingPlanCheckpoints.set(draftKey + '\0' + block.id, entry);
    persistRecovery();
    return resumePlanCheckpoint(entry, baseline);
  }
  const hasUnsavedChanges = () =>
    !!state.pendingMutation ||
    Object.entries(state.newTaskDrafts).some(
      ([key, value]) => newSaved.get(key) !== fingerprint(value),
    ) ||
    Object.values(state.externalDirty).some(Boolean) ||
    Object.entries(state.drafts).some(([k, v]) => saved.get(k) !== fingerprint(v));
  function selectTask(id: string, occurrenceId?: string) {
    state.selectedTaskId = id;
    const data = state.snapshot,
      task = data?.tasks.find((t) => t.id === id);
    const occurrence =
      data?.occurrences.find((o) => o.id === occurrenceId && o.taskId === id && !o.deletedAt) ||
      data?.occurrences
        .filter((o) => o.taskId === id && !o.deletedAt)
        .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''))[0] ||
      null;
    const retained = occurrenceId && state.drafts[id + '@' + occurrenceId];
    state.selectedOccurrenceId = retained ? occurrenceId : occurrence?.id || '';
    syncSelectedConflict();
    if (!task) return;
    if (state.drafts[key()] && dirty()) return;
    const value = clone({
      task,
      occurrence,
      blocks:
        data?.timeBlocks.filter((b) => !b.deletedAt && b.occurrenceId === occurrence?.id) || [],
    });
    state.drafts[key()] = value;
    saved.set(key(), fingerprint(value));
  }
  function adopt(data: ToDooSnapshot, append = false) {
    const changedDataset = state.snapshot?.datasetId !== data.datasetId;
    if (changedDataset || state.snapshot?.version !== data.version) state.taskAncestors = {};
    if (changedDataset) state.listCatalog = [];
    if (changedDataset) {
      persistRecovery();
      restoringRecovery = true;
      recoveryReadBlocked = false;
      if (state.completionFeedback) state.notice = '';
      state.completionFeedback = null;
      completionUndo = undefined;
      pendingPlanCheckpoints.clear();
      pendingStatusReceipts.clear();
      state.drafts = {};
      state.newTaskDrafts = {};
      saved.clear();
      newSaved.clear();
      state.draftConflicts = [];
      state.conflictDraftKeys = [];
      state.conflictDraftKey = '';
      state.conflict = false;
      state.recoveredDraftKeys = [];
      state.unavailableDrafts = {};
      state.recoveryStatus = 'idle';
      state.selectedTaskId = '';
      state.selectedOccurrenceId = '';
      state.selectedIds = [];
      state.detailPages = {};
      state.detailCollectionPages = {};
      state.pendingOperations = [];
      state.operationPage = null;
    }
    if (append && state.snapshot && !changedDataset) {
      const next = clone(data);
      next.collectionPages = { ...state.snapshot.collectionPages, ...data.collectionPages };
      for (const collection of Object.values(TO_DOO_COLLECTIONS)) {
        const merged = new Map<string, ToDooEntity>(
          (state.snapshot[collection] as ToDooEntity[]).map((v) => [v.id, v]),
        );
        (data[collection] as ToDooEntity[]).forEach((v) => merged.set(v.id, v));
        (next[collection] as ToDooEntity[]) = [...merged.values()];
      }
      state.snapshot = next;
    } else state.snapshot = data;
    if (changedDataset) {
      state.pendingMutation = null;
      restoreRecovery(data.datasetId);
      restoringRecovery = false;
    }
  }
  async function hydrateTaskDefinitions(ticket: number) {
    const missing = [
      ...new Set(
        state.snapshot?.occurrences
          .map((o) => o.taskId)
          .filter((id) => !state.snapshot?.tasks.some((t) => t.id === id)) || [],
      ),
    ];
    for (let i = 0; i < missing.length; i += 200) {
      const data = (await request(
        '/api/to-doo/state?kind=task&ids=' +
          encodeURIComponent(missing.slice(i, i + 200).join(',')) +
          '&limit=200',
      )) as ToDooSnapshot;
      if (ticket !== generation) return;
      const pages = { ...state.snapshot?.collectionPages };
      adoptDetail(data);
      if (state.snapshot) state.snapshot.collectionPages = pages;
    }
  }
  function taskDefinitions() {
    return [
      ...new Map(
        [...Object.values(state.taskAncestors), ...(state.snapshot?.tasks ?? [])].map((task) => [
          task.id,
          task,
        ]),
      ).values(),
    ];
  }
  let catalogRead: Promise<void> | undefined;
  let catalogVersion = '';
  function taskLists() {
    return [
      ...new Map(
        [...state.listCatalog, ...(state.snapshot?.lists ?? [])].map((list) => [list.id, list]),
      ).values(),
    ].filter((list) => !list.deletedAt);
  }
  function ensureListCatalog(): Promise<void> {
    if (catalogRead) return catalogRead;
    if (catalogVersion === state.snapshot?.datasetId + ':' + state.snapshot?.version)
      return Promise.resolve();
    const dataset = state.snapshot?.datasetId;
    catalogRead = (async () => {
      const lists: ToDooEntityMap['list'][] = [];
      const seen = new Set<string>();
      let cursor: string | undefined, version: string | undefined;
      do {
        const query = new URLSearchParams({ kind: 'list', limit: '500' });
        if (cursor) query.set('cursor', cursor);
        const page = await request('/api/to-doo/state?' + query.toString());
        if (state.snapshot?.datasetId !== dataset) return;
        version ??= page.version;
        if (version !== page.version) throw Error('清单有更新，请重新打开菜单');
        lists.push(...page.lists);
        cursor = page.page?.nextCursor || undefined;
        if (cursor && (seen.has(cursor) || seen.size >= 20))
          throw Error('清单较多，请先完成目录载入');
        if (cursor) seen.add(cursor);
      } while (cursor);
      state.listCatalog = lists;
      catalogVersion = dataset + ':' + version;
    })()
      .catch((cause) => {
        state.error = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        catalogRead = undefined;
      });
    return catalogRead;
  }
  async function hydrateTaskAncestors(ticket: number) {
    if (
      state.query.view &&
      !['tasks', 'board', 'matrix', 'calendar', 'timeline', 'overview'].includes(state.query.view)
    )
      return;
    const attempted = new Set<string>();
    for (let depth = 0; depth < 1024; depth++) {
      const known = taskDefinitions();
      const ids = new Set(known.map((task) => task.id));
      const missing = [
        ...new Set(
          known
            .filter((task) => !task.sectionId)
            .map((task) => task.parentTaskId)
            .filter((id): id is string => !!id && !ids.has(id) && !attempted.has(id)),
        ),
      ];
      if (!missing.length) return;
      const version = state.snapshot?.version;
      for (let start = 0; start < missing.length; start += 100) {
        const part = missing.slice(start, start + 100);
        const data = await request(
          '/api/to-doo/state?kind=task&ids=' + encodeURIComponent(part.join(',')) + '&limit=100',
        );
        if (ticket !== generation) return;
        if (data.version !== version) throw Error('任务分组有更新，请刷新后重试');
        part.forEach((id) => attempted.add(id));
        for (const task of data.tasks as ToDooTask[])
          if (part.includes(task.id)) state.taskAncestors[task.id] = task;
      }
    }
    throw Error('任务层级较深，请先展开对应父任务再重试');
  }
  async function load(query: ToDooQuery = state.query, append = false) {
    const ticket = ++generation;
    state.loading = true;
    state.error = '';
    const filter = query.filter
      ? Object.fromEntries(
          Object.entries(query.filter).filter(
            ([, value]) => !Array.isArray(value) || value.length > 0,
          ),
        )
      : undefined;
    state.query = {
      ...query,
      ...(filter ? { filter } : {}),
      limit: Math.min(query.limit || 200, 500),
    };
    const params = new URLSearchParams();
    Object.entries(state.query).forEach(([k, v]) => {
      if (v !== undefined && k !== 'all')
        params.set(
          k,
          Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v),
        );
    });
    try {
      const data = await request('/api/to-doo/state?' + params.toString());
      if (ticket === generation) {
        adopt(data, append);
        if (pendingStatusReceipts.size) {
          const records = await readCommittedStatuses(state.snapshot!, ticket);
          if (ticket !== generation) return data as ToDooSnapshot;
          mergeCommittedStatuses(records);
        }
        await hydrateTaskDefinitions(ticket);
        await hydrateTaskAncestors(ticket);
        if (state.selectedTaskId) selectTask(state.selectedTaskId, state.selectedOccurrenceId);
      }
      return data as ToDooSnapshot;
    } catch (e) {
      if (ticket === generation) state.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (ticket === generation) state.loading = false;
    }
  }
  function adoptDetail(data: ToDooSnapshot, id?: string) {
    const page = state.snapshot?.page,
      collectionPages = state.snapshot?.collectionPages,
      statistics = state.snapshot?.statistics;
    adopt(data, true);
    if (state.snapshot && page) state.snapshot.page = page;
    if (id && state.snapshot) state.snapshot.collectionPages = collectionPages;
    if (state.snapshot && statistics) state.snapshot.statistics = statistics;
    if (id) {
      state.detailPages[id] = data.page;
      state.detailCollectionPages[id] = {
        ...state.detailCollectionPages[id],
        ...data.collectionPages,
      };
    }
  }
  async function ensureTask(id: string, cursor?: string) {
    const ticket = generation;
    try {
      const data = (await request(
        '/api/to-doo/state?taskIds=' +
          encodeURIComponent(id) +
          '&includeTree=true&limit=500' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )) as ToDooSnapshot;
      if (ticket === generation) adoptDetail(data, id);
      return data;
    } catch (e) {
      if (ticket === generation) state.error = e instanceof Error ? e.message : String(e);
    }
  }
  async function nextCollectionPage(kind: ToDooEntityKind, taskId?: string) {
    const meta = taskId
      ? state.detailCollectionPages[taskId]?.[kind]
      : state.snapshot?.collectionPages?.[kind];
    if (!meta?.nextCursor || state.collectionLoading) return;
    const ticket = generation;
    const query: ToDooQuery = taskId
      ? { taskIds: [taskId], includeTree: true, limit: 500 }
      : { ...state.query };
    delete query.kinds;
    Object.assign(query, { kind, limit: meta.limit, cursor: meta.nextCursor });
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined)
        params.set(
          k,
          Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v),
        );
    });
    state.collectionLoading = true;
    state.error = '';
    try {
      const data = (await request('/api/to-doo/state?' + params.toString())) as ToDooSnapshot;
      if (ticket !== generation) return;
      const outerPage = state.snapshot?.page,
        outerPages = { ...state.snapshot?.collectionPages };
      adoptDetail(data);
      if (taskId) {
        state.detailCollectionPages[taskId] = {
          ...state.detailCollectionPages[taskId],
          [kind]: data.collectionPages?.[kind] || data.page,
        };
        if (state.snapshot) state.snapshot.collectionPages = outerPages;
      }
      if (state.snapshot && outerPage) state.snapshot.page = outerPage;
      await hydrateTaskAncestors(ticket);
      await hydrateTaskDefinitions(ticket);
      if (state.selectedTaskId) selectTask(state.selectedTaskId, state.selectedOccurrenceId);
      return data;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.collectionLoading = false;
    }
  }
  async function loadPendingOperations(append = false) {
    if (state.operationLoading) return;
    const ticket = generation;
    state.operationLoading = true;
    state.operationError = '';
    try {
      const cursor = append ? state.operationPage?.nextCursor : null;
      const data = (await request(
        '/api/to-doo/state?kind=operation&limit=50' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )) as ToDooSnapshot;
      if (ticket !== generation) return;
      const values = new Map((append ? state.pendingOperations : []).map((o) => [o.id, o]));
      data.operations.forEach((o) => values.set(o.id, o));
      state.pendingOperations = [...values.values()].filter(
        (o) => !o.deletedAt && o.state !== 'completed',
      );
      state.operationPage = data.page;
    } catch (e) {
      if (ticket === generation) state.operationError = e instanceof Error ? e.message : String(e);
    } finally {
      state.operationLoading = false;
    }
  }
  const statusReadWarning =
    '任务状态已保存，但最新记录暂时无法读取。请刷新后核对，当前输入仍保留。';
  function statusReceiptConflict() {
    state.error = '任务状态已保存，但记录版本已变化。请核对最新内容，当前输入仍保留。';
    markDraftConflict(key());
  }
  async function readCommittedStatuses(data: ToDooSnapshot, ticket: number) {
    const records = new Map<string, ToDooOccurrence>();
    const entries = [...pendingStatusReceipts].filter(
      ([, entry]) => entry.datasetId === data.datasetId,
    );
    const missing: typeof entries = [];
    for (const [id, entry] of entries) {
      const row = data.occurrences.find((row) => row.id === id && row.revision === entry.revision);
      if (row) records.set(id, clone(row));
      else missing.push([id, entry]);
    }
    for (let offset = 0; offset < missing.length; offset += 50) {
      const part = missing.slice(offset, offset + 50);
      const query = new URLSearchParams({
        kinds: 'occurrence',
        ids: part.map(([id]) => id).join(','),
        filter: JSON.stringify({ includeDeleted: true, includeArchived: true }),
        limit: '50',
      });
      try {
        const page = (await request('/api/to-doo/state?' + query)) as ToDooSnapshot;
        if (ticket !== generation || state.snapshot?.datasetId !== data.datasetId)
          return new Map<string, ToDooOccurrence>();
        if (page.datasetId !== data.datasetId)
          throw Error('资料库已变化，请重新载入后核对任务状态');
        for (const [id, entry] of part) {
          if (pendingStatusReceipts.get(id)?.revision !== entry.revision) continue;
          const row = page.occurrences.find((row) => row.id === id);
          if (row?.revision === entry.revision) records.set(id, clone(row));
          else {
            pendingStatusReceipts.delete(id);
            statusReceiptConflict();
          }
        }
      } catch {
        if (ticket === generation && state.snapshot?.datasetId === data.datasetId)
          state.localWarning = statusReadWarning;
        break;
      }
    }
    return records;
  }
  function checkpointStatusDrafts(records: Map<string, ToDooOccurrence>) {
    for (const [draftKey, current] of Object.entries(state.drafts)) {
      const remote = current.occurrence && records.get(current.occurrence.id);
      if (!remote) continue;
      const baseline = JSON.parse(saved.get(draftKey) || fingerprint(current)) as ToDooTaskDraft;
      checkpointSavedEntity(
        draftKey,
        baseline.occurrence || current.occurrence!,
        remote,
        'occurrence',
        baseline,
      );
    }
  }
  function mergeCommittedStatuses(records: Map<string, ToDooOccurrence>) {
    const accepted = new Map<string, ToDooOccurrence>();
    if (!state.snapshot) return accepted;
    const values = new Map(state.snapshot.occurrences.map((row) => [row.id, row]));
    for (const [id, row] of records) {
      const entry = pendingStatusReceipts.get(id);
      if (!entry || entry.datasetId !== state.snapshot.datasetId || entry.revision !== row.revision)
        continue;
      const current = values.get(id);
      if (
        current &&
        current.revision !== entry.revision &&
        current.revision !== entry.previousRevision
      ) {
        pendingStatusReceipts.delete(id);
        statusReceiptConflict();
        continue;
      }
      values.set(id, clone(row));
      accepted.set(id, row);
      pendingStatusReceipts.delete(id);
    }
    state.snapshot.occurrences = [...values.values()];
    checkpointStatusDrafts(accepted);
    if (!pendingStatusReceipts.size && state.localWarning === statusReadWarning)
      state.localWarning = '';
    return accepted;
  }
  async function execute(input: ToDooInput, notice = '已保存') {
    if (state.busy) return;
    // Only the latest write can offer an undo; this state is never recovery data.
    state.completionFeedback = null;
    completionUndo = undefined;
    const parsedInput = toDooCommandSchema.safeParse({ ...input, requestId: 'pending' });
    const normalized: ToDooInput = parsedInput.success
      ? ({ action: parsedInput.data.action, payload: parsedInput.data.payload } as ToDooInput)
      : input;
    if (
      state.pendingMutation &&
      fingerprint({
        action: state.pendingMutation.action,
        payload: state.pendingMutation.payload,
      }) !== fingerprint(normalized)
    ) {
      state.error = '尚有结果待核对的原操作，请先重试原操作，再提交不同内容。';
      state.notice = '';
      return;
    }
    const command =
      state.pendingMutation || ({ ...normalized, requestId: crypto.randomUUID() } as ToDooCommand);
    const affectedDraftKeys = Object.entries(state.drafts).filter(([, value]) => {
      if (command.action === 'update_task') return value.task.id === command.payload.id;
      if (command.action === 'change_recurrence') return value.task.id === command.payload.taskId;
      if (command.action === 'set_occurrence_status') return value.occurrence?.id === command.payload.id;
      if (command.action === 'save_entity') return command.payload.kind === 'task'
        ? value.task.id === command.payload.entity.id : command.payload.kind === 'occurrence'
          ? value.occurrence?.id === command.payload.entity.id : command.payload.kind === 'timeBlock'
            && value.blocks.some((block) => block.id === command.payload.entity.id);
      if (command.action === 'batch_tasks') return command.payload.ids.includes(value.task.id);
      return false;
    }).map(([draftKey]) => draftKey);
    const statusBefore =
      command.action === 'set_occurrence_status' && state.snapshot
        ? clone({
            datasetId: state.snapshot.datasetId,
            tasks: state.snapshot.tasks,
            occurrences: state.snapshot.occurrences,
            timeBlocks: state.snapshot.timeBlocks,
          })
        : undefined;
    const completion = (() => {
      if (command.action !== 'set_occurrence_status' || command.payload.status !== 'done') return;
      const occurrence = state.snapshot?.occurrences.find((row) => row.id === command.payload.id);
      const task = occurrence && taskDefinitions().find((row) => row.id === occurrence.taskId);
      if (!occurrence || !task || !state.snapshot) return;
      return {
        datasetId: state.snapshot.datasetId,
        taskId: task.id,
        occurrenceId: occurrence.id,
        title: task.title,
        previousStatus: occurrence.status,
        simple:
          !command.payload.cascade &&
          occurrence.status !== 'done' &&
          !task.recurrence &&
          !task.parentTaskId &&
          !occurrence.parentOccurrenceId,
      };
    })();
    state.pendingMutation = command;
    persistRecovery();
    state.busy = true;
    state.error = '';
    syncSelectedConflict();
    state.notice = '';
    const ticket = ++generation;
    state.loading = false;
    try {
      const result = (await request('/api/to-doo/commands', 'POST', command)) as ToDooCommandResult;
      if (
        command.action === 'set_occurrence_status' &&
        state.pendingMutation?.requestId === command.requestId
      ) {
        // The write is confirmed. A failed follow-up read must never replay it.
        state.pendingMutation = null;
        persistRecovery();
      }
      let statusRecords = new Map<string, ToDooOccurrence>();
      if (statusBefore) {
        if (
          state.snapshot?.datasetId !== statusBefore.datasetId ||
          result.snapshot.datasetId !== statusBefore.datasetId
        )
          return result;
        for (const changed of result.changed.filter((row) => row.kind === 'occurrence'))
          pendingStatusReceipts.set(changed.id, {
            datasetId: statusBefore.datasetId,
            revision: changed.revision,
            previousRevision: statusBefore.occurrences.find((row) => row.id === changed.id)
              ?.revision,
          });
        statusRecords = await readCommittedStatuses(result.snapshot, ticket);
        if (state.snapshot?.datasetId !== statusBefore.datasetId) return result;
        if (ticket === generation) {
          const next = clone(result.snapshot);
          for (const [kind, collection] of [
            ['task', 'tasks'],
            ['occurrence', 'occurrences'],
            ['timeBlock', 'timeBlocks'],
          ] as const) {
            const changedIds = new Set(
              result.changed.filter((row) => row.kind === kind).map((row) => row.id),
            );
            const values = new Map<string, ToDooEntity>(
              (statusBefore[collection] as ToDooEntity[])
                .filter((row) => !changedIds.has(row.id))
                .map((row) => [row.id, row]),
            );
            (next[collection] as ToDooEntity[]).forEach((row) => values.set(row.id, row));
            // Keep the last readable fields when a confirmed write's read-back is unavailable.
            if (kind === 'occurrence')
              for (const row of statusBefore.occurrences)
                if (!values.has(row.id) && !statusRecords.has(row.id)) values.set(row.id, row);
            if (kind === 'occurrence') statusRecords.forEach((row) => values.set(row.id, row));
            (next[collection] as ToDooEntity[]) = [...values.values()];
          }
          adopt(next);
        }
        if (ticket === generation) mergeCommittedStatuses(statusRecords);
      } else adopt(result.snapshot);
      if (command.action === 'set_occurrence_status') {
        const affected = new Set([
          command.payload.id,
          ...result.changed
            .filter((change) => change.kind === 'occurrence')
            .map((change) => change.id),
        ]);
        // Transports without per-entity receipts retain the existing snapshot behavior.
        const withoutReceipts = new Map(
          state.snapshot?.occurrences
            .filter(
              (row) =>
                affected.has(row.id) &&
                !result.changed.some(
                  (change) => change.kind === 'occurrence' && change.id === row.id,
                ),
            )
            .map((row) => [row.id, row]),
        );
        checkpointStatusDrafts(withoutReceipts);
      }
      if (command.action !== 'set_occurrence_status') {
        state.pendingMutation = null;
        persistRecovery();
      }
      state.preview = result.preview || null;
      state.notice = notice;
      const completed = result.changed.find(
        (row) => row.kind === 'occurrence' && row.id === completion?.occurrenceId,
      );
      if (completion && completed && state.snapshot?.datasetId === completion.datasetId) {
        const changedOccurrences = new Set(
          result.changed.filter((row) => row.kind === 'occurrence').map((row) => row.id),
        );
        const undoable =
          completion.simple &&
          changedOccurrences.size === 1 &&
          !state.conflict &&
          statusRecords.get(completion.occurrenceId)?.revision === completed.revision;
        state.completionFeedback = {
          title: completion.title,
          taskId: completion.taskId,
          occurrenceId: completion.occurrenceId,
          undoable,
        };
        if (undoable)
          completionUndo = {
            datasetId: completion.datasetId,
            occurrenceId: completion.occurrenceId,
            expectedRevision: completed.revision,
            previousStatus: completion.previousStatus,
            title: completion.title,
          };
        state.notice = `已完成「${completion.title}」`;
      }
      try {
        await hydrateTaskAncestors(generation);
      } catch (cause) {
        state.localWarning =
          '操作已保存，但分组信息暂时无法读取：' +
          (cause instanceof Error ? cause.message : String(cause));
      }
      return result;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        state.pendingMutation = null;
        persistRecovery();
      }
      if (/版本|冲突/.test(state.error) || (e as { status?: number }).status === 409)
        affectedDraftKeys.forEach(markDraftConflict);
    } finally {
      state.busy = false;
    }
  }
  async function undoCompletion() {
    const undo = completionUndo;
    if (
      !undo ||
      !state.completionFeedback?.undoable ||
      state.snapshot?.datasetId !== undo.datasetId ||
      state.busy ||
      state.pendingMutation
    )
      return;
    return execute(
      {
        action: 'set_occurrence_status',
        payload: {
          id: undo.occurrenceId,
          expectedRevision: undo.expectedRevision,
          status: undo.previousStatus,
          cascade: false,
        },
      },
      `已撤销「${undo.title}」的完成`,
    );
  }
  async function createTask(payload: Extract<ToDooCommand, { action: 'create_task' }>['payload']) {
    const submittedDrafts = new Map(
      Object.entries(state.newTaskDrafts).map(([key, draft]) => [key, fingerprint(draft)]),
    );
    const result = await execute({ action: 'create_task', payload }, '任务已创建');
    const taskId = result?.ids.find((id) => state.snapshot?.tasks.some((t) => t.id === id));
    if (taskId) selectTask(taskId);
    if (result) {
      for (const [key, d] of Object.entries(state.newTaskDrafts)) {
        if (
          submittedDrafts.get(key) === fingerprint(d) &&
          d.title.trim() === payload.title &&
          d.description === (payload.description || '') &&
          d.criteria === (payload.criteria || '') &&
          d.listId === (payload.listId || null) &&
          d.parentTaskId === (payload.parentTaskId || null) &&
          (d.sectionId ?? null) === (payload.sectionId ?? null) &&
          d.dueDate === (payload.due?.date || '') &&
          d.planDate === (payload.plan?.date || '') &&
          fingerprint(d.tagIds) === fingerprint(payload.tagIds || []) &&
          d.priority === (payload.priority || 'none') &&
          d.initialStatus === (payload.initialStatus || 'todo') &&
          fingerprint(d.reminders) === fingerprint(payload.reminders || []) &&
          d.frequency === (payload.recurrence?.frequency || null) &&
          (d.estimate === '' ? null : d.estimate) === (payload.estimateMinutes ?? null) &&
          (!d.dueDate || (d.dueTime || null) === (payload.due?.time || null)) &&
          (!d.planDate || (d.planTime || null) === (payload.plan?.time || null)) &&
          (!d.frequency ||
            (d.recurrenceId === payload.recurrence?.id &&
              fingerprint(d.weekdays) === fingerprint(payload.recurrence?.weekdays || [])))
        ) {
          delete state.newTaskDrafts[key];
          newSaved.delete(key);
        }
      }
      persistRecovery();
    }
    return result;
  }
  async function saveTask(scope: 'all' | 'future' = 'all') {
    let value = draft();
    if (!value) return;
    const draftKey = key(),
      datasetId = state.snapshot?.datasetId;
    if (state.recoveredDraftKeys.includes(draftKey)) {
      if (!(await rebaseDraft(draftKey))) return;
      value = state.drafts[draftKey];
      if (!value || state.snapshot?.datasetId !== datasetId) return;
    }
    if (state.unavailableDrafts[draftKey] || state.draftConflicts.some((entry) => entry.draftKey === draftKey) ||
      state.conflictDraftKeys.includes(draftKey)) {
      state.error = state.unavailableDrafts[draftKey] || '请先比较最新版本并选择冲突字段，再保存任务';
      syncSelectedConflict();
      return;
    }
    if (pendingStatusReceipts.size && state.snapshot) {
      const records = await readCommittedStatuses(state.snapshot, generation);
      mergeCommittedStatuses(records);
      if (pendingStatusReceipts.has(value.occurrence?.id || '') || state.conflict) return;
      if (state.snapshot?.datasetId !== datasetId || state.drafts[draftKey] !== value) return;
    }
    const pendingPlans = [...pendingPlanCheckpoints.values()].filter(
      (entry) => entry.draftKey === draftKey,
    );
    if (pendingPlans.length) {
      const baseline = JSON.parse(saved.get(draftKey) || fingerprint(value)) as ToDooTaskDraft;
      for (const entry of pendingPlans) if (!(await resumePlanCheckpoint(entry, baseline))) return;
    }
    if (value.task.recurrence) {
      value.task.recurrence.time ||= null;
      value.task.recurrence.until ||= null;
      value.task.recurrence.count ||= null;
    }
    const submitted = clone(value),
      baseline = JSON.parse(saved.get(draftKey) || fingerprint(value)) as ToDooTaskDraft;
    const structuralMove = submitted.task.listId !== baseline.task.listId ||
      submitted.task.parentTaskId !== baseline.task.parentTaskId;
    if (structuralMove) {
      const blockers = await prepareTaskAction([submitted.task.id], true);
      if (!blockers || state.snapshot?.datasetId !== datasetId) return;
      if (blockers.some((entry) => entry.key !== draftKey || entry.kind === 'new')) {
        state.error = '移动范围内还有其他未保存的任务，请先处理这些草稿';
        return;
      }
    }
    const {
      id,
      revision,
      createdAt,
      updatedAt,
      deletedAt,
      recurrence,
      recurrenceHistory,
      ...patch
    } = submitted.task;
    if (structuralMove) {
      delete (patch as Partial<ToDooTask>).listId;
      delete (patch as Partial<ToDooTask>).parentTaskId;
      delete (patch as Partial<ToDooTask>).sectionId;
    }
    const result = await execute(
      { action: 'update_task', payload: { id, expectedRevision: revision, patch } },
      '',
    );
    if (!result) return;
    const ownRevisions = new Map(result.changed.map((c) => [c.id, c.revision]));
    let fresh = state.snapshot?.tasks.find((t) => t.id === id);
    checkpointSavedEntity(
      draftKey,
      {
        ...submitted.task,
        ...(structuralMove ? { listId: baseline.task.listId, parentTaskId: baseline.task.parentTaskId,
          sectionId: baseline.task.sectionId } : {}),
        recurrence: baseline.task.recurrence,
        recurrenceHistory: baseline.task.recurrenceHistory,
      },
      fresh,
      'task',
      baseline,
    );
    if (structuralMove) {
      const moved = await moveTasks([id], submitted.task.listId, {
        excludeDraftKey: draftKey, parentTaskId: submitted.task.parentTaskId });
      if (!moved) {
        state.error = '任务内容已保存，移动尚未完成：' + (state.error || '请重试移动');
        return;
      }
      moved.changed.forEach((entry) => ownRevisions.set(entry.id, entry.revision));
      fresh = state.snapshot?.tasks.find((task) => task.id === id);
      checkpointSavedEntity(draftKey, { ...submitted.task, recurrence: baseline.task.recurrence,
        recurrenceHistory: baseline.task.recurrenceHistory }, fresh, 'task', baseline);
    }
    if (
      submitted.occurrence &&
      fingerprint(baseline?.occurrence) !== fingerprint(submitted.occurrence)
    ) {
      const changed = await saveEntity(
        'occurrence',
        submitted.occurrence,
        ownRevisions.get(submitted.occurrence.id) || submitted.occurrence.revision,
        '',
      );
      if (!changed) return;
      checkpointSavedEntity(
        draftKey,
        submitted.occurrence,
        state.snapshot?.occurrences.find((o) => o.id === submitted.occurrence!.id),
        'occurrence',
        baseline,
      );
    }
    for (const block of submitted.blocks) {
      if (fingerprint(baseline?.blocks.find((b) => b.id === block.id)) === fingerprint(block))
        continue;
      const changed = await saveEntity('timeBlock', block, block.revision || undefined, '');
      if (!changed) return;
      if (!(await checkpointCommittedPlan(draftKey, block, baseline, changed))) return;
    }
    // Commit instance edits first so recurrence changes preserve those explicitly edited cycles.
    if (fingerprint(baseline.task.recurrence) !== fingerprint(recurrence)) {
      const changed = await execute(
        {
          action: 'change_recurrence',
          payload: {
            taskId: id,
            expectedRevision: fresh!.revision,
            rule: recurrence,
            scope,
            ...(scope === 'future'
              ? {
                  from:
                    submitted.occurrence?.scheduledDate ||
                    recurrence?.anchorDate ||
                    toDooLocalDate(),
                }
              : {}),
          },
        },
        '',
      );
      if (!changed) return;
      checkpointSavedEntity(
        draftKey,
        submitted.task,
        state.snapshot?.tasks.find((t) => t.id === id),
        'task',
        baseline,
      );
    }
    // Only committed input becomes the baseline; text typed during the save remains a draft.
    const current = state.drafts[draftKey];
    if (current && saved.get(draftKey) === fingerprint(current)) {
      delete state.drafts[draftKey];
      if (key() === draftKey) selectTask(id, submitted.occurrence?.id);
    }
    if (key() !== draftKey && !dirty())
      selectTask(state.selectedTaskId, state.selectedOccurrenceId);
    state.rebasedFields = [];
    state.notice = '任务已保存';
    persistRecovery();
    return result;
  }
  async function readStatusGraph(taskIds: string[]) {
    const tasks = new Map<string, ToDooTask>(),
      occurrences = new Map<string, ToDooOccurrence>();
    for (let offset = 0; offset < taskIds.length; offset += 50) {
      for (const kind of ['task', 'occurrence'] as const) {
        let cursor: string | undefined;
        const visited = new Set<string>();
        do {
          const params = new URLSearchParams({
            kind,
            taskIds: taskIds.slice(offset, offset + 50).join(','),
            includeTree: 'true',
            limit: '500',
            filter: JSON.stringify({ includeArchived: true }),
          });
          if (cursor) params.set('cursor', cursor);
          const data = (await request('/api/to-doo/state?' + params.toString())) as ToDooSnapshot;
          data.tasks.forEach((task) => tasks.set(task.id, task));
          data.occurrences.forEach((occurrence) => occurrences.set(occurrence.id, occurrence));
          const outerPages = state.snapshot?.collectionPages;
          adoptDetail(data);
          if (state.snapshot) state.snapshot.collectionPages = outerPages;
          cursor = data.collectionPages?.[kind]?.nextCursor || data.page.nextCursor || undefined;
          if (
            (cursor && (visited.has(cursor) || visited.size >= 20)) ||
            tasks.size > 10000 ||
            occurrences.size > 10000
          )
            throw Error('当前子树或执行历史较大，请分批选择后再执行');
          if (cursor) visited.add(cursor);
        } while (cursor);
      }
    }
    return { tasks: [...tasks.values()], occurrences: [...occurrences.values()] };
  }
  async function statusChildCount(taskId: string) {
    try {
      const graph = await readStatusGraph([taskId]);
      return graph.tasks.filter((task) => !task.deletedAt && task.parentTaskId === taskId).length;
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause);
      return null;
    }
  }
  async function setStatus(id: string, status: ToDooOccurrence['status'], cascade = false) {
    const pending = state.pendingMutation;
    if (
      pending?.action === 'set_occurrence_status' &&
      pending.payload.id === id &&
      pending.payload.status === status &&
      !!pending.payload.cascade === cascade
    ) {
      const { requestId, ...input } = pending;
      return execute(input, status === 'done' ? '任务已完成' : '状态已更新');
    }
    const o = state.snapshot?.occurrences.find((o) => o.id === id);
    if (!o) {
      state.error = '执行记录尚未载入，请刷新后重试';
      return;
    }
    let closure: ReturnType<typeof resolveToDooStatusSelection> | undefined;
    if (cascade) {
      try {
        closure = resolveToDooStatusSelection(await readStatusGraph([o.taskId]), {
          occurrenceId: id,
          cascade: true,
          status,
        });
      } catch (cause) {
        state.error = cause instanceof Error ? cause.message : String(cause);
        return;
      }
    }
    return execute(
      {
        action: 'set_occurrence_status',
        payload: {
          id,
          expectedRevision: o.revision,
          status,
          cascade,
          ...(closure
            ? {
                expectedOccurrenceIds: closure.occurrenceIds,
                expectedRevisions: closure.expectedRevisions,
              }
            : {}),
        },
      },
      status === 'done' ? '任务已完成' : '状态已更新',
    );
  }
  async function saveEntity<K extends ToDooEntityKind>(
    kind: K,
    entity: Record<string, unknown> | ToDooEntityMap[K],
    expectedRevision?: string,
    notice = '已保存',
  ) {
    return execute(
      {
        action: 'save_entity',
        payload: {
          kind,
          entity: clone(entity) as Record<string, unknown>,
          ...(expectedRevision ? { expectedRevision } : {}),
        },
      },
      notice,
    );
  }
  async function removeEntity(
    kind: ToDooEntityKind,
    entity: ToDooEntity,
    restore = false,
    cascade = false,
  ) {
    return execute(
      {
        action: 'delete_entity',
        payload: { kind, id: entity.id, expectedRevision: entity.revision, restore, cascade },
      },
      restore ? '已恢复' : '已移入回收站',
    );
  }
  async function batch(
    operation: Extract<ToDooCommand, { action: 'batch_tasks' }>['payload']['operation'],
    extra: Partial<Extract<ToDooCommand, { action: 'batch_tasks' }>['payload']> = {},
    taskIds?: readonly string[],
  ) {
    const ids = [...(taskIds ?? state.selectedIds)];
    if (!ids.length || ids.length > 1000) {
      state.error = '每批请选择 1 至 1000 项任务';
      return;
    }
    if (operation === 'complete' || operation === 'cancel') {
      const pending = state.pendingMutation;
      if (
        pending?.action === 'batch_tasks' &&
        pending.payload.operation === operation &&
        fingerprint([...pending.payload.ids].sort()) === fingerprint([...ids].sort()) &&
        Object.entries(extra).every(
          ([key, value]) =>
            fingerprint((pending.payload as Record<string, unknown>)[key]) === fingerprint(value),
        )
      ) {
        const { requestId, ...input } = pending;
        return execute(input, '批量操作已保存');
      }
      try {
        const closure = resolveToDooStatusSelection(await readStatusGraph(ids), {
          taskIds: ids,
          includeDescendants: extra.includeDescendants ?? true,
          scope: extra.scope ?? 'current',
          from: extra.from,
          to: extra.to,
          status: operation === 'complete' ? 'done' : 'cancelled',
        });
        return execute(
          {
            action: 'batch_tasks',
            payload: {
              ids,
              operation,
              includeDescendants: true,
              ...extra,
              occurrenceIds: closure.occurrenceIds,
              expectedRevisions: closure.expectedRevisions,
            },
          },
          '批量操作已保存',
        );
      } catch (cause) {
        state.error = cause instanceof Error ? cause.message : String(cause);
        return;
      }
    }
    for (const id of ids) {
      let cursor: string | undefined;
      const visited = new Set<string>();
      let pages = 0;
      do {
        try {
          const data = (await request(
            '/api/to-doo/state?taskIds=' +
              encodeURIComponent(id) +
              '&includeTree=true&kinds=task&limit=500&filter=' +
              encodeURIComponent(
                JSON.stringify({
                  includeDeleted: operation === 'restore' || !!state.filter.includeDeleted,
                  includeArchived: !!state.filter.includeArchived,
                }),
              ) +
              (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          )) as ToDooSnapshot;
          adoptDetail(data);
          cursor = data.page.nextCursor || undefined;
          if (cursor && (visited.has(cursor) || ++pages >= 20)) {
            state.error = '当前子树较大，请分批选择后再执行';
            return;
          }
          if (cursor) visited.add(cursor);
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
          return;
        }
      } while (cursor);
    }
    const affected = new Set(ids);
    if (extra.includeDescendants !== false) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const task of state.snapshot?.tasks || []) {
          if (task.parentTaskId && affected.has(task.parentTaskId) && !affected.has(task.id)) {
            affected.add(task.id);
            grew = true;
          }
        }
      }
    }
    const expectedRevisions = Object.fromEntries(
      [...affected].map((id) => [
        id,
        state.snapshot?.tasks.find((t) => t.id === id)?.revision || '',
      ]),
    );
    return execute(
      {
        action: 'batch_tasks',
        payload: { ids, expectedRevisions, operation, includeDescendants: true, ...extra },
      },
      '批量操作已保存',
    );
  }
  const nextPage = () =>
    state.snapshot?.page.nextCursor
      ? load({ ...state.query, cursor: state.snapshot.page.nextCursor }, true)
      : Promise.resolve();
  async function retryPending() {
    const pending = state.pendingMutation;
    if (!pending) return;
    const { requestId, ...input } = pending;
    if (input.action === 'create_task') return createTask(input.payload);
    const result = await execute(input);
    if (!result) return;
    for (const [draftKey, current] of Object.entries(state.drafts)) {
      const baseline = JSON.parse(saved.get(draftKey) || fingerprint(current)) as ToDooTaskDraft;
      if (input.action === 'update_task' && current.task.id === input.payload.id) {
        checkpointSavedEntity(
          draftKey,
          { ...baseline.task, ...input.payload.patch },
          state.snapshot?.tasks.find((t) => t.id === input.payload.id),
          'task',
          baseline,
        );
      } else if (input.action === 'change_recurrence' && current.task.id === input.payload.taskId) {
        checkpointSavedEntity(
          draftKey,
          { ...baseline.task, recurrence: input.payload.rule },
          state.snapshot?.tasks.find((t) => t.id === input.payload.taskId),
          'task',
          baseline,
        );
      } else if (input.action === 'batch_tasks' && input.payload.operation === 'move' &&
        Object.hasOwn(input.payload.expectedRevisions, current.task.id)) {
        const remote = state.snapshot?.tasks.find((entry) => entry.id === current.task.id);
        const receipt = result.changed.find((entry) => entry.kind === 'task' && entry.id === current.task.id);
        if (remote && receipt && remote.revision !== receipt.revision) {
          markDraftConflict(draftKey);
          state.error = '移动已保存，但任务又有更新，请比较最新版本；当前输入仍保留';
          continue;
        }
        if (remote) checkpointSavedEntity(draftKey, { ...baseline.task,
          listId: input.payload.listId ?? null, sectionId: null,
          parentTaskId: remote.parentTaskId }, remote, 'task', baseline);
      } else if (input.action === 'save_entity') {
        const { kind, entity } = input.payload;
        if (kind !== 'task' && kind !== 'occurrence' && kind !== 'timeBlock') continue;
        const base =
          kind === 'timeBlock'
            ? baseline.blocks.find((b) => b.id === entity.id) ||
              current.blocks.find((b) => b.id === entity.id)
            : baseline[kind];
        if (!base || base.id !== entity.id) continue;
        if (kind === 'timeBlock') {
          await checkpointCommittedPlan(
            draftKey,
            { ...base, ...entity } as ToDooEntityMap['timeBlock'],
            baseline,
            result,
          );
          continue;
        }
        checkpointSavedEntity(
          draftKey,
          { ...base, ...entity } as ToDooEntity,
          state.snapshot?.[TO_DOO_COLLECTIONS[kind]].find((e) => e.id === entity.id),
          kind,
          baseline,
        );
      }
    }
    persistRecovery();
    return result;
  }
  function conflictEntity(value: ToDooTaskDraft, kind: ToDooDraftConflict['kind'], id: string) {
    return kind === 'timeBlock' ? value.blocks.find((block) => block.id === id) || null
      : value[kind]?.id === id ? value[kind] : null;
  }
  function conflictValue(value: ToDooTaskDraft, kind: ToDooDraftConflict['kind'], id: string, field: string): unknown {
    const entity = conflictEntity(value, kind, id);
    return field === '$entity' ? entity : entity && (entity as unknown as Record<string, unknown>)[field];
  }
  function retainedTaskDrafts() {
    return Object.entries(state.drafts).filter(([draftKey, value]) => saved.get(draftKey) !== fingerprint(value))
      .map(([draftKey, value]) => ({ key: draftKey, taskId: value.task.id,
        occurrenceId: value.occurrence?.id || '', title: value.task.title,
        kind: 'task' as const, recovered: state.recoveredDraftKeys.includes(draftKey),
        unavailable: state.unavailableDrafts[draftKey] || '', draft: value }));
  }
  function actionDrafts(taskIds: readonly string[], actionOptions: {
    includeDescendants?: boolean; excludeDraftKey?: string;
  } = {}): ToDooActionDraft[] {
    const affected = new Set(taskIds);
    if (actionOptions.includeDescendants !== false) {
      const definitions = [...taskDefinitions(), ...Object.values(state.drafts).map((value) => value.task)];
      let grew = true;
      while (grew) {
        grew = false;
        for (const task of definitions)
          if (task.parentTaskId && affected.has(task.parentTaskId) && !affected.has(task.id)) {
            affected.add(task.id); grew = true;
          }
      }
    }
    return [
      ...retainedTaskDrafts().filter((entry) => affected.has(entry.taskId) &&
        entry.key !== actionOptions.excludeDraftKey).map(({ key, taskId, occurrenceId, title, kind }) =>
        ({ key, taskId, occurrenceId, title, kind })),
      ...retainedNewTaskDrafts().filter((entry) => entry.parentTaskId && affected.has(entry.parentTaskId))
        .map((entry) => ({ key: entry.key, taskId: entry.parentTaskId!, occurrenceId: '',
          title: entry.draft.title || '未命名子任务', kind: 'new' as const })),
    ];
  }
  async function readActionTasks(taskIds: readonly string[], includeDescendants = true) {
    const datasetId = state.snapshot?.datasetId, ticket = generation;
    if (!datasetId) throw Error('请先载入任务工作区');
    for (let offset = 0; offset < taskIds.length; offset += 50) {
      let cursor: string | undefined;
      const visited = new Set<string>();
      do {
        const query = new URLSearchParams({ kind: 'task', taskIds: taskIds.slice(offset, offset + 50).join(','),
          includeTree: String(includeDescendants), limit: '500',
          filter: JSON.stringify({ includeArchived: true, includeDeleted: true }) });
        if (cursor) query.set('cursor', cursor);
        const data = await request('/api/to-doo/state?' + query) as ToDooSnapshot;
        if (ticket !== generation || state.snapshot?.datasetId !== datasetId || data.datasetId !== datasetId)
          throw Error('资料库或任务范围已变化，请重新执行操作');
        adoptDetail(data);
        cursor = data.collectionPages?.task?.nextCursor || data.page.nextCursor || undefined;
        if (cursor && (visited.has(cursor) || visited.size >= 20)) throw Error('当前子树较大，请分批处理');
        if (cursor) visited.add(cursor);
      } while (cursor);
    }
  }
  async function prepareTaskAction(taskIds: readonly string[], includeDescendants = true): Promise<ToDooActionDraft[] | null> {
    if (state.busy || state.pendingMutation) {
      state.error = state.pendingMutation ? '请先核对结果待确认的原操作' : '正在保存，请稍后再试';
      return null;
    }
    try {
      await readActionTasks(taskIds, includeDescendants);
      return actionDrafts(taskIds, { includeDescendants });
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause); return null;
    }
  }
  async function moveTasks(taskIds: readonly string[], listId: string | null, moveOptions: {
    excludeDraftKey?: string; parentTaskId?: string | null;
  } = {}) {
    const blockers = await prepareTaskAction(taskIds, true);
    if (!blockers) return;
    if (blockers.some((entry) => entry.key !== moveOptions.excludeDraftKey || entry.kind === 'new')) {
      state.error = '移动范围内还有未保存的任务，请先处理这些草稿'; return;
    }
    return batch('move', { listId, ...(moveOptions.parentTaskId !== undefined
      ? { parentTaskId: moveOptions.parentTaskId } : {}) }, taskIds);
  }
  function discardTaskDraft(draftKey: string) {
    for (const [id, entry] of pendingPlanCheckpoints)
      if (entry.draftKey === draftKey) pendingPlanCheckpoints.delete(id);
    delete state.drafts[draftKey]; saved.delete(draftKey);
    delete state.unavailableDrafts[draftKey];
    state.recoveredDraftKeys = state.recoveredDraftKeys.filter((entry) => entry !== draftKey);
    state.draftConflicts = state.draftConflicts.filter((entry) => entry.draftKey !== draftKey);
    state.conflictDraftKeys = state.conflictDraftKeys.filter((entry) => entry !== draftKey);
    syncSelectedConflict();
    if (key() === draftKey) selectTask(state.selectedTaskId, state.selectedOccurrenceId);
    persistRecovery();
  }
  function discardDraft() { discardTaskDraft(key()); }
  async function readRemoteDraft(local: ToDooTaskDraft): Promise<ToDooTaskDraft | null> {
    const datasetId = state.snapshot?.datasetId, ticket = generation;
    const result: ToDooTaskDraft = { task: local.task, occurrence: null, blocks: [] };
    let foundTask = false, version: string | undefined;
    for (const kind of ['task', 'occurrence', 'timeBlock'] as const) {
      if (kind === 'occurrence' && !local.occurrence) continue;
      let cursor: string | undefined;
      const visited = new Set<string>();
      do {
        const query = new URLSearchParams({ kind, limit: '500',
          filter: JSON.stringify({ includeDeleted: true, includeArchived: true }) });
        if (kind === 'timeBlock') query.set('taskIds', local.task.id);
        else query.set('ids', kind === 'task' ? local.task.id : local.occurrence!.id);
        if (cursor) query.set('cursor', cursor);
        const data = await request('/api/to-doo/state?' + query) as ToDooSnapshot;
        if (ticket !== generation || state.snapshot?.datasetId !== datasetId || data.datasetId !== datasetId)
          throw Error('资料库已变化，请重新载入后比较草稿');
        if (version && version !== data.version) throw Error('比较期间任务又有更新，请重新比较');
        version = data.version;
        if (kind === 'task') {
          const task = data.tasks.find((entry) => entry.id === local.task.id);
          if (task) { result.task = clone(task); foundTask = true; }
        } else if (kind === 'occurrence')
          result.occurrence = clone(data.occurrences.find((entry) => entry.id === local.occurrence!.id) || null);
        else result.blocks.push(...data.timeBlocks.filter((entry) => entry.occurrenceId === local.occurrence?.id).map(clone));
        adoptDetail(data);
        cursor = data.collectionPages?.[kind]?.nextCursor || data.page.nextCursor || undefined;
        if (cursor && (visited.has(cursor) || visited.size >= 20)) throw Error('任务历史较大，请分批核对');
        if (cursor) visited.add(cursor);
      } while (cursor);
    }
    return foundTask ? result : null;
  }
  async function rebaseDraft(draftKey = key()) {
    const local = state.drafts[draftKey];
    if (!local || state.busy) return false;
    if (state.pendingMutation) { state.error = '请先核对结果待确认的原操作'; return false; }
    const baseline = JSON.parse(saved.get(draftKey) || 'null') as ToDooTaskDraft | null;
    if (!baseline) return false;
    const datasetId = state.snapshot?.datasetId;
    state.busy = true;
    try {
      const remote = await readRemoteDraft(local);
      if (state.snapshot?.datasetId !== datasetId || !state.drafts[draftKey]) return false;
      if (!remote || remote.task.deletedAt || local.occurrence && (!remote.occurrence || remote.occurrence.deletedAt)) {
        const reason = '任务或本次执行已被移除，草稿仍保留；可复制内容或明确放弃草稿';
        state.unavailableDrafts[draftKey] = reason; state.error = reason; return false;
      }
      const merged = mergeToDooTaskDraft(draftKey, state.drafts[draftKey], baseline, remote);
      const oldConflicts = state.draftConflicts.filter((entry) => entry.draftKey === draftKey);
      for (const entry of oldConflicts) {
        if (merged.conflicts.some((conflict) => conflict.id === entry.id)) continue;
        const mine = conflictValue(merged.draft, entry.kind, entry.entityId, entry.field),
          theirs = conflictValue(remote, entry.kind, entry.entityId, entry.field);
        if (!sameToDooDraftValue(mine, theirs)) merged.conflicts.push({ ...entry, local: mine, remote: theirs });
      }
      state.drafts[draftKey] = merged.draft; saved.set(draftKey, fingerprint(remote));
      state.draftConflicts = [...state.draftConflicts.filter((entry) => entry.draftKey !== draftKey), ...merged.conflicts];
      state.rebasedFields = [...new Set(merged.conflicts.map((entry) => entry.label))];
      state.recoveredDraftKeys = state.recoveredDraftKeys.filter((entry) => entry !== draftKey);
      delete state.unavailableDrafts[draftKey];
      for (const [id, entry] of pendingPlanCheckpoints)
        if (entry.draftKey === draftKey) pendingPlanCheckpoints.delete(id);
      state.conflictDraftKeys = state.conflictDraftKeys.filter((entry) => entry !== draftKey);
      syncSelectedConflict();
      state.error = merged.conflicts.length ? '有字段同时被修改，请比较并明确选择保留内容' : '';
      state.notice = merged.conflicts.length ? '' : '已载入最新版本并保留你的修改，仍需显式保存';
      persistRecovery(); return merged.conflicts.length === 0;
    } catch (cause) {
      if (state.snapshot?.datasetId === datasetId) state.error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally { state.busy = false; }
  }
  function resolveDraftConflict(id: string, choice: 'local' | 'remote') {
    const conflict = state.draftConflicts.find((entry) => entry.id === id);
    if (!conflict || state.busy) return false;
    const value = state.drafts[conflict.draftKey];
    if (!value) return false;
    if (choice === 'remote') {
      if (conflict.field === '$entity' && conflict.kind === 'timeBlock') {
        value.blocks = value.blocks.filter((entry) => entry.id !== conflict.entityId);
        if (conflict.remote) value.blocks.push(clone(conflict.remote) as ToDooEntityMap['timeBlock']);
      } else {
        const entity = conflictEntity(value, conflict.kind, conflict.entityId) as unknown as Record<string, unknown> | null;
        if (!entity) return false;
        if (conflict.remote === undefined) delete entity[conflict.field];
        else entity[conflict.field] = clone(conflict.remote);
      }
    } else if (conflict.field === '$entity' && conflict.kind === 'timeBlock' && !conflict.local && conflict.remote) {
      value.blocks = value.blocks.filter((entry) => entry.id !== conflict.entityId);
      value.blocks.push({ ...clone(conflict.remote) as ToDooEntityMap['timeBlock'], deletedAt: new Date().toISOString() });
    }
    state.draftConflicts = state.draftConflicts.filter((entry) => entry.id !== id);
    state.rebasedFields = state.draftConflicts.filter((entry) => entry.draftKey === conflict.draftKey).map((entry) => entry.label);
    syncSelectedConflict();
    if (!state.conflict) { state.error = ''; state.notice = '比较结果已保留，仍需保存任务'; }
    persistRecovery(); return true;
  }
  function resolveAllDraftConflicts(choice: 'local' | 'remote', draftKey = key()) {
    for (const entry of [...state.draftConflicts])
      if (entry.draftKey === draftKey) resolveDraftConflict(entry.id, choice);
  }
  return {
    state,
    request,
    load,
    nextPage,
    loadPendingOperations,
    newTaskDraft,
    retainedNewTaskDrafts,
    retainedTaskDrafts,
    actionDrafts,
    prepareTaskAction,
    moveTasks,
    discardTaskDraft,
    flushRecovery: persistRecovery,
    resolveDraftConflict,
    resolveAllDraftConflicts,
    retainedNewTaskDraft: () => retainedNewTaskDrafts()[0],
    clearNewTaskDraft,
    hasNewTaskDraft: () =>
      Object.entries(state.newTaskDrafts).some(
        ([key, value]) => newSaved.get(key) !== fingerprint(value),
      ),
    retryPending,
    ensureTask,
    nextCollectionPage,
    nextTaskCollectionPage: (id: string, kind: ToDooEntityKind) => nextCollectionPage(kind, id),
    nextTaskPage: (id: string) => ensureTask(id, state.detailPages[id]?.nextCursor || undefined),
    acceptSnapshot: (data: ToDooSnapshot, detail = false) => {
      if (detail) adoptDetail(data);
      else adopt(data);
      if (state.selectedTaskId) selectTask(state.selectedTaskId, state.selectedOccurrenceId);
    },
    execute,
    createTask,
    selectTask,
    draft,
    dirty,
    hasUnsavedChanges,
    saveTask,
    setStatus,
    undoCompletion,
    statusChildCount,
    saveEntity,
    removeEntity,
    batch,
    taskDefinitions,
    taskLists,
    ensureListCatalog,
    batchTasks: (
      ids: readonly string[],
      operation: Parameters<typeof batch>[0],
      extra: Parameters<typeof batch>[1] = {},
    ) => batch(operation, extra, ids),
    discardDraft,
    rebaseDraft,
    items: () => (state.snapshot ? deriveToDooItems(state.snapshot, state.filter, state.sort) : []),
  };
}
export type ToDooWorkbench = ReturnType<typeof createToDooWorkbench>;
