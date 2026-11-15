import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as contextNavigation from '../apps/web/to-doo-context-navigation';
import * as controls from '../apps/web/to-doo-controls';
import * as actionGuards from '../apps/web/to-doo-action-guard';
import * as clock from '../apps/web/to-doo-time';
import { TO_DOO_COLLECTIONS, toDooCommandSchema, toDooEntitySchemas } from '../shared/to-doo-contracts';

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('document', {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});

function fixture() {
  const stamp = {
    revision: 'r1',
    createdAt: '2026-10-30T08:00:00Z',
    updatedAt: '2026-10-30T08:00:00Z',
  };
  return {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((key) => [key, []])),
    datasetId: 'outcome-ownership',
    version: '1',
    now: stamp.createdAt,
    settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings' }),
    tasks: [
      toDooEntitySchemas.task.parse({ ...stamp, id: 'task-a', title: '准备报告' }),
      toDooEntitySchemas.task.parse({ ...stamp, id: 'task-b', title: '整理资料' }),
    ],
    occurrences: [
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-a',
        taskId: 'task-a',
        cycleKey: '2026-10-30',
        scheduleRevision: 'r1',
        scheduledDate: '2026-10-30',
      }),
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-a-next',
        taskId: 'task-a',
        cycleKey: '2026-10-31',
        scheduleRevision: 'r1',
        scheduledDate: '2026-10-31',
      }),
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-b',
        taskId: 'task-b',
        cycleKey: 'once',
        scheduleRevision: 'r1',
      }),
    ],
    page: { kind: null, total: 2, limit: 200, nextCursor: null, truncated: false, counts: {} },
    statistics: {
      completed: 0,
      pending: 3,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    warnings: [],
  };
}

function component(path: string, request: (...args: any[]) => Promise<any>) {
  const { descriptor } = parse(
    readFileSync(new URL('../apps/web/components/' + path + '.vue', import.meta.url), 'utf8'),
  );
  const script = compileScript(descriptor, { id: path });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
      if (id.endsWith('/to-doo-context-navigation')) return contextNavigation;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id.endsWith('/to-doo-action-guard')) return actionGuards;
      if (id.endsWith('/to-doo-time')) return clock;
      if (id === '../api') return { api: request };
      if (id === '../preferences') return { resolvedTheme: Vue.ref('light') };
      if (id === '../ant-design') return { toDooAntTheme: () => ({}) };
      if (id === 'ant-design-vue' || id.endsWith('.vue') || id.endsWith('.css')) return {};
      throw Error('Unexpected component dependency: ' + id);
    },
    output,
    output.exports,
  );
  return { ...output.exports.default, render: () => null };
}

