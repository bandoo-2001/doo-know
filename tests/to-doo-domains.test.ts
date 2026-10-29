import { resolveToDooStatusSelection, type ToDooSnapshot } from '../shared/to-doo-contracts';
import { summarizeHabitPeriod } from '../shared/to-doo-habits';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
let root: string, db: ReturnType<typeof openDatabase>, s: ReturnType<typeof createToDooService>;
const c = (action: string, payload: unknown) =>
  s.command({ requestId: randomUUID(), action, payload });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'todo-domains-'));
  const config = {
    knowledgeRoot: join(root, 'k'),
    dataRoot: join(root, 'd'),
    origin: 'http://localhost:3010',
    secret: 'test',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  s = createToDooService(config, db, noteService(config, db));
});
afterEach(async () => {
  s?.close();
  if (db.open) db.close();
  await rm(root, { recursive: true, force: true });
});

const freezeBatch = (
  state: ToDooSnapshot,
  ids: string[],
  scope: 'current' | 'range' | 'all_materialized' = 'current',
) => {
  const selection = resolveToDooStatusSelection(state, {
    taskIds: ids,
    includeDescendants: true,
    scope,
    status: 'done',
  });
  return { occurrenceIds: selection.occurrenceIds, expectedRevisions: selection.expectedRevisions };
};
const freezeCascade = (state: ToDooSnapshot, id: string, status: 'done' | 'todo' = 'done') => {
  const selection = resolveToDooStatusSelection(state, { occurrenceId: id, cascade: true, status });
  return {
    expectedOccurrenceIds: selection.occurrenceIds,
    expectedRevisions: selection.expectedRevisions,
  };
};
it('keeps independent repeat instances and stable completion-based successors', () => {
  const id = c('create_task', {
    title: 'Review',
    recurrence: {
      id: 'review-rule',
      frequency: 'after_completion',
      interval: 2,
      anchorDate: '2026-10-29',
      timeZone: 'UTC',
    },
  }).ids[0];
  let first = s.snapshot().occurrences.find((o) => o.taskId === id)!;
  c('set_occurrence_status', {
    id: first.id,
    expectedRevision: first.revision,
    status: 'done',
    at: '2026-10-29T10:00:00.000Z',
  });
  let periods = s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === id);
  expect(periods).toHaveLength(2);
  expect(periods.find((o) => o.predecessorId === first.id)?.due?.date).toBe('2026-10-31');
  first = periods.find((o) => o.id === first.id)!;
  expect(() =>
    c('set_occurrence_status', { id: first.id, expectedRevision: first.revision, status: 'todo' }),
  ).not.toThrow();
  expect(s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === id)).toHaveLength(2);
});
it('records multiple habit amounts and excludes deleted entries from statistics', () => {
  const id = c('save_entity', {
    kind: 'habit',
    entity: { name: 'Read', startDate: '2026-10-01', target: 30, unit: '页' },
  }).ids[0];
  c('checkin_habit', { habitId: id, localDate: '2026-10-29', amount: 10 });
  const entry = c('checkin_habit', { habitId: id, localDate: '2026-10-29', amount: 20 }).snapshot
    .habitEntries[1];
  expect(s.snapshot().statistics.habitAmount).toBe(30);
  c('delete_entity', { kind: 'habitEntry', id: entry.id, expectedRevision: entry.revision });
  expect(s.snapshot().statistics.habitAmount).toBe(10);
});
it('computes focus time from confirmed paused intervals and persists outcomes', () => {
  const id = c('start_focus', { mode: 'stopwatch', at: '2026-10-29T10:00:00.000Z' }).ids[0];
  let session = s.snapshot().focusSessions[0];
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'pause',
    at: '2026-10-29T10:10:00.000Z',
  });
  session = s.snapshot().focusSessions[0];
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'resume',
    at: '2026-10-29T10:20:00.000Z',
  });
  session = s.snapshot().focusSessions[0];
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'finish',
    at: '2026-10-29T10:25:00.000Z',
  });
  expect(s.snapshot().statistics.focusMinutes).toBe(15);
  c('save_entity', {
    kind: 'outcome',
    entity: { summary: 'Can explain the design', verification: 'practice' },
  });
  expect(s.snapshot().statistics.outcomes).toBe(1);
});
it('applies saved templates and rejects stale plan changes', () => {
  const template = c('save_entity', {
    kind: 'template',
    entity: {
      name: 'Release',
      tasks: [
        { key: 'a', title: 'Prepare' },
        { key: 'b', parentKey: 'a', title: 'Verify' },
      ],
    },
  }).ids[0];
  c('apply_template', { templateId: template, listId: null });
  expect(s.snapshot().tasks).toHaveLength(2);
  const occurrence = s.snapshot().occurrences[0];
  const preview = c('preview_plan', {
    name: 'Tomorrow',
    changes: [
      {
        occurrenceId: occurrence.id,
        expectedRevision: occurrence.revision,
        start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
        durationMinutes: 45,
      },
    ],
  }).preview!;
  c('set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'doing',
  });
  expect(() => c('apply_plan', { plan: preview })).toThrow(/变化|版本|冲突/);
  expect(s.snapshot().timeBlocks).toHaveLength(0);
});
it('keeps plan preview read-only and rechecks newly conflicting blocks during apply', () => {
  const id = c('create_task', { title: 'Plan task' }).ids[0];
  const o = s.snapshot().occurrences.find((x) => x.taskId === id)!;
  const before = s.exportCheckpoint().transactions.length;
  const plan = c('preview_plan', {
    name: 'Schedule',
    changes: [
      {
        occurrenceId: o.id,
        expectedRevision: o.revision,
        start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
        durationMinutes: 60,
      },
    ],
  }).preview!;
  expect(s.exportCheckpoint().transactions).toHaveLength(before);
  c('save_entity', {
    kind: 'timeBlock',
    entity: {
      title: 'Another meeting',
      start: { date: '2026-10-30', time: '09:30', timeZone: 'UTC' },
      durationMinutes: 30,
    },
  });
  expect(() => c('apply_plan', { plan })).toThrow(/冲突/);
});
it('applies a single-instance exception without altering other repeat dates', () => {
  const id = c('create_task', {
    title: 'Weekly',
    recurrence: {
      id: 'weekly',
      frequency: 'weekly',
      anchorDate: '2026-10-26',
      weekdays: [1],
      timeZone: 'UTC',
    },
  }).ids[0];
  let occurrences = s.snapshot({ all: true }).occurrences.filter((x) => x.taskId === id);
  const first = occurrences[0];
  c('save_entity', {
    kind: 'exception',
    entity: {
      taskId: id,
      cycleKey: first.cycleKey,
      kind: 'override',
      date: '2026-10-26',
      due: { date: '2026-10-27', time: '12:00', timeZone: 'UTC' },
    },
  });
  occurrences = s.snapshot({ all: true }).occurrences.filter((x) => x.taskId === id);
  expect(occurrences.find((x) => x.id === first.id)?.due?.date).toBe('2026-10-27');
  expect(occurrences[1].due?.date).toBe('2026-11-02');
});
it('corrects focus totals without cancelling a finished session and invalidates an old controller on takeover', () => {
  const id = c('start_focus', { mode: 'pomodoro', at: '2026-10-29T10:00:00.000Z' }).ids[0];
  let session = s.snapshot().focusSessions[0];
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'takeover',
    at: '2026-10-29T10:05:00.000Z',
  });
  expect(() =>
    c('control_focus', {
      id,
      expectedRevision: session.revision,
      operation: 'pause',
      at: '2026-10-29T10:06:00.000Z',
    }),
  ).toThrow();
  session = s.snapshot().focusSessions[0];
  expect(session.status).toBe('running');
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'finish',
    at: '2026-10-29T10:20:00.000Z',
  });
  session = s.snapshot().focusSessions[0];
  c('control_focus', {
    id,
    expectedRevision: session.revision,
    operation: 'correct',
    correctedMinutes: 12,
  });
  expect(s.snapshot().focusSessions[0].status).toBe('finished');
  expect(s.snapshot().statistics.focusMinutes).toBe(12);
});
it('reports period statistics independently of pagination and excludes other completion dates', () => {
  for (const date of ['2026-10-28', '2026-10-29']) {
    const id = c('create_task', { title: date }).ids[0],
      o = s.snapshot({ all: true }).occurrences.find((x) => x.taskId === id)!;
    c('set_occurrence_status', {
      id: o.id,
      expectedRevision: o.revision,
      status: 'done',
      at: date + 'T12:00:00.000Z',
    });
  }
  const state = s.snapshot({ from: '2026-10-29', to: '2026-10-29', limit: 1 });
  expect(state.statistics.scope).toBe('period');
  expect(state.statistics.completed).toBe(1);
});
it('executes nested AND/OR saved filters without treating the group as text', () => {
  const a = c('create_task', { title: 'Alpha', priority: 'low' }).ids[0];
  c('create_task', { title: 'Beta', priority: 'normal' });
  const gamma = c('create_task', { title: 'Gamma', priority: 'high' }).ids[0];
  const o = s.snapshot().occurrences.find((x) => x.taskId === gamma)!;
  c('set_occurrence_status', { id: o.id, expectedRevision: o.revision, status: 'done' });
  const filter = {
    group: {
      operator: 'or',
      conditions: [
        { field: 'query', operator: 'contains', value: 'Alpha' },
        {
          operator: 'and',
          conditions: [
            { field: 'priority', operator: 'is', value: 'high' },
            { field: 'status', operator: 'is', value: 'done' },
          ],
        },
      ],
    },
  };
  c('save_entity', { kind: 'view', entity: { name: 'Nested', filter } });
  expect(s.snapshot({ kind: 'task', filter: filter as any }).tasks.map((t) => t.id)).toEqual([
    a,
    gamma,
  ]);
});
it('atomically applies batch recurrence rules and preserves completed instances', () => {
  const ids = [
    c('create_task', {
      title: 'Repeat A',
      recurrence: {
        id: 'old-a',
        frequency: 'daily',
        anchorDate: '2026-10-29',
        count: 3,
        timeZone: 'UTC',
      },
    }).ids[0],
    c('create_task', { title: 'Repeat B' }).ids[0],
  ];
  let state = s.snapshot({ all: true });
  const completed = state.occurrences.find((o) => o.taskId === ids[0])!;
  c('set_occurrence_status', {
    id: completed.id,
    expectedRevision: completed.revision,
    status: 'done',
  });
  state = s.snapshot({ all: true });
  c('batch_tasks', {
    ids,
    expectedRevisions: Object.fromEntries(state.tasks.map((t) => [t.id, t.revision])),
    operation: 'patch',
    patch: {
      recurrence: {
        id: 'new-weekly',
        frequency: 'weekly',
        anchorDate: '2026-10-30',
        weekdays: [5],
        count: 3,
        timeZone: 'UTC',
      },
    },
    includeDescendants: true,
  });
  state = s.snapshot({ all: true });
  expect(state.occurrences.find((o) => o.id === completed.id)?.status).toBe('done');
  for (const id of ids)
    expect(
      state.occurrences
        .filter((o) => o.taskId === id && !o.deletedAt && o.seriesSegmentId === 'new-weekly')
        .map((o) => o.due?.date),
    ).toEqual(['2026-10-30', '2026-11-06', '2026-11-13']);
});
it('completes only the current repeat period in a default task batch', () => {
  const id = c('create_task', {
    title: 'Daily',
    recurrence: {
      id: 'daily-rule',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      count: 3,
      timeZone: 'UTC',
    },
  }).ids[0];
  const state = s.snapshot({ all: true });
  c('batch_tasks', {
    ids: [id],
    ...freezeBatch(state, [id]),
    operation: 'complete',
    includeDescendants: true,
  });
  const periods = s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === id);
  expect(periods.filter((o) => o.status === 'done')).toHaveLength(1);
  expect(periods.filter((o) => o.status === 'todo')).toHaveLength(2);
});
it('rejects overdeep filter groups and keeps comparison values as data', () => {
  const group: any = {
    operator: 'and',
    conditions: [
      { field: 'query', operator: 'contains', value: "'); DELETE FROM todo_entities; --" },
    ],
  };
  let deep = group;
  for (let i = 0; i < 3; i++) deep = { operator: 'and', conditions: [deep] };
  expect(() => s.snapshot({ kind: 'task', filter: { group: deep } })).toThrow(/过滤|3层/);
  const id = c('create_task', { title: 'Still here' }).ids[0];
  expect(s.snapshot({ kind: 'task', filter: { group } }).tasks).toHaveLength(0);
  expect(s.getEntity('task', id)).toBeTruthy();
});
it('reschedules an untouched completion-based successor under a count cap without changing its identity', () => {
  const task = c('create_task', {
    title: 'Review',
    recurrence: {
      id: 'bounded-after',
      frequency: 'after_completion',
      interval: 2,
      count: 2,
      anchorDate: '2026-10-29',
      timeZone: 'UTC',
    },
  }).ids[0];
  let first = s.snapshot().occurrences.find((o) => o.taskId === task)!;
  c('set_occurrence_status', {
    id: first.id,
    expectedRevision: first.revision,
    status: 'done',
    at: '2026-10-29T10:00:00.000Z',
  });
  let after = s.snapshot({ all: true }).occurrences.find((o) => o.predecessorId === first.id)!;
  const successorId = after.id;
  first = s.snapshot().occurrences.find((o) => o.id === first.id)!;
  c('set_occurrence_status', { id: first.id, expectedRevision: first.revision, status: 'todo' });
  first = s.snapshot().occurrences.find((o) => o.id === first.id)!;
  c('set_occurrence_status', {
    id: first.id,
    expectedRevision: first.revision,
    status: 'done',
    at: '2026-10-30T10:00:00.000Z',
  });
  after = s.snapshot({ all: true }).occurrences.find((o) => o.id === successorId)!;
  expect(after.due?.date).toBe('2026-11-01');
  expect(s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === task)).toHaveLength(2);
});
it('saves an outcome, completion activity and note-operation receipt in one transaction', () => {
  const id = c('create_task', { title: 'Deliver' }).ids[0];
  const o = s.snapshot().occurrences.find((x) => x.taskId === id)!;
  const operationId = c('save_entity', {
    kind: 'operation',
    entity: {
      kind: 'outcome_note',
      requestId: 'make-note-request',
      fingerprint: 'request-fingerprint',
      occurrenceId: o.id,
      expectedRevision: o.revision,
      title: 'Result',
      folderPath: '00-Inbox',
      fileName: 'result.md',
      content: '# Result',
      verification: 'delivered',
      complete: true,
      criteriaResults: [],
      noteId: 'note-1',
      state: 'note_saved',
    },
  }).ids[0];
  const result = c('save_outcome', {
    occurrenceId: o.id,
    expectedRevision: o.revision,
    outcome: {
      summary: 'Delivered',
      verification: 'delivered',
      criteriaResults: [],
      evidenceRefs: [{ noteId: 'note-1', role: 'output' }],
    },
    complete: true,
    operationId,
  });
  expect(result.changed.map((x) => x.kind)).toEqual(
    expect.arrayContaining(['outcome', 'occurrence', 'activity', 'operation']),
  );
  expect(s.snapshot().outcomes[0].summary).toBe('Delivered');
  expect(s.snapshot().occurrences[0].status).toBe('done');
  expect(s.getEntity('operation', operationId)).toMatchObject({
    state: 'completed',
    content: '',
    noteId: 'note-1',
  });
});
it('finishes focus and keeps its result note in one durable command', () => {
  const id = c('start_focus', { mode: 'stopwatch', at: '2026-10-29T10:00:00.000Z' }).ids[0];
  const focus = s.snapshot().focusSessions[0];
  const result = c('control_focus', {
    id,
    expectedRevision: focus.revision,
    operation: 'finish',
    at: '2026-10-29T10:10:00.000Z',
    note: 'Compared two architecture options',
  });
  expect(result.changed.map((e) => e.kind)).toEqual(
    expect.arrayContaining(['focusSession', 'record']),
  );
  expect(s.snapshot().focusSessions[0].note).toBe('Compared two architecture options');
  expect(s.snapshot().records[0]).toMatchObject({
    sourceSessionId: id,
    content: 'Compared two architecture options',
  });
});

