import { describe, expect, test } from 'vitest';
import { createToDooWorkbench } from '../apps/web/to-doo-workbench';
import {
  toDooQuickFilter,
  prepareToDooQuickDraft,
  toDooDraftPayload,
  toDooDateLabel,
} from '../apps/web/to-doo-presentation';

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
    expect(toDooDraftPayload(prepareToDooQuickDraft(restored, '2026-10-29', [], '2026-10-29'), 'UTC').plan).toBeNull();
  });
});

test('date labels are short and use the supplied user-local day', () => {
  expect(toDooDateLabel('', '2026-10-29')).toBe('');
  expect(toDooDateLabel('2026-10-29', '2026-10-29')).toBe('今天');
  expect(toDooDateLabel('2026-10-30', '2026-10-29')).toBe('明天');
  expect(toDooDateLabel('2027-01-01', '2026-10-29')).toBe('2027年1月1日');
});
