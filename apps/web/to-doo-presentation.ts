import type { ToDooCommand, ToDooEntityMap, ToDooFilter } from '../../shared/to-doo-contracts';
import type { ToDooTaskFilter } from './navigation';
import {
  parseToDooQuickEntry,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooNewTaskDraft,
} from './to-doo-workbench';

export type ToDooQuickFilter = ToDooTaskFilter;
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
    filter.dueBefore = shiftToDooDate(today, -1);
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
  } else if (!draft.planDate && draft.planDateCleared !== true && defaultDate) value.planDate = defaultDate;
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
    description: draft.description,
    criteria: draft.criteria,
    listId: draft.listId,
    parentTaskId: draft.parentTaskId,
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