function mount(subject: any, props: Record<string, any>) {
  const renderer = Vue.createRenderer<any, any>({
    createComment: () => ({}),
    createElement: () => ({}),
    createText: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const subjectRef = Vue.ref<any>();
  let confirmation!: ReturnType<typeof controls.provideToDooConfirm>;
  const app = renderer.createApp({
    setup() {
      confirmation = controls.provideToDooConfirm();
      return () => Vue.h(subject, { ...props, ref: subjectRef });
    },
  });
  app.mount({});
  const instance = subjectRef.value;
  cleanup.push(() => app.unmount());
  return { instance, state: (instance.$ as any).setupState, confirmation, unmount: () => app.unmount() };
}

async function workspace(failOutcome: boolean | 'once' = false) {
  const data = fixture();
  const writes: Record<string, any>[] = [];
  const taskWrites: Record<string, any>[] = [];
  const acceptedOutcomeRequests = new Set<string>();
  const request = async (url: string, method = 'GET', body?: Record<string, any>) => {
    if (url.startsWith('/api/to-doo/state?')) return structuredClone(data);
    if (url.startsWith('/api/to-doo/operations'))
      return { operations: [], page: { nextCursor: null } };
    if (url === '/api/to-doo/commands' && method === 'POST') {
      const command = toDooCommandSchema.parse(body);
      taskWrites.push(command);
      let changed: { kind: string; id: string; revision: string }[] = [];
      if (command.action === 'update_task') {
        const task = data.tasks.find(task => task.id === command.payload.id)!;
        expect(command.payload.expectedRevision).toBe(task.revision);
        Object.assign(task, command.payload.patch, { revision: 'task-r' + taskWrites.length });
        changed = [{ kind: 'task', id: task.id, revision: task.revision }];
      } else if (command.action === 'save_entity' && command.payload.kind === 'occurrence') {
        const occurrence = data.occurrences.find(o => o.id === command.payload.entity.id)!;
        expect(command.payload.expectedRevision).toBe(occurrence.revision);
        Object.assign(occurrence, command.payload.entity, { revision: 'occ-r' + taskWrites.length });
        changed = [{ kind: 'occurrence', id: occurrence.id, revision: occurrence.revision }];
      } else throw Error('Unexpected guarded outcome command: ' + command.action);
      data.version = String(Number(data.version) + 1);
      return { snapshot: structuredClone(data), changed, ids: changed.map(value => value.id), replayed: false, transactionId: 'tx-' + taskWrites.length };
    }
    if (url === '/api/to-doo/outcome-note' && method === 'POST') {
      writes.push(JSON.parse(JSON.stringify(body)));
      const occurrence = data.occurrences.find(o => o.id === body?.occurrenceId)!;
      if (!acceptedOutcomeRequests.has(body!.requestId) && body!.expectedRevision !== occurrence.revision)
        throw Object.assign(Error('执行版本已变化，请核对后继续'), { status: 409, data: { needsReconciliation: false } });
      acceptedOutcomeRequests.add(body!.requestId);
      if (body?.complete) {
        occurrence.status = 'done';
        occurrence.revision = 'outcome-committed';
      }
      if (failOutcome === true || failOutcome === 'once' && writes.length === 1) throw Error('结果暂未返回，请保留本次请求');
      return { snapshot: structuredClone(data), noteId: 'outcome-note' };
    }
    throw Error('Unexpected request: ' + method + ' ' + url);
  };
  const view = mount(component('ToDooWorkspace', request), {
    section: 'tasks',
    tree: [],
    selection: {},
  });
  for (let i = 0; i < 8; i++) await Vue.nextTick();
  const open = (taskId: string, occurrenceId: string) => {
    view.state.model.selectTask(taskId, occurrenceId);
    view.state.openOutcomeNote();
  };
  let outcomeConfirmation!: ReturnType<typeof controls.provideToDooConfirm>;
  const retain = () => {
    const outcome = mount(component('to-doo/ToDooOutcomeNote', request), {
      model: view.state.model,
      task: view.state.outcomeNote.task,
      occurrence: view.state.outcomeNote.occurrence,
      tree: [],
    });
    view.state.outcomeRef = outcome.instance;
    view.state.outcomeNoteOpen = false;
    outcomeConfirmation = outcome.confirmation;
    return outcome.state;
  };
  return { ...view, open, retain, writes, taskWrites, data, confirmation: () => outcomeConfirmation };
}

async function waitForConfirmation(view: Awaited<ReturnType<typeof workspace>>) {
  for (let i = 0; i < 20 && !view.confirmation().current.value; i++) await Vue.nextTick();
  expect(view.confirmation().current.value?.title).toBe('保存并继续');
}

test('an untouched retained outcome opens for the newly requested task', async () => {
  const view = await workspace();
  view.open('task-a', 'occ-a');
  view.retain();
  view.open('task-b', 'occ-b');
  expect(view.state.outcomeNote.task.id).toBe('task-b');
  expect(view.state.outcomeNote.occurrence.id).toBe('occ-b');
  expect(view.state.outcomeNoteOpen).toBe(true);
});

test.each([
  ['task-b', 'occ-b'],
  ['task-a', 'occ-a-next'],
])(
  'a retained draft keeps its original ownership when opened from %s %s',
  async (taskId, occurrenceId) => {
    const view = await workspace();
    view.open('task-a', 'occ-a');
    const outcome = view.retain();
    outcome.form.title = '尚未保存的报告成果';
    outcome.form.content = '# 报告\n\n需要保留的内容';
    view.open(taskId, occurrenceId);
    expect(view.state.outcomeNote.task.id).toBe('task-a');
    expect(view.state.outcomeNote.occurrence.id).toBe('occ-a');
    expect(view.state.outcomeNoteOpen).toBe(true);
    expect(view.state.state.notice).toContain('准备报告');
    expect(view.state.state.notice).toContain('2026-10-30');
    expect(outcome.form.content).toBe('# 报告\n\n需要保留的内容');
    await outcome.save();
    expect(view.writes).toEqual([
      expect.objectContaining({ occurrenceId: 'occ-a', title: '尚未保存的报告成果' }),
    ]);
  },
);

test('an already submitted outcome remains attached to its original occurrence', async () => {
  const view = await workspace(true);
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  await outcome.save();
  expect(outcome.error).toContain('保留本次请求');
  view.open('task-b', 'occ-b');
  expect(view.state.outcomeNote.task.id).toBe('task-a');
  expect(view.state.outcomeNote.occurrence.id).toBe('occ-a');
  expect(view.state.state.notice).toContain('准备报告');
  await outcome.save();
  expect(view.writes).toHaveLength(2);
  expect(view.writes[1]).toEqual(view.writes[0]);
  expect(view.writes[1].occurrenceId).toBe('occ-a');
});

test('declining task-save confirmation keeps a retained outcome editable without submitting it', async () => {
  const view = await workspace();
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  outcome.form.complete = true;
  view.state.model.draft().task.criteria = '还没有保存的完成标准';
  const saving = outcome.save();
  await waitForConfirmation(view);
  view.confirmation().finish(false);
  await saving;
  expect(view.writes).toEqual([]);
  expect(view.taskWrites).toEqual([]);
  expect(outcome.submitted).toBeUndefined();
  expect(view.state.model.draft().task.criteria).toBe('还没有保存的完成标准');
});

test('fresh complete outcome waits for task save and uses committed criteria and execution revision', async () => {
  const view = await workspace();
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  outcome.form.complete = true;
  view.state.model.draft().task.criteria = '报告经过评审';
  view.state.model.draft().occurrence.due = { date: '2026-11-20', time: null, timeZone: 'UTC' };
  const saving = outcome.save();
  await waitForConfirmation(view);
  expect(view.writes).toEqual([]);
  view.confirmation().finish(true);
  await saving;
  expect(view.taskWrites.map(command => command.action)).toEqual(['update_task', 'save_entity']);
  expect(view.writes).toEqual([expect.objectContaining({
    occurrenceId: 'occ-a', expectedRevision: 'occ-r2', complete: true,
    criteriaResults: [{ label: '报告经过评审', passed: false }],
  })]);
  expect(view.state.model.dirty()).toBe(false);
});

test('a refreshed external revision keeps the outcome opening version until explicit reconciliation', async () => {
  const view = await workspace();
  view.data.tasks[0].criteria = '打开时的完成标准';
  view.state.model.acceptSnapshot(structuredClone(view.data), true);
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  view.data.occurrences[0].revision = 'external-r2';
  view.data.tasks[0].criteria = '外部新完成标准';
  await outcome.save();
  expect(view.taskWrites).toEqual([]);
  expect(view.writes).toEqual([expect.objectContaining({
    expectedRevision: 'r1', criteriaResults: [{ label: '打开时的完成标准', passed: false }],
  })]);
  expect(outcome.error).toContain('执行版本已变化');
  expect(outcome.form.content).toContain('准备报告');
});

test('a dirty different execution of the retained task blocks fresh outcome completion', async () => {
  const view = await workspace();
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  outcome.form.complete = true;
  view.state.model.selectTask('task-a', 'occ-a-next');
  view.state.model.draft().task.description = '下次执行仍有未保存内容';
  view.state.model.selectTask('task-a', 'occ-a');
  await outcome.save();
  expect(view.writes).toEqual([]);
  expect(view.taskWrites).toEqual([]);
  expect(view.state.state.error).toContain('任务草稿');
  expect(outcome.submitted).toBeUndefined();
});

test('switching tasks while the outcome task-save confirmation is pending prevents submission', async () => {
  const view = await workspace();
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  view.state.model.draft().task.description = '保留这份输入';
  const saving = outcome.save();
  await waitForConfirmation(view);
  view.state.model.selectTask('task-b', 'occ-b');
  view.confirmation().finish(true);
  await saving;
  expect(view.writes).toEqual([]);
  expect(view.taskWrites).toEqual([]);
  expect(view.state.model.state.selectedTaskId).toBe('task-b');
});

test('an uncertain original outcome retries its fixed payload and preserves later task input', async () => {
  const view = await workspace('once');
  view.open('task-a', 'occ-a');
  const outcome = view.retain();
  outcome.form.complete = true;
  await outcome.save();
  expect(view.writes).toHaveLength(1);
  view.state.model.draft().task.description = '原提交后继续输入';
  view.state.model.draft().occurrence.due = { date: '2026-12-01', time: null, timeZone: 'UTC' };
  await outcome.save();
  expect(view.writes).toHaveLength(2);
  expect(view.writes[1]).toEqual(view.writes[0]);
  expect(view.taskWrites).toEqual([]);
  expect(view.state.model.draft().task.description).toBe('原提交后继续输入');
  expect(view.state.model.draft().occurrence.due.date).toBe('2026-12-01');
  expect(view.state.model.state.snapshot.occurrences.find((o: any) => o.id === 'occ-a').status).toBe('done');
  expect(view.state.model.dirty()).toBe(true);
});
