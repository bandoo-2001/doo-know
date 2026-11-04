import type { ToDooCommand, ToDooEntityMap, ToDooFilter } from '../../shared/to-doo-contracts';
import type { ToDooTaskFilter } from './navigation';
import {
  parseToDooQuickEntry,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooNewTaskDraft,
} from './to-doo-workbench';

export type ToDooQuickFilter = ToDooTaskFilter;
export function toDooCalendarRange(
  anchor: string,
  view: 'month' | 'week' | 'timeline',
  weekStartsOn = 1,
) {
  if (view === 'timeline') return { from: anchor, to: shiftToDooDate(anchor, 27) };
  const first = view === 'month' ? anchor.slice(0, 7) + '-01' : anchor;
  const weekday = new Date(first + 'T12:00:00Z').getUTCDay();
  const from = shiftToDooDate(first, -((weekday - weekStartsOn + 7) % 7));
  return { from, to: shiftToDooDate(from, view === 'month' ? 41 : 6) };
}
export const toDooQuickViews = [
  { id: 'inbox', name: '收集箱', icon: 'inbox' },
  { id: 'today', name: '今天', icon: 'today' },
  { id: 'upcoming', name: '近七天', icon: 'upcoming' },
  { id: 'all', name: '所有任务', icon: 'tasks' },
] as const;

export function toDooQuickFilter(
  current: ToDooFilter,
  value: ToDooQuickFilter,
  today: string,
): ToDooFilter {
  const filter = { ...current };
  for (const key of [
    'statuses',
    'from',
    'to',
    'dueBefore',
    'overdue',
    'unscheduled',
    'includeDeleted',
    'includeArchived',
  ] as const)
    delete filter[key];
  if (value === 'today' || value === 'upcoming') {
    filter.from = today;
    filter.to = value === 'today' ? today : shiftToDooDate(today, 6);
    filter.statuses = ['todo', 'doing', 'blocked'];
  }
  if (value === 'overdue') {
    filter.overdue = true;
    filter.statuses = ['todo', 'doing', 'blocked'];
  }
  if (value === 'unscheduled') filter.unscheduled = true;
  if (value === 'done') filter.statuses = ['done'];
  if (value === 'blocked') filter.statuses = ['blocked'];
  if (value === 'trash') filter.includeDeleted = true;
  if (value === 'archived') filter.includeArchived = true;
  return filter;
}

export function prepareToDooQuickDraft(
  draft: ToDooNewTaskDraft,
  today: string,
  tags: ToDooEntityMap['tag'][],
  defaultDate = '',
): ToDooNewTaskDraft {
  const quick = parseToDooQuickEntry(draft.title, today, tags);
  const value = {
    ...draft,
    title: quick.title.trim(),
    tagIds: [...new Set([...draft.tagIds, ...quick.tagIds])],
  };
  if (quick.date && quick.due) {
    value.dueDate = quick.date;
    value.dueTime = quick.time || '';
  } else if (quick.date || quick.time) {
    value.planDate = quick.date || draft.planDate || today;
    value.planTime = quick.time || draft.planTime;
    value.planDateCleared = false;
  } else if (!draft.planDate && draft.planDateCleared !== true && defaultDate)
    value.planDate = defaultDate;
  if (quick.frequency) {
    value.frequency = quick.frequency;
    value.weekdays = quick.weekdays;
  }
  return value;
}

export function toDooDraftPayload(
  draft: ToDooNewTaskDraft,
  timeZone: string,
): Extract<ToDooCommand, { action: 'create_task' }>['payload'] {
  return {
    title: draft.title.trim(),
    initialStatus: draft.initialStatus,
    priority: draft.priority,
    reminders: draft.reminders,
    description: draft.description,
    criteria: draft.criteria,
    listId: draft.listId,
    parentTaskId: draft.parentTaskId,
    ...(draft.sectionId !== undefined ? { sectionId: draft.sectionId } : {}),
    estimateMinutes: draft.estimate === '' ? null : draft.estimate,
    tagIds: draft.tagIds,
    due: draft.dueDate ? { date: draft.dueDate, time: draft.dueTime || null, timeZone } : null,
    plan: draft.planDate ? { date: draft.planDate, time: draft.planTime || null, timeZone } : null,
    recurrence: draft.frequency
      ? {
          id: draft.recurrenceId,
          frequency: draft.frequency,
          interval: 1,
          anchorDate: draft.planDate || draft.dueDate || toDooLocalDate(new Date(), timeZone),
          time: draft.planTime || null,
          timeZone,
          weekdays: draft.weekdays,
          until: null,
          count: null,
          shortMonth: 'last_day',
          excludedDates: [],
          additionalDates: [],
          endedAt: null,
          completionUnit: 'day',
        }
      : null,
  };
}