it('keeps future independent child periods untouched when completing a one-off parent batch', () => {
  const parent = c('create_task', { title: 'One-off parent' }).ids[0];
  const child = c('create_task', {
    title: 'Independent daily child',
    parentTaskId: parent,
    recurrence: {
      id: 'independent-child',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      count: 3,
      timeZone: 'UTC',
    },
  }).ids[0];
  const before = s.snapshot({ all: true });
  c('batch_tasks', {
    ids: [parent],
    ...freezeBatch(before, [parent]),
    operation: 'complete',
    scope: 'current',
    includeDescendants: true,
  });
  const periods = s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === child);
  expect(periods.filter((o) => o.status === 'done')).toHaveLength(1);
  expect(periods.filter((o) => o.status === 'todo')).toHaveLength(2);
});

it('advances an inherited after-completion tree as one shared period', () => {
  const parent = c('create_task', {
    title: 'Recurring parent',
    recurrence: {
      id: 'family-after',
      frequency: 'after_completion',
      anchorDate: '2026-10-29',
      interval: 2,
      count: 3,
      timeZone: 'UTC',
    },
  }).ids[0];
  const child = c('create_task', { title: 'Inherited child', parentTaskId: parent }).ids[0];
  const first = s.snapshot({ all: true }).occurrences.find((o) => o.taskId === parent)!;
  c('set_occurrence_status', {
    id: first.id,
    expectedRevision: first.revision,
    status: 'done',
    cascade: true,
    ...freezeCascade(s.snapshot({ all: true }), first.id),
    at: '2026-10-29T10:00:00.000Z',
  });
  let state = s.snapshot({ all: true });
  const parentNext = state.occurrences.find((o) => o.taskId === parent && o.status === 'todo')!,
    childNext = state.occurrences.find((o) => o.taskId === child && o.status === 'todo')!;
  expect(childNext.cycleKey).toBe(parentNext.cycleKey);
  expect(childNext.parentOccurrenceId).toBe(parentNext.id);
  c('set_occurrence_status', {
    id: childNext.id,
    expectedRevision: childNext.revision,
    status: 'done',
    at: '2026-10-31T09:00:00.000Z',
  });
  expect(s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === child)).toHaveLength(2);
  c('set_occurrence_status', {
    id: parentNext.id,
    expectedRevision: s.getEntity('occurrence', parentNext.id)!.revision,
    status: 'done',
    at: '2026-10-31T10:00:00.000Z',
  });
  state = s.snapshot({ all: true });
  const thirdParent = state.occurrences.find((o) => o.taskId === parent && o.status === 'todo')!,
    thirdChild = state.occurrences.find((o) => o.taskId === child && o.status === 'todo')!;
  expect(thirdChild.parentOccurrenceId).toBe(thirdParent.id);
  expect(thirdChild.cycleKey).toBe(thirdParent.cycleKey);
});

