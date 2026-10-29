import { reactive, watch } from 'vue';
import type { ToDooTaskFilter } from './navigation';
import {
  TO_DOO_COLLECTIONS,
  toDooCommandSchema,
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
export type ToDooRequest = (url: string, method?: string, body?: unknown) => Promise<any>;
export type ToDooSelection = {
  task?: string;
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
export type ToDooNewTaskDraft = {
  title: string;
  description: string;
  criteria: string;
  listId: string | null;
  parentTaskId: string | null;
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
      const dates = [
        ...row.blocks.map((b) => b.start.date),
        o?.due ? toDooDisplayTime(o.due, data.settings.timeZone).date : undefined,
        o?.scheduledDate,
      ].filter((d): d is string => !!d);
      if (
        (filter.from || filter.to) &&
        !dates.some((d) => (!filter.from || d >= filter.from) && (!filter.to || d <= filter.to))
      )
        return false;
      if (filter.dueBefore && (!o?.due || o.due.date > filter.dueBefore)) return false;
      if (
        filter.hasEvidence &&
        !data.outcomes.some(
          (x) => !x.deletedAt && x.occurrenceId === o?.id && x.evidenceRefs.length,
        )
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
        (n, s) => n + Math.max(0, ((s.end ? Date.parse(s.end) : now) - Date.parse(s.start)) / 1000),
        0,
      );
}
export function nextToDooAnniversary(
  a: ToDooEntityMap['anniversary'],
  from: string,
): string | null {
  if (a.calendar === 'gregorian') {
    if (!a.repeatYearly) return a.date;
    for (let year = Number(from.slice(0, 4)); year < Number(from.slice(0, 4)) + 9; year++) {
      const desired = year + a.date.slice(4),
        rolled = new Date(desired + 'T12:00:00Z').toISOString().slice(0, 10);
      let candidate = desired;
      if (rolled !== desired) {
        if (a.leapPolicy === 'skip') continue;
        candidate = a.leapPolicy === 'previous_day' ? shiftToDooDate(rolled, -1) : rolled;
      }
      if (candidate >= from) return candidate;
    }
    return null;
  }
  const formatter = new Intl.DateTimeFormat('en-u-ca-chinese', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const month = Number(a.date.slice(5, 7)),
    day = Number(a.date.slice(8)),
    year = Number(a.date.slice(0, 4));
  const first = a.repeatYearly ? from : shiftToDooDate(year + '-01-01', -40),
    limit = a.repeatYearly ? 8000 : 440;
  for (let i = 0; i < limit; i++) {
    const candidate = shiftToDooDate(first, i),
      parts = formatter.formatToParts(new Date(candidate + 'T12:00:00Z'));
    const get = (key: string) => parts.find((p) => p.type === key)?.value || '';
    if (
      parseInt(get('month')) === month &&
      Number(get('day')) === day &&
      get('month').includes('bis') === a.lunarLeapMonth &&
      (a.repeatYearly || Number(get('relatedYear')) === year)
    )
      return candidate;
  }
  return null;
}
export function createToDooWorkbench(request: ToDooRequest) {
  const state = reactive({
    snapshot: null as ToDooSnapshot | null,
    selectedTaskId: '',
    selectedOccurrenceId: '',
    drafts: {} as Record<string, ToDooTaskDraft>,
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
    filter: {} as ToDooFilter,
    externalDirty: {} as Record<string, boolean>,
    sort: 'manual',
    query: { limit: 200 } as ToDooQuery,
    loading: false,
    busy: false,
    error: '',
    conflict: false,
    rebasedFields: [] as string[],
    notice: '',
    preview: null as ToDooCommandResult['preview'] | null,
  });
  const saved = new Map<string, string>();
  const newSaved = new Map<string, string>();
  const newDefaults = (parentTaskId: string | null, listId: string | null): ToDooNewTaskDraft => ({
    title: '',
    description: '',
    criteria: '',
    parentTaskId,
    listId,
    dueDate: '',
    dueTime: '',
    planDate: '',
    planTime: '09:00',
    estimate: 30,
    tagIds: [],
    frequency: null,
    weekdays: [],
    recurrenceId: crypto.randomUUID(),
  });
  function persistRecovery() {
    if (typeof localStorage === 'undefined' || !state.snapshot) return;
    try {
      const key = 'dooknow.to-doo.recovery:' + state.snapshot.datasetId;
      localStorage.setItem(
        key,
        JSON.stringify({ pending: state.pendingMutation, drafts: state.newTaskDrafts }),
      );
      state.localWarning = '';
    } catch {
      state.localWarning = '浏览器暂时不能保存恢复信息，请在当前页面核对提交结果后再离开。';
    }
  }
  function restoreRecovery(datasetId: string) {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = JSON.parse(
        localStorage.getItem('dooknow.to-doo.recovery:' + datasetId) || 'null',
      );
      const parsed = toDooCommandSchema.safeParse(raw?.pending);
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
    } catch {
      state.localWarning = '本地恢复信息无法读取，当前服务器内容仍可正常访问。';
    }
  }
  function newTaskDraft(parent?: string, list?: string) {
    const listId = list || state.snapshot?.tasks.find((t) => t.id === parent)?.listId || null,
      key = (parent || '') + '@' + (listId || '');
    if (!state.newTaskDrafts[key]) {
      const value = newDefaults(parent || null, listId);
      newSaved.set(key, fingerprint(value));
      state.newTaskDrafts[key] = value;
    }
    return state.newTaskDrafts[key]!;
  }
  function clearNewTaskDraft(parent?: string, list?: string) {
    const listId = list || state.snapshot?.tasks.find((t) => t.id === parent)?.listId || null,
      key = (parent || '') + '@' + (listId || '');
    delete state.newTaskDrafts[key];
    newSaved.delete(key);
    persistRecovery();
  }
  watch(() => [state.newTaskDrafts, state.pendingMutation], persistRecovery, { deep: true });
  let generation = 0;
  const key = () => state.selectedTaskId + '@' + state.selectedOccurrenceId;
  const draft = () => state.drafts[key()];
  const dirty = (id?: string) =>
    id
      ? Object.entries(state.drafts).some(
          ([k, v]) => v.task.id === id && saved.get(k) !== fingerprint(v),
        )
      : !!draft() && saved.get(key()) !== fingerprint(draft());
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
      data?.occurrences.find((o) => o.id === occurrenceId) ||
      data?.occurrences
        .filter((o) => o.taskId === id && !o.deletedAt)
        .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''))[0] ||
      null;
    state.selectedOccurrenceId = occurrence?.id || '';
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
    if (changedDataset) {
      persistRecovery();
      state.drafts = {};
      state.newTaskDrafts = {};
      saved.clear();
      newSaved.clear();
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
        await hydrateTaskDefinitions(ticket);
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
      state.error = e instanceof Error ? e.message : String(e);
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
    state.operationLoading = true;
    state.operationError = '';
    try {
      const cursor = append ? state.operationPage?.nextCursor : null;
      const data = (await request(
        '/api/to-doo/state?kind=operation&limit=50' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      )) as ToDooSnapshot;
      const values = new Map((append ? state.pendingOperations : []).map((o) => [o.id, o]));
      data.operations.forEach((o) => values.set(o.id, o));
      state.pendingOperations = [...values.values()].filter(
        (o) => !o.deletedAt && o.state !== 'completed',
      );
      state.operationPage = data.page;
    } catch (e) {
      state.operationError = e instanceof Error ? e.message : String(e);
    } finally {
      state.operationLoading = false;
    }
  }
  async function execute(input: ToDooInput, notice = '已保存') {
    if (state.busy) return;
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
    state.pendingMutation = command;
    persistRecovery();
    state.busy = true;
    state.error = '';
    state.conflict = false;
    state.notice = '';
    ++generation;
    state.loading = false;
    try {
      const result = (await request('/api/to-doo/commands', 'POST', command)) as ToDooCommandResult;
      adopt(result.snapshot);
      state.pendingMutation = null;
      persistRecovery();
      state.preview = result.preview || null;
      state.notice = notice;
      return result;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        state.pendingMutation = null;
        persistRecovery();
      }
      state.conflict = /版本|冲突/.test(state.error) || (e as { status?: number }).status === 409;
    } finally {
      state.busy = false;
    }
  }
  async function createTask(payload: Extract<ToDooCommand, { action: 'create_task' }>['payload']) {
    const result = await execute({ action: 'create_task', payload }, '任务已创建');
    const taskId = result?.ids.find((id) => state.snapshot?.tasks.some((t) => t.id === id));
    if (taskId) selectTask(taskId);
    if (result) {
      for (const [key, d] of Object.entries(state.newTaskDrafts)) {
        if (
          d.title.trim() === payload.title &&
          d.description === (payload.description || '') &&
          d.criteria === (payload.criteria || '') &&
          d.listId === (payload.listId || null) &&
          d.parentTaskId === (payload.parentTaskId || null) &&
          d.dueDate === (payload.due?.date || '') &&
          d.planDate === (payload.plan?.date || '') &&
          fingerprint(d.tagIds) === fingerprint(payload.tagIds || []) &&
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
    const value = draft();
    if (!value) return;
    const draftKey = key(),
      submitted = clone(value),
      baseline = JSON.parse(saved.get(draftKey) || 'null') as ToDooTaskDraft | null;
    if (submitted.task.recurrence) {
      submitted.task.recurrence.time ||= null;
      submitted.task.recurrence.until ||= null;
      submitted.task.recurrence.count ||= null;
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
    const before = fingerprint(value);
    const result = await execute(
      { action: 'update_task', payload: { id, expectedRevision: revision, patch } },
      '',
    );
    if (!result) return;
    const ownRevisions = new Map(result.changed.map((c) => [c.id, c.revision]));
    const fresh = state.snapshot?.tasks.find((t) => t.id === id);
    if (fresh && state.drafts[draftKey]) state.drafts[draftKey]!.task.revision = fresh.revision;
    if (fingerprint(baseline?.task.recurrence) !== fingerprint(recurrence)) {
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
      changed.changed.forEach((c) => ownRevisions.set(c.id, c.revision));
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
    }
    for (const block of submitted.blocks) {
      if (fingerprint(baseline?.blocks.find((b) => b.id === block.id)) === fingerprint(block))
        continue;
      const changed = await saveEntity('timeBlock', block, block.revision || undefined, '');
      if (!changed) return;
    }
    // Text typed during the save remains a draft. Only the submitted snapshot becomes the baseline.
    const current = state.drafts[draftKey];
    if (current && fingerprint({ ...current, task: { ...current.task, revision } }) === before) {
      delete state.drafts[draftKey];
      if (state.selectedTaskId === id) selectTask(id, submitted.occurrence?.id);
    } else if (current) {
      const remote = state.snapshot?.tasks.find((t) => t.id === id);
      saved.set(draftKey, fingerprint({ ...submitted, task: remote || submitted.task }));
    }
    state.rebasedFields = [];
    state.notice = '任务已保存';
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
  ) {
    const ids = [...state.selectedIds];
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
  function discardDraft() {
    delete state.drafts[key()];
    selectTask(state.selectedTaskId, state.selectedOccurrenceId);
  }
  async function rebaseDraft() {
    const local = draft();
    if (!local) return;
    const draftKey = key(),
      baseline = JSON.parse(saved.get(draftKey) || 'null') as ToDooTaskDraft | null;
    if (!baseline) return;
    const response = await ensureTask(local.task.id);
    if (!response) return;
    const remoteTask = state.snapshot?.tasks.find((t) => t.id === local.task.id),
      remoteOccurrence =
        state.snapshot?.occurrences.find((o) => o.id === local.occurrence?.id) || null;
    if (!remoteTask) {
      state.error = '任务已不可用，当前输入仍保留在表单中';
      return;
    }
    const remote = clone({
      task: remoteTask,
      occurrence: remoteOccurrence,
      blocks: state.snapshot!.timeBlocks.filter(
        (b) => !b.deletedAt && b.occurrenceId === remoteOccurrence?.id,
      ),
    });
    const names: Record<string, string> = {
      title: '标题',
      description: '任务说明',
      criteria: '完成标准',
      priority: '优先级',
      importance: '重要程度',
      noteRefs: '关联资料',
      attachments: '附件',
      source: '资料引用',
      tagIds: '标签',
      listId: '所属清单',
      parentTaskId: '父任务',
      recurrence: '重复规则',
      due: '截止时间',
      status: '执行状态',
      blockedReason: '受阻原因',
    };
    const fields = new Set<string>();
    function merge<T extends object>(mine: T, base: T, theirs: T): T {
      return Object.fromEntries(
        Object.entries(theirs).map(([key, value]) => {
          const k = key as keyof T;
          const changed = fingerprint(mine[k]) !== fingerprint(base[k]);
          if (
            changed &&
            fingerprint(value) !== fingerprint(base[k]) &&
            fingerprint(mine[k]) !== fingerprint(value)
          )
            fields.add(names[key] || '其他字段');
          return [
            key,
            ['id', 'revision', 'createdAt', 'updatedAt', 'deletedAt'].includes(key) || !changed
              ? clone(value)
              : clone(mine[k]),
          ];
        }),
      ) as T;
    }
    state.drafts[draftKey] = {
      task: merge(local.task, baseline.task, remote.task),
      occurrence:
        local.occurrence && baseline.occurrence && remote.occurrence
          ? merge(local.occurrence, baseline.occurrence, remote.occurrence)
          : remote.occurrence,
      blocks: remote.blocks,
    };
    saved.set(draftKey, fingerprint(remote));
    state.rebasedFields = [...fields];
    state.conflict = false;
    state.error = '';
    state.notice = fields.size
      ? '已载入最新版本，并保留你编辑的字段。核对下方表单后，再次保存将使用当前输入。'
      : '已载入最新版本，其他人的未编辑字段已带入；你的输入仍待显式保存。';
  }
  return {
    state,
    request,
    load,
    nextPage,
    loadPendingOperations,
    newTaskDraft,
    clearNewTaskDraft,
    hasNewTaskDraft: () =>
      Object.entries(state.newTaskDrafts).some(
        ([key, value]) => newSaved.get(key) !== fingerprint(value),
      ),
    retryPending: () => {
      const pending = state.pendingMutation;
      if (!pending) return Promise.resolve(undefined);
      const { requestId, ...input } = pending;
      return input.action === 'create_task'
        ? createTask(input.payload)
        : execute(input as ToDooInput);
    },
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
    saveEntity,
    removeEntity,
    batch,
    discardDraft,
    rebaseDraft,
    items: () => (state.snapshot ? deriveToDooItems(state.snapshot, state.filter, state.sort) : []),
  };
}
export type ToDooWorkbench = ReturnType<typeof createToDooWorkbench>;
