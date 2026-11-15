import { expect, test } from 'vitest';
import { validateToDooTaskDraft } from '../apps/web/to-doo-draft-validation';
import { toDooEntitySchemas, toDooRecurrenceSchema } from '../shared/to-doo-contracts';
import type { ToDooTaskDraft } from '../apps/web/to-doo-workbench';

function draft(): ToDooTaskDraft {
  const stamp = { revision: 'r1', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' };
  return {
    task: toDooEntitySchemas.task.parse({ ...stamp, id: 'task', title: '整理报告', recurrence: { id: 'rule', frequency: 'daily', anchorDate: '2026-11-15' } }),
    occurrence: toDooEntitySchemas.occurrence.parse({ ...stamp, id: 'occ', taskId: 'task', cycleKey: 'once', scheduleRevision: 's1' }),
    blocks: [toDooEntitySchemas.timeBlock.parse({ ...stamp, id: 'block', occurrenceId: 'occ', start: { date: '2026-11-15', time: '09:00' } })],
  };
}

test.each([null, undefined, 0, 1001, 1.5])('a cleared or invalid recurrence interval %s cannot become a schema default', value => {
  const valueDraft = draft();
  Object.assign(valueDraft.task.recurrence!, { interval: value });
  expect(validateToDooTaskDraft(valueDraft)).toEqual(expect.arrayContaining([
    expect.objectContaining({ panel: 'repeat', path: ['recurrence', 'interval'], label: '间隔' }),
  ]));
});

test('validation accepts recoverable blanks and unsaved blocks without changing edit values', () => {
  const value = draft();
  value.task.title = '  ';
  Object.assign(value.task.recurrence!, { time: '', until: '' });
  value.blocks[0].revision = '';
  const before = structuredClone(value);
  expect(validateToDooTaskDraft(value, { allowEmptyTitle: true })).toEqual([]);
  expect(value).toEqual(before);
  expect(validateToDooTaskDraft(value)).toEqual([expect.objectContaining({ panel: 'title', message: '请填写任务标题' })]);
});

test.each([null, undefined])('only an empty string is an editable unsaved block revision, not %s', revision => {
  const value = draft();
  Object.assign(value.blocks[0], { revision });
  expect(validateToDooTaskDraft(value)).toEqual(expect.arrayContaining([
    expect.objectContaining({ panel: 'plan', entityId: 'block', path: ['revision'] }),
  ]));
});

test('finishing one setting ignores unrelated invalid title and validates only that panel', () => {
  const value = draft();
  value.task.title = '';
  Object.assign(value.task.recurrence!, { anchorDate: '' });
  expect(validateToDooTaskDraft(value, { panel: 'priority' })).toEqual([]);
  expect(validateToDooTaskDraft(value, { panel: 'repeat' })).toEqual([
    expect.objectContaining({ panel: 'repeat', path: ['recurrence', 'anchorDate'], label: '开始日期' }),
  ]);
  expect(validateToDooTaskDraft(value).map(issue => issue.panel)).toContain('title');
});

test('required text-backed numeric editors cannot persist null lag or block duration', () => {
  const value = draft();
  value.task.dependencies = [{ taskId: 'other', lagMinutes: null as any }];
  value.blocks[0].durationMinutes = undefined as any;
  const issues = validateToDooTaskDraft(value, { allowEmptyTitle: true });
  expect(issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ panel: 'properties', path: ['dependencies', 0, 'lagMinutes'] }),
    expect.objectContaining({ panel: 'plan', entityId: 'block', path: ['durationMinutes'] }),
  ]));
  value.task.dependencies[0].lagMinutes = 0;
  value.blocks[0].durationMinutes = 30;
  value.task.estimateMinutes = null;
  expect(validateToDooTaskDraft(value)).toEqual([]);
});

test('recurrence time, date exceptions and timezones use the command contract', () => {
  const value = draft();
  value.task.recurrence = toDooRecurrenceSchema.parse({ id: 'weekly', frequency: 'weekly', anchorDate: '2026-11-15' });
  Object.assign(value.task.recurrence, { time: '25:00', timeZone: 'invalid-zone', excludedDates: ['2026-02-30'] });
  const issues = validateToDooTaskDraft(value);
  expect(issues.map(issue => issue.path.join('.'))).toEqual(expect.arrayContaining([
    'recurrence.time', 'recurrence.timeZone', 'recurrence.excludedDates.0',
  ]));
  expect(issues.every(issue => issue.panel === 'repeat')).toBe(true);
});