it('turns a stopped repeat tree into executable one-off instances without deleting history', () => {
  const parent = c('create_task', {
    title: 'Stop repeat',
    recurrence: {
      id: 'stop-daily',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      count: 2,
      timeZone: 'UTC',
    },
  }).ids[0];
  const child = c('create_task', { title: 'Inherited stop child', parentTaskId: parent }).ids[0];
  const task = s.getEntity('task', parent)!;
  c('change_recurrence', {
    taskId: parent,
    expectedRevision: task.revision,
    rule: null,
    scope: 'all',
  });
  const state = s.snapshot({ all: true });
  const oneOffParent = state.occurrences.find(
    (o) => o.taskId === parent && !o.deletedAt && o.status === 'todo' && o.seriesSegmentId === null,
  );
  const oneOffChild = state.occurrences.find(
    (o) => o.taskId === child && !o.deletedAt && o.status === 'todo' && o.seriesSegmentId === null,
  );
  expect(oneOffParent).toBeTruthy();
  expect(oneOffChild?.parentOccurrenceId).toBe(oneOffParent?.id);
  expect(state.occurrences.filter((o) => o.seriesSegmentId === 'stop-daily')).toHaveLength(4);
});

it('persists effective habit rules so a new target cannot rewrite the previous period', () => {
  const id = c('save_entity', {
    kind: 'habit',
    entity: { name: 'Versioned reading', startDate: '2026-10-01', target: 1 },
  }).ids[0];
  let habit = s.getEntity('habit', id) as any;
  c('checkin_habit', { habitId: id, localDate: '2026-10-28', amount: 1 });
  c('save_entity', {
    kind: 'habit',
    entity: { ...habit, target: 2, effectiveFrom: '2026-10-29' },
    expectedRevision: habit.revision,
  });
  habit = s.getEntity('habit', id) as any;
  expect(habit.ruleVersions.find((rule: any) => rule.effectiveFrom === '2026-10-01')?.target).toBe(
    1,
  );
  expect(habit.ruleVersions.find((rule: any) => rule.effectiveFrom === '2026-10-29')?.target).toBe(
    2,
  );
  expect(
    summarizeHabitPeriod(habit, s.snapshot({ all: true }).habitEntries, '2026-10-28'),
  ).toMatchObject({ target: 1, status: 'achieved', estimated: false });
  expect(
    summarizeHabitPeriod(habit, s.snapshot({ all: true }).habitEntries, '2026-10-29'),
  ).toMatchObject({ target: 2, status: 'pending' });
});

