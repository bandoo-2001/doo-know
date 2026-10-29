import { describe, expect, it } from 'vitest';
import { toDooEntitySchemas, type ToDooDateTime } from '../shared/to-doo-contracts.js';
import {
  validateToDooPlan,
  previewToDooDependentAdjustment,
  type ToDooPlanningData,
  type ToDooScheduleChange,
} from '../packages/core/to-doo/planning.js';

const at = '2026-10-29T08:00:00.000Z';
const base = (id: string) => ({ id, revision: 'rev_' + id, createdAt: at, updatedAt: at });
const task = (id: string, extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.task.parse({ ...base(id), title: id, ...extra });
const occurrence = (id: string, taskId: string, extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.occurrence.parse({
    ...base(id),
    taskId,
    cycleKey: 'once',
    scheduleRevision: 'schedule_' + id,
    ...extra,
  });
const time = (date: string, hour: string | null, timeZone = 'UTC'): ToDooDateTime => ({
  date,
  time: hour,
  timeZone,
});
const block = (
  id: string,
  occurrenceId: string,
  start: ToDooDateTime,
  durationMinutes = 60,
  extra: Record<string, unknown> = {},
) =>
  toDooEntitySchemas.timeBlock.parse({
    ...base(id),
    occurrenceId,
    start,
    durationMinutes,
    ...extra,
  });
const change = (
  occurrenceId: string,
  start: ToDooDateTime,
  durationMinutes = 60,
  blockId?: string,
): ToDooScheduleChange => ({
  occurrenceId,
  expectedRevision: 'rev_' + occurrenceId,
  start,
  durationMinutes,
  ...(blockId ? { blockId, expectedBlockRevision: 'rev_' + blockId } : {}),
});
const data = (): ToDooPlanningData => ({
  tasks: [task('a'), task('b')],
  occurrences: [occurrence('oa', 'a'), occurrence('ob', 'b')],
  timeBlocks: [],
});

describe('candidate timetable and dependency validation', () => {
  it('rejects two newly proposed 09–10 blocks and accepts touching boundaries', () => {
    const state = data();
    const overlapping = validateToDooPlan(state, [
      change('oa', time('2026-10-29', '09:00')),
      change('ob', time('2026-10-29', '09:00')),
    ]);
    expect(overlapping.issues.some((issue) => issue.code === 'overlap')).toBe(true);
    expect(overlapping.conflicts.length).toBeGreaterThan(0);
    expect(
      validateToDooPlan(state, [
        change('oa', time('2026-10-29', '09:00')),
        change('ob', time('2026-10-29', '10:00')),
      ]).conflicts,
    ).toEqual([]);
  });
  it('compares absolute instants across time zones, midnight, and the DST gap policy', () => {
    const state = data();
    expect(
      validateToDooPlan(state, [
        change('oa', time('2026-10-29', '09:00', 'Asia/Shanghai')),
        change('ob', time('2026-10-29', '01:00')),
      ]).issues.some((issue) => issue.code === 'overlap'),
    ).toBe(true);
    state.timeBlocks = [block('old', 'ob', time('2026-10-30', '01:00'))];
    expect(
      validateToDooPlan(state, [change('oa', time('2026-10-29', '23:30'), 120)]).issues.some(
        (issue) => issue.code === 'overlap',
      ),
    ).toBe(true);
    state.timeBlocks = [];
    expect(
      validateToDooPlan(state, [
        change('oa', time('2026-03-08', '02:30', 'America/New_York')),
        change('ob', time('2026-03-08', '07:00')),
      ]).issues.some((issue) => issue.code === 'overlap'),
    ).toBe(true);
  });
  it('uses completed facts plus lag and the last planned segment for unfinished predecessors', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 30 }];
    state.occurrences[0].status = 'done';
    state.occurrences[0].completedAt = '2026-10-29T09:00:00.000Z';
    expect(
      validateToDooPlan(state, [change('ob', time('2026-10-29', '09:15'))]).issues.some(
        (issue) => issue.code === 'dependency_timing',
      ),
    ).toBe(true);
    expect(validateToDooPlan(state, [change('ob', time('2026-10-29', '09:30'))]).conflicts).toEqual(
      [],
    );
    state.occurrences[0].status = 'todo';
    state.occurrences[0].completedAt = null;
    state.timeBlocks = [
      block('a1', 'oa', time('2026-10-29', '09:00')),
      block('a2', 'oa', time('2026-10-29', '11:00')),
    ];
    expect(
      validateToDooPlan(state, [change('ob', time('2026-10-29', '12:15'))]).issues.some(
        (issue) => issue.code === 'dependency_timing',
      ),
    ).toBe(true);
    expect(validateToDooPlan(state, [change('ob', time('2026-10-29', '12:30'))]).conflicts).toEqual(
      [],
    );
  });
  it('checks an unchanged successor when its predecessor is moved and only moves it in an explicit pure preview', () => {
    const state: ToDooPlanningData = {
      tasks: [
        task('a'),
        task('b', { dependencies: [{ taskId: 'a', lagMinutes: 30 }] }),
        task('c', { dependencies: [{ taskId: 'b', lagMinutes: 15 }] }),
      ],
      occurrences: [occurrence('oa', 'a'), occurrence('ob', 'b'), occurrence('oc', 'c')],
      timeBlocks: [
        block('a1', 'oa', time('2026-10-29', '09:00')),
        block('b1', 'ob', time('2026-10-29', '10:30'), 30),
        block('b2', 'ob', time('2026-10-29', '12:00')),
        block('c1', 'oc', time('2026-10-29', '13:30'), 30),
      ],
    };
    const original = JSON.stringify(state),
      initial = [change('oa', time('2026-10-29', '11:00'), 60, 'a1')];
    expect(
      validateToDooPlan(state, initial).issues.some(
        (issue) => issue.code === 'dependency_timing' && issue.occurrenceId === 'ob',
      ),
    ).toBe(true);
    expect(initial).toHaveLength(1);
    const linked = previewToDooDependentAdjustment(state, initial);
    expect(linked.conflicts).toEqual([]);
    expect(linked.changes.find((item) => item.blockId === 'b1')).toMatchObject({
      occurrenceId: 'ob',
      start: time('2026-10-29', '12:30'),
      durationMinutes: 30,
      expectedBlockRevision: 'rev_b1',
    });
    expect(linked.changes.find((item) => item.blockId === 'b2')).toMatchObject({
      start: time('2026-10-29', '14:00'),
      durationMinutes: 60,
    });
    expect(linked.changes.find((item) => item.blockId === 'c1')?.start).toEqual(
      time('2026-10-29', '15:15'),
    );
    expect(linked.expectedRevisions['occurrence:ob']).toBe('rev_ob');
    expect(linked.expectedRevisions['timeBlock:b2']).toBe('rev_b2');
    expect(JSON.stringify(state)).toBe(original);
  });
  it('moves linked segments across midnight without wrapping into the old date', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 15 }];
    state.timeBlocks = [
      block('a1', 'oa', time('2026-10-29', '22:00')),
      block('b1', 'ob', time('2026-10-29', '23:30'), 30),
    ];
    const result = previewToDooDependentAdjustment(state, [
      change('oa', time('2026-10-29', '23:00'), 60, 'a1'),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.changes.find((item) => item.blockId === 'b1')?.start).toEqual(
      time('2026-10-30', '00:15'),
    );
  });
  it('reports missing or ambiguous predecessor finishes instead of inventing a schedule', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 0 }];
    expect(
      validateToDooPlan(state, [change('ob', time('2026-10-29', '09:00'))]).issues.some(
        (issue) => issue.code === 'dependency_unverifiable',
      ),
    ).toBe(true);
    state.tasks[0].recurrence = toDooEntitySchemas.task.parse({
      ...base('a'),
      title: 'a',
      recurrence: { id: 'series', frequency: 'daily', anchorDate: '2026-10-29' },
    }).recurrence;
    state.occurrences[0].cycleKey = 'series:2026-10-29';
    state.occurrences[0].seriesSegmentId = 'series';
    state.occurrences[0].scheduledDate = '2026-10-29';
    state.occurrences.push(
      occurrence('oa2', 'a', {
        cycleKey: 'series:2026-10-30',
        seriesSegmentId: 'series',
        scheduledDate: '2026-10-30',
      }),
    );
    expect(
      validateToDooPlan(state, [change('ob', time('2026-10-29', '09:00'))]).issues.some(
        (issue) => issue.code === 'dependency_ambiguous',
      ),
    ).toBe(true);
    const linked = previewToDooDependentAdjustment(state, [
      change('oa', time('2026-10-29', '09:00')),
    ]);
    expect(linked.conflicts.length).toBeGreaterThan(0);
    expect(linked.changes.filter((item) => item.occurrenceId === 'ob')).toEqual([]);
  });
  it('rejects cycles, expansion beyond its budget, and unauthorized dependent expansion', () => {
    const state = data();
    state.tasks[0].dependencies = [{ taskId: 'b', lagMinutes: 0 }];
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 0 }];
    expect(
      previewToDooDependentAdjustment(state, [
        change('oa', time('2026-10-29', '09:00')),
      ]).issues.some((issue) => issue.code === 'dependency_cycle'),
    ).toBe(true);
    state.tasks[0].dependencies = [];
    expect(
      previewToDooDependentAdjustment(state, [change('oa', time('2026-10-29', '09:00'))], {
        maxAffected: 1,
      }).issues.some((issue) => issue.code === 'planning_limit'),
    ).toBe(true);
    const scoped = previewToDooDependentAdjustment(
      state,
      [change('oa', time('2026-10-29', '09:00'))],
      { allowedTaskIds: ['a'] },
    );
    expect(scoped.issues.some((issue) => issue.code === 'scope_required')).toBe(true);
    expect(scoped.changes.some((item) => item.occurrenceId === 'ob')).toBe(false);
    expect(scoped.affectedOccurrenceIds).not.toContain('ob');
    expect(scoped.expectedRevisions).not.toHaveProperty('task:b');
  });
  it('updates only an explicitly named block and requires its expected revision', () => {
    const state = data();
    state.timeBlocks = [block('a1', 'oa', time('2026-10-29', '09:00'), 120)];
    expect(
      validateToDooPlan(state, [change('oa', time('2026-10-29', '10:00'), 60, 'a1')]).conflicts,
    ).toEqual([]);
    expect(
      validateToDooPlan(state, [change('oa', time('2026-10-29', '10:00'))]).issues.some(
        (issue) => issue.code === 'overlap',
      ),
    ).toBe(true);
    expect(
      validateToDooPlan(state, [
        { ...change('oa', time('2026-10-29', '10:00'), 60, 'a1'), expectedBlockRevision: 'stale' },
      ]).issues.some((issue) => issue.code === 'stale_block'),
    ).toBe(true);
  });
  it('rounds an actual completion with seconds up to a representable planned minute', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 30 }];
    state.occurrences[0].status = 'done';
    state.occurrences[0].completedAt = '2026-10-29T09:00:15.123Z';
    state.timeBlocks = [block('b1', 'ob', time('2026-10-29', '09:00'))];
    const preview = previewToDooDependentAdjustment(state, [
      change('oa', time('2026-10-29', '08:00')),
    ]);
    expect(preview.issues.some((issue) => issue.code === 'time_unrepresentable')).toBe(false);
    const active = data();
    active.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 30 }];
    active.occurrences[0].status = 'done';
    active.occurrences[0].completedAt = '2026-10-29T09:00:15.123Z';
    active.tasks.push(task('root'));
    active.occurrences.push(occurrence('oroot', 'root'));
    active.tasks[1].dependencies.push({ taskId: 'root', lagMinutes: 0 });
    active.timeBlocks = [block('b1', 'ob', time('2026-10-29', '09:00'))];
    const adjusted = previewToDooDependentAdjustment(active, [
      change('oroot', time('2026-10-29', '08:00')),
    ]);
    expect(adjusted.conflicts).toEqual([]);
    expect(adjusted.changes.find((item) => item.blockId === 'b1')?.start.time).toBe('09:31');
  });
  it('does not mistake repeated dependency edges for a graph cycle', () => {
    const state = data();
    state.tasks[1].dependencies = [
      { taskId: 'a', lagMinutes: 15 },
      { taskId: 'a', lagMinutes: 30 },
    ];
    state.timeBlocks = [block('a1', 'oa', time('2026-10-29', '09:00'))];
    const result = validateToDooPlan(state, [change('ob', time('2026-10-29', '10:30'))]);
    expect(result.conflicts).toEqual([]);
  });
  it('ignores explicitly deleted occurrences but still checks full all-day occupancy', () => {
    const state = data();
    state.occurrences[1].deletedAt = at;
    state.timeBlocks = [block('old', 'ob', time('2026-10-29', '09:00'))];
    expect(validateToDooPlan(state, [change('oa', time('2026-10-29', '09:00'))]).conflicts).toEqual(
      [],
    );
    state.occurrences[1].deletedAt = null;
    state.timeBlocks = [
      block('day', 'ob', time('2026-10-29', null), 1440, {
        allDay: true,
        dateEndExclusive: '2026-10-30',
      }),
    ];
    expect(
      validateToDooPlan(state, [change('oa', time('2026-10-29', '12:00'))]).issues.some(
        (issue) => issue.code === 'overlap',
      ),
    ).toBe(true);
  });
  it('does not reveal hidden or unbound block identities in a scoped preview', () => {
    const state = data();
    state.occurrences = state.occurrences.filter((item) => item.id === 'oa');
    state.timeBlocks = [block('hidden', 'ob', time('2026-10-29', '09:00'))];
    const scoped = validateToDooPlan(state, [change('oa', time('2026-10-29', '09:00'))], {
      allowedTaskIds: ['a'],
    });
    expect(scoped.issues.find((issue) => issue.code === 'overlap')?.otherBlockId).toBeUndefined();
    expect(scoped.expectedRevisions).not.toHaveProperty('timeBlock:hidden');
    state.timeBlocks = [
      block('unbound', 'ob', time('2026-10-29', '09:00'), 60, { occurrenceId: null }),
    ];
    const unbound = validateToDooPlan(state, [change('oa', time('2026-10-29', '09:00'))], {
      allowedTaskIds: ['a'],
    });
    expect(unbound.issues.find((issue) => issue.code === 'overlap')?.otherBlockId).toBeUndefined();
    expect(unbound.expectedRevisions).not.toHaveProperty('timeBlock:unbound');
  });
  it('does not normalize a foreign block using its hidden all-day fields', () => {
    const state = data();
    state.timeBlocks = [
      block('foreign', 'ob', time('2026-10-29', null), 1440, {
        allDay: true,
        dateEndExclusive: '2026-11-02',
      }),
    ];
    const result = validateToDooPlan(
      state,
      [change('oa', time('2026-10-29', '09:00'), 60, 'foreign')],
      { allowedTaskIds: ['a'] },
    );
    expect(result.issues.some((issue) => issue.code === 'missing_block')).toBe(true);
    expect(result.changes[0].allDay).toBeUndefined();
    expect(result.changes[0].dateEndExclusive).toBeUndefined();
    expect(result.expectedRevisions).not.toHaveProperty('timeBlock:foreign');
  });
  it('advances an all-day successor to its next local date and carries its exclusive end', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 0 }];
    state.timeBlocks = [
      block('a1', 'oa', time('2026-10-28', '12:00')),
      block('bday', 'ob', time('2026-10-29', null), 1440, {
        allDay: true,
        dateEndExclusive: '2026-10-30',
      }),
    ];
    const result = previewToDooDependentAdjustment(state, [
      change('oa', time('2026-10-29', '12:00'), 60, 'a1'),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.changes.find((item) => item.blockId === 'bday')).toMatchObject({
      start: time('2026-10-30', null),
      allDay: true,
      dateEndExclusive: '2026-10-31',
      durationMinutes: 1440,
    });
  });
  it('rechecks unrelated bookings against every generated dependent move', () => {
    const state = data();
    state.tasks[1].dependencies = [{ taskId: 'a', lagMinutes: 30 }];
    state.tasks.push(task('other'));
    state.occurrences.push(occurrence('oother', 'other'));
    state.timeBlocks = [
      block('a1', 'oa', time('2026-10-29', '09:00')),
      block('b1', 'ob', time('2026-10-29', '10:30')),
      block('other', 'oother', time('2026-10-29', '12:30')),
    ];
    const result = previewToDooDependentAdjustment(state, [
      change('oa', time('2026-10-29', '11:00'), 60, 'a1'),
    ]);
    expect(result.changes.find((item) => item.blockId === 'b1')?.start.time).toBe('12:30');
    expect(
      result.issues.some((issue) => issue.code === 'overlap' && issue.occurrenceId === 'ob'),
    ).toBe(true);
    expect(state.timeBlocks.find((item) => item.id === 'b1')?.start.time).toBe('10:30');
  });
});
