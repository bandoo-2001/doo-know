import { describe, expect, test, vi } from 'vitest';
import {
  createToDooWorkbench,
  deriveToDooItems,
  toDooDisplayTime,
  parseToDooQuickEntry,
  toDooOutcomeResumeInput,
  toDooDependencies,
  toDooMoveBlock,
  focusElapsed,
} from '../apps/web/to-doo-workbench';
import { toDooAnniversaryDate as nextToDooAnniversary } from '../shared/to-doo-anniversaries';
import { prepareToDooQuickDraft, toDooDraftPayload } from '../apps/web/to-doo-presentation';
import { saveTaskSection } from '../apps/web/to-doo-task-groups';
import { toDooCaptureFromNote } from '../apps/web/to-doo-capture';
import {
  TO_DOO_COLLECTIONS,
  toDooEntitySchemas,
  toDooCommandSchema,
  type ToDooSnapshot,
  type ToDooCollections,
  type ToDooCommandResult,
} from '../shared/to-doo-contracts';

test.each([
  ['paused', 300],
  ['interrupted', 300],
  ['running', 900],
] as const)('focus display only extends an open segment while %s', (status, seconds) => {
  const session = toDooEntitySchemas.focusSession.parse({
    id: 'clock',
    revision: 'clock-r1',
    createdAt: '2026-10-30T11:00:00Z',
    updatedAt: '2026-10-30T11:00:00Z',
    mode: 'stopwatch',
    status,
    segments: [
      { start: '2026-10-30T11:00:00Z', end: '2026-10-30T11:05:00Z' },
      { start: '2026-10-30T11:50:00Z', end: null },
    ],
  });
  expect(focusElapsed(session, Date.parse('2026-10-30T12:00:00Z'))).toBe(seconds);
});

test('filtered child results hydrate ancestor metadata without adding ancestor rows to the result set', async () => {
  const data = snapshot();
  const parent = { ...data.tasks[0]!, sectionId: 'group-a' };
  const child = {
    ...parent,
    id: 'child-only',
    title: '匹配子任务',
    sectionId: null,
    parentTaskId: parent.id,
  };
  data.tasks = [child];
  data.occurrences = [{ ...data.occurrences[0], id: 'child-occurrence', taskId: child.id }];
  const reads: string[] = [];
  const model = createToDooWorkbench(async (url) => {
    reads.push(url);
    return url.includes('ids=task-a') ? { ...data, tasks: [parent], occurrences: [] } : data;
  });
  model.state.filter = { query: '匹配子任务' };
  await model.load({ view: 'tasks', filter: model.state.filter });
  expect(model.taskDefinitions().find((task) => task.id === parent.id)?.sectionId).toBe('group-a');
  expect(model.state.snapshot?.tasks.map((task) => task.id)).toEqual(['child-only']);
  expect(model.items().map((row) => row.task.id)).toEqual(['child-only']);
  expect(reads.some((url) => url.includes('ids=task-a') && !url.includes('includeTree'))).toBe(
    true,
  );
  model.acceptSnapshot({ ...data, datasetId: 'another-dataset' });
  expect(model.taskDefinitions().some((task) => task.id === parent.id)).toBe(false);
});

test('a scoped task page loads alternative lists as metadata without replacing its visible result set', async () => {
  const data = snapshot();
  const current = toDooEntitySchemas.list.parse({ ...stamp, id: 'current-list', name: '当前清单' });
  const other = toDooEntitySchemas.list.parse({ ...stamp, id: 'other-list', name: '另一清单' });
  data.lists = [current];
  const model = createToDooWorkbench(async (url) =>
    url.includes('kind=list') ? { ...data, lists: [current, other] } : data,
  );
  model.acceptSnapshot(data);
  await model.ensureListCatalog();
  expect(model.taskLists().map((list) => list.id)).toEqual(['current-list', 'other-list']);
  expect(model.state.snapshot?.lists.map((list) => list.id)).toEqual(['current-list']);
  model.acceptSnapshot({ ...data, datasetId: 'another-library' });
  expect(model.taskLists().map((list) => list.id)).toEqual(['current-list']);
});

test('saving a new task does not erase a group change made while the request was pending', async () => {
  const data = snapshot();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = createToDooWorkbench(async (_url, method = 'GET') => {
    if (method === 'GET') return data;
    await wait;
    return { snapshot: data, ids: [], changed: [] };
  });
  model.acceptSnapshot(data);
  const draft = model.newTaskDraft();
  Object.assign(draft, { title: '保留新分组', sectionId: 'group-a' });
  const saving = model.createTask(toDooDraftPayload(draft, 'UTC'));
  draft.sectionId = 'group-b';
  release();
  await saving;
  expect(model.newTaskDraft()).toMatchObject({ title: '保留新分组', sectionId: 'group-b' });
});

const stamp = {
  id: 'task-a',
  revision: 'r1',
  createdAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T08:00:00.000Z',
};

test.each(['unchanged', 'edited', 'replaced'] as const)(
  'a recovered quick capture receipt clears only its exact original draft (%s)', async (change) => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      const data = snapshot(), server = transport(data);
      const scope = { recoveryScope: 'capture-owner' };
      const first = createToDooWorkbench(async () => { throw Error('response lost'); }, scope);
      first.acceptSnapshot(data);
      const source = first.newTaskDraft(undefined, 'list-A');
      source.title = '明天 核对账单';
      const prepared = prepareToDooQuickDraft(source, '2026-10-29', []);
      const payload = toDooDraftPayload(prepared, 'UTC');
      // Two saved drafts may point to the same editable destination.
      const other = first.newTaskDraft(undefined, 'list-B');
      Object.assign(other, prepared);
      await first.createTask(payload, source);
      const originalId = first.state.pendingMutation!.requestId;
      expect(source.title).toBe('明天 核对账单');
      const second = createToDooWorkbench(async (url, method, body) => {
        if (method === 'POST') expect(toDooCommandSchema.parse(body).requestId).toBe(originalId);
        return server.request(url, method, body);
      }, scope);
      second.acceptSnapshot(data);
      if (change === 'replaced') {
        second.clearNewTaskDraft(undefined, 'list-A');
        second.newTaskDraft(undefined, 'list-A').title = source.title;
      }
      if (change === 'edited') second.newTaskDraft(undefined, 'list-A').criteria = '补充核对要求';
      expect(await second.retryPending()).toBeDefined();
      expect(second.newTaskDraft(undefined, 'list-A').title).toBe(change === 'unchanged' ? '' : source.title);
      expect(second.newTaskDraft(undefined, 'list-B').title).toBe(payload.title);
      expect(second.state.pendingQuickCapture).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  },
);

test('a late quick capture receipt keeps the draft and selection in the newly opened dataset', async () => {
  const data = snapshot();
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const server = transport(data);
  const model = createToDooWorkbench(async (url, method, body) => {
    if (method === 'POST') await wait;
    return server.request(url, method, body);
  });
  model.acceptSnapshot(data);
  const source = model.newTaskDraft();
  source.title = '核对账单';
  const saving = model.createTask(toDooDraftPayload(source, 'UTC'), source);
  model.acceptSnapshot({ ...data, datasetId: 'another-dataset' });
  model.newTaskDraft().title = source.title;
  finish();
  await saving;
  expect(model.newTaskDraft().title).toBe(source.title);
  expect(model.state.selectedTaskId).toBe('');
});

