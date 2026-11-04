import { describe, expect, test } from 'vitest';
import { createToDooWorkbench } from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import {
  toDooQuickFilter,
  prepareToDooQuickDraft,
  toDooDraftPayload,
  toDooDateLabel,
} from '../apps/web/to-doo-presentation';

test.each([
  ['month', 1, { from: '2026-09-28', to: '2026-11-08' }],
  ['week', 1, { from: '2026-10-26', to: '2026-11-01' }],
  ['week', 0, { from: '2026-10-25', to: '2026-10-31' }],
  ['timeline', 1, { from: '2026-10-30', to: '2026-11-26' }],
] as const)(
  'calendar data covers the entire %s display with week start %s',
  (view, weekStartsOn, expected) => {
    expect((presentation as any).toDooCalendarRange('2026-10-30', view, weekStartsOn)).toEqual(
      expected,
    );
  },
);

describe('daily task navigation', () => {
  test('leaving trash for today resets incompatible filters while retaining search and tags', () => {
    expect(
      toDooQuickFilter(
        {
          includeDeleted: true,
          includeArchived: true,
          dueBefore: '2026-10-01',
          unscheduled: true,
          query: '方案',
          tagIds: ['work'],
        },
        'today',
        '2026-10-29',
      ),
    ).toEqual({
      query: '方案',
      tagIds: ['work'],
      from: '2026-10-29',
      to: '2026-10-29',
      statuses: ['todo', 'doing', 'blocked'],
    });
  });
  test('all clears builtin date and status constraints without mutating the source', () => {
    const source = {
      from: '2026-10-29',
      to: '2026-11-04',
      statuses: ['done' as const],
      listIds: ['work'],
    };
    expect(toDooQuickFilter(source, 'all', '2026-10-29')).toEqual({ listIds: ['work'] });
    expect(source.from).toBe('2026-10-29');
    expect(toDooQuickFilter({}, 'upcoming', '2026-10-29').to).toBe('2026-11-04');
  });
});

describe('inline task capture', () => {
  const draft = () => ({
    ...createToDooWorkbench(async () => undefined).newTaskDraft(undefined, 'work'),
  });
  test('today capture inherits the selected list and plans a task without adding a deadline', () => {
    const value = draft();
    value.title = '写方案';
    const prepared = prepareToDooQuickDraft(value, '2026-10-29', [], '2026-10-29');
    const payload = toDooDraftPayload(prepared, 'Asia/Shanghai');
    expect(payload).toMatchObject({
      title: '写方案',
      listId: 'work',
      due: null,
      plan: { date: '2026-10-29', timeZone: 'Asia/Shanghai' },
    });
    expect(value.planDate).toBe('');
  });
  test('an explicit tomorrow overrides today and preserves recurrence identity and existing detail fields', () => {
    const value = draft();
    Object.assign(value, {
      title: '明天 每天 写方案',
      description: '保留说明',
      criteria: '保留完成标准',
    });
    const prepared = prepareToDooQuickDraft(value, '2026-10-29', [], '2026-10-29');
    const payload = toDooDraftPayload(prepared, 'Asia/Shanghai');
    expect(payload).toMatchObject({
      title: '写方案',
      description: '保留说明',
      criteria: '保留完成标准',
      plan: { date: '2026-10-30' },
      recurrence: { id: value.recurrenceId, frequency: 'daily', timeZone: 'Asia/Shanghai' },
    });
  });
  test('a plain inbox capture stays unscheduled and an explicit deadline stays separate from the plan', () => {
    const value = draft();
    value.title = '周五前交稿';
    value.dueDate = '2026-10-30';
    expect(
      toDooDraftPayload(prepareToDooQuickDraft(value, '2026-10-29', []), 'Asia/Shanghai'),
    ).toMatchObject({ plan: null, due: { date: '2026-10-30' } });
  });
  test('an explicitly cleared plan remains unscheduled even inside Today after restoring its draft', () => {
    const value = draft();
    Object.assign(value, { title: '稍后安排', planDate: '', planDateCleared: true });
    const restored = JSON.parse(JSON.stringify(value));
    expect(
      toDooDraftPayload(prepareToDooQuickDraft(restored, '2026-10-29', [], '2026-10-29'), 'UTC')
        .plan,
    ).toBeNull();
  });
});