it('checks overlap among proposed blocks and recomputes conflicts when a client clears them', () => {
  const first = c('create_task', { title: 'First candidate' }).ids[0],
    second = c('create_task', { title: 'Second candidate' }).ids[0];
  const state = s.snapshot();
  const changes = [first, second].map((id) => {
    const o = state.occurrences.find((x) => x.taskId === id)!;
    return {
      occurrenceId: o.id,
      expectedRevision: o.revision,
      start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      durationMinutes: 60,
    };
  });
  const plan = c('preview_plan', { name: 'Overlapping proposal', changes }).preview!;
  expect(plan.conflicts.length).toBeGreaterThan(0);
  expect(() => c('apply_plan', { plan: { ...plan, conflicts: [] } })).toThrow(/冲突/);
  expect(s.snapshot().timeBlocks).toHaveLength(0);
});

it('previews dependent moves and updates existing blocks with all constraint versions checked', () => {
  const first = c('create_task', { title: 'Predecessor' }).ids[0],
    second = c('create_task', {
      title: 'Successor',
      dependencies: [{ taskId: first, lagMinutes: 30 }],
    }).ids[0];
  let state = s.snapshot();
  const a = state.occurrences.find((x) => x.taskId === first)!,
    b = state.occurrences.find((x) => x.taskId === second)!;
  c('save_entity', {
    kind: 'timeBlock',
    entity: {
      occurrenceId: a.id,
      start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      durationMinutes: 60,
    },
  });
  c('save_entity', {
    kind: 'timeBlock',
    entity: {
      occurrenceId: b.id,
      start: { date: '2026-10-30', time: '10:30', timeZone: 'UTC' },
      durationMinutes: 30,
    },
  });
  state = s.snapshot();
  const block = state.timeBlocks.find((x) => x.occurrenceId === a.id)!;
  const changes = [
    {
      occurrenceId: a.id,
      expectedRevision: s.getEntity('occurrence', a.id)!.revision,
      blockId: block.id,
      expectedBlockRevision: block.revision,
      start: { date: '2026-10-30', time: '11:00', timeZone: 'UTC' },
      durationMinutes: 60,
    },
  ];
  const invalid = c('preview_plan', { name: 'Blocked dependency', changes }).preview!;
  expect(invalid.conflicts.length).toBeGreaterThan(0);
  let plan = c('preview_plan', { name: 'Move chain', changes, includeDependents: true }).preview!;
  expect(plan.conflicts).toHaveLength(0);
  expect(plan.changes).toHaveLength(2);
  const task = s.getEntity('task', first)!;
  c('update_task', {
    id: first,
    expectedRevision: task.revision,
    patch: { title: 'Predecessor updated' },
  });
  expect(() => c('apply_plan', { plan })).toThrow(/版本|变化/);
  plan = c('preview_plan', { name: 'Move chain again', changes, includeDependents: true }).preview!;
  c('apply_plan', { plan });
  state = s.snapshot();
  expect(state.timeBlocks).toHaveLength(2);
  expect(state.timeBlocks.find((x) => x.occurrenceId === b.id)?.start.time).toBe('12:30');
});

