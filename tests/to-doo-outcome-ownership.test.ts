import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as controls from '../apps/web/to-doo-controls';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas } from '../shared/to-doo-contracts';

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
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
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id === '../api') return { api: request };
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
  const app = renderer.createApp(subject, props);
  const instance = app.mount({});
  cleanup.push(() => app.unmount());
  return { instance, state: (instance.$ as any).setupState };
}

async function workspace(failOutcome = false) {
  const data = fixture();
  const writes: Record<string, any>[] = [];
  const request = async (url: string, method = 'GET', body?: Record<string, any>) => {
    if (url.startsWith('/api/to-doo/state?')) return structuredClone(data);
    if (url.startsWith('/api/to-doo/operations'))
      return { operations: [], page: { nextCursor: null } };
    if (url === '/api/to-doo/outcome-note' && method === 'POST') {
      writes.push(JSON.parse(JSON.stringify(body)));
      if (failOutcome) throw Error('结果暂未返回，请保留本次请求');
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
  const retain = () => {
    const outcome = mount(component('to-doo/ToDooOutcomeNote', request), {
      model: view.state.model,
      task: view.state.outcomeNote.task,
      occurrence: view.state.outcomeNote.occurrence,
      tree: [],
    });
    view.state.outcomeRef = outcome.instance;
    view.state.outcomeNoteOpen = false;
    return outcome.state;
  };
  return { ...view, open, retain, writes };
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