test('date labels are short and use the supplied user-local day', () => {
  expect(toDooDateLabel('', '2026-10-29')).toBe('');
  expect(toDooDateLabel('2026-10-29', '2026-10-29')).toBe('今天');
  expect(toDooDateLabel('2026-10-30', '2026-10-29')).toBe('明天');
  expect(toDooDateLabel('2027-01-01', '2026-10-29')).toBe('2027年1月1日');
});

test('new task seed is applied only to a fresh parent/list draft and payloads retain creation fields', () => {
  const model = createToDooWorkbench(async () => undefined);
  const seed = {
    initialStatus: 'doing',
    priority: 'high',
    planDate: '2026-10-30',
    tagIds: ['work'],
  } as const;
  const draft = model.newTaskDraft(undefined, 'work', seed as any);
  expect(draft).toMatchObject(seed);
  expect(draft.planTime).toBe('');
  expect(draft.estimate).toBe('');
  Object.assign(draft, {
    title: '我的草稿',
    priority: 'low',
    planDate: '',
    planDateCleared: true,
    reminders: [{ id: 'reminder', anchor: 'due', offsetMinutes: -15, allDayTime: '08:00' }],
    frequency: 'daily',
  });
  expect(
    model.newTaskDraft(undefined, 'work', { priority: 'high', planDate: '2026-10-31' } as any),
  ).toBe(draft);
  expect(draft).toMatchObject({
    title: '我的草稿',
    priority: 'low',
    planDate: '',
    planDateCleared: true,
  });
  expect(toDooDraftPayload(draft, 'UTC')).toMatchObject({
    priority: 'low',
    initialStatus: 'doing',
    reminders: [{ id: 'reminder', anchor: 'due', offsetMinutes: -15 }],
    recurrence: { frequency: 'daily' },
    plan: null,
  });
});

test('a pristine composer placeholder accepts the explicit context when opened from a board column', () => {
  const model = createToDooWorkbench(async () => undefined);
  const placeholder = model.newTaskDraft();
  const seeded = model.newTaskDraft(undefined, undefined, {
    initialStatus: 'doing',
    priority: 'high',
    planDate: '2026-10-30',
  } as any);
  expect(seeded).toBe(placeholder);
  expect(seeded).toMatchObject({
    initialStatus: 'doing',
    priority: 'high',
    planDate: '2026-10-30',
  });
  expect(model.hasNewTaskDraft()).toBe(false);
});

test('every supported effective direct filter is visible in a readable summary', () => {
  const summary = (presentation as any).toDooFilterSummary({
    query: '报告',
    listIds: ['work'],
    tagIds: ['tag'],
    statuses: ['blocked'],
    priorities: ['high'],
    importance: 'important',
    from: '2026-11-01',
    to: '2026-11-03',
    dueBefore: '2026-10-30',
    unscheduled: true,
    hasEvidence: false,
    includeDeleted: true,
    includeArchived: true,
    leafOnly: true,
    group: { operator: 'and', conditions: [{ field: 'priority', operator: 'is', value: 'high' }] },
  });
  expect(summary.join(' · ')).toMatch(
    /报告.*work.*tag.*受阻.*高.*重要.*2026-11-01.*2026-11-03.*2026-10-30.*未安排.*无成果.*回收.*归档.*叶.*优先级/,
  );
});

test('empty saved-view arrays follow the workbench request normalization and do not claim active conditions', async () => {
  const requests: string[] = [];
  const model = createToDooWorkbench(async (url) => {
    requests.push(url);
    return undefined;
  });
  const saved = { listIds: [], tagIds: [], statuses: [], priorities: [] };
  model.state.filter = saved;
  await model.load({ filter: saved });
  expect(JSON.parse(new URL(requests[0]!, 'http://local').searchParams.get('filter')!)).toEqual({});
  expect(presentation.toDooFilterSummary(saved)).toEqual([]);
  expect(
    presentation.toDooFilterSummary(
      { listIds: ['work'], tagIds: ['red'] },
      { lists: [{ id: 'work', name: '工作' }], tags: [{ id: 'red', name: '紧急' }] },
    ),
  ).toEqual(['清单：工作', '标签：紧急']);
});