it('rejects an unfrozen stale current batch instead of completing tomorrow after another client completed today', () => {
  const taskId = c('create_task', {
    title: 'Concurrent daily',
    recurrence: {
      id: 'concurrent-daily',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      count: 3,
      timeZone: 'UTC',
    },
  }).ids[0];
  const stale = s.snapshot({ all: true }),
    task = stale.tasks.find((t) => t.id === taskId)!,
    today = stale.occurrences.find((o) => o.taskId === taskId)!;
  c('set_occurrence_status', { id: today.id, expectedRevision: today.revision, status: 'done' });
  let error: unknown;
  try {
    c('batch_tasks', {
      ids: [taskId],
      expectedRevisions: { [taskId]: task.revision },
      operation: 'complete',
      scope: 'current',
      includeDescendants: true,
    });
  } catch (e) {
    error = e;
  }
  const periods = s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === taskId);
  expect(periods.filter((o) => o.status === 'done')).toHaveLength(1);
  expect(error).toBeTruthy();
});

it('rejects a cascade that has no frozen child versions after a concurrent child edit', () => {
  const parent = c('create_task', { title: 'Parent CAS' }).ids[0],
    child = c('create_task', { title: 'Child CAS', parentTaskId: parent }).ids[0];
  const stale = s.snapshot({ all: true }),
    parentPeriod = stale.occurrences.find((o) => o.taskId === parent)!,
    childPeriod = stale.occurrences.find((o) => o.taskId === child)!;
  c('set_occurrence_status', {
    id: childPeriod.id,
    expectedRevision: childPeriod.revision,
    status: 'doing',
  });
  let error: unknown;
  try {
    c('set_occurrence_status', {
      id: parentPeriod.id,
      expectedRevision: parentPeriod.revision,
      status: 'done',
      cascade: true,
    });
  } catch (e) {
    error = e;
  }
  expect(s.getEntity('occurrence', childPeriod.id)).toMatchObject({ status: 'doing' });
  expect(s.getEntity('occurrence', parentPeriod.id)).toMatchObject({ status: 'todo' });
  expect(error).toBeTruthy();
});

