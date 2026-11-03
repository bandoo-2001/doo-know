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
import { toDooDraftPayload } from '../apps/web/to-doo-presentation';
import {
  TO_DOO_COLLECTIONS,
  toDooEntitySchemas,
  toDooCommandSchema,
  type ToDooSnapshot,
  type ToDooCollections,
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
  expect((model as any).retainedNewTaskDraft?.()).toMatchObject({
    parentTaskId: 'parent-a',
    listId: 'work',
    title: child.title,
  });
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