function snapshot(): ToDooSnapshot {
  const collections: ToDooCollections = {
    lists: [],
    sections: [],
    tags: [],
    tasks: [],
    occurrences: [],
    exceptions: [],
    timeBlocks: [],
    outcomes: [],
    records: [],
    activities: [],
    focusTopics: [],
    focusSessions: [],
    habits: [],
    habitEntries: [],
    anniversaries: [],
    views: [],
    templates: [],
    reviews: [],
    plans: [],
    reminderEvents: [],
    calendarSources: [],
    calendarEvents: [],
    calendarFeeds: [],
    imports: [],
    operations: [],
  };
  return {
    ...collections,
    datasetId: 'test',
    version: '1',
    now: stamp.createdAt,
    settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings' }),
    tasks: [
      toDooEntitySchemas.task.parse({
        ...stamp,
        title: 'Architecture',
        criteria: 'Draw a diagram',
      }),
    ],
    occurrences: [
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-a',
        taskId: 'task-a',
        cycleKey: 'once',
        scheduleRevision: 'r1',
        due: { date: '2026-10-30' },
      }),
    ],
    page: {
      kind: null,
      total: 1,
      limit: 100,
      nextCursor: null,
      truncated: false,
      counts: { tasks: 1 },
      from: '2026-10-01',
      to: '2026-11-30',
    },
    statistics: {
      completed: 0,
      pending: 1,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    warnings: [],
  } as ToDooSnapshot;
}
// This transport models the HTTP boundary; schema validation catches wrong instance IDs and task/status mixing.
function transport(initial = snapshot()) {
  let data = structuredClone(initial),
    failure = '';
  return {
    get data() {
      return data;
    },
    fail(message: string) {
      failure = message;
    },
    request: async (_url: string, method = 'GET', input?: unknown) => {
      if (failure) throw Error(failure);
      if (method === 'GET') return structuredClone(data);
      const command = toDooCommandSchema.parse(input);
      if (command.action === 'update_task') {
        const t = data.tasks.find((t) => t.id === command.payload.id)!;
        if (t.revision !== command.payload.expectedRevision)
          throw Object.assign(Error('版本冲突'), { status: 409 });
        Object.assign(t, command.payload.patch, { revision: 'r2' });
      } else if (command.action === 'set_occurrence_status') {
        const o = data.occurrences.find((o) => o.id === command.payload.id);
        if (!o || o.revision !== command.payload.expectedRevision) throw Error('错误的执行实例');
        o.status = command.payload.status;
        o.revision = 'r2';
      } else if (command.action === 'create_task') {
        data.tasks.push(
          toDooEntitySchemas.task.parse({ ...stamp, ...command.payload, id: 'task-b' }),
        );
      } else if (command.action === 'batch_tasks') {
        const selected = data.tasks.filter(
          (t) =>
            command.payload.ids.includes(t.id) ||
            (command.payload.includeDescendants &&
              t.parentTaskId &&
              command.payload.ids.includes(t.parentTaskId)),
        );
        for (const task of selected)
          if (command.payload.expectedRevisions[task.id] !== task.revision)
            throw Error('缺少子任务预期版本');
        if (command.payload.operation === 'complete')
          data.occurrences
            .filter((o) => selected.some((t) => t.id === o.taskId))
            .forEach((o) => (o.status = 'done'));
      }
      data.version = '2';
      return {
        snapshot: structuredClone(data),
        ids: command.action === 'create_task' ? ['task-b'] : [],
        changed: [],
        replayed: false,
        transactionId: 'tx',
      };
    },
  };
}
test('active editor validation protects non-serializable input from an indirect save', async () => {
  const server = transport(), model = createToDooWorkbench(server.request);
  await model.load(); model.selectTask('task-a');
  model.draft()!.task.title = '仍在编辑';
  const release = model.registerTaskDraftValidator('task-a@' + model.state.selectedOccurrenceId, () => false);
  expect(await model.saveTask()).toBeUndefined();
  expect(server.data.tasks[0].title).not.toBe('仍在编辑'); expect(model.dirty()).toBe(true);
  release(); await model.saveTask();
  expect(server.data.tasks[0].title).toBe('仍在编辑'); expect(model.dirty()).toBe(false);
});
async function domainStatusFixture() {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const { openDatabase } = await import('../packages/core/db'),
    { noteService } = await import('../packages/core/notes'),
    { createToDooService } = await import('../packages/core/to-doo/service');
  const root = await mkdtemp(join(tmpdir(), 'to-doo-status-workbench-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-secret',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  const request = async (url: string, method = 'GET', body?: unknown) => {
    if (method === 'POST') return service.command(body);
    const query: any = {};
    new URL(url, 'https://local').searchParams.forEach(
      (v, k) =>
        (query[k] = ['ids', 'taskIds', 'kinds', 'listIds'].includes(k)
          ? v.split(',')
          : k === 'limit'
            ? Number(v)
            : k === 'includeTree'
              ? v === 'true'
              : k === 'filter'
                ? JSON.parse(v)
                : v),
    );
    return service.snapshot(query);
  };
  const create = (title: string, extra: Record<string, unknown> = {}) => {
    const result = service.command({
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { title, ...extra },
    });
    return result.snapshot.tasks.find((t) => t.title === title)!;
  };
  return {
    service,
    request,
    create,
    close: async () => {
      service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe('completion feedback and undo', () => {
  test('undo restores the actual previous status and preserves unsaved detail fields', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('准备读书笔记', {
        initialStatus: 'doing',
        due: { date: '2030-05-17' },
      });
      const model = createToDooWorkbench(f.request);
      await model.load();
      model.selectTask(task.id);
      const occurrenceId = model.draft()!.occurrence!.id;
      model.draft()!.task.description = '这份说明还没有保存';
      model.draft()!.occurrence!.due!.date = '2030-05-18';

      await model.setStatus(occurrenceId, 'done');

      expect(model.state.notice).toBe('已完成「准备读书笔记」');
      expect(model.state.completionFeedback).toEqual({
        title: task.title,
        taskId: task.id,
        occurrenceId,
        undoable: true,
      });
      await model.undoCompletion();

      expect(model.state.notice).toBe('已撤销「准备读书笔记」的完成');
      expect(model.state.completionFeedback).toBeNull();
      expect(f.service.snapshot({ taskIds: [task.id] }).occurrences[0]?.status).toBe('doing');
      expect(model.draft()?.occurrence?.status).toBe('doing');
      expect(model.draft()?.task.description).toBe('这份说明还没有保存');
      expect(model.draft()?.occurrence?.due?.date).toBe('2030-05-18');
      expect(model.dirty()).toBe(true);
      await model.saveTask();
      const saved = f.service.snapshot({ taskIds: [task.id] });
      expect(saved.tasks[0]?.description).toBe('这份说明还没有保存');
      expect(saved.occurrences[0]).toMatchObject({ status: 'doing', due: { date: '2030-05-18' } });
    } finally {
      await f.close();
    }
  });

  test('consecutive completions only undo the last successfully completed task', async () => {
    const f = await domainStatusFixture();
    try {
      const first = f.create('第一项'),
        second = f.create('第二项');
      const model = createToDooWorkbench(f.request);
      await model.load();
      const occurrence = (taskId: string) =>
        model.state.snapshot!.occurrences.find((row) => row.taskId === taskId)!;
      await model.setStatus(occurrence(first.id).id, 'done');
      await model.setStatus(occurrence(second.id).id, 'done');
      expect(model.state.completionFeedback?.taskId).toBe(second.id);
      await model.undoCompletion();
      const data = f.service.snapshot();
      expect(data.occurrences.find((row) => row.taskId === first.id)?.status).toBe('done');
      expect(data.occurrences.find((row) => row.taskId === second.id)?.status).toBe('todo');
      expect(await model.undoCompletion()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  test('a reloaded newer version cannot be silently reopened by an old undo', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('存在更新的任务');
      const model = createToDooWorkbench(f.request);
      await model.load();
      const occurrenceId = model.state.snapshot!.occurrences.find(
        (row) => row.taskId === task.id,
      )!.id;
      await model.setStatus(occurrenceId, 'done');
      const completed = f.service.snapshot({ taskIds: [task.id] }).occurrences[0]!;
      f.service.command({
        requestId: crypto.randomUUID(),
        action: 'set_occurrence_status',
        payload: { id: occurrenceId, expectedRevision: completed.revision, status: 'blocked' },
      });
      await model.load();
      expect(model.state.completionFeedback?.undoable).toBe(true);
      expect(await model.undoCompletion()).toBeUndefined();
      expect(model.state.error).toContain('版本');
      expect(model.state.completionFeedback).toBeNull();
      expect(f.service.snapshot({ taskIds: [task.id] }).occurrences[0]?.status).toBe('blocked');
    } finally {
      await f.close();
    }
  });

  test('a failed completion has no success feedback and another write invalidates undo', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('完成失败不能显示成功');
      let fail = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST' && fail) throw Object.assign(Error('提交被拒绝'), { status: 400 });
        return f.request(url, method, body);
      });
      await model.load();
      const occurrenceId = model.state.snapshot!.occurrences.find(
        (row) => row.taskId === task.id,
      )!.id;
      expect(await model.setStatus(occurrenceId, 'done')).toBeUndefined();
      expect(model.state.completionFeedback).toBeNull();
      expect(model.state.notice).toBe('');
      fail = false;
      await model.setStatus(occurrenceId, 'done');
      expect(model.state.completionFeedback?.undoable).toBe(true);
      await model.saveEntity('list', { name: '新的清单' });
      expect(model.state.completionFeedback).toBeNull();
      expect(await model.undoCompletion()).toBeUndefined();
      expect(f.service.snapshot({ taskIds: [task.id] }).occurrences[0]?.status).toBe('done');
    } finally {
      await f.close();
    }
  });

  test('cascade and recurring completion feedback never reopens a family or cycle', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('父任务'),
        child = f.create('子任务', { parentTaskId: parent.id }),
        recurring = f.create('重复行动', {
          recurrence: {
            id: 'completion-feedback-repeat',
            frequency: 'after_completion',
            anchorDate: new Date().toISOString().slice(0, 10),
            timeZone: 'UTC',
          },
        });
      const model = createToDooWorkbench(f.request);
      await model.load();
      const occurrence = (taskId: string) =>
        model.state.snapshot!.occurrences.find((row) => row.taskId === taskId)!;
      await model.setStatus(occurrence(parent.id).id, 'done', true);
      expect(model.state.completionFeedback).toMatchObject({ taskId: parent.id, undoable: false });
      expect(await model.undoCompletion()).toBeUndefined();
      expect(
        f.service
          .snapshot({ taskIds: [parent.id], includeTree: true })
          .occurrences.every((row) => row.status === 'done'),
      ).toBe(true);

      await model.setStatus(occurrence(recurring.id).id, 'done');
      expect(model.state.completionFeedback).toMatchObject({
        taskId: recurring.id,
        undoable: false,
      });
      expect(await model.undoCompletion()).toBeUndefined();
      const cycles = f.service.snapshot({ taskIds: [recurring.id] }).occurrences;
      expect(cycles.filter((row) => row.status === 'done')).toHaveLength(1);
      expect(cycles.filter((row) => row.status === 'todo')).toHaveLength(1);
      expect(f.service.snapshot({ taskIds: [child.id] }).occurrences[0]?.status).toBe('done');
    } finally {
      await f.close();
    }
  });

  test('changing datasets removes the temporary completion action', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('原资料库的任务');
      const model = createToDooWorkbench(f.request);
      await model.load();
      const occurrenceId = model.state.snapshot!.occurrences.find(
        (row) => row.taskId === task.id,
      )!.id;
      await model.setStatus(occurrenceId, 'done');
      model.acceptSnapshot({ ...f.service.snapshot(), datasetId: 'different-dataset' });
      expect(model.state.completionFeedback).toBeNull();
      expect(model.state.notice).toBe('');
      expect(await model.undoCompletion()).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe('To Doo workbench', () => {
  test.each(['done', 'todo'] as const)(
    'changing status to %s preserves dirty detail edits without undoing the status on save',
    async (status) => {
      const f = await domainStatusFixture();
      try {
        const task = f.create('Dirty status', { due: { date: '2026-10-30' } });
        if (status === 'todo') {
          const occurrence = f.service.snapshot({ taskIds: [task.id] }).occurrences[0]!;
          f.service.command({
            requestId: crypto.randomUUID(),
            action: 'set_occurrence_status',
            payload: { id: occurrence.id, expectedRevision: occurrence.revision, status: 'done' },
          });
        }
        const model = createToDooWorkbench(f.request);
        await model.load();
        model.selectTask(task.id);
        const occurrenceId = model.draft()!.occurrence!.id;
        model.draft()!.task.description = 'Unsaved explanation';
        model.draft()!.occurrence!.due!.date = '2026-10-31';

        await model.setStatus(occurrenceId, status);

        const remote = f.service.snapshot({ taskIds: [task.id] }).occurrences[0]!;
        expect(remote.status).toBe(status);
        expect(model.draft()?.occurrence?.status).toBe(status);
        expect(model.draft()?.occurrence?.revision).toBe(remote.revision);
        expect(model.draft()?.occurrence?.completedAt).toBe(remote.completedAt);
        expect(model.draft()?.task.description).toBe('Unsaved explanation');
        expect(model.draft()?.occurrence?.due?.date).toBe('2026-10-31');
        expect(model.dirty()).toBe(true);

        await model.saveTask();

        expect(model.state.error).toBe('');
        const saved = f.service.snapshot({ taskIds: [task.id] });
        expect(saved.tasks[0]?.description).toBe('Unsaved explanation');
        expect(saved.occurrences[0]?.due?.date).toBe('2026-10-31');
        expect(saved.occurrences[0]?.status).toBe(status);
        expect(model.dirty()).toBe(false);
      } finally {
        await f.close();
      }
    },
  );
  test('completion refreshes its dirty execution after another cycle is selected', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Dirty recurring status', {
        due: { date: '2026-10-29' },
        recurrence: {
          id: 'dirty-status-cycles',
          frequency: 'daily',
          anchorDate: '2026-10-29',
          count: 2,
          timeZone: 'UTC',
        },
      });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') await waiting;
        return f.request(url, method, body);
      });
      await model.load();
      const first = model.state.snapshot!.occurrences.find(
          (o) => o.taskId === task.id && o.scheduledDate === '2026-10-29',
        )!,
        next = model.state.snapshot!.occurrences.find(
          (o) => o.taskId === task.id && o.scheduledDate === '2026-10-30',
        )!;
      model.selectTask(task.id, first.id);
      model.draft()!.occurrence!.due!.date = '2026-11-01';
      const completing = model.setStatus(first.id, 'done');
      model.selectTask(task.id, next.id);
      model.draft()!.occurrence!.due!.date = '2026-11-02';
      const nextRevision = model.draft()!.occurrence!.revision;
      release();
      await completing;

      expect(model.state.selectedOccurrenceId).toBe(next.id);
      expect(model.draft()?.occurrence?.status).toBe('todo');
      expect(model.draft()?.occurrence?.revision).toBe(nextRevision);
      expect(model.draft()?.occurrence?.due?.date).toBe('2026-11-02');
      expect(model.dirty()).toBe(true);
      model.selectTask(task.id, first.id);
      expect(model.draft()?.occurrence?.status).toBe('done');
      expect(model.draft()?.occurrence?.due?.date).toBe('2026-11-01');
      await model.saveTask();
      expect(model.state.error).toBe('');
      const saved = f.service.snapshot({ taskIds: [task.id] });
      expect(saved.occurrences.find((o) => o.id === first.id)?.status).toBe('done');
      expect(saved.occurrences.find((o) => o.id === next.id)?.status).toBe('todo');
    } finally {
      await f.close();
    }
  });
  test('an explicit execution ID cannot pair a task with another task execution', async () => {
    const data = snapshot();
    data.tasks.push({ ...data.tasks[0]!, id: 'task-b', title: 'Another task' });
    data.occurrences.push({ ...data.occurrences[0]!, id: 'occ-b', taskId: 'task-b' });
    const model = createToDooWorkbench(transport(data).request);
    await model.load();
    model.selectTask('task-a', 'occ-b');
    expect(model.draft()?.occurrence?.id).toBe('occ-a');
    expect(model.state.selectedOccurrenceId).toBe('occ-a');
  });
  test('finishing a task save preserves a different execution selected during the request', async () => {
    const data = snapshot();
    data.occurrences.push({ ...data.occurrences[0]!, id: 'occ-next', scheduledDate: '2026-10-31' });
    const server = transport(data);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = createToDooWorkbench(async (url, method = 'GET', body) => {
      if (method === 'POST') await waiting;
      return server.request(url, method, body);
    });
    await model.load();
    model.selectTask('task-a', 'occ-a');
    model.draft()!.task.title = 'Updated title';
    const saving = model.saveTask();
    model.selectTask('task-a', 'occ-next');
    release();
    await saving;
    expect(model.state.selectedOccurrenceId).toBe('occ-next');
    expect(model.draft()?.occurrence?.id).toBe('occ-next');
  });
  test('execution edits typed during a save retain current revisions for the next save', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Draft dates', { due: { date: '2026-10-30' } });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delayed = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST' && delayed) {
          delayed = false;
          await waiting;
        }
        return f.request(url, method, body);
      });
      await model.load();
      model.selectTask(task.id);
      model.draft()!.occurrence!.due!.date = '2026-10-31';
      const saving = model.saveTask();
      model.draft()!.occurrence!.due!.date = '2026-11-01';
      release();
      await saving;
      expect(model.draft()?.occurrence?.due?.date).toBe('2026-11-01');
      expect(model.dirty()).toBe(true);
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(f.service.snapshot({ taskIds: [task.id] }).occurrences[0]?.due?.date).toBe(
        '2026-11-01',
      );
      expect(model.dirty()).toBe(false);
    } finally {
      await f.close();
    }
  });
  test('a new date-only plan outside the reply window checkpoints creation, moves and removal', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('只安排日期的任务');
      const model = createToDooWorkbench(f.request);
      await model.load();
      model.selectTask(task.id);
      const now = new Date().toISOString();
      const blockId = 'plan-' + crypto.randomUUID();
      model.draft()!.blocks.push({
        id: blockId,
        revision: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        occurrenceId: model.draft()!.occurrence!.id,
        title: '',
        start: { date: '2030-05-17', time: null, timeZone: 'UTC' },
        durationMinutes: 30,
        allDay: false,
        dateEndExclusive: null,
      });
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(model.draft()?.blocks[0]).toMatchObject({
        id: blockId,
        start: { date: '2030-05-17', time: null },
      });
      expect(model.draft()?.blocks[0]?.revision).not.toBe('');

      model.draft()!.blocks[0]!.start.date = '2030-05-18';
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
        start: { date: '2030-05-18', time: null },
      });

      model.draft()!.blocks[0]!.deletedAt = new Date().toISOString();
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(model.draft()?.blocks).toEqual([]);
      expect(f.service.getEntity('timeBlock', blockId)?.deletedAt).not.toBeNull();
      await model.load();
      expect(model.draft()?.blocks).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test('checking a newly committed date preserves later plan and text edits for the next save', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('保存中仍可继续编辑');
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delayed = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST' && delayed) {
          delayed = false;
          await waiting;
        }
        return f.request(url, method, body);
      });
      await model.load();
      model.selectTask(task.id);
      const now = new Date().toISOString();
      const blockId = 'plan-' + crypto.randomUUID();
      model.draft()!.blocks.push({
        id: blockId,
        revision: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        occurrenceId: model.draft()!.occurrence!.id,
        title: '',
        start: { date: '2030-05-17', time: null, timeZone: 'UTC' },
        durationMinutes: 30,
        allDay: false,
        dateEndExclusive: null,
      });
      const saving = model.saveTask();
      model.draft()!.blocks[0]!.start.date = '2030-05-19';
      model.draft()!.task.description = '保存期间继续补充的说明';
      release();
      await saving;
      expect(model.draft()?.blocks[0]?.start.date).toBe('2030-05-19');
      expect(model.draft()?.blocks[0]?.revision).not.toBe('');
      expect(model.dirty()).toBe(true);
      expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
        start: { date: '2030-05-17' },
      });
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
        start: { date: '2030-05-19', time: null },
      });
      expect(f.service.getEntity('task', task.id)).toMatchObject({
        description: '保存期间继续补充的说明',
      });
    } finally {
      await f.close();
    }
  });

  test.each(['reply', 'verification'] as const)(
    'a new far-date plan recovers a failed %s without creating another block',
    async (failure) => {
      const f = await domainStatusFixture();
      try {
        const task = f.create('计划提交后继续核对');
        let once = true;
        const blockWrites: any[] = [];
        const model = createToDooWorkbench(async (url, method = 'GET', body) => {
          if (
            method === 'GET' &&
            url.includes('kinds=timeBlock') &&
            failure === 'verification' &&
            once
          ) {
            once = false;
            throw Error('计划读取暂时失败');
          }
          const result = await f.request(url, method, body);
          const command = body as { action?: string; payload?: { kind?: string } } | undefined;
          if (
            method === 'POST' &&
            command?.action === 'save_entity' &&
            command.payload?.kind === 'timeBlock'
          ) {
            blockWrites.push(body);
            if (failure === 'reply' && once) {
              once = false;
              throw Error('提交成功但回复丢失');
            }
          }
          return result;
        });
        await model.load();
        model.selectTask(task.id);
        const now = new Date().toISOString();
        const blockId = 'plan-' + crypto.randomUUID();
        model.draft()!.blocks.push({
          id: blockId,
          revision: '',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          occurrenceId: model.draft()!.occurrence!.id,
          title: '',
          start: { date: '2030-05-17', time: null, timeZone: 'UTC' },
          durationMinutes: 30,
          allDay: false,
          dateEndExclusive: null,
        });
        expect(await model.saveTask()).toBeUndefined();
        expect(model.dirty()).toBe(true);
        if (failure === 'reply') {
          expect(model.state.pendingMutation?.action).toBe('save_entity');
          await model.retryPending();
          expect(blockWrites).toHaveLength(2);
          expect(blockWrites[0].requestId).toBe(blockWrites[1].requestId);
        } else {
          expect(model.state.pendingMutation).toBeNull();
          expect(model.state.error).toContain('请重试保存');
          await model.saveTask();
          expect(blockWrites).toHaveLength(1);
        }
        expect(model.state.error).toBe('');
        expect(model.dirty()).toBe(false);
        expect(f.service.snapshot({ taskIds: [task.id] }).timeBlocks).toHaveLength(1);
        expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
          start: { date: '2030-05-17', time: null },
        });
      } finally {
        await f.close();
      }
    },
  );

  test('verifying a committed plan does not accept a different remote revision as this save', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('计划核对时发生外部修改');
      const blockId = 'plan-' + crypto.randomUUID();
      let changeDuringRead = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && url.includes('kinds=timeBlock') && changeDuringRead) {
          changeDuringRead = false;
          const block = toDooEntitySchemas.timeBlock.parse(
            f.service.getEntity('timeBlock', blockId),
          );
          f.service.command({
            requestId: crypto.randomUUID(),
            action: 'save_entity',
            payload: {
              kind: 'timeBlock',
              entity: { ...block, start: { ...block.start, date: '2030-05-20' } },
              expectedRevision: block.revision,
            },
          });
        }
        return f.request(url, method, body);
      });
      await model.load();
      model.selectTask(task.id);
      const now = new Date().toISOString();
      model.draft()!.blocks.push({
        id: blockId,
        revision: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        occurrenceId: model.draft()!.occurrence!.id,
        title: '',
        start: { date: '2030-05-17', time: null, timeZone: 'UTC' },
        durationMinutes: 30,
        allDay: false,
        dateEndExclusive: null,
      });
      expect(await model.saveTask()).toBeUndefined();
      expect(model.state.conflict).toBe(true);
      expect(model.state.error).toContain('版本');
      expect(model.dirty()).toBe(true);
      expect(model.draft()?.blocks[0]?.start.date).toBe('2030-05-17');
      expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
        start: { date: '2030-05-20' },
      });
      await model.rebaseDraft();
      expect(model.state.draftConflicts).toMatchObject([{ kind: 'timeBlock', field: 'start' }]);
      model.resolveAllDraftConflicts('local');
      model.draft()!.blocks[0]!.start.date = '2030-05-21';
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(f.service.getEntity('timeBlock', blockId)).toMatchObject({
        start: { date: '2030-05-21' },
      });
    } finally {
      await f.close();
    }
  });

  test('clearing a new plan during verification retains the removal for a follow-up save', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('核对期间清除安排');
      const blockId = 'plan-' + crypto.randomUUID();
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const verifying = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let pauseRead = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && url.includes('kinds=timeBlock') && pauseRead) {
          pauseRead = false;
          reached();
          await waiting;
        }
        return f.request(url, method, body);
      });
      await model.load();
      model.selectTask(task.id);
      const now = new Date().toISOString();
      model.draft()!.blocks.push({
        id: blockId,
        revision: '',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        occurrenceId: model.draft()!.occurrence!.id,
        title: '',
        start: { date: '2030-05-17', time: null, timeZone: 'UTC' },
        durationMinutes: 30,
        allDay: false,
        dateEndExclusive: null,
      });
      const saving = model.saveTask();
      await verifying;
      model.draft()!.blocks = [];
      model.draft()!.task.description = '同时补充说明';
      release();
      await saving;
      expect(model.dirty()).toBe(true);
      expect(model.draft()?.blocks[0]?.deletedAt).not.toBeNull();
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.dirty()).toBe(false);
      expect(model.draft()?.blocks).toEqual([]);
      expect(f.service.getEntity('timeBlock', blockId)?.deletedAt).not.toBeNull();
      expect(f.service.getEntity('task', task.id)).toMatchObject({ description: '同时补充说明' });
    } finally {
      await f.close();
    }
  });

  test('retrying a partially saved detail uses the committed execution revision', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Partial dates', {
        due: { date: '2026-10-30' },
        plan: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      });
      let rejectBlock = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const command = body as { action?: string; payload?: { kind?: string } } | undefined;
        if (
          command?.action === 'save_entity' &&
          command.payload?.kind === 'timeBlock' &&
          rejectBlock
        ) {
          rejectBlock = false;
          throw Object.assign(Error('计划时间尚未保存'), { status: 400 });
        }
        return f.request(url, method, body);
      });
      await model.load();
      model.selectTask(task.id);
      model.draft()!.occurrence!.due!.date = '2026-10-31';
      model.draft()!.blocks[0]!.start.time = '10:00';
      await model.saveTask();
      expect(model.state.error).toBe('计划时间尚未保存');
      await model.saveTask();
      expect(model.state.error).toBe('');
      const remote = f.service.snapshot({ taskIds: [task.id] });
      expect(remote.occurrences[0]?.due?.date).toBe('2026-10-31');
      expect(remote.timeBlocks[0]?.start.time).toBe('10:00');
      expect(model.dirty()).toBe(false);
    } finally {
      await f.close();
    }
  });
  test.each([false, true])(
    'a time-block save refreshes its execution revision while preserving a later due edit (lost reply: %s)',
    async (loseReply) => {
      const f = await domainStatusFixture();
      try {
        const task = f.create('Block and later deadline', {
          due: { date: '2026-10-30' },
          plan: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
        });
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        let delayed = true;
        const model = createToDooWorkbench(async (url, method = 'GET', body) => {
          if (method === 'POST' && delayed) {
            delayed = false;
            await waiting;
          }
          const result = await f.request(url, method, body),
            command = body as { action?: string; payload?: { kind?: string } } | undefined;
          if (
            loseReply &&
            command?.action === 'save_entity' &&
            command.payload?.kind === 'timeBlock'
          ) {
            loseReply = false;
            throw Error('计划已提交但回复丢失');
          }
          return result;
        });
        await model.load();
        model.selectTask(task.id);
        model.draft()!.blocks[0]!.start.time = '10:00';
        const saving = model.saveTask();
        model.draft()!.occurrence!.due!.date = '2026-10-31';
        release();
        await saving;
        if (model.state.pendingMutation) await model.retryPending();
        expect(model.draft()?.occurrence?.due?.date).toBe('2026-10-31');
        await model.saveTask();
        expect(model.state.error).toBe('');
        const remote = f.service.snapshot({ taskIds: [task.id] });
        expect(remote.occurrences[0]?.due?.date).toBe('2026-10-31');
        expect(remote.timeBlocks[0]?.start.time).toBe('10:00');
        expect(model.dirty()).toBe(false);
      } finally {
        await f.close();
      }
    },
  );
  test('saving an execution edit before its new recurrence protects the edited cycle from replacement', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Repeat with edited deadline', {
        recurrence: {
          id: 'rule-original',
          frequency: 'daily',
          anchorDate: '2026-10-30',
          count: 2,
          timeZone: 'UTC',
        },
      });
      const model = createToDooWorkbench(f.request);
      await model.load();
      model.selectTask(task.id);
      const originalId = model.draft()!.occurrence!.id;
      model.draft()!.task.recurrence!.interval = 2;
      model.draft()!.occurrence!.due!.date = '2026-11-01';
      await model.saveTask();
      expect(model.state.error).toBe('');
      const remote = f.service.snapshot({ taskIds: [task.id] });
      expect(remote.occurrences.filter((o) => !o.deletedAt)).toHaveLength(2);
      expect(remote.occurrences.find((o) => o.id === originalId)).toMatchObject({
        deletedAt: null,
        due: { date: '2026-11-01' },
        manuallyEdited: true,
      });
      expect(
        remote.occurrences.filter((o) => !o.deletedAt && o.scheduledDate === '2026-10-30'),
      ).toHaveLength(1);
      expect(model.dirty()).toBe(false);
    } finally {
      await f.close();
    }
  });
  test('reconciling a lost execution-save reply makes the remaining detail safely saveable', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Uncertain dates', {
        due: { date: '2026-10-30' },
        plan: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      });
      let loseReply = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const result = await f.request(url, method, body),
          command = body as { action?: string; payload?: { kind?: string } } | undefined;
        if (
          command?.action === 'save_entity' &&
          command.payload?.kind === 'occurrence' &&
          loseReply
        ) {
          loseReply = false;
          throw Error('执行内容已提交但回复丢失');
        }
        return result;
      });
      await model.load();
      model.selectTask(task.id);
      model.draft()!.occurrence!.due!.date = '2026-10-31';
      model.draft()!.blocks[0]!.start.time = '10:00';
      await model.saveTask();
      expect(model.state.pendingMutation?.action).toBe('save_entity');
      await model.retryPending();
      expect(model.state.pendingMutation).toBeNull();
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(f.service.snapshot({ taskIds: [task.id] }).timeBlocks[0]?.start.time).toBe('10:00');
      expect(model.dirty()).toBe(false);
    } finally {
      await f.close();
    }
  });
  test('overdue filtering follows the displayed local date of a timed deadline', () => {
    const data = snapshot();
    data.settings.timeZone = 'America/Los_Angeles';
    data.occurrences[0]!.due = { date: '2026-10-30', time: '01:00', timeZone: 'UTC' };
    expect(deriveToDooItems(data, { dueBefore: '2026-10-29' })).toHaveLength(1);
  });
  test('saving cleared optional recurrence fields leaves a clean normalized draft', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Repeat without an end', {
        recurrence: { id: 'no-end', frequency: 'daily', anchorDate: '2026-10-30', timeZone: 'UTC' },
      });
      const model = createToDooWorkbench(f.request);
      await model.load();
      model.selectTask(task.id);
      model.draft()!.task.recurrence!.until = '';
      await model.saveTask();
      expect(model.state.error).toBe('');
      expect(model.draft()?.task.recurrence?.until).toBeNull();
      expect(model.dirty()).toBe(false);
    } finally {
      await f.close();
    }
  });
  test('an old pending-operation response cannot enter a different dataset', async () => {
    let current = snapshot(),
      finish!: (value: ToDooSnapshot) => void;
    const model = createToDooWorkbench(async (url) =>
      url.includes('kind=operation')
        ? new Promise<ToDooSnapshot>((resolve) => {
            finish = resolve;
          })
        : structuredClone(current),
    );
    await model.load();
    const loading = model.loadPendingOperations();
    current = { ...snapshot(), datasetId: 'other-dataset' };
    await model.load();
    const old = snapshot();
    old.operations.push(
      toDooEntitySchemas.operation.parse({
        ...stamp,
        id: 'private-operation',
        kind: 'outcome_note',
        occurrenceId: 'occ-a',
        requestId: 'private-request',
        fingerprint: 'private-fingerprint',
        expectedRevision: 'r1',
        title: 'Private title',
        folderPath: '00-Inbox',
        fileName: 'private.md',
        content: 'Private content',
        state: 'prepared',
      }),
    );
    finish(old);
    await loading;
    expect(model.state.snapshot?.datasetId).toBe('other-dataset');
    expect(model.state.pendingOperations).toEqual([]);
    expect(model.state.operationPage).toBeNull();
  });
  test('a stale detail failure cannot replace the current dataset error state', async () => {
    let current = snapshot(),
      fail!: (reason: Error) => void;
    const model = createToDooWorkbench(async (url) =>
      url.includes('taskIds=')
        ? new Promise<ToDooSnapshot>((_resolve, reject) => {
            fail = reject;
          })
        : structuredClone(current),
    );
    await model.load();
    const loading = model.ensureTask('task-a');
    current = { ...snapshot(), datasetId: 'other-dataset' };
    await model.load();
    fail(Error('旧资料库已无法连接'));
    await loading;
    expect(model.state.error).toBe('');
  });
  test('a second client finishing today cannot redirect a frozen current batch onto tomorrow', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Repeat', {
          recurrence: {
            id: 'repeat-cas',
            frequency: 'daily',
            anchorDate: '2026-10-29',
            count: 2,
            timeZone: 'UTC',
          },
        }),
        before = f.service.snapshot({ taskIds: [task.id] }),
        today = before.occurrences.find((o) => o.scheduledDate === '2026-10-29')!,
        tomorrow = before.occurrences.find((o) => o.scheduledDate === '2026-10-30')!;
      const other = createToDooWorkbench(f.request);
      await other.load();
      let submitted: any;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') {
          submitted = body;
          await other.setStatus(today.id, 'done');
        }
        return f.request(url, method, body);
      });
      await model.load();
      const outerPages = JSON.stringify(model.state.snapshot?.collectionPages);
      model.state.selectedIds = [task.id];
      await model.batch('complete');
      expect(submitted.payload.occurrenceIds).toContain(today.id);
      expect(submitted.payload.occurrenceIds).not.toContain(tomorrow.id);
      expect(submitted.payload.expectedRevisions[today.id]).toBe(today.revision);
      expect(model.state.error).toMatch(/版本|变化|冲突/);
      expect(JSON.stringify(model.state.snapshot?.collectionPages)).toBe(outerPages);
      const after = f.service.snapshot({ taskIds: [task.id] });
      expect(after.occurrences.find((o) => o.id === today.id)?.status).toBe('done');
      expect(after.occurrences.find((o) => o.id === tomorrow.id)?.status).toBe('todo');
    } finally {
      await f.close();
    }
  });
  test('a cascading parent completion guards a child changed by another client before submission', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Parent'),
        child = f.create('Child', { parentTaskId: parent.id }),
        before = f.service.snapshot({ taskIds: [parent.id], includeTree: true }),
        root = before.occurrences.find((o) => o.taskId === parent.id)!,
        leaf = before.occurrences.find((o) => o.taskId === child.id)!;
      let submitted: any;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') {
          submitted = body;
          f.service.command({
            requestId: crypto.randomUUID(),
            action: 'set_occurrence_status',
            payload: { id: leaf.id, expectedRevision: leaf.revision, status: 'doing' },
          });
        }
        return f.request(url, method, body);
      });
      await model.load();
      await model.setStatus(root.id, 'done', true);
      expect(submitted.payload.expectedOccurrenceIds).toContain(leaf.id);
      expect(submitted.payload.expectedRevisions[leaf.id]).toBe(leaf.revision);
      expect(model.state.error).toMatch(/版本|变化|冲突/);
      const after = f.service.snapshot({ taskIds: [parent.id], includeTree: true });
      expect(after.occurrences.find((o) => o.id === root.id)?.status).toBe('todo');
      expect(after.occurrences.find((o) => o.id === leaf.id)?.status).toBe('doing');
    } finally {
      await f.close();
    }
  });
  test.each(['added', 'deleted', 'moved'] as const)('a child %s while the descendant confirmation is open invalidates the frozen scope', async (change) => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Confirmed parent'), child = f.create('Confirmed child', { parentTaskId: parent.id });
      const before = f.service.snapshot({ taskIds: [parent.id], includeTree: true });
      const root = before.occurrences.find(o => o.taskId === parent.id)!;
      const bodies: any[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') bodies.push(JSON.parse(JSON.stringify(body)));
        return f.request(url, method, body);
      });
      await model.load();
      expect(await model.statusChildCount(parent.id)).toBe(1);
      let extraId: string | undefined;
      if (change === 'added') extraId = f.create('New unconfirmed child', { parentTaskId: parent.id }).id;
      else f.service.command({ requestId: crypto.randomUUID(),
        ...(change === 'deleted'
          ? { action: 'delete_entity', payload: { kind: 'task', id: child.id, expectedRevision: child.revision, cascade: true } }
          : { action: 'batch_tasks', payload: { ids: [child.id], expectedRevisions: { [child.id]: child.revision }, operation: 'move', parentTaskId: null, listId: null, includeDescendants: true } }),
      });
      await model.setStatus(root.id, 'done', true);
      expect(model.state.error).toMatch(/版本|变化|冲突/);
      expect(bodies).toHaveLength(1);
      expect([...bodies[0].payload.expectedOccurrenceIds].sort()).toEqual(before.occurrences.map(o => o.id).sort());
      const after = f.service.snapshot({ filter: { includeDeleted: true }, limit: 500 });
      expect(after.occurrences.find(o => o.id === root.id)?.status).toBe('todo');
      if (extraId) expect(after.occurrences.find(o => o.taskId === extraId)?.status).toBe('todo');
    } finally { await f.close(); }
  });

  test('a child edited while the descendant confirmation is open keeps its frozen expected revision', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Parent confirmation'), child = f.create('Child confirmation', { parentTaskId: parent.id });
      const before = f.service.snapshot({ taskIds: [parent.id], includeTree: true });
      const root = before.occurrences.find(o => o.taskId === parent.id)!, leaf = before.occurrences.find(o => o.taskId === child.id)!;
      const model = createToDooWorkbench(f.request);
      await model.load();
      expect(await model.statusChildCount(parent.id)).toBe(1);
      f.service.command({ requestId: crypto.randomUUID(), action: 'set_occurrence_status',
        payload: { id: leaf.id, expectedRevision: leaf.revision, status: 'doing' } });
      await model.setStatus(root.id, 'done', true);
      expect(model.state.error).toMatch(/版本|变化|冲突/);
      const after = f.service.snapshot({ taskIds: [parent.id], includeTree: true });
      expect(after.occurrences.find(o => o.id === root.id)?.status).toBe('todo');
      expect(after.occurrences.find(o => o.id === leaf.id)?.status).toBe('doing');
    } finally { await f.close(); }
  });

  test('a repeated count refreshes a cancelled confirmation baseline before the next cascade', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Reconfirmed parent'); f.create('Original child', { parentTaskId: parent.id });
      const model = createToDooWorkbench(f.request);
      await model.load();
      const root = model.state.snapshot!.occurrences.find(o => o.taskId === parent.id)!;
      expect(await model.statusChildCount(parent.id)).toBe(1);
      f.create('Confirmed new child', { parentTaskId: parent.id });
      expect(await model.statusChildCount(parent.id)).toBe(2);
      expect(await model.setStatus(root.id, 'done', true)).toBeTruthy();
      expect(model.state.error).toBe('');
      expect(f.service.snapshot({ taskIds: [parent.id], includeTree: true }).occurrences.every(o => o.status === 'done')).toBe(true);
    } finally { await f.close(); }
  });

  test('a non-cascading status consumes its count baseline and a later direct cascade reads fresh scope', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('One-shot confirmation'); f.create('Original child', { parentTaskId: parent.id });
      const model = createToDooWorkbench(f.request);
      await model.load();
      const root = model.state.snapshot!.occurrences.find(o => o.taskId === parent.id)!;
      await model.statusChildCount(parent.id);
      expect(await model.setStatus(root.id, 'doing', false)).toBeTruthy();
      f.create('Direct API child', { parentTaskId: parent.id });
      expect(await model.setStatus(root.id, 'done', true)).toBeTruthy();
      expect(model.state.error).toBe('');
      expect(f.service.snapshot({ taskIds: [parent.id], includeTree: true }).occurrences.every(o => o.status === 'done')).toBe(true);
    } finally { await f.close(); }
  });

  test('a changed dataset cannot consume an old descendant confirmation or adopt its late graph read', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Dataset confirmation'); f.create('Child', { parentTaskId: parent.id });
      const bodies: any[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') bodies.push(body);
        return f.request(url, method, body);
      });
      await model.load();
      const root = model.state.snapshot!.occurrences.find(o => o.taskId === parent.id)!;
      await model.statusChildCount(parent.id);
      model.acceptSnapshot({ ...f.service.snapshot(), datasetId: 'different-confirmation-dataset' });
      await model.setStatus(root.id, 'done', true);
      expect(bodies).toEqual([]);
      expect(model.state.snapshot?.datasetId).toBe('different-confirmation-dataset');
      expect(model.state.error).toMatch(/资料库|范围已变化/);
      expect(f.service.snapshot({ taskIds: [parent.id] }).occurrences.find(o => o.id === root.id)?.status).toBe('todo');
    } finally { await f.close(); }
  });

  test('an unknown cascade retries its original frozen request even after a newer count', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Receipt confirmation'); f.create('Original child', { parentTaskId: parent.id });
      const bodies: any[] = []; let lost = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          bodies.push(JSON.parse(JSON.stringify(body)));
          if (lost) { lost = false; throw Error('confirmed cascade reply lost'); }
        }
        return result;
      });
      await model.load();
      const root = model.state.snapshot!.occurrences.find(o => o.taskId === parent.id)!;
      await model.statusChildCount(parent.id);
      await model.setStatus(root.id, 'done', true);
      expect(model.state.pendingMutation).not.toBeNull();
      const added = f.create('Added after commit', { parentTaskId: parent.id });
      await model.statusChildCount(parent.id);
      await model.setStatus(root.id, 'done', true);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(model.state.pendingMutation).toBeNull();
      expect(f.service.snapshot({ taskIds: [added.id] }).occurrences.find(o => o.taskId === added.id)?.status).toBe('todo');
    } finally { await f.close(); }
  });

  test('a normal subtree batch completes leaves then parents with one frozen version closure', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Batch parent');
      f.create('Batch child', { parentTaskId: parent.id, archivedAt: '2026-10-29T08:00:00.000Z' });
      const model = createToDooWorkbench(f.request);
      await model.load();
      model.state.selectedIds = [parent.id];
      const result = await model.batch('complete');
      expect(model.state.error).toBe('');
      expect(result).toBeTruthy();
      expect(
        f.service
          .snapshot({ taskIds: [parent.id], includeTree: true })
          .occurrences.every((o) => o.status === 'done'),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  test('an uncertain cascading completion retries the identical frozen body and selection', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Retry parent');
      f.create('Retry child', { parentTaskId: parent.id });
      let lost = true;
      const bodies: any[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          bodies.push(JSON.parse(JSON.stringify(body)));
          if (lost) {
            lost = false;
            throw Error('response lost after commit');
          }
        }
        return result;
      });
      await model.load();
      const root = model.state.snapshot!.occurrences.find((o) => o.taskId === parent.id)!;
      await model.setStatus(root.id, 'done', true);
      await model.setStatus(root.id, 'done', true);
      expect(model.state.error).toBe('');
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(model.state.pendingMutation).toBeNull();
      expect(
        f.service
          .snapshot({ taskIds: [parent.id], includeTree: true })
          .occurrences.every((o) => o.status === 'done'),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  test('recovery drafts stay in their own dataset when a workspace changes libraries', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      let current = snapshot();
      const model = createToDooWorkbench(async () => structuredClone(current));
      await model.load();
      model.newTaskDraft().title = 'Private draft';
      model.selectTask('task-a');
      model.draft()!.task.title = 'Private edit';
      await (await import('vue')).nextTick();
      current = { ...snapshot(), datasetId: 'second-library' };
      await model.load();
      expect(model.newTaskDraft().title).toBe('');
      expect(model.state.selectedTaskId).toBe('');
      expect(Object.keys(model.state.drafts)).toHaveLength(0);
      current = snapshot();
      await model.load();
      expect(model.newTaskDraft().title).toBe('Private draft');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test('real domain cursors reach over 500 executions and 200 habits through the workbench transport', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises'),
      { tmpdir } = await import('node:os'),
      { join } = await import('node:path');
    const { openDatabase } = await import('../packages/core/db'),
      { noteService } = await import('../packages/core/notes'),
      { createToDooService } = await import('../packages/core/to-doo/service');
    const root = await mkdtemp(join(tmpdir(), 'to-doo-workbench-'));
    const config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'http://localhost:3010',
      secret: 'fixture-secret',
    };
    await mkdir(config.knowledgeRoot, { recursive: true });
    const db = openDatabase(config.dataRoot),
      service = createToDooService(config, db, noteService(config, db));
    try {
      const created = service.command({
          requestId: 'page-task',
          action: 'create_task',
          payload: { title: 'Paged execution' },
        }),
        task = created.snapshot.tasks[0]!;
      service.command({
        requestId: 'page-entities',
        action: 'import_entities',
        payload: {
          entities: [
            ...Array.from({ length: 550 }, (_, i) => ({
              kind: 'occurrence' as const,
              entity: {
                id: 'paged-execution-' + i,
                taskId: task.id,
                cycleKey: 'cycle-' + i,
                scheduleRevision: task.revision,
                scheduledDate: '2026-10-29',
              },
            })),
            ...Array.from({ length: 205 }, (_, i) => ({
              kind: 'habit' as const,
              entity: { id: 'paged-habit-' + i, name: 'Habit ' + i, startDate: '2026-10-01' },
            })),
          ],
        },
      });
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') return service.command(body);
        const query: any = {};
        new URL(url, 'https://local').searchParams.forEach(
          (v, k) =>
            (query[k] = ['ids', 'taskIds', 'kinds', 'listIds'].includes(k)
              ? v.split(',')
              : k === 'limit'
                ? Number(v)
                : k === 'includeTree'
                  ? v === 'true'
                  : k === 'filter'
                    ? JSON.parse(v)
                    : v),
        );
        return service.snapshot(query);
      });
      await model.load({ view: 'calendar', from: '2026-10-01', to: '2026-11-30', limit: 200 });
      expect(model.state.snapshot?.occurrences).toHaveLength(500);
      await model.nextCollectionPage('occurrence');
      expect(model.state.snapshot?.occurrences).toHaveLength(551);
      expect(model.state.error).toBe('');
      await model.nextCollectionPage('habit');
      expect(model.state.snapshot?.habits).toHaveLength(205);
      expect(model.state.error).toBe('');
      await model.ensureTask(task.id);
      expect(model.state.detailCollectionPages[task.id]?.occurrence?.nextCursor).toBeTruthy();
      await model.nextTaskCollectionPage(task.id, 'occurrence');
      expect(model.state.detailCollectionPages[task.id]?.occurrence?.nextCursor).toBeNull();
      expect(model.state.error).toBe('');
      model.state.selectedIds = [task.id];
      expect(await model.batch('complete', { scope: 'all_materialized' })).toBeTruthy();
      expect(model.state.error).toBe('');
      expect(
        service
          .snapshot({ taskIds: [task.id], kind: 'occurrence', limit: 500 })
          .occurrences.every((o) => o.status === 'done'),
      ).toBe(true);
      expect(
        service
          .exportCheckpoint()
          .entities.filter(
            (e) =>
              e.kind === 'occurrence' &&
              'taskId' in e.entity &&
              e.entity.taskId === task.id &&
              'status' in e.entity &&
              e.entity.status === 'done',
          ),
      ).toHaveLength(551);
    } finally {
      service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('each collection and task detail continues its own cursor without replacing another view page', async () => {
    const urls: string[] = [];
    const model = createToDooWorkbench(async (url) => {
      urls.push(url);
      const data = snapshot(),
        q = new URL(url, 'https://local').searchParams;
      const meta = {
        ...data.page,
        kind: 'occurrence' as const,
        limit: 500,
        total: 550,
        nextCursor: q.get('kind') ? 'occ-end' : 'occ-next',
      };
      data.page.nextCursor = 'outer-task-next';
      data.collectionPages = {
        occurrence: meta,
        habit: { ...meta, kind: 'habit', limit: 200, nextCursor: 'habit-next' },
      };
      if (q.get('kind') === 'occurrence')
        data.occurrences = [{ ...data.occurrences[0]!, id: 'occ-later', status: 'done' }];
      return data;
    });
    await model.load({ view: 'calendar', from: '2026-10-01', to: '2026-11-30', limit: 200 });
    await model.nextCollectionPage('occurrence');
    expect(new URL(urls.at(-1)!, 'https://local').searchParams.get('cursor')).toBe('occ-next');
    expect(new URL(urls.at(-1)!, 'https://local').searchParams.get('limit')).toBe('500');
    expect(model.state.snapshot?.occurrences.some((o) => o.id === 'occ-later')).toBe(true);
    expect(model.state.snapshot?.page.nextCursor).toBe('outer-task-next');
    expect(model.state.snapshot?.collectionPages?.habit?.nextCursor).toBe('habit-next');
    await model.ensureTask('task-a');
    await model.nextTaskCollectionPage('task-a', 'occurrence');
    const detail = new URL(urls.at(-1)!, 'https://local').searchParams;
    expect(detail.get('taskIds')).toBe('task-a');
    expect(detail.get('kind')).toBe('occurrence');
    expect(detail.get('cursor')).toBe('occ-next');
    expect(model.state.snapshot?.page.nextCursor).toBe('outer-task-next');
  });
  test('a missing execution is visibly unavailable instead of invented as a pending action', () => {
    const data = snapshot();
    data.occurrences = [];
    expect(deriveToDooItems(data)[0]?.status).toBe('unavailable');
    expect(deriveToDooItems(data, { statuses: ['todo'] })).toHaveLength(0);
  });
  test('editing dependency choices preserves existing lag and moving a block proposes the same block', () => {
    expect(toDooDependencies([{ taskId: 'a', lagMinutes: 45 }], ['a', 'b'])).toEqual([
      { taskId: 'a', lagMinutes: 45 },
      { taskId: 'b', lagMinutes: 0 },
    ]);
    const block = toDooEntitySchemas.timeBlock.parse({
      ...stamp,
      id: 'block-a',
      occurrenceId: 'occ-a',
      start: { date: '2026-10-29', time: '09:00', timeZone: 'UTC' },
      durationMinutes: 30,
    });
    expect(
      toDooMoveBlock(block, snapshot().occurrences[0]!, { ...block.start, date: '2026-10-30' }),
    ).toMatchObject({
      blockId: 'block-a',
      expectedBlockRevision: 'r1',
      occurrenceId: 'occ-a',
      expectedRevision: 'r1',
      start: { date: '2026-10-30' },
    });
    expect(
      toDooMoveBlock(
        { ...block, allDay: true, dateEndExclusive: '2026-10-31' },
        snapshot().occurrences[0]!,
        { ...block.start, date: '2026-11-01' },
      ).dateEndExclusive,
    ).toBe('2026-11-03');
  });
  test('a new browser workbench can discover a portable unfinished outcome and keep its original intent', async () => {
    const operation = toDooEntitySchemas.operation.parse({
      ...stamp,
      id: 'operation-a',
      kind: 'outcome_note',
      requestId: 'original-request',
      fingerprint: 'original-fingerprint',
      occurrenceId: 'occ-a',
      expectedRevision: 'old-r',
      title: 'Evidence',
      folderPath: '00-Inbox',
      fileName: 'Evidence.md',
      content: '# Keep original evidence',
      noteId: 'note-saved',
      state: 'note_saved',
    });
    const data = snapshot();
    data.operations = [operation, { ...operation, id: 'completed-operation', state: 'completed' }];
    data.page = { ...data.page, kind: 'operation', total: 2, nextCursor: 'op-next' };
    const model = createToDooWorkbench(async () => structuredClone(data));
    await model.loadPendingOperations();
    expect(model.state.pendingOperations.map((o) => o.id)).toEqual(['operation-a']);
    expect(model.state.operationPage?.nextCursor).toBe('op-next');
    expect(toDooOutcomeResumeInput(model.state.pendingOperations[0]!, 'verified-r2')).toMatchObject(
      {
        requestId: 'original-request',
        operationId: 'operation-a',
        expectedRevision: 'verified-r2',
        title: 'Evidence',
        content: '# Keep original evidence',
      },
    );
  });
  test('a lost create reply retries the same request instead of creating a second task', async () => {
    const data = snapshot();
    data.tasks = [];
    data.occurrences = [];
    const server = transport(data),
      receipts = new Map<string, any>();
    let lost = true;
    const model = createToDooWorkbench(async (url, method = 'GET', body) => {
      if (method === 'GET') return server.request(url, method, body);
      const id = (body as any).requestId;
      if (receipts.has(id)) return receipts.get(id);
      const result = await server.request(url, method, body);
      receipts.set(id, result);
      if (lost) {
        lost = false;
        throw Error('response lost');
      }
      return result;
    });
    await model.load();
    await model.createTask({ title: 'Only once' });
    await model.createTask({ title: 'Only once' });
    expect(server.data.tasks).toHaveLength(1);
    expect(model.state.selectedTaskId).toBe('task-b');
  });
  test('a different mutation is held until an uncertain original request is reconciled', async () => {
    const server = transport(),
      model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET') return server.request(url, method, body);
        await server.request(url, method, body);
        throw Error('response lost');
      });
    await model.load();
    await model.createTask({ title: 'First' });
    await model.createTask({ title: 'Changed' });
    expect(server.data.tasks.filter((t) => t.id !== 'task-a')).toHaveLength(1);
    expect(model.state.error).toContain('原操作');
  });
  test('a new task form remains owned by the workbench when its detail panel closes', async () => {
    const model = createToDooWorkbench(transport().request);
    await model.load();
    model.newTaskDraft().title = 'Keep new input';
    model.newTaskDraft().description = 'Do not drop this when closing';
    model.selectTask('task-a');
    model.selectTask('');
    expect(model.newTaskDraft().title).toBe('Keep new input');
    expect(model.newTaskDraft().description).toBe('Do not drop this when closing');
    expect(model.hasUnsavedChanges()).toBe(true);
  });
  test('explicit conflict reconciliation carries remote untouched fields while preserving local edits', async () => {
    const server = transport(),
      model = createToDooWorkbench(server.request);
    await model.load();
    model.selectTask('task-a');
    model.draft()!.task.title = 'My architecture';
    server.data.tasks[0]!.revision = 'remote-r';
    server.data.tasks[0]!.description = 'Remote notes';
    await model.saveTask();
    expect(model.state.error).toContain('版本');
    await model.rebaseDraft();
    expect(model.draft()?.task.title).toBe('My architecture');
    expect(model.draft()?.task.description).toBe('Remote notes');
    await model.saveTask();
    expect(server.data.tasks[0]?.title).toBe('My architecture');
    expect(server.data.tasks[0]?.description).toBe('Remote notes');
    expect(model.dirty()).toBe(false);
  });
  test('reading a task detail preserves the outer list cursor for subsequent page loading', async () => {
    const model = createToDooWorkbench(async (url) => {
      const data = snapshot();
      data.page.nextCursor = url.includes('taskIds=') ? 'detail-next' : 'list-next';
      return data;
    });
    await model.load();
    await model.ensureTask('task-a');
    expect(model.state.snapshot?.page.nextCursor).toBe('list-next');
  });
  test('quick entry proposes clear Chinese dates and known tags while preserving ambiguous text', () => {
    expect(
      parseToDooQuickEntry('明天 下午3点 写方案 #设计', '2026-10-29', [
        { id: 'tag-design', name: '设计' },
      ]),
    ).toMatchObject({
      title: '写方案',
      date: '2026-10-30',
      time: '15:00',
      tagIds: ['tag-design'],
      recognized: true,
    });
    expect(parseToDooQuickEntry('找资料 3点', '2026-10-29')).toMatchObject({
      title: '找资料 3点',
      time: null,
      recognized: false,
    });
    expect(parseToDooQuickEntry('每周一 09:00 回顾', '2026-10-29')).toMatchObject({
      title: '回顾',
      frequency: 'weekly',
      weekdays: [1],
      time: '09:00',
    });
  });
  test('clearing filter pickers omits empty selection arrays instead of requesting no matching tasks', async () => {
    const model = createToDooWorkbench(async (url) => {
      const query = JSON.parse(new URL(url, 'https://local').searchParams.get('filter') || '{}');
      const data = snapshot();
      if (Object.values(query).some((v) => Array.isArray(v) && !v.length)) data.tasks = [];
      return data;
    });
    await model.load({ filter: { listIds: [], tagIds: [], statuses: [], priorities: [] } });
    expect(model.state.snapshot?.tasks.map((t) => t.title)).toEqual(['Architecture']);
  });
  test('nested OR and AND groups do not reintroduce rows excluded by a saved filter', () => {
    const data = snapshot();
    const filter = {
      group: {
        operator: 'or' as const,
        conditions: [
          { field: 'status' as const, operator: 'is' as const, value: 'done' },
          {
            operator: 'and' as const,
            conditions: [
              { field: 'tagId' as const, operator: 'is' as const, value: 'tag-a' },
              { field: 'query' as const, operator: 'contains' as const, value: 'Arch' },
            ],
          },
        ],
      },
    };
    expect(deriveToDooItems(data, filter)).toHaveLength(0);
    data.tasks[0]!.tagIds = ['tag-a'];
    expect(deriveToDooItems(data, filter).map((i) => i.title)).toEqual(['Architecture']);
  });
  test('display zones convert timed records across midnight while keeping all-day dates stable', () => {
    expect(
      toDooDisplayTime({ date: '2026-10-29', time: '00:30', timeZone: 'Asia/Shanghai' }, 'UTC'),
    ).toEqual({ date: '2026-10-28', time: '16:30', timeZone: 'UTC' });
    expect(
      toDooDisplayTime(
        { date: '2026-10-29', time: null, timeZone: 'Asia/Shanghai' },
        'America/New_York',
      ).date,
    ).toBe('2026-10-29');
    expect(
      toDooDisplayTime({ date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' }, 'UTC'),
    ).toEqual({ date: '2026-03-08', time: '07:00', timeZone: 'UTC' });
  });
  test('a subtree batch includes descendant revisions before submitting an atomic completion', async () => {
    const data = snapshot();
    data.tasks.push({ ...data.tasks[0]!, id: 'task-child', parentTaskId: 'task-a' });
    data.occurrences.push({ ...data.occurrences[0]!, id: 'occ-child', taskId: 'task-child' });
    const server = transport(data),
      model = createToDooWorkbench(server.request);
    await model.load();
    model.state.selectedIds = ['task-a'];
    await model.batch('complete');
    expect(model.state.error).toBe('');
    expect(model.state.snapshot?.occurrences.map((o) => o.status)).toEqual(['done', 'done']);
  });
  test('a task menu operation reads descendant revisions without changing the active multi-selection', async () => {
    const data = snapshot();
    data.tasks.push({
      ...data.tasks[0]!,
      id: 'task-child',
      revision: 'child-r2',
      parentTaskId: 'task-a',
    });
    const commands: any[] = [];
    const model = createToDooWorkbench(async (_url, method = 'GET', body) => {
      if (method !== 'GET') commands.push(toDooCommandSchema.parse(body));
      return method === 'GET'
        ? data
        : { snapshot: data, ids: ['copy'], changed: [], requestId: 'menu' };
    });
    model.acceptSnapshot(data);
    model.state.selectedIds = ['someone-else'];
    await model.batchTasks(['task-a'], 'copy');
    expect(model.state.selectedIds).toEqual(['someone-else']);
    expect(commands).toMatchObject([
      {
        action: 'batch_tasks',
        payload: {
          ids: ['task-a'],
          operation: 'copy',
          includeDescendants: true,
          expectedRevisions: { 'task-a': 'r1', 'task-child': 'child-r2' },
        },
      },
    ]);
  });
  test('yearly anniversaries honor leap-day policy without rolling into a different month', () => {
    const anniversary = toDooEntitySchemas.anniversary.parse({
      ...stamp,
      name: 'Leap birthday',
      date: '2024-02-29',
      leapPolicy: 'previous_day',
    });
    expect(nextToDooAnniversary(anniversary, '2026-02-01')).toBe('2026-02-28');
    expect(nextToDooAnniversary({ ...anniversary, leapPolicy: 'next_day' }, '2026-02-01')).toBe(
      '2026-03-01',
    );
    expect(nextToDooAnniversary({ ...anniversary, leapPolicy: 'skip' }, '2026-02-01')).toBe(
      '2028-02-29',
    );
  });
  test('an empty library stays empty and creation adopts the server result', async () => {
    const blank = snapshot();
    blank.tasks = [];
    blank.occurrences = [];
    const server = transport(blank),
      model = createToDooWorkbench(server.request);
    await model.load();
    expect(model.state.snapshot?.tasks).toHaveLength(0);
    await model.createTask({ title: 'First action' });
    expect(model.state.snapshot?.tasks[0]?.title).toBe('First action');
    expect(model.state.selectedTaskId).toBe('task-b');
  });
  test('completion changes the occurrence while preserving the task definition', async () => {
    const server = transport(),
      model = createToDooWorkbench(server.request);
    await model.load();
    await model.setStatus('occ-a', 'done');
    expect(model.state.snapshot?.occurrences[0]?.status).toBe('done');
    expect(model.state.snapshot?.tasks[0]?.title).toBe('Architecture');
  });
  test('switching selection and refreshing preserve unsaved task text', async () => {
    const server = transport(),
      model = createToDooWorkbench(server.request);
    await model.load();
    model.selectTask('task-a');
    model.draft()!.task.title = 'Keep this draft';
    model.selectTask('');
    await model.load();
    model.selectTask('task-a');
    expect(model.draft()?.task.title).toBe('Keep this draft');
    expect(model.hasUnsavedChanges()).toBe(true);
  });
  test('saving persists metadata with its revision and clears only the saved draft', async () => {
    const server = transport(),
      model = createToDooWorkbench(server.request);
    await model.load();
    model.selectTask('task-a');
    model.draft()!.task.title = 'Architecture diagram';
    await model.saveTask();
    expect(server.data.tasks[0]?.title).toBe('Architecture diagram');
    expect(model.dirty()).toBe(false);
  });
  test('a failed save retains text and never announces success', async () => {
    const server = transport(),
      model = createToDooWorkbench(server.request);
    await model.load();
    model.selectTask('task-a');
    model.draft()!.task.title = 'Unsent';
    server.fail('网络暂不可用');
    await model.saveTask();
    expect(model.draft()?.task.title).toBe('Unsent');
    expect(model.state.error).toContain('网络');
    expect(model.state.notice).toBe('');
    expect(model.dirty()).toBe(true);
  });
  test('a stale load cannot overwrite a newer command result', async () => {
    let finish!: (v: ToDooSnapshot) => void;
    const server = transport();
    let reads = 0;
    const model = createToDooWorkbench((url, method = 'GET', body) =>
      method === 'GET' && ++reads === 2
        ? new Promise((r) => {
            finish = r;
          })
        : server.request(url, method, body),
    );
    await model.load();
    const old = model.load();
    await model.setStatus('occ-a', 'done');
    finish(snapshot());
    await old;
    expect(model.state.snapshot?.occurrences[0]?.status).toBe('done');
  });
  test('view queries remain bounded and only explicitly load the next page', async () => {
    let calls = 0;
    const initial = snapshot();
    initial.page.nextCursor = 'cursor-next';
    const model = createToDooWorkbench(async () => {
      calls++;
      return initial;
    });
    await model.load({ view: 'calendar', from: '2026-10-26', to: '2026-11-01', limit: 80 });
    expect(calls).toBe(1);
    expect(model.state.snapshot?.page.nextCursor).toBe('cursor-next');
  });
  test('dates and status are derived from execution and plan records, not copied onto tasks', () => {
    const data = snapshot();
    data.timeBlocks.push(
      toDooEntitySchemas.timeBlock.parse({
        ...stamp,
        id: 'block-a',
        occurrenceId: 'occ-a',
        start: { date: '2026-10-29', time: '14:00', timeZone: 'Asia/Shanghai' },
        durationMinutes: 45,
      }),
    );
    const rows = deriveToDooItems(data, { from: '2026-10-29', to: '2026-10-29' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-10-29');
    expect(rows[0]?.blocks[0]?.durationMinutes).toBe(45);
    expect(deriveToDooItems(data, { statuses: ['done'] })).toHaveLength(0);
  });
});

test.each(['priority', 'initialStatus', 'reminders'] as const)(
  'saving new task retains a concurrent %s edit',
  async (field) => {
    const data = snapshot();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = createToDooWorkbench(async (_url, method = 'GET') => {
      if (method === 'GET') return data;
      await wait;
      return { snapshot: data, ids: [], changed: [] };
    });
    model.acceptSnapshot(data);
    const draft = model.newTaskDraft(undefined, undefined, {
      priority: 'high',
      initialStatus: 'doing',
    } as any);
    draft.title = '保留并发输入';
    const saving = model.createTask(toDooDraftPayload(draft, 'UTC'));
    Object.assign(
      draft,
      field === 'priority'
        ? { priority: 'low' }
        : field === 'initialStatus'
          ? { initialStatus: 'todo' }
          : {
              reminders: [
                { id: 'new-reminder', anchor: 'due', offsetMinutes: -30, allDayTime: '08:00' },
              ],
            },
    );
    release();
    await saving;
    expect(model.newTaskDraft()).toBe(draft);
    expect(draft.title).toBe('保留并发输入');
  },
);

test('recovered creation fields survive a new column seed without changing the parent/list key', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  try {
    const data = snapshot();
    const first = createToDooWorkbench(async () => data);
    first.acceptSnapshot(data);
    const draft = first.newTaskDraft(undefined, 'work', {
      initialStatus: 'doing',
      priority: 'high',
    } as any);
    Object.assign(draft, {
      title: '恢复中的任务',
      planDate: '',
      planDateCleared: true,
      reminders: [
        { id: 'persisted-reminder', anchor: 'due', offsetMinutes: -30, allDayTime: '08:00' },
      ],
    });
    await import('vue').then((v) => v.nextTick());
    const restored = createToDooWorkbench(async () => data);
    restored.acceptSnapshot(data);
    const retained = restored.newTaskDraft(undefined, 'work', {
      initialStatus: 'done',
      priority: 'low',
      planDate: '2026-10-30',
    } as any);
    expect(Object.keys(restored.state.newTaskDrafts)).toEqual(['@work']);
    expect(retained).toMatchObject({
      title: '恢复中的任务',
      initialStatus: 'doing',
      priority: 'high',
      planDate: '',
      planDateCleared: true,
      reminders: [{ id: 'persisted-reminder', anchor: 'due' }],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test('resuming new task drafting identifies the retained parent and list rather than opening a root draft', () => {
  const model = createToDooWorkbench(async () => undefined);
  model.newTaskDraft();
  const child = model.newTaskDraft('parent-a', 'work');
  child.title = '尚未创建的子任务';
  expect(model.retainedNewTaskDraft()).toMatchObject({
    key: 'parent-a@work',
    parentTaskId: 'parent-a',
    listId: 'work',
    draft: { title: child.title },
  });
  const other = model.newTaskDraft(undefined, 'other');
  other.title = '另一份任务草稿';
  child.listId = 'destination';
  expect(model.retainedNewTaskDrafts()).toMatchObject([
    {
      key: 'parent-a@work',
      parentTaskId: 'parent-a',
      listId: 'work',
      draft: { listId: 'destination' },
    },
    { key: '@other', parentTaskId: null, listId: 'other', draft: { title: other.title } },
  ]);
});

test('a plan-clearing choice made during creation survives the response even when the submitted plan was empty', async () => {
  const data = snapshot();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = createToDooWorkbench(async (_url, method = 'GET') => {
    if (method === 'GET') return data;
    await wait;
    return { snapshot: data, ids: [], changed: [] };
  });
  model.acceptSnapshot(data);
  const draft = model.newTaskDraft();
  draft.title = '创建期间明确清空计划';
  const saving = model.createTask(toDooDraftPayload(draft, 'UTC'));
  draft.planDateCleared = true;
  release();
  await saving;
  expect(model.newTaskDraft()).toBe(draft);
  expect(draft.planDateCleared).toBe(true);
});

test('a recovered untouched composer placeholder still accepts its first explicit column context', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  try {
    const data = snapshot();
    const first = createToDooWorkbench(async () => data);
    first.acceptSnapshot(data);
    first.newTaskDraft();
    await import('vue').then((v) => v.nextTick());
    const restored = createToDooWorkbench(async () => data);
    restored.acceptSnapshot(data);
    const placeholder = restored.newTaskDraft(undefined, undefined, {
      initialStatus: 'doing',
      priority: 'high',
      planDate: '2026-10-30',
    });
    expect(placeholder).toMatchObject({
      title: '',
      initialStatus: 'doing',
      priority: 'high',
      planDate: '2026-10-30',
    });
    expect(restored.hasNewTaskDraft()).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

for (const recovered of [false, true]) {
  test.each([
    [undefined, 'A', 'B', false],
    [undefined, 'A', null, false],
    [undefined, 'A', 'B', true],
    ['task-a', 'A', 'B', true],
    ['task-a', null, 'B', true],
  ] as const)(
    'resume keeps storage identity parent=%s origin=%s destination=%s otherDraft=%s recovered=' +
      recovered,
    async (parent, originalList, destination, otherDraft) => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) || null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
      try {
        const data = snapshot();
        data.tasks[0].listId = originalList;
        const first = createToDooWorkbench(async () => data);
        first.acceptSnapshot(data);
        const draft = first.newTaskDraft(parent, originalList || '');
        Object.assign(draft, {
          title: '保留原始草稿',
          description: '不能定位到另一个草稿',
          listId: destination,
        });
        if (otherDraft) first.newTaskDraft(parent, 'B').title = 'B清单另一份草稿';
        if (parent) data.tasks[0].listId = destination;
        await import('vue').then((v) => v.nextTick());
        const model = recovered ? createToDooWorkbench(async () => data) : first;
        if (recovered) model.acceptSnapshot(data);
        const retained = model.retainedNewTaskDraft();
        expect(retained).toMatchObject({
          key: (parent || '') + '@' + (originalList || ''),
          parentTaskId: parent || null,
          listId: originalList,
          draft: { title: '保留原始草稿', listId: destination },
        });
        const resumed = model.newTaskDraft(
          retained!.parentTaskId || undefined,
          retained!.listId || '',
        );
        expect(resumed).toBe(retained!.draft);
        expect(resumed.title).toBe('保留原始草稿');
        expect(toDooDraftPayload(resumed, 'UTC').listId).toBe(destination);
        if (otherDraft)
          expect(model.state.newTaskDrafts[(parent || '') + '@B'].title).toBe('B清单另一份草稿');
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
}

describe('versioned editing recovery and action guards', () => {
  function storageFixture() {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) });
    return values;
  }
  test('restores a future recurrence scope and uses it for an indirect save instead of changing the whole series', async () => {
    const storage = storageFixture();
    try {
      const initial = snapshot();
      initial.tasks[0].recurrence = toDooEntitySchemas.task.parse({ ...initial.tasks[0], recurrence: {
        id: 'daily-rule', frequency: 'daily', interval: 1, anchorDate: '2026-11-01', timeZone: 'UTC',
      } }).recurrence;
      initial.occurrences[0].scheduledDate = '2026-11-20';
      const server = transport(initial), submitted: ReturnType<typeof toDooCommandSchema.parse>[] = [];
      const request = async (url: string, method = 'GET', input?: unknown) => {
        if (method !== 'GET') {
          const command = toDooCommandSchema.parse(input);
          submitted.push(command);
          if (command.action === 'change_recurrence') {
            const task = server.data.tasks.find((entry) => entry.id === command.payload.taskId)!;
            expect(command.payload.expectedRevision).toBe(task.revision);
            task.recurrence = command.payload.rule;
            task.revision = 'recurrence-r3'; server.data.version = '3';
            return { snapshot: structuredClone(server.data), ids: [task.id],
              changed: [{ kind: 'task', id: task.id, revision: task.revision }],
              replayed: false, transactionId: 'recurrence-tx' };
          }
        }
        return server.request(url, method, input);
      };
      const first = createToDooWorkbench(request); await first.load(); first.selectTask('task-a', 'occ-a');
      first.setDraftRecurrenceScope('future');
      expect(first.dirty()).toBe(false);
      first.draft()!.task.recurrence!.interval = 2;
      expect(first.flushRecovery()).toBe(true);
      expect(JSON.parse(storage.get('dooknow.to-doo.recovery:test')!).edits['task-a@occ-a'].scope).toBe('future');
      const restored = createToDooWorkbench(request); await restored.load(); restored.selectTask('task-a', 'occ-a');
      expect(restored.getDraftRecurrenceScope()).toBe('future');
      await restored.saveTask();
      expect(submitted.filter((entry) => entry.action === 'change_recurrence')).toMatchObject([
        { payload: { scope: 'future', from: '2026-11-20', rule: { interval: 2 } } },
      ]);
      expect(server.data.tasks[0].recurrence?.interval).toBe(2);
      expect(restored.dirty()).toBe(false);
      expect(restored.getDraftRecurrenceScope()).toBe('all');
      restored.draft()!.task.recurrence!.interval = 3;
      restored.setDraftRecurrenceScope('future');
      await restored.saveTask('all');
      expect(submitted.filter((entry) => entry.action === 'change_recurrence').at(-1)).toMatchObject({ payload: { scope: 'all' } });
    } finally { vi.unstubAllGlobals(); }
  });
  test('discard and dataset changes clear recurrence choices without making scope alone an entity edit', async () => {
    const model = createToDooWorkbench(transport().request); await model.load(); model.selectTask('task-a', 'occ-a');
    model.setDraftRecurrenceScope('future');
    expect(model.dirty()).toBe(false);
    expect(model.hasUnsavedChanges()).toBe(false);
    model.discardDraft();
    expect(model.getDraftRecurrenceScope()).toBe('all');
    expect(model.state.draftRecurrenceScopes).toEqual({});
    model.setDraftRecurrenceScope('future');
    model.acceptSnapshot({ ...snapshot(), datasetId: 'another-library' });
    expect(model.state.draftRecurrenceScopes).toEqual({});
    expect(model.getDraftRecurrenceScope('task-a@occ-a')).toBe('all');
  });
  test('restores an existing edit, empty title and a new unsaved plan without claiming server persistence', async () => {
    const storage = storageFixture();
    try {
      const server = transport(), first = createToDooWorkbench(server.request);
      await first.load(); first.selectTask('task-a');
      first.draft()!.task.title = '';
      first.draft()!.task.description = '刷新前的输入';
      first.draft()!.blocks.push({ ...toDooEntitySchemas.timeBlock.parse({ ...stamp, id: 'local-plan',
        occurrenceId: 'occ-a', start: { date: '2026-11-18' }, durationMinutes: 30 }), revision: '' });
      expect(first.flushRecovery()).toBe(true);
      expect(JSON.parse(storage.get('dooknow.to-doo.recovery:test')!).schemaVersion).toBe(2);
      const second = createToDooWorkbench(server.request);
      await second.load(); second.selectTask('task-a', 'occ-a');
      expect(second.draft()?.task).toMatchObject({ title: '', description: '刷新前的输入' });
      expect(second.draft()?.blocks[0]).toMatchObject({ id: 'local-plan', revision: '' });
      expect(second.retainedTaskDrafts()).toMatchObject([{ recovered: true, key: 'task-a@occ-a' }]);
      expect(server.data.tasks[0].description).toBe('');
      expect(second.dirty()).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  test('a restored conflicting field cannot be submitted until an explicit choice, even after another reload', async () => {
    storageFixture();
    try {
      const server = transport(); let writes = 0;
      const request = async (url: string, method = 'GET', body?: unknown) => {
        if (method !== 'GET') writes++;
        return server.request(url, method, body);
      };
      const first = createToDooWorkbench(request); await first.load(); first.selectTask('task-a');
      first.draft()!.task.title = '本地标题'; first.flushRecovery();
      server.data.tasks[0].title = '远端标题'; server.data.tasks[0].revision = 'remote-title';
      const restored = createToDooWorkbench(request); await restored.load(); restored.selectTask('task-a', 'occ-a');
      expect(await restored.rebaseDraft()).toBe(false);
      expect(restored.state.draftConflicts).toMatchObject([{ kind: 'task', field: 'title', local: '本地标题', remote: '远端标题' }]);
      await restored.saveTask(); expect(writes).toBe(0);
      const third = createToDooWorkbench(request); await third.load(); third.selectTask('task-a', 'occ-a');
      expect(await third.rebaseDraft()).toBe(false);
      expect(third.state.conflictDraftKey).toBe('task-a@occ-a');
      third.resolveAllDraftConflicts('local');
      await third.saveTask();
      expect(writes).toBe(1); expect(server.data.tasks[0].title).toBe('本地标题');
      expect(third.dirty()).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  test('legacy new-draft and pending records stay readable and are not discarded with an existing edit', async () => {
    const storage = storageFixture();
    try {
      const source = createToDooWorkbench(transport().request); await source.load();
      const newDraft = { ...source.newTaskDraft(), title: '旧新建草稿' };
      await (await import('vue')).nextTick();
      const pending = { requestId: 'lost-request', action: 'create_task', payload: { title: '待核对' } };
      storage.set('dooknow.to-doo.recovery:test', JSON.stringify({ drafts: { '@': newDraft }, pending }));
      const restored = createToDooWorkbench(transport().request); await restored.load();
      expect(restored.newTaskDraft().title).toBe('旧新建草稿');
      expect(restored.state.pendingMutation).toMatchObject(pending);
      restored.selectTask('task-a'); restored.draft()!.task.description = '待放弃';
      restored.discardDraft();
      expect(restored.state.pendingMutation).toMatchObject(pending);
      expect(JSON.parse(storage.get('dooknow.to-doo.recovery:test')!).pending.requestId).toBe('lost-request');
    } finally { vi.unstubAllGlobals(); }
  });
  test('failed or unreadable storage remains an explicit failure without erasing the recovery record', async () => {
    const storage = storageFixture();
    try {
      const unknownRecord = JSON.stringify({ schemaVersion: 999, edits: { future: 'retain' } });
      storage.set('dooknow.to-doo.recovery:test', unknownRecord);
      const model = createToDooWorkbench(transport().request); await model.load(); model.selectTask('task-a');
      model.draft()!.task.description = '仍在内存';
      expect(model.flushRecovery()).toBe(false);
      expect(model.state.recoveryStatus).toBe('unavailable');
      expect(storage.get('dooknow.to-doo.recovery:test')).toBe(unknownRecord);
      expect(model.hasUnsavedChanges()).toBe(true);
      vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw Error('quota'); } });
      const quota = createToDooWorkbench(transport().request); await quota.load(); quota.selectTask('task-a');
      quota.draft()!.task.description = '容量失败';
      expect(quota.flushRecovery()).toBe(false); expect(quota.state.localWarning).toContain('不能保存恢复信息');
      expect(quota.draft()!.task.description).toBe('容量失败');
    } finally { vi.unstubAllGlobals(); }
  });
  test('headless clean reads and untouched composers need no recovery storage but real edits still report failure', async () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      const model = createToDooWorkbench(transport().request); await model.load();
      model.newTaskDraft(); await (await import('vue')).nextTick();
      expect(model.state.recoveryStatus).toBe('idle');
      expect(model.state.localWarning).toBe('');
      expect(model.flushRecovery()).toBe(true);
      model.newTaskDraft().title = '需要恢复的真实内容';
      await (await import('vue')).nextTick();
      expect(model.state.recoveryStatus).toBe('unavailable');
      expect(model.flushRecovery()).toBe(false);
      model.clearNewTaskDraft();
      expect(model.state.recoveryStatus).toBe('idle');
      expect(model.flushRecovery()).toBe(true);
      model.selectTask('task-a'); model.draft()!.task.description = '既有任务的未保存修改';
      expect(model.flushRecovery()).toBe(false);
      expect(model.state.recoveryStatus).toBe('unavailable');
    } finally { vi.unstubAllGlobals(); }
  });
  test('legacy recovery reveals only a summary and migrates after explicit adoption without deleting the source', async () => {
    const storage = storageFixture();
    try {
      const server = transport(), legacy = createToDooWorkbench(server.request);
      await legacy.load(); legacy.newTaskDraft().title = '不能在归属确认前展示的标题';
      legacy.selectTask('task-a'); legacy.draft()!.task.description = '旧版编辑';
      legacy.setDraftRecurrenceScope('future');
      legacy.state.pendingMutation = { requestId: 'legacy-unknown', action: 'create_task', payload: { title: '待核对创建' } } as any;
      legacy.flushRecovery(); await (await import('vue')).nextTick();
      const original = storage.get('dooknow.to-doo.recovery:test');
      const scoped = createToDooWorkbench(server.request, { recoveryScope: 'account-a' }); await scoped.load();
      expect(scoped.state.legacyRecoveryAvailable).toBe(true);
      expect(scoped.state.legacyRecoverySummary).toEqual({ newDrafts: 1, taskDrafts: 1, pending: true, receipts: 0 });
      expect(scoped.retainedTaskDrafts()).toEqual([]); expect(scoped.state.pendingMutation).toBeNull();
      expect(scoped.adoptLegacyRecovery()).toBe(true);
      expect(scoped.retainedTaskDrafts()[0]?.draft.task.description).toBe('旧版编辑');
      expect(scoped.getDraftRecurrenceScope('task-a@occ-a')).toBe('future');
      expect(scoped.state.pendingMutation?.requestId).toBe('legacy-unknown');
      expect(scoped.state.legacyRecoveryAvailable).toBe(false);
      expect(storage.get('dooknow.to-doo.recovery:test')).toBe(original);
      const again = createToDooWorkbench(server.request, { recoveryScope: 'account-a' }); await again.load();
      expect(again.state.legacyRecoveryAvailable).toBe(false);
      expect(again.state.pendingMutation?.requestId).toBe('legacy-unknown');
    } finally { vi.unstubAllGlobals(); }
  });
  test('legacy adoption refuses same-task input collisions and preserves both account and legacy records', async () => {
    const storage = storageFixture();
    try {
      const server = transport(), legacy = createToDooWorkbench(server.request); await legacy.load(); legacy.selectTask('task-a');
      legacy.draft()!.task.description = '旧版内容'; legacy.flushRecovery(); await (await import('vue')).nextTick();
      const original = storage.get('dooknow.to-doo.recovery:test');
      const scoped = createToDooWorkbench(server.request, { recoveryScope: 'account-a' }); await scoped.load(); scoped.selectTask('task-a');
      scoped.draft()!.task.description = '当前账号内容'; scoped.flushRecovery();
      expect(scoped.adoptLegacyRecovery()).toBe(false);
      expect(scoped.state.error).toContain('同任务');
      expect(scoped.draft()!.task.description).toBe('当前账号内容');
      expect(storage.get('dooknow.to-doo.recovery:test')).toBe(original);
      expect(scoped.state.legacyRecoveryAvailable).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  test('adopting legacy new drafts keeps the currently open clean detail available', async () => {
    storageFixture();
    try {
      const server = transport(), legacy = createToDooWorkbench(server.request); await legacy.load();
      legacy.newTaskDraft().title = '旧版新建内容'; legacy.flushRecovery(); await (await import('vue')).nextTick();
      const scoped = createToDooWorkbench(server.request, { recoveryScope: 'account-a' });
      await scoped.load(); scoped.selectTask('task-a');
      expect(scoped.adoptLegacyRecovery()).toBe(true);
      expect(scoped.state.selectedTaskId).toBe('task-a');
      expect(scoped.draft()?.task.id).toBe('task-a');
      expect(scoped.dirty()).toBe(false);
      expect(scoped.retainedNewTaskDrafts()[0]?.draft.title).toBe('旧版新建内容');
    } finally { vi.unstubAllGlobals(); }
  });
  test('empty legacy composer placeholders stay quiet while confirmed receipts remain recoverable', async () => {
    const storage = storageFixture();
    try {
      const source = createToDooWorkbench(transport().request); await source.load();
      source.newTaskDraft(undefined, 'work', { planDate: '2026-11-15', priority: 'high' });
      source.flushRecovery(); await (await import('vue')).nextTick();
      const quiet = createToDooWorkbench(transport().request, { recoveryScope: 'account-a' }); await quiet.load();
      expect(quiet.state.legacyRecoveryAvailable).toBe(false);
      expect(quiet.state.legacyRecoverySummary).toBeNull();
      const raw = JSON.parse(storage.get('dooknow.to-doo.recovery:test')!);
      raw.statusReceipts = [['occ-a', { datasetId: 'test', revision: 'confirmed-r' }]];
      storage.set('dooknow.to-doo.recovery:test', JSON.stringify(raw));
      const receipts = createToDooWorkbench(transport().request, { recoveryScope: 'account-b' }); await receipts.load();
      expect(receipts.state.legacyRecoveryAvailable).toBe(true);
      expect(receipts.state.legacyRecoverySummary).toEqual({ newDrafts: 0, taskDrafts: 0, pending: false, receipts: 1 });
    } finally { vi.unstubAllGlobals(); }
  });
  test('legacy adoption cannot replace a scoped pending request or report success when scoped writes fail', async () => {
    const storage = storageFixture();
    try {
      const legacy = createToDooWorkbench(transport().request); await legacy.load(); legacy.newTaskDraft().title = '旧新建';
      legacy.flushRecovery(); await (await import('vue')).nextTick();
      const original = storage.get('dooknow.to-doo.recovery:test');
      const scoped = createToDooWorkbench(transport().request, { recoveryScope: 'account-a' }); await scoped.load();
      scoped.state.pendingMutation = { requestId: 'current-unknown', action: 'create_task', payload: { title: '当前待核对' } } as any;
      expect(scoped.adoptLegacyRecovery()).toBe(false); expect(scoped.state.pendingMutation?.requestId).toBe('current-unknown');
      scoped.state.pendingMutation = null;
      vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: () => { throw Error('quota'); } });
      expect(scoped.adoptLegacyRecovery()).toBe(false);
      expect(scoped.state.recoveryStatus).toBe('unavailable');
      expect(storage.get('dooknow.to-doo.recovery:test')).toBe(original);
      expect(scoped.retainedNewTaskDrafts()).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
  test('account scopes and datasets cannot adopt another identity\'s existing drafts', async () => {
    storageFixture();
    try {
      const data = transport(); const a = createToDooWorkbench(data.request, { recoveryScope: 'account-a' });
      await a.load(); a.selectTask('task-a'); a.draft()!.task.description = 'A私有输入'; a.flushRecovery();
      const b = createToDooWorkbench(data.request, { recoveryScope: 'account-b' });
      await b.load(); expect(b.retainedTaskDrafts()).toEqual([]);
      const aAgain = createToDooWorkbench(data.request, { recoveryScope: 'account-a' });
      await aAgain.load(); expect(aAgain.retainedTaskDrafts()[0]?.draft.task.description).toBe('A私有输入');
    } finally { vi.unstubAllGlobals(); }
  });
  test('a recovered edit of a remotely deleted task remains copyable and cannot silently restore it', async () => {
    storageFixture();
    try {
      const server = transport(); let writes = 0;
      const request = async (url: string, method = 'GET', body?: unknown) => {
        if (method !== 'GET') writes++;
        return server.request(url, method, body);
      };
      const first = createToDooWorkbench(request); await first.load(); first.selectTask('task-a');
      first.draft()!.task.description = '删除前尚未提交的内容'; first.flushRecovery();
      server.data.tasks[0].deletedAt = '2026-11-15T12:00:00Z'; server.data.tasks[0].revision = 'deleted-r';
      const recovered = createToDooWorkbench(request); await recovered.load(); recovered.selectTask('task-a', 'occ-a');
      expect(await recovered.saveTask()).toBeUndefined();
      expect(writes).toBe(0); expect(recovered.draft()?.task.description).toBe('删除前尚未提交的内容');
      expect(recovered.state.unavailableDrafts['task-a@occ-a']).toContain('已被移除');
      expect(recovered.state.conflictDraftKey).toBe('task-a@occ-a');
      expect(server.data.tasks[0].deletedAt).toBe('2026-11-15T12:00:00Z');
    } finally { vi.unstubAllGlobals(); }
  });
  test('action preparation finds hidden-period, descendant and not-yet-created child drafts', async () => {
    const data = snapshot(), parent = data.tasks[0];
    data.tasks.push({ ...parent, id: 'child', title: '后代任务', parentTaskId: parent.id });
    data.occurrences.push({ ...data.occurrences[0], id: 'child-occ', taskId: 'child' },
      { ...data.occurrences[0], id: 'another-period', cycleKey: 'later' });
    const model = createToDooWorkbench(transport(data).request); await model.load();
    model.selectTask('task-a', 'another-period'); model.draft()!.task.description = '隐藏周期输入';
    model.selectTask('child', 'child-occ'); model.draft()!.task.title = '后代草稿';
    model.newTaskDraft('child').title = '未创建后代'; model.selectTask('');
    expect(await model.prepareTaskAction(['task-a'])).toMatchObject([
      { key: 'task-a@another-period', kind: 'task' }, { key: 'child@child-occ', kind: 'task' },
      { taskId: 'child', occurrenceId: '', title: '未创建后代', kind: 'new' },
    ]);
  });
  test('preparing a subtree action hydrates metadata without adding children to filtered result rows', async () => {
    const visible = snapshot(), tree = structuredClone(visible);
    tree.tasks.push({ ...tree.tasks[0], id: 'unmatched-child', title: '未命中筛选的子项', parentTaskId: 'task-a' });
    const model = createToDooWorkbench(async (url) => url.includes('kind=task') ? structuredClone(tree) : structuredClone(visible));
    await model.load();
    expect(await model.prepareTaskAction(['task-a'])).toEqual([]);
    expect(model.state.snapshot?.tasks.map((task) => task.id)).toEqual(['task-a']);
    expect(model.taskDefinitions().some((task) => task.id === 'unmatched-child')).toBe(true);
  });
  test('saving a parent list change moves the frozen subtree without an invalid single-task list patch', async () => {
    const f = await domainStatusFixture();
    try {
      const first = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name: '原清单' } } }).ids[0];
      const second = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name: '目标清单' } } }).ids[0];
      const parent = f.create('父任务', { listId: first }), child = f.create('子任务', { listId: first, parentTaskId: parent.id });
      const bodies: any[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'POST') bodies.push(JSON.parse(JSON.stringify(body)));
        return f.request(url, method, body);
      });
      await model.load(); model.selectTask(parent.id);
      model.draft()!.task.listId = second; model.draft()!.task.description = '移动同时修改正文';
      await model.saveTask();
      expect(model.state.error).toBe(''); expect(model.dirty()).toBe(false);
      expect(bodies.find((body) => body.action === 'update_task').payload.patch).not.toHaveProperty('listId');
      const move = bodies.find((body) => body.action === 'batch_tasks');
      expect(move.payload).toMatchObject({ operation: 'move', includeDescendants: true, listId: second });
      expect(move.payload.expectedRevisions[child.id]).toBeTruthy();
      for (const id of [parent.id, child.id]) expect(f.service.getEntity('task', id)).toMatchObject({ listId: second, sectionId: null });
      expect(f.service.getEntity('task', parent.id)).toMatchObject({ description: '移动同时修改正文' });
    } finally { await f.close(); }
  });
  test('unknown subtree move retries its exact body and checkpoints the destination before another save', async () => {
    const f = await domainStatusFixture();
    try {
      const target = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name: '目标' } } }).ids[0];
      const parent = f.create('响应丢失的移动'), child = f.create('子项', { parentTaskId: parent.id });
      const bodies: any[] = []; let lose = true;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const command = body as any;
        if (method === 'POST' && command.action === 'batch_tasks')
          bodies.push(JSON.parse(JSON.stringify(body)));
        const result = await f.request(url, method, body);
        if (method === 'POST' && command.action === 'batch_tasks') {
          if (lose) { lose = false; throw Error('回复丢失'); }
        }
        return result;
      });
      await model.load(); model.selectTask(parent.id); model.draft()!.task.listId = target;
      await model.saveTask(); expect(model.state.pendingMutation?.action).toBe('batch_tasks');
      expect(await model.retryPending()).toBeDefined();
      expect(model.state.error).toBe('');
      expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
      model.draft()!.task.description = '核对后继续编辑'; await model.saveTask();
      expect(model.state.error).toBe(''); expect(model.dirty()).toBe(false);
      expect(f.service.getEntity('task', child.id)).toMatchObject({ listId: target });
      expect(f.service.getEntity('task', parent.id)).toMatchObject({ listId: target, description: '核对后继续编辑' });
    } finally { await f.close(); }
  });
});