it('rejects a frozen cascade when an observed child revision changed without changing its task definition', () => {
  const parent = c('create_task', { title: 'Frozen parent' }).ids[0],
    child = c('create_task', { title: 'Frozen child', parentTaskId: parent }).ids[0];
  const stale = s.snapshot({ all: true }),
    root = stale.occurrences.find((o) => o.taskId === parent)!,
    leaf = stale.occurrences.find((o) => o.taskId === child)!;
  const expectedRevisions = Object.fromEntries(
    [...stale.tasks, ...stale.occurrences].map((e) => [e.id, e.revision]),
  );
  c('set_occurrence_status', { id: leaf.id, expectedRevision: leaf.revision, status: 'doing' });
  expect(() =>
    c('set_occurrence_status', {
      id: root.id,
      expectedRevision: root.revision,
      status: 'done',
      cascade: true,
      expectedOccurrenceIds: stale.occurrences.map((o) => o.id),
      expectedRevisions,
    }),
  ).toThrow(/版本/);
  expect(s.getEntity('occurrence', leaf.id)).toMatchObject({ status: 'doing' });
});

it('checks a complete frozen inherited status set before changing any member', () => {
  const parent = c('create_task', {
    title: 'Frozen inherited root',
    recurrence: {
      id: 'frozen-family',
      frequency: 'after_completion',
      anchorDate: '2026-10-29',
      interval: 2,
      timeZone: 'UTC',
    },
  }).ids[0];
  const child = c('create_task', { title: 'Frozen inherited leaf', parentTaskId: parent }).ids[0];
  const stale = s.snapshot({ all: true }),
    frozen = freezeBatch(stale, [parent]);
  expect(() =>
    c('batch_tasks', {
      ids: [parent],
      ...frozen,
      operation: 'complete',
      scope: 'current',
      includeDescendants: true,
    }),
  ).not.toThrow();
  const state = s.snapshot({ all: true });
  expect(state.occurrences.filter((o) => o.status === 'done')).toHaveLength(2);
  expect(state.occurrences.filter((o) => o.status === 'todo')).toHaveLength(2);
  const nextParent = state.occurrences.find((o) => o.taskId === parent && o.status === 'todo')!,
    nextChild = state.occurrences.find((o) => o.taskId === child && o.status === 'todo')!;
  expect(nextChild.parentOccurrenceId).toBe(nextParent.id);
});