export function toDooDateLabel(date: string, today: string): string {
  if (!date) return '';
  if (date === today) return '今天';
  if (date === shiftToDooDate(today, 1)) return '明天';
  if (date === shiftToDooDate(today, -1)) return '昨天';
  const [year, month, day] = date.split('-');
  return (
    (year === today.slice(0, 4) ? '' : year + '年') + Number(month) + '月' + Number(day) + '日'
  );
}

/** All direct schema fields and nested conditions are inspectable in every task view. */
export function toDooFilterSummary(
  filter: ToDooFilter,
  catalog?: { lists?: { id: string; name: string }[]; tags?: { id: string; name: string }[] },
): string[] {
  const names: Record<string, string> = {
    todo: '待办',
    doing: '进行中',
    blocked: '受阻',
    done: '已完成',
    cancelled: '已取消',
    skipped: '已跳过',
    none: '无',
    low: '低',
    normal: '普通',
    high: '高',
    important: '重要',
    query: '搜索',
    listId: '清单',
    tagId: '标签',
    status: '状态',
    priority: '优先级',
    importance: '重要程度',
    dueDate: '截止日期',
    plannedDate: '计划日期',
    createdDate: '创建日期',
    completedDate: '完成日期',
    hasEvidence: '成果证据',
    isLeaf: '叶子任务',
    isUnscheduled: '未安排',
    contains: '包含',
    not_contains: '不包含',
    is: '为',
    is_not: '不为',
    in: '属于',
    not_in: '不属于',
    before: '早于',
    on: '等于',
    after: '晚于',
    between: '介于',
    is_empty: '为空',
    not_empty: '不为空',
  };
  const name = (value: string) => names[value] || value;
  const parts: string[] = [];
  if (filter.query) parts.push('搜索：' + filter.query);
  if (filter.listIds?.length)
    parts.push(
      '清单：' +
        filter.listIds
          .map((id) =>
            catalog
              ? catalog.lists?.find((list) => list.id === id)?.name ||
                (id === 'inbox' ? '收集箱' : '未知清单')
              : id,
          )
          .join('、'),
    );
  if (filter.tagIds?.length)
    parts.push(
      '标签：' +
        filter.tagIds
          .map((id) =>
            catalog ? catalog.tags?.find((tag) => tag.id === id)?.name || '未知标签' : id,
          )
          .join('、'),
    );
  if (filter.statuses?.length) parts.push('状态：' + filter.statuses.map(name).join('、'));
  if (filter.priorities?.length) parts.push('优先级：' + filter.priorities.map(name).join('、'));
  if (filter.importance) parts.push('重要程度：' + name(filter.importance));
  if (filter.from || filter.to)
    parts.push('日期：' + (filter.from || '不限') + ' 至 ' + (filter.to || '不限'));
  if (filter.dueBefore) parts.push('截止不晚于：' + filter.dueBefore);
  if (filter.overdue) parts.push('按实际截止时刻逾期');
  if (filter.unscheduled) parts.push('仅未安排');
  if (filter.hasEvidence !== undefined)
    parts.push(filter.hasEvidence ? '有成果证据' : '无成果证据');
  if (filter.includeDeleted) parts.push('包含回收站');
  if (filter.includeArchived) parts.push('包含归档');
  if (filter.leafOnly) parts.push('仅叶子任务');
  if (filter.group?.conditions.length) {
    const describe = (
      condition: NonNullable<ToDooFilter['group']>['conditions'][number],
    ): string => {
      if ('conditions' in condition)
        return (
          '(' +
          condition.conditions.map(describe).join(condition.operator === 'and' ? ' 且 ' : ' 或 ') +
          ')'
        );
      const values = Array.isArray(condition.value)
        ? condition.value
        : condition.value === undefined
          ? []
          : [condition.value];
      return (
        name(condition.field) +
        ' ' +
        name(condition.operator) +
        ' ' +
        values
          .map((value) =>
            typeof value === 'boolean'
              ? value
                ? '是'
                : '否'
              : condition.field === 'listId' && catalog
                ? catalog.lists?.find((list) => list.id === value)?.name ||
                  (value === 'inbox' ? '收集箱' : '未知清单')
                : condition.field === 'tagId' && catalog
                  ? catalog.tags?.find((tag) => tag.id === value)?.name || '未知标签'
                  : name(String(value)),
          )
          .join('、')
      );
    };
    parts.push('条件组：' + describe(filter.group));
  }
  return parts;
}