describe('confirmed status records outside the reply window', () => {
  function withoutStatusRecords(result: ToDooSnapshot | ToDooCommandResult, omitTasks = false) {
    if (!('snapshot' in result)) throw Error('A status command must return a transaction receipt');
    return {
      ...result,
      snapshot: {
        ...result.snapshot,
        ...(omitTasks ? { tasks: [] } : {}),
        occurrences: [],
        timeBlocks: [],
      },
    };
  }
  const future = { date: '2030-05-17', time: null, timeZone: 'UTC' };
  const interval = { view: 'calendar' as const, from: '2030-05-01', to: '2030-05-31' };
  test('completion reads the exact future execution and retains unrelated calendar plans and dirty input', async () => {
    const f = await domainStatusFixture();
    try {
      const first = f.create('Future task A', {
        due: future,
        plan: future,
        initialStatus: 'doing',
      });
      const second = f.create('Future task B', { due: future, plan: { ...future, time: '15:00' } });
      let writes = 0,
        reads = 0;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const result = await f.request(url, method, body);
        if (
          method === 'POST' &&
          toDooCommandSchema.parse(body).action === 'set_occurrence_status'
        ) {
          writes++;
          return withoutStatusRecords(result, true);
        }
        if (method === 'GET' && url.includes('kinds=occurrence') && url.includes('ids=')) reads++;
        return result;
      });
      await model.load(interval);
      model.selectTask(first.id);
      const occurrenceId = model.draft()!.occurrence!.id;
      const secondOccurrence = model.state.snapshot!.occurrences.find(
        (row) => row.taskId === second.id,
      )!;
      const secondPlan = model.state.snapshot!.timeBlocks.find(
        (row) => row.occurrenceId === secondOccurrence.id,
      )!;
      model.draft()!.task.description = '尚未保存的说明';
      model.draft()!.occurrence!.due!.date = '2030-05-18';
      const result = await model.setStatus(occurrenceId, 'done');
      expect(result?.snapshot.occurrences).toEqual([]);
      const stored = toDooEntitySchemas.occurrence.parse(
        f.service.getEntity('occurrence', occurrenceId),
      );
      expect(model.state.selectedOccurrenceId).toBe(occurrenceId);
      expect(model.draft()?.occurrence).toMatchObject({
        status: 'done',
        revision: stored.revision,
        due: { date: '2030-05-18' },
      });
      expect(model.draft()?.task.description).toBe('尚未保存的说明');
      expect(model.dirty()).toBe(true);
      expect(
        model.state.snapshot?.occurrences.find((row) => row.id === secondOccurrence.id)?.revision,
      ).toBe(secondOccurrence.revision);
      expect(model.state.snapshot?.timeBlocks.find((row) => row.id === secondPlan.id)).toEqual(
        secondPlan,
      );
      expect(model.items().map((row) => row.task.id)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
      expect(model.draft()?.blocks).toHaveLength(1);
      expect(model.state.completionFeedback?.undoable).toBe(true);
      await model.undoCompletion();
      expect(model.draft()?.occurrence?.status).toBe('doing');
      expect(model.draft()?.task.description).toBe('尚未保存的说明');
      expect(model.draft()?.occurrence?.due?.date).toBe('2030-05-18');
      expect(writes).toBe(2);
      expect(reads).toBe(2);
    } finally {
      await f.close();
    }
  });

  test('future parent and child completion checkpoints each receipt without inferring cascade states', async () => {
    const f = await domainStatusFixture();
    try {
      const parent = f.create('Future parent', { due: future, plan: future });
      const child = f.create('Future child', {
        parentTaskId: parent.id,
        due: future,
        plan: future,
      });
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const result = await f.request(url, method, body);
        return method === 'POST' ? withoutStatusRecords(result) : result;
      });
      await model.load(interval);
      model.selectTask(child.id);
      const childId = model.draft()!.occurrence!.id;
      model.draft()!.task.description = '子任务输入保留';
      model.selectTask(parent.id);
      const parentId = model.draft()!.occurrence!.id;
      model.draft()!.task.description = '父任务输入保留';
      await model.setStatus(parentId, 'done', true);
      expect(model.state.selectedOccurrenceId).toBe(parentId);
      expect(model.draft()?.occurrence?.status).toBe('done');
      expect(model.draft()?.task.description).toBe('父任务输入保留');
      model.selectTask(child.id, childId);
      const actual = toDooEntitySchemas.occurrence.parse(
        f.service.getEntity('occurrence', childId),
      );
      expect(model.draft()?.occurrence).toMatchObject({
        status: 'done',
        revision: actual.revision,
      });
      expect(model.draft()?.task.description).toBe('子任务输入保留');
      expect(model.state.snapshot?.timeBlocks).toHaveLength(2);
      expect(model.state.completionFeedback?.undoable).toBe(false);
      expect(model.state.pendingMutation).toBeNull();
    } finally {
      await f.close();
    }
  });

  test('a read failure never repeats a confirmed status write and a later refresh reconciles dirty fields', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Retry reading a future status', { due: future, plan: future });
      let committed = false,
        fail = true,
        writes = 0;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && url.includes('kinds=occurrence') && fail)
          throw Object.assign(Error('读取暂不可用'), { status: 503 });
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          writes++;
          committed = true;
          return withoutStatusRecords(result);
        }
        if (committed && !url.includes('ids=')) return { ...result, occurrences: [] };
        return result;
      });
      await model.load(interval);
      model.selectTask(task.id);
      const id = model.draft()!.occurrence!.id;
      model.draft()!.task.description = '读取失败仍保留';
      model.draft()!.occurrence!.due!.date = '2030-05-18';
      expect(await model.setStatus(id, 'done')).toBeDefined();
      expect(model.state.pendingMutation).toBeNull();
      expect(model.state.localWarning).toContain('任务状态已保存');
      expect(model.draft()?.blocks).toHaveLength(1);
      expect(model.draft()?.task.description).toBe('读取失败仍保留');
      expect(f.service.getEntity('occurrence', id)).toMatchObject({ status: 'done' });
      fail = false;
      await model.load(interval);
      expect(model.state.error).toBe('');
      expect(model.state.localWarning).toBe('');
      expect(model.draft()?.occurrence).toMatchObject({
        status: 'done',
        due: { date: '2030-05-18' },
      });
      expect(model.draft()?.task.description).toBe('读取失败仍保留');
      expect(model.dirty()).toBe(true);
      expect(writes).toBe(1);
    } finally {
      await f.close();
    }
  });

  test('a newer execution from another writer is never treated as this completion receipt', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Concurrent future status', { due: future });
      let changed = false,
        writes = 0;
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && url.includes('kinds=occurrence') && !changed) {
          changed = true;
          const current = f.service.snapshot({ taskIds: [task.id] }).occurrences[0]!;
          f.service.command({
            requestId: crypto.randomUUID(),
            action: 'set_occurrence_status',
            payload: { id: current.id, expectedRevision: current.revision, status: 'blocked' },
          });
        }
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          writes++;
          return withoutStatusRecords(result);
        }
        return result;
      });
      await model.load(interval);
      model.selectTask(task.id);
      const id = model.draft()!.occurrence!.id;
      const oldRevision = model.draft()!.occurrence!.revision;
      model.draft()!.task.description = '并发时也不丢';
      await model.setStatus(id, 'done');
      expect(model.state.pendingMutation).toBeNull();
      expect(model.state.conflict).toBe(true);
      expect(model.state.error).toContain('记录版本已变化');
      expect(model.draft()?.occurrence?.revision).toBe(oldRevision);
      expect(model.draft()?.task.description).toBe('并发时也不丢');
      expect(model.state.completionFeedback?.undoable).toBe(false);
      expect(await model.undoCompletion()).toBeUndefined();
      expect(f.service.getEntity('occurrence', id)).toMatchObject({ status: 'blocked' });
      expect(writes).toBe(1);
    } finally {
      await f.close();
    }
  });

  test('a late read cannot restore a previous dataset or its completion action', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Dataset changes during a confirmed status read', { due: future });
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && url.includes('kinds=occurrence')) {
          entered();
          await wait;
        }
        const result = await f.request(url, method, body);
        return method === 'POST' ? withoutStatusRecords(result) : result;
      });
      await model.load(interval);
      model.selectTask(task.id);
      const completing = model.setStatus(model.draft()!.occurrence!.id, 'done');
      await started;
      model.acceptSnapshot({ ...snapshot(), datasetId: 'another-library' });
      release();
      await completing;
      expect(model.state.snapshot?.datasetId).toBe('another-library');
      expect(model.state.completionFeedback).toBeNull();
      expect(model.state.drafts).toEqual({});
      expect(model.state.pendingMutation).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe('confirmed task records outside the reply window', () => {
  function pagingContext(page: ToDooSnapshot['page']) {
    const { kind, total, limit, nextCursor, truncated, from, to } = page;
    return { kind, total, limit, nextCursor, truncated, from, to };
  }
  function isExactTaskRead(url: string, taskId: string) {
    const params = new URL(url, 'https://local').searchParams;
    return (params.get('kind') === 'task' || params.get('kinds')?.split(',').includes('task')) &&
      params.get('ids')?.split(',').includes(taskId);
  }
  function withoutTaskRecord(result: ToDooSnapshot | ToDooCommandResult, taskId: string) {
    if (!('snapshot' in result)) throw Error('A task command must return a transaction receipt');
    return { ...result, snapshot: { ...result.snapshot,
      tasks: result.snapshot.tasks.filter(task => task.id !== taskId) } };
  }
  test('saving row 205 reads its receipt revision without replacing the loaded rows, page or selection', async () => {
    const f = await domainStatusFixture();
    try {
      const ids: string[] = [];
      for (let index = 1; index <= 205; index++) {
        const result = f.service.command({ requestId: crypto.randomUUID(), action: 'create_task',
          payload: { title: 'Receipt row ' + String(index).padStart(3, '0') } });
        ids.push(result.ids[0]);
      }
      const taskId = ids[204];
      let writes = 0, reads = 0, receiptRevision = '';
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && isExactTaskRead(url, taskId)) reads++;
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'update_task') {
          writes++;
          if (!('snapshot' in result)) throw Error('Expected the real service transaction receipt');
          expect(result.snapshot.tasks).toHaveLength(200);
          expect(result.snapshot.tasks.some(task => task.id === taskId)).toBe(false);
          receiptRevision = result.changed.find(entry => entry.kind === 'task' && entry.id === taskId)!.revision;
        }
        return result;
      });
      await model.load({ view: 'tasks', limit: 500 });
      expect(model.state.snapshot?.tasks).toHaveLength(205);
      const loadedIds = model.state.snapshot!.tasks.map(task => task.id);
      const page = { ...model.state.snapshot!.page };
      const taskPage = { ...model.state.snapshot!.collectionPages!.task! };
      model.state.selectedIds = [ids[0], taskId];
      model.selectTask(taskId);
      const occurrenceId = model.state.selectedOccurrenceId;
      model.draft()!.task.description = 'The last loaded task was saved';
      await model.saveTask();
      expect(writes).toBe(1); expect(reads).toBe(1);
      expect(receiptRevision).toBeTruthy();
      expect(f.service.getEntity('task', taskId)).toMatchObject({ description: 'The last loaded task was saved', revision: receiptRevision });
      expect(model.draft()?.task).toMatchObject({ description: 'The last loaded task was saved', revision: receiptRevision });
      expect(model.dirty()).toBe(false); expect(model.state.pendingMutation).toBeNull();
      expect(model.state.snapshot?.tasks.map(task => task.id)).toEqual(loadedIds);
      expect(model.state.snapshot?.tasks.find(task => task.id === taskId)?.revision).toBe(receiptRevision);
      expect(model.state.snapshot?.page).toMatchObject({ limit: page.limit, total: page.total, nextCursor: page.nextCursor });
      expect(model.state.snapshot?.collectionPages?.task).toMatchObject({ limit: taskPage.limit, total: taskPage.total, nextCursor: taskPage.nextCursor });
      expect(model.state.query).toMatchObject({ view: 'tasks', limit: 500 });
      expect(model.state.selectedIds).toEqual([ids[0], taskId]);
      expect(model.state.selectedTaskId).toBe(taskId); expect(model.state.selectedOccurrenceId).toBe(occurrenceId);
    } finally { await f.close(); }
  }, 30000);
  test('a partial filtered task page retains its scoped cursor through a save and can continue paging', async () => {
    const f = await domainStatusFixture();
    try {
      const listId = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name: 'Filtered receipt list' } } }).ids[0];
      const otherListId = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name: 'Outside the active filter' } } }).ids[0];
      const outsiderId = f.service.command({ requestId: crypto.randomUUID(), action: 'create_task',
        payload: { title: 'This row must stay outside the filtered view', listId: otherListId } }).ids[0];
      const scopedIds: string[] = [];
      for (let index = 1; index <= 205; index++)
        scopedIds.push(f.service.command({ requestId: crypto.randomUUID(), action: 'create_task',
          payload: { title: 'Scoped receipt row ' + String(index).padStart(3, '0'), listId } }).ids[0]);
      let writes = 0;
      const pageReads: URLSearchParams[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        const params = new URL(url, 'https://local').searchParams;
        if (method === 'GET' && params.has('cursor')) pageReads.push(params);
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'update_task') {
          writes++;
          if (!('snapshot' in result)) throw Error('Expected the real unfiltered command receipt');
          expect(result.snapshot.tasks.some(task => task.id === outsiderId)).toBe(true);
          expect(result.snapshot.page.nextCursor).not.toBeNull();
        }
        return result;
      });
      const filter = { listIds: [listId] };
      await model.load({ view: 'tasks', limit: 200, filter });
      const page = JSON.parse(JSON.stringify(model.state.snapshot!.page));
      const taskPage = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages!.task!));
      const originalQuery = JSON.parse(JSON.stringify(model.state.query));
      expect(page.nextCursor).not.toBeNull(); expect(taskPage.nextCursor).not.toBeNull();
      expect(page.total).toBe(205); expect(page.limit).toBe(200);
      model.selectTask(scopedIds[0]);
      model.draft()!.task.title = 'Saved within the original filtered page';
      await model.saveTask();
      expect(writes).toBe(1); expect(model.dirty()).toBe(false);
      expect(model.state.query).toEqual(originalQuery);
      expect(model.state.snapshot?.page).toMatchObject(pagingContext(page));
      expect(model.state.snapshot?.collectionPages?.task).toMatchObject(pagingContext(taskPage));
      expect(model.state.snapshot?.tasks.some(task => task.id === outsiderId)).toBe(false);
      expect(model.state.snapshot?.tasks.every(task => task.listId === listId)).toBe(true);
      await model.nextPage();
      expect(model.state.error).toBe('');
      expect(pageReads).toHaveLength(1);
      expect(pageReads[0].get('cursor')).toBe(page.nextCursor);
      expect(JSON.parse(pageReads[0].get('filter')!)).toEqual(filter);
      expect(model.state.query.filter).toEqual(filter);
      expect(model.state.snapshot?.page.nextCursor).toBeNull();
      const loaded = model.state.snapshot!.tasks;
      expect(loaded).toHaveLength(205);
      expect(new Set(loaded.map(task => task.id)).size).toBe(205);
      expect(loaded.map(task => task.id).sort()).toEqual([...scopedIds].sort());
      expect(loaded.every(task => task.listId === listId)).toBe(true);
      expect(f.service.getEntity('task', scopedIds[0])).toMatchObject({ title: 'Saved within the original filtered page', listId });
    } finally { await f.close(); }
  }, 30000);
  test.each([false, true])('a failed receipt read stays recoverable and only verifies the confirmed write (reload: %s)', async reload => {
    const f = await domainStatusFixture();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) });
    try {
      const task = f.create('Task receipt verification retry');
      const recoveryKey = 'dooknow.to-doo.recovery:' + f.service.snapshot({ taskIds: [task.id] }).datasetId;
      const calls: { method: string; url: string }[] = [];
      let fail = true, writes = 0, reads = 0, receiptRevision = '';
      let recoveryBeforeFirstRead: any;
      const request: Parameters<typeof createToDooWorkbench>[0] = async (url, method = 'GET', body) => {
        calls.push({ method, url });
        if (method === 'GET' && isExactTaskRead(url, task.id)) {
          reads++;
          if (fail) {
            recoveryBeforeFirstRead = JSON.parse(storage.get(recoveryKey)!);
            fail = false; throw Error('Confirmed task read temporarily unavailable');
          }
        }
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'update_task') {
          writes++;
          if (!('snapshot' in result)) throw Error('Expected a task receipt');
          receiptRevision = result.changed.find(entry => entry.kind === 'task' && entry.id === task.id)!.revision;
          return withoutTaskRecord(result, task.id);
        }
        return result;
      };
      const model = createToDooWorkbench(request);
      await model.load(); model.selectTask(task.id);
      model.draft()!.task.description = 'Committed once, not sent twice';
      await model.saveTask();
      expect(writes).toBe(1); expect(reads).toBe(1);
      expect(recoveryBeforeFirstRead.pending).toBeNull();
      expect(recoveryBeforeFirstRead.taskCheckpoints).toEqual(expect.arrayContaining([
        [expect.any(String), expect.objectContaining({ revision: receiptRevision,
          submitted: expect.objectContaining({ id: task.id, description: 'Committed once, not sent twice' }) })],
      ]));
      expect(model.state.pendingMutation).toBeNull(); expect(model.dirty()).toBe(true);
      expect(model.state.localWarning || model.state.error).toMatch(/保存|提交|核对|读取/);
      expect(f.service.getEntity('task', task.id)).toMatchObject({ description: 'Committed once, not sent twice', revision: receiptRevision });
      expect(model.draft()?.task.description).toBe('Committed once, not sent twice');
      expect(model.flushRecovery()).toBe(true);
      const persisted = JSON.parse(storage.get(recoveryKey)!);
      expect(persisted.pending).toBeNull();
      expect(persisted.taskCheckpoints).toMatchObject([[model.state.selectedTaskId + '@' + model.state.selectedOccurrenceId,
        { revision: receiptRevision, submitted: { id: task.id, description: 'Committed once, not sent twice' } }]]);
      const recoveryCallIndex = calls.length;
      const recovering = reload ? createToDooWorkbench(request) : model;
      if (reload) {
        await recovering.load(); recovering.selectTask(task.id, model.state.selectedOccurrenceId);
        expect(recovering.dirty()).toBe(true);
        expect(recovering.draft()?.task.description).toBe('Committed once, not sent twice');
      }
      expect(await recovering.saveTask()).toBeTruthy();
      expect(writes).toBe(1);
      if (!reload) expect(reads).toBe(2);
      const recoveryCalls = calls.slice(recoveryCallIndex);
      expect(recoveryCalls.length).toBeGreaterThan(0);
      expect(recoveryCalls.every(call => call.method === 'GET')).toBe(true);
      expect(recovering.state.error).toBe(''); expect(recovering.dirty()).toBe(false);
      expect(recovering.draft()?.task.revision).toBe(receiptRevision);
      expect(JSON.parse(storage.get(recoveryKey)!).taskCheckpoints).toEqual([]);
      expect(JSON.parse(storage.get(recoveryKey)!).pending).toBeNull();
      expect(f.service.getEntity('task', task.id)?.revision).toBe(receiptRevision);
    } finally { vi.unstubAllGlobals(); await f.close(); }
  });
  test('a newer remote task is not accepted as the confirmed save and requires explicit comparison', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Task receipt concurrent writer');
      let writes = 0, externalChange = false, receiptRevision = '';
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && isExactTaskRead(url, task.id) && !externalChange) {
          externalChange = true;
          const current = toDooEntitySchemas.task.parse(f.service.getEntity('task', task.id));
          f.service.command({ requestId: crypto.randomUUID(), action: 'update_task', payload: {
            id: task.id, expectedRevision: current.revision, patch: { description: 'Another writer changed it after commit' },
          } });
        }
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'update_task') {
          writes++;
          if (!('snapshot' in result)) throw Error('Expected a task receipt');
          receiptRevision = result.changed.find(entry => entry.kind === 'task' && entry.id === task.id)!.revision;
          return withoutTaskRecord(result, task.id);
        }
        return result;
      });
      await model.load(); model.selectTask(task.id);
      model.draft()!.task.description = 'My confirmed input';
      await model.saveTask();
      const remote = toDooEntitySchemas.task.parse(f.service.getEntity('task', task.id));
      expect(remote.revision).not.toBe(receiptRevision);
      expect(remote.description).toBe('Another writer changed it after commit');
      expect(model.state.conflict).toBe(true); expect(model.state.error).toMatch(/版本|比较|变化|冲突/);
      expect(model.dirty()).toBe(true); expect(model.draft()?.task.description).toBe('My confirmed input');
      expect(model.draft()?.task.revision).not.toBe(remote.revision);
      await model.saveTask(); expect(writes).toBe(1);
      await model.rebaseDraft();
      expect(model.state.draftConflicts).toMatchObject([{ kind: 'task', field: 'description', local: 'My confirmed input', remote: 'Another writer changed it after commit' }]);
      expect(f.service.getEntity('task', task.id)?.revision).toBe(remote.revision);
    } finally { await f.close(); }
  });
  test('text typed while a confirmed task receipt is being read remains a later draft with the new revision', async () => {
    const f = await domainStatusFixture();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    try {
      const task = f.create('Task receipt later input');
      let reached!: () => void;
      const started = new Promise<void>(resolve => { reached = resolve; });
      let pauseRead = true, writes = 0, receiptRevision = '';
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET' && isExactTaskRead(url, task.id) && pauseRead) {
          pauseRead = false; reached(); await wait;
        }
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'update_task') {
          writes++;
          if (!('snapshot' in result)) throw Error('Expected a task receipt');
          receiptRevision = result.changed.find(entry => entry.kind === 'task' && entry.id === task.id)!.revision;
          return withoutTaskRecord(result, task.id);
        }
        return result;
      });
      await model.load(); model.selectTask(task.id);
      model.draft()!.task.description = 'The submitted description';
      const saving = model.saveTask();
      await started;
      expect(f.service.getEntity('task', task.id)).toMatchObject({ description: 'The submitted description', revision: receiptRevision });
      model.draft()!.task.description = 'Typed after commit while verification was pending';
      release(); await saving;
      expect(writes).toBe(1);
      expect(model.draft()?.task).toMatchObject({ description: 'Typed after commit while verification was pending', revision: receiptRevision });
      expect(model.dirty()).toBe(true); expect(model.state.pendingMutation).toBeNull();
      expect(f.service.getEntity('task', task.id)).toMatchObject({ description: 'The submitted description', revision: receiptRevision });
      await model.saveTask();
      expect(writes).toBe(2); expect(model.state.error).toBe(''); expect(model.dirty()).toBe(false);
      expect(f.service.getEntity('task', task.id)).toMatchObject({ description: 'Typed after commit while verification was pending', revision: receiptRevision });
      expect(model.draft()?.task.revision).toBe(receiptRevision);
    } finally { release(); await f.close(); }
  });
  test('general command receipts preserve scoped trees, hydrate copies and captures, and remove moved rows beyond the global reply window', async () => {
    const f = await domainStatusFixture();
    try {
      const createList = (name: string) => f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'list', entity: { name } } }).ids[0];
      const backgroundList = createList('Global rows before the active list');
      const listId = createList('Current scoped command list');
      const movedList = createList('Moved tree destination');
      const create = (title: string, extra: Record<string, unknown> = {}) => {
        const id = f.service.command({ requestId: crypto.randomUUID(), action: 'create_task',
          payload: { title, ...extra } }).ids[0];
        return toDooEntitySchemas.task.parse(f.service.getEntity('task', id));
      };
      const backgroundIds = new Set<string>();
      for (let index = 1; index <= 205; index++)
        backgroundIds.add(create('Global command row ' + String(index).padStart(3, '0'), { listId: backgroundList }).id);
      const originalSection = f.service.command({ requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'section', entity: { name: 'Original group', listId } } }).ids[0];
      const parent = create('Scoped command parent', { listId, sectionId: originalSection });
      const child = create('Scoped command child', { listId, parentTaskId: parent.id });
      const originalIds = [parent.id, child.id];
      const calls: { method: string; url: string }[] = [];
      const commands: ReturnType<typeof toDooCommandSchema.parse>[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        calls.push({ method, url });
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          const command = toDooCommandSchema.parse(body);
          commands.push(command);
          if (!('snapshot' in result)) throw Error('Expected a real command receipt');
          expect(result.snapshot.tasks).toHaveLength(200);
          expect(result.snapshot.tasks.every(task => backgroundIds.has(task.id))).toBe(true);
          if (command.action === 'batch_tasks' && command.payload.operation === 'copy' || command.action === 'create_task')
            expect(result.ids.every(id => !result.snapshot.tasks.some(task => task.id === id))).toBe(true);
        }
        return result;
      });
      const filter = { listIds: [listId] };
      model.state.filter = filter;
      await model.load({ view: 'tasks', limit: 200, filter }); model.selectTask(parent.id);
      const originalQuery = JSON.parse(JSON.stringify(model.state.query));
      const assertScopedRows = (expectedIds: string[]) => {
        const tasks = model.state.snapshot!.tasks;
        expect(tasks.map(task => task.id).sort()).toEqual([...expectedIds].sort());
        expect(tasks.every(task => task.listId === listId && !task.deletedAt)).toBe(true);
        expect(tasks.some(task => backgroundIds.has(task.id))).toBe(false);
        expect(model.state.query).toEqual(originalQuery);
        expect(model.state.filter).toEqual(filter);
      };
      const assertExactTaskReads = (expectedIds: string[], after: number) => {
        const readIds = new Set(calls.slice(after).filter(call => call.method === 'GET').flatMap(call => {
          const params = new URL(call.url, 'https://local').searchParams;
          if (params.get('kind') !== 'task' && !params.get('kinds')?.split(',').includes('task')) return [];
          return (params.get('ids') || params.get('taskIds') || '').split(',').filter(Boolean);
        }));
        for (const id of expectedIds) expect(readIds.has(id)).toBe(true);
      };
      assertScopedRows(originalIds);
      const inserted = await saveTaskSection(model, { name: 'Inserted group', listId }, { beforeId: originalSection });
      expect(inserted).toBeTruthy(); expect(commands.at(-1)?.action).toBe('import_entities');
      assertScopedRows(originalIds);
      const insertedSection = model.state.snapshot!.sections.find(section => section.name === 'Inserted group')!;
      expect(insertedSection).toBeTruthy();
      expect(f.service.getEntity('section', insertedSection.id)).toMatchObject({ listId, name: 'Inserted group', deletedAt: null });
      const deleted = await model.removeEntity('section', insertedSection);
      expect(deleted).toBeTruthy(); assertScopedRows(originalIds);
      expect(f.service.getEntity('section', insertedSection.id)?.deletedAt).not.toBeNull();
      expect(model.state.snapshot!.sections.some(section => section.id === insertedSection.id && !section.deletedAt)).toBe(false);

      model.state.selectedIds = [child.id];
      const copyReadStart = calls.length;
      const copied = await model.batchTasks([parent.id], 'copy');
      expect(copied).toBeTruthy(); expect(copied!.ids).toHaveLength(2);
      const copiedIds = copied!.ids;
      assertExactTaskReads(copiedIds, copyReadStart);
      assertScopedRows([...originalIds, ...copiedIds]);
      expect(model.state.selectedIds).toEqual([child.id]);
      const copiedParent = copied!.snapshot.tasks.find(task => copiedIds.includes(task.id) && !task.parentTaskId)!;
      const copiedChild = copied!.snapshot.tasks.find(task => copiedIds.includes(task.id) && task.parentTaskId === copiedParent.id)!;
      expect(copiedParent).toMatchObject({ title: parent.title + ' 副本', listId });
      expect(copiedChild).toMatchObject({ title: child.title + ' 副本', listId, parentTaskId: copiedParent.id });
      for (const id of copiedIds) {
        const task = toDooEntitySchemas.task.parse(f.service.getEntity('task', id));
        const occurrence = f.service.snapshot({ taskIds: [id] }).occurrences.find(row => row.taskId === id && !row.deletedAt)!;
        expect(occurrence).toBeTruthy();
        expect(copied!.snapshot.tasks.find(row => row.id === id)?.revision).toBe(task.revision);
        expect(model.state.snapshot!.tasks.find(row => row.id === id)?.revision).toBe(task.revision);
        expect(copied!.snapshot.occurrences.find(row => row.id === occurrence.id)).toMatchObject({ taskId: id, revision: occurrence.revision });
        expect(model.state.snapshot!.occurrences.find(row => row.id === occurrence.id)).toMatchObject({ taskId: id, revision: occurrence.revision });
      }

      const priorityReadStart = calls.length;
      const currentParent = model.state.snapshot!.tasks.find(task => task.id === parent.id)!;
      const prioritized = await model.execute({ action: 'update_task', payload: { id: parent.id,
        expectedRevision: currentParent.revision, patch: { priority: 'high' } } });
      expect(prioritized).toBeTruthy(); assertExactTaskReads([parent.id], priorityReadStart);
      assertScopedRows([...originalIds, ...copiedIds]);
      expect(model.state.snapshot!.tasks.find(task => task.id === parent.id)?.priority).toBe('high');
      expect(f.service.getEntity('task', parent.id)).toMatchObject({ priority: 'high', listId });
      expect(model.state.selectedIds).toEqual([child.id]);

      const moved = await model.moveTasks([parent.id], movedList);
      expect(moved).toBeTruthy(); assertScopedRows(copiedIds);
      for (const id of originalIds) {
        expect(f.service.getEntity('task', id)).toMatchObject({ listId: movedList, sectionId: null });
        expect(model.state.snapshot!.tasks.some(task => task.id === id)).toBe(false);
        expect(model.items().some(item => item.task.id === id)).toBe(false);
      }
      expect(f.service.getEntity('task', child.id)).toMatchObject({ parentTaskId: parent.id });

      const composer = model.newTaskDraft(undefined, listId);
      composer.title = 'Created inside the active task list';
      composer.description = 'Submitted through the ordinary task composer';
      const taskCreateStart = calls.length;
      const created = await model.createTask(toDooDraftPayload(composer, 'UTC'));
      expect(created).toBeTruthy();
      const createdId = created!.ids[0];
      assertExactTaskReads([createdId], taskCreateStart); assertScopedRows([...copiedIds, createdId]);
      expect(model.state.selectedTaskId).toBe(createdId);
      expect(model.draft()?.task).toMatchObject({ id: createdId, title: composer.title, listId });
      const createdOccurrence = f.service.snapshot({ taskIds: [createdId] }).occurrences.find(row => row.taskId === createdId && !row.deletedAt)!;
      expect(model.state.selectedOccurrenceId).toBe(createdOccurrence.id);
      expect(created!.snapshot.tasks.find(task => task.id === createdId)).toMatchObject({ title: composer.title, listId });
      expect(created!.snapshot.occurrences.find(row => row.id === createdOccurrence.id)).toMatchObject({ taskId: createdId });
      expect(model.retainedNewTaskDrafts()).toEqual([]);

      model.state.filter = {};
      await model.load({ view: 'workspace', limit: 200 });
      const workspaceIds = model.state.snapshot!.tasks.map(task => task.id);
      const capture = toDooCaptureFromNote({ noteId: 'capture-source-note', title: 'Source material',
        markdown: 'Check the captured source material', savedMarkdown: 'Check the captured source material',
        selection: { anchor: 0, head: 34 }, contentHash: 'capture-content-hash' });
      const captureReadStart = calls.length;
      const captured = await model.createTask({ ...capture, listId });
      expect(captured).toBeTruthy();
      const capturedId = captured!.ids[0];
      assertExactTaskReads([capturedId], captureReadStart);
      expect(model.state.query).toMatchObject({ view: 'workspace', limit: 200 });
      expect(model.state.selectedTaskId).toBe(capturedId);
      expect(model.state.snapshot!.tasks.map(task => task.id).sort()).toEqual([...workspaceIds, capturedId].sort());
      const capturedOccurrence = f.service.snapshot({ taskIds: [capturedId] }).occurrences.find(row => row.taskId === capturedId && !row.deletedAt)!;
      expect(model.state.selectedOccurrenceId).toBe(capturedOccurrence.id);
      for (const data of [model.state.snapshot!, captured!.snapshot]) {
        expect(data.tasks.find(task => task.id === capturedId)).toMatchObject({ id: capturedId, title: capture.title,
          listId, noteRefs: [{ noteId: 'capture-source-note', role: 'source' }], source: { noteId: 'capture-source-note', quote: capture.description } });
        expect(data.occurrences.find(row => row.id === capturedOccurrence.id)).toMatchObject({ taskId: capturedId, revision: capturedOccurrence.revision });
      }
      expect(f.service.getEntity('task', capturedId)).toMatchObject({ title: capture.title, listId, source: { noteId: 'capture-source-note' } });
      expect(model.state.pendingMutation).toBeNull(); expect(model.state.error).toBe('');
      expect(commands.map(command => command.action)).toEqual([
        'import_entities', 'delete_entity', 'batch_tasks', 'update_task', 'batch_tasks', 'create_task', 'create_task',
      ]);
    } finally { await f.close(); }
  }, 45000);
  test('a confirmed create with a failed entity read clears only the submitted composer and recovers by GET without creating twice', async () => {
    const f = await domainStatusFixture();
    try {
      let createdId = '', createWrites = 0, failedReads = 0;
      const calls: { method: string; url: string }[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        calls.push({ method, url });
        if (method === 'GET' && createdId && isExactTaskRead(url, createdId) && failedReads === 0) {
          failedReads++;
          throw Error('The confirmed task cannot be read back yet');
        }
        const result = await f.request(url, method, body);
        if (method === 'POST' && toDooCommandSchema.parse(body).action === 'create_task') {
          createWrites++;
          if (!('snapshot' in result)) throw Error('Expected the real confirmed creation receipt');
          createdId = result.ids.find(id => result.changed.some(row => row.kind === 'task' && row.id === id))!;
          return withoutTaskRecord(result, createdId);
        }
        return result;
      });
      await model.load({ view: 'workspace', limit: 200 });
      const composer = model.newTaskDraft();
      composer.title = 'Confirmed creation despite a missing reply-window entity';
      composer.description = 'A second Enter must not create this task again';
      const result = await model.createTask(toDooDraftPayload(composer, 'UTC'));
      expect(result).toBeTruthy(); expect(createdId).toBeTruthy();
      expect(result!.ids).toContain(createdId);
      expect(result!.changed).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task', id: createdId })]));
      expect(createWrites).toBe(1); expect(failedReads).toBe(1);
      expect(f.service.getEntity('task', createdId)).toMatchObject({ title: composer.title, description: composer.description });
      expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
      expect(model.state.newTaskDrafts).toEqual({});
      expect(model.retainedNewTaskDrafts()).toEqual([]); expect(model.hasNewTaskDraft()).toBe(false);
      expect(model.state.selectedTaskId).toBe(createdId);
      expect(model.draft()).toBeUndefined();
      expect(model.state.snapshot!.tasks.some(task => task.id === createdId)).toBe(false);
      expect(result!.snapshot.tasks.some(task => task.id === createdId)).toBe(false);
      expect(model.state.localWarning).toMatch(/已保存|已创建/);
      expect(model.state.localWarning).toMatch(/核对|读取|刷新/);
      expect(model.state.pendingMutation).toBeNull();
      const readStart = calls.length;
      const recovered = await model.ensureTask(model.state.selectedTaskId);
      expect(recovered).toBeTruthy();
      const reads = calls.slice(readStart);
      expect(reads.length).toBeGreaterThan(0); expect(reads.every(call => call.method === 'GET')).toBe(true);
      expect(reads.some(call => new URL(call.url, 'https://local').searchParams.get('taskIds') === createdId)).toBe(true);
      const stored = toDooEntitySchemas.task.parse(f.service.getEntity('task', createdId));
      const occurrence = f.service.snapshot({ taskIds: [createdId] }).occurrences.find(row => row.taskId === createdId && !row.deletedAt)!;
      expect(model.state.snapshot!.tasks.find(task => task.id === createdId)).toMatchObject({ title: composer.title, revision: stored.revision });
      expect(model.state.snapshot!.occurrences.find(row => row.id === occurrence.id)).toMatchObject({ taskId: createdId, revision: occurrence.revision });
      expect(model.state.selectedTaskId).toBe(createdId); expect(model.hasNewTaskDraft()).toBe(false);
      expect(createWrites).toBe(1); expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
    } finally { await f.close(); }
  });
  test('a generic time-block editor without detail ownership still reads a confirmed far-date block into state and its returned snapshot', async () => {
    const f = await domainStatusFixture();
    try {
      const task = f.create('Generic time-block receipt');
      const blockId = 'generic-block-' + crypto.randomUUID();
      const reads: URLSearchParams[] = [];
      let writes = 0, receiptRevision = '';
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        if (method === 'GET') reads.push(new URL(url, 'https://local').searchParams);
        const result = await f.request(url, method, body);
        if (method === 'POST') {
          const command = toDooCommandSchema.parse(body);
          expect(command).toMatchObject({ action: 'save_entity', payload: { kind: 'timeBlock', entity: { id: blockId } } });
          writes++;
          if (!('snapshot' in result)) throw Error('Expected the real time-block transaction receipt');
          expect(result.snapshot.timeBlocks.some(block => block.id === blockId)).toBe(false);
          receiptRevision = result.changed.find(row => row.kind === 'timeBlock' && row.id === blockId)!.revision;
        }
        return result;
      });
      await model.load({ view: 'tasks', limit: 200 }); model.selectTask(task.id);
      const occurrenceId = model.state.selectedOccurrenceId;
      const result = await model.saveEntity('timeBlock', { id: blockId, occurrenceId,
        title: 'Direct entity editor plan', start: { date: '2030-05-17', time: '10:30', timeZone: 'UTC' },
        durationMinutes: 45, allDay: false, dateEndExclusive: null });
      expect(result).toBeTruthy(); expect(writes).toBe(1); expect(receiptRevision).toBeTruthy();
      expect(reads.some(params => (params.get('kind') === 'timeBlock' || params.get('kinds')?.split(',').includes('timeBlock')) &&
        params.get('ids')?.split(',').includes(blockId))).toBe(true);
      const block = toDooEntitySchemas.timeBlock.parse(f.service.getEntity('timeBlock', blockId));
      const occurrence = toDooEntitySchemas.occurrence.parse(f.service.getEntity('occurrence', occurrenceId));
      expect(block.revision).toBe(receiptRevision);
      for (const data of [model.state.snapshot!, result!.snapshot]) {
        expect(data.timeBlocks.find(row => row.id === blockId)).toMatchObject({ occurrenceId,
          revision: receiptRevision, start: { date: '2030-05-17', time: '10:30' }, durationMinutes: 45 });
        expect(data.occurrences.find(row => row.id === occurrenceId)).toMatchObject({ revision: occurrence.revision, scheduleRevision: occurrence.scheduleRevision });
        expect(data.tasks.some(row => row.id === task.id)).toBe(true);
      }
      expect(f.service.snapshot({ taskIds: [task.id] }).timeBlocks).toHaveLength(1);
      expect(model.state.pendingMutation).toBeNull(); expect(model.state.error).toBe('');
    } finally { await f.close(); }
  });
  test('an externally confirmed attachment refreshes the clean selected task beyond row 200 using only GETs', async () => {
    const f = await domainStatusFixture();
    let restoreAssetRead = () => {};
    try {
      const ids: string[] = [];
      for (let index = 1; index <= 205; index++)
        ids.push(f.service.command({ requestId: crypto.randomUUID(), action: 'create_task',
          payload: { title: 'External attachment row ' + String(index).padStart(3, '0') } }).ids[0]);
      const taskId = ids[204];
      const calls: { method: string; url: string }[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        calls.push({ method, url });
        return f.request(url, method, body);
      });
      await model.load({ view: 'tasks', limit: 500 }); model.selectTask(taskId);
      expect(model.dirty()).toBe(false); expect(model.draft()?.task.attachments).toEqual([]);
      const loadedIds = model.state.snapshot!.tasks.map(task => task.id);
      expect(loadedIds).toHaveLength(205);
      const page = JSON.parse(JSON.stringify(model.state.snapshot!.page));
      const taskPage = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages!.task!));
      const occurrenceId = model.state.selectedOccurrenceId;
      const bytes = Buffer.from('In-memory attachment receipt proof');
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const knowledgeData = await import('../packages/core/knowledge-data');
      const originalRead = knowledgeData.readKnowledgeDataFile;
      const assetRead = vi.spyOn(knowledgeData, 'readKnowledgeDataFile').mockImplementation((root, relative) =>
        relative === 'apps/to-doo/assets/' + hash ? bytes : originalRead(root, relative));
      restoreAssetRead = () => assetRead.mockRestore();
      const attachment = { hash, name: 'receipt-proof.txt', mime: 'text/plain', size: bytes.length };
      const commandContext = model.captureCommandResultContext();
      const result = f.service.command({ requestId: crypto.randomUUID(), action: 'attach_asset',
        payload: { taskId, expectedRevision: model.draft()!.task.revision, attachment } });
      expect(result.snapshot.tasks).toHaveLength(200);
      expect(result.snapshot.tasks.some(task => task.id === taskId)).toBe(false);
      const revision = result.changed.find(row => row.kind === 'task' && row.id === taskId)!.revision;
      const readStart = calls.length;
      expect(await model.acceptCommandResult(result, commandContext)).toBe(true);
      const reads = calls.slice(readStart);
      expect(reads.length).toBeGreaterThan(0); expect(reads.every(call => call.method === 'GET')).toBe(true);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(model.state.snapshot!.tasks.map(task => task.id)).toEqual(loadedIds);
      expect(model.state.snapshot!.page).toMatchObject(pagingContext(page));
      expect(model.state.snapshot!.collectionPages!.task).toMatchObject(pagingContext(taskPage));
      expect(model.state.selectedTaskId).toBe(taskId); expect(model.state.selectedOccurrenceId).toBe(occurrenceId);
      expect(model.draft()?.task).toMatchObject({ id: taskId, revision, attachments: [attachment] });
      expect(model.state.snapshot!.tasks.find(task => task.id === taskId)).toMatchObject({ revision, attachments: [attachment] });
      expect(f.service.getEntity('task', taskId)).toMatchObject({ revision, attachments: [attachment] });
      expect(model.dirty()).toBe(false);
      const beforeForeign = JSON.stringify(model.state);
      const foreignContext = model.captureCommandResultContext();
      expect(await model.acceptCommandResult({ ...result, snapshot: { ...result.snapshot, datasetId: 'foreign-attachment-library' } }, foreignContext)).toBe(false);
      expect(JSON.stringify(model.state)).toBe(beforeForeign);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { restoreAssetRead(); await f.close(); }
  }, 30000);
  test('an old external attachment response cannot replace a newer task read after its POST was captured', async () => {
    const f = await domainStatusFixture();
    let restoreAssetRead = () => {};
    try {
      const task = f.create('Before the delayed external attachment response');
      const calls: { method: string; url: string }[] = [];
      const model = createToDooWorkbench(async (url, method = 'GET', body) => {
        calls.push({ method, url }); return f.request(url, method, body);
      });
      await model.load({ view: 'tasks', limit: 200 }); model.selectTask(task.id);
      const bytes = Buffer.from('Delayed external receipt proof');
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const knowledgeData = await import('../packages/core/knowledge-data');
      const originalRead = knowledgeData.readKnowledgeDataFile;
      const assetRead = vi.spyOn(knowledgeData, 'readKnowledgeDataFile').mockImplementation((root, relative) =>
        relative === 'apps/to-doo/assets/' + hash ? bytes : originalRead(root, relative));
      restoreAssetRead = () => assetRead.mockRestore();
      const attachment = { hash, name: 'delayed-proof.txt', mime: 'text/plain', size: bytes.length };
      const postedContext = model.captureCommandResultContext();
      const delayed = f.service.command({ requestId: crypto.randomUUID(), action: 'attach_asset',
        payload: { taskId: task.id, expectedRevision: model.draft()!.task.revision, attachment } });
      const attached = toDooEntitySchemas.task.parse(f.service.getEntity('task', task.id));
      expect(delayed.changed).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task', id: task.id, revision: attached.revision })]));
      f.service.command({ requestId: crypto.randomUUID(), action: 'update_task', payload: {
        id: task.id, expectedRevision: attached.revision,
        patch: { title: 'Newer task title from another writer', description: 'The later read must remain authoritative', priority: 'high' },
      } });
      await model.load({ view: 'tasks', limit: 200 });
      const current = toDooEntitySchemas.task.parse(f.service.getEntity('task', task.id));
      expect(current.revision).not.toBe(attached.revision);
      expect(model.draft()?.task).toMatchObject({ title: current.title, description: current.description,
        priority: 'high', revision: current.revision, attachments: [attachment] });
      const before = JSON.stringify(model.state), readCount = calls.length;
      expect(await model.acceptCommandResult(delayed, postedContext)).toBe(false);
      expect(JSON.stringify(model.state)).toBe(before);
      expect(calls).toHaveLength(readCount); expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(f.service.getEntity('task', task.id)).toMatchObject({ title: 'Newer task title from another writer',
        description: 'The later read must remain authoritative', priority: 'high', revision: current.revision, attachments: [attachment] });
    } finally { restoreAssetRead(); await f.close(); }
  });
});