it('rejects an all-materialized status selection if another client generated an unseen instance', () => {
  const id = c('create_task', {
    title: 'More materialized periods',
    recurrence: {
      id: 'unseen-period',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      timeZone: 'UTC',
    },
  }).ids[0];
  const frozen = freezeBatch(s.snapshot({ all: true }), [id], 'all_materialized');
  c('materialize_occurrences', { taskId: id, from: '2027-02-01', to: '2027-02-02' });
  expect(() =>
    c('batch_tasks', {
      ids: [id],
      ...frozen,
      operation: 'complete',
      scope: 'all_materialized',
      includeDescendants: true,
    }),
  ).toThrow(/集合.*变化/);
  expect(s.snapshot({ all: true }).occurrences.every((o) => o.status === 'todo')).toBe(true);
});

it('rejects a newly linked execution child outside a previously frozen cascade', () => {
  const parent = c('create_task', { title: 'Parent with observed tree' }).ids[0],
    child = c('create_task', { title: 'Known child definition', parentTaskId: parent }).ids[0];
  const stale = s.snapshot({ all: true }),
    root = stale.occurrences.find((o) => o.taskId === parent)!,
    frozen = freezeCascade(stale, root.id);
  c('save_entity', {
    kind: 'occurrence',
    entity: {
      id: 'new-linked-instance',
      taskId: child,
      cycleKey: 'additional-run',
      parentOccurrenceId: root.id,
      scheduleRevision: 'new-instance-schedule',
    },
  });
  expect(() =>
    c('set_occurrence_status', {
      id: root.id,
      expectedRevision: root.revision,
      status: 'done',
      cascade: true,
      ...frozen,
    }),
  ).toThrow(/集合.*变化/);
  expect(s.snapshot({ all: true }).occurrences.every((o) => o.status === 'todo')).toBe(true);
});

it('requires every frozen occurrence version rather than only task versions', () => {
  const id = c('create_task', { title: 'Required occurrence CAS' }).ids[0],
    state = s.snapshot({ all: true }),
    frozen = freezeBatch(state, [id]);
  const period = state.occurrences[0];
  delete frozen.expectedRevisions[period.id];
  expect(() =>
    c('batch_tasks', {
      ids: [id],
      ...frozen,
      operation: 'complete',
      scope: 'current',
      includeDescendants: true,
    }),
  ).toThrow(/执行实例预期版本/);
  expect(s.getEntity('occurrence', period.id)).toMatchObject({ status: 'todo' });
});

it('keeps every reopen action when a frozen cascade is applied leaf first', () => {
  const parent = c('create_task', { title: 'Reopen parent' }).ids[0];
  c('create_task', { title: 'Reopen leaf', parentTaskId: parent });
  let state = s.snapshot({ all: true }),
    root = state.occurrences.find((o) => o.taskId === parent)!;
  c('set_occurrence_status', {
    id: root.id,
    expectedRevision: root.revision,
    status: 'done',
    cascade: true,
    ...freezeCascade(state, root.id),
  });
  state = s.snapshot({ all: true });
  root = state.occurrences.find((o) => o.id === root.id)!;
  c('set_occurrence_status', {
    id: root.id,
    expectedRevision: root.revision,
    status: 'todo',
    cascade: true,
    ...freezeCascade(state, root.id, 'todo'),
  });
  expect(s.snapshot({ all: true }).occurrences.every((o) => o.status === 'todo')).toBe(true);
  expect(s.snapshot({ all: true }).activities.filter((a) => a.action === 'reopen')).toHaveLength(2);
});

it('replays a frozen batch after the current occurrence advanced without completing the next one', () => {
  const id = c('create_task', {
    title: 'Replay frozen current',
    recurrence: {
      id: 'frozen-replay',
      frequency: 'daily',
      anchorDate: '2026-10-29',
      count: 3,
      timeZone: 'UTC',
    },
  }).ids[0];
  const frozen = freezeBatch(s.snapshot({ all: true }), [id]);
  const request = {
    requestId: 'frozen-current-retry',
    action: 'batch_tasks',
    payload: {
      ids: [id],
      ...frozen,
      operation: 'complete',
      scope: 'current',
      includeDescendants: true,
    },
  };
  s.command(request);
  expect(s.command(request).replayed).toBe(true);
  expect(
    s.snapshot({ all: true }).occurrences.filter((o) => o.taskId === id && o.status === 'done'),
  ).toHaveLength(1);
});
