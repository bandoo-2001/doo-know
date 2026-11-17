import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as vueuse from '@vueuse/core';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import * as focusSync from '../apps/web/to-doo-focus-history-sync';
import * as workbench from '../apps/web/to-doo-workbench';
import * as actionGuards from '../apps/web/to-doo-action-guard';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas } from '../shared/to-doo-contracts';

type Node = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const control = (tag: string) =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        Vue.h(tag, attrs, tag === 'Drawer' && !attrs.open ? [] : slots.default?.()),
  });
const controls = toDooAntStubs;
const Input = controls.Input;
function component(
  name: string,
  confirm: (message: string) => Promise<boolean> = async () => false,
  inlineTemplate = true,
): Vue.Component {
  const { descriptor } = parse(
    readFileSync(new URL(`../apps/web/components/to-doo/${name}.vue`, import.meta.url), 'utf8'),
  );
  const compiled = compileScript(descriptor, { id: name, inlineTemplate });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {} };
      if (id === '@vueuse/core') return vueuse;
      if (id === '../../to-doo-focus-history-sync') return focusSync;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-action-guard') return actionGuards;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => confirm };
      if (id === 'ant-design-vue')
        return {
          ...controls,
          Input,
          Menu: Object.assign(controls.Menu, { Item: control('MenuItem') }),
          Tabs: Object.assign(controls.Tabs, { TabPane: control('TabPane') }),
        };
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (
        /ToDoo(PageToolbar|SectionHeader|Focus|FocusTrend|FocusTimerFields|HabitCard|Icon)\.vue$/.test(
          id,
        )
      )
        return { default: component(id.split('/').at(-1)!.replace('.vue', '')) };
      if (id.endsWith('.css')) return {};
      throw Error(`Unexpected dependency: ${id}`);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(name: string, props: Record<string, any>) {
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    insertStaticContent(content, parent) {
      const child = node('#static', content);
      parent.children.push(child);
      return [child, child];
    },
    createElement: (tag) => Object.assign(node(tag), { style: {} }),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const i = anchor ? parent.children.indexOf(anchor) : -1;
      if (i < 0) parent.children.push(child);
      else parent.children.splice(i, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent || null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp(node, key, _before, value) {
      node.props[key] = value;
    },
  });
  const root = node('root'),
    app = renderer.createApp({
      render: () => Vue.h(Vue.KeepAlive, null, { default: () => Vue.h(component(name), props) }),
    });
  const vm = app.mount(root) as any;
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  return {
    vm,
    all,
    text,
    button: (label: string) =>
      all().find((n) => ['button', 'Button'].includes(n.tag) && text(n).trim() === label)!,
    dialog: () => all().find((n) => n.tag === 'Modal' && n.props.open)!,
  };
}

function model(count = 1) {
  const now = '2026-11-03T12:00:00Z';
  const sessions = Array.from({ length: count }, (_, index) =>
    toDooEntitySchemas.focusSession.parse({
      id: `row-${String(index).padStart(4, '0')}`,
      revision: 'r1',
      createdAt: now,
      updatedAt: now,
      mode: 'stopwatch',
      status: 'finished',
      segments: [{ start: new Date(Date.parse(now) - index * 60000).toISOString(), end: now }],
      note: '',
    }),
  );
  const topics = [
    toDooEntitySchemas.focusTopic.parse({
      id: 'topic',
      name: '阅读',
      revision: 'r1',
      createdAt: now,
      updatedAt: now,
    }),
  ];
  const state = Vue.reactive<any>({
    snapshot: {
      ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((name) => [name, []])),
      settings: toDooEntitySchemas.settings.parse({
        id: 'settings',
        revision: 'r1',
        createdAt: now,
        updatedAt: now,
      }),
    },
    externalDirty: {},
    busy: false,
    error: '',
    notice: '',
  });
  const data = { sessions, datasetId: 'fixture', revision: 'r1' };
  const request = vi.fn(async (url: string) => {
    if (!url.includes('/focus/history'))
      return { focusTopics: topics, page: { nextCursor: null as string | null } };
    const query = new URL(url, 'http://fixture').searchParams;
    const rows = data.sessions.filter(
      (row) => !query.get('topicId') || row.topicId === query.get('topicId'),
    );
    const cursor = Number(query.get('cursor') || 0),
      items = rows.slice(cursor, cursor + 50),
      hasMore = cursor + 50 < rows.length;
    return {
      datasetId: data.datasetId,
      revision: data.revision,
      now,
      timeZone: 'UTC',
      active: rows.find((row) => ['running', 'paused'].includes(row.status)) || null,
      items,
      overview: {
        today: { minutes: 0, completed: 0 },
        lifetime: { minutes: 0, completed: 0 },
        filtered: { minutes: 0, completed: 0 },
        byTopic: {},
      },
      page: {
        limit: 50,
        total: rows.length,
        hasMore,
        nextCursor: hasMore ? String(cursor + 50) : null,
      },
    };
  });
  return {
    state,
    execute: vi.fn(async () => ({})),
    request,
    data,
    taskLists: () => state.snapshot.lists,
  };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Vue.nextTick();
}
function button(view: ReturnType<typeof mount>, label: string) {
  return view
    .all()
    .find(
      (n) =>
        n.tag === 'button' && (n.props['aria-label'] === label || view.text(n).trim() === label),
    );
}
function rows(view: ReturnType<typeof mount>) {
  return view.all().filter((n) => n.props['data-session-id']);
}
function refresh(view: ReturnType<typeof mount>) {
  button(view, '刷新专注记录')!.props.onClick();
}

test('future zero buckets are absent from chart while nonzero future data and the complete data table remain', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  const view = mount('ToDooFocusTrend', {
    period: 'week',
    date: '2026-11-03',
    loading: false,
    error: '',
    timeZone: 'UTC',
    trend: {
      period: 'week',
      from: '2026-11-02',
      to: '2026-11-08',
      bucket: 'day',
      totalMinutes: 40,
      points: [
        { date: '2026-11-02', minutes: 10 },
        { date: '2026-11-03', minutes: 25 },
        { date: '2026-11-04', minutes: 0 },
        { date: '2026-11-05', minutes: 5 },
        { date: '2026-11-06', minutes: 0 },
      ],
    },
  });
  expect(
    view
      .all()
      .filter((n) => n.tag === 'circle' && n.props.role === 'button')
      .map((n) => n.props['aria-label']),
  ).toEqual(['2026-11-02：10 分钟', '2026-11-03：25 分钟', '2026-11-05：5 分钟']);
  expect(
    view
      .all()
      .find((n) => n.tag === 'polyline')!
      .props.points.split(' '),
  ).toHaveLength(2);
  expect(view.all().filter((n) => n.tag === 'tr')).toHaveLength(6);
});

test('clearing the timer project starts free focus without changing the history filter', async () => {
  const value = model(),
    view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '选择专注项目 阅读')!.props.onClick();
  await settle();
  expect(button(view, '自由专注')).toBeDefined();
  button(view, '自由专注')!.props.onClick();
  await settle();
  button(view, '开始专注')!.props.onClick();
  await settle();
  expect(value.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'start_focus',
      payload: expect.objectContaining({ topicId: null }),
    }),
    expect.anything(),
  );
});

test('focus and history panes share one tab state while the live timer remains mounted', async () => {
  const value = model();
  value.data.sessions[0].status = 'running';
  const view = mount('ToDooFocus', { model: value });
  await settle();
  const section = (label: string) =>
    view.all().find((node) => node.props['aria-label'] === label) as Node & {
      style: Record<string, string>;
    };
  expect(section('专注概览和历史').style.display).toBe('none');
  expect(section('专注项目').style.display).not.toBe('none');
  expect(button(view, '暂停')).toBeDefined();
  button(view, '历史')!.props.onClick();
  await settle();
  expect(section('专注概览和历史').style.display).not.toBe('none');
  expect(section('专注项目').style.display).toBe('none');
  expect(button(view, '暂停')).toBeDefined();
  button(view, '专注')!.props.onClick();
  await settle();
  expect(section('专注概览和历史').style.display).toBe('none');
  expect(button(view, '暂停')).toBeDefined();
  expect(value.execute).not.toHaveBeenCalled();
});

test('project creation and archive browsing remain reachable from project actions', async () => {
  const value = model(),
    edit = vi.fn(),
    view = mount('ToDooFocus', { model: value, onEdit: edit });
  await settle();
  const menuItem = (text: string) =>
    view.all().find((node) => node.tag === 'MenuItem' && view.text(node) === text)!;
  expect(button(view, '专注项目更多')).toBeDefined();
  menuItem('新建项目').props.onClick();
  expect(edit).toHaveBeenCalledWith('focusTopic');
  menuItem('已归档项目').props.onClick();
  await settle();
  expect(menuItem('进行中项目')).toBeDefined();
  expect(menuItem('查看全部记录')).toBeDefined();
});

test('corrected history marks the displayed duration including a zero-minute correction', async () => {
  const value = model();
  value.data.sessions[0].correctedMinutes = 0;
  const view = mount('ToDooFocus', { model: value });
  await settle();
  expect(rows(view).map(view.text).join('')).toContain('已修正');
});

test('same-scope refresh reconciles additions beyond fifty and deletions without dropping loaded older pages', async () => {
  const value = model(130),
    view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '加载更早记录')!.props.onClick();
  await settle();
  expect(rows(view)).toHaveLength(100);
  const originals = [...value.data.sessions];
  const additions = Array.from({ length: 65 }, (_, i) => ({
    ...originals[0],
    id: `new-${i}`,
    segments: [
      {
        start: new Date(Date.parse(originals[0].segments[0].start) + (i + 1) * 60000).toISOString(),
        end: null,
      },
    ],
  })).reverse();
  value.data.sessions = [...additions, ...originals.filter((row) => row.id !== 'row-0070')];
  value.data.revision = 'r2';
  refresh(view);
  await settle();
  const ids = rows(view).map((n) => n.props['data-session-id']);
  expect(ids).toContain('row-0099');
  expect(ids).not.toContain('row-0070');
  expect(ids.slice(0, 65)).toEqual(additions.map((row) => row.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(164);
});

test('a previously complete history discovers backdated records on refresh', async () => {
  const value = model(70),
    view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '加载更早记录')!.props.onClick();
  await settle();
  value.data.sessions.push({
    ...value.data.sessions[69],
    id: 'backdated',
    segments: [{ start: '2020-01-01T12:00:00Z', end: '2020-01-01T12:01:00Z' }],
  });
  value.data.revision = 'r2';
  refresh(view);
  await settle();
  expect(rows(view).map((n) => n.props['data-session-id'])).toContain('backdated');
  expect(rows(view)).toHaveLength(71);
});

test('an activity poll includes another device record and keeps the loaded older page', async () => {
  vi.useFakeTimers();
  const value = model(80),
    view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '加载更早记录')!.props.onClick();
  await settle();
  value.data.sessions.unshift({
    ...value.data.sessions[0],
    id: 'other-device',
    segments: [{ start: '2026-11-04T12:00:00Z', end: '2026-11-04T12:01:00Z' }],
  });
  value.data.revision = 'r2';
  await vi.advanceTimersByTimeAsync(10001);
  await settle();
  expect(rows(view)).toHaveLength(81);
  expect(rows(view)[0].props['data-session-id']).toBe('other-device');
  expect(rows(view).at(-1)!.props['data-session-id']).toBe('row-0079');
});

test('a delayed reconciliation page cannot overwrite the newly selected history scope', async () => {
  const value = model(100),
    view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '加载更早记录')!.props.onClick();
  await settle();
  value.data.revision = 'r2';
  const native = value.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  value.request.mockImplementation(async (url: string) => {
    const response = await native(url);
    if (url.includes('cursor=') && !url.includes('topicId=')) {
      entered = true;
      await gate;
    }
    return response;
  });
  refresh(view);
  await settle();
  expect(entered).toBe(true);
  view
    .all()
    .find((n) => n.tag === 'select' && n.props['aria-label'] === '专注记录项目')!
    .props.onChange('topic');
  await settle();
  expect(rows(view)).toHaveLength(0);
  release();
  await settle();
  expect(rows(view)).toHaveLength(0);
});

test('a dataset switch while a history read is pending discards its stale response', async () => {
  const value = model(70),
    view = mount('ToDooFocus', { model: value });
  await settle();
  const native = value.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  value.request.mockImplementation(async (url: string) => {
    const result = await native(url);
    await gate;
    return result;
  });
  refresh(view);
  await settle();
  value.state.snapshot.datasetId = 'replacement';
  value.data.datasetId = 'replacement';
  value.data.sessions = [];
  release();
  await settle();
  // The old response cannot publish into the new dataset; the next read replaces the list.
  value.request.mockImplementation(native);
  refresh(view);
  await settle();
  expect(rows(view)).toHaveLength(0);
});

test('a fresh timer state is applied before slow history reconciliation pages finish', async () => {
  const value = model(70);
  value.data.sessions[0].status = 'running';
  const view = mount('ToDooFocus', { model: value });
  await settle();
  button(view, '加载更早记录')!.props.onClick();
  await settle();
  expect(button(view, '暂停')).toBeDefined();
  value.data.sessions[0] = { ...value.data.sessions[0], status: 'finished' };
  value.data.revision = 'r2';
  const native = value.request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  value.request.mockImplementation(async (url: string) => {
    const response = await native(url);
    if (url.includes('cursor=')) await gate;
    return response;
  });
  refresh(view);
  await settle();
  try {
    expect(button(view, '开始专注')).toBeDefined();
    expect(button(view, '开始专注')!.props.disabled).toBe(false);
  } finally {
    release();
    await settle();
  }
});

test('history responses from a different snapshot dataset cannot populate the current page', async () => {
  const value = model(1);
  value.state.snapshot.datasetId = 'fixture';
  const view = mount('ToDooFocus', { model: value });
  await settle();
  value.data.datasetId = 'other-dataset';
  value.data.sessions = [{ ...value.data.sessions[0], id: 'wrong-dataset-row' }];
  refresh(view);
  await settle();
  expect(rows(view).map((n) => n.props['data-session-id'])).toEqual(['row-0000']);
});

test('changing projects keeps the visible task choice while free focus clears both targets', async () => {
  const value = model();
  value.state.snapshot.tasks = [{ id: 'task', title: '已关联行动', listId: 'inbox' }];
  value.state.snapshot.occurrences = [{ id: 'action', taskId: 'task', status: 'todo' }];
  const view = mount('ToDooFocus', { model: value, occurrenceId: 'action' });
  await settle();
  button(view, '选择专注项目 阅读')!.props.onClick();
  await settle();
  expect(view.all().find((n) => n.props['aria-label'] === '专注任务')!.props.value).toBe('action');
  button(view, '自由专注')!.props.onClick();
  await settle();
  button(view, '开始专注')!.props.onClick();
  await settle();
  expect(value.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'start_focus',
      payload: expect.objectContaining({ occurrenceId: null, topicId: null }),
    }),
    expect.anything(),
  );
});

function completionFixture() {
  const value = model();
  const stamp = {
    revision: 'r1',
    createdAt: '2026-11-03T12:00:00Z',
    updatedAt: '2026-11-03T12:00:00Z',
  };
  const task = toDooEntitySchemas.task.parse({ ...stamp, id: 'task', title: '完成专注后的行动' });
  const occurrence = toDooEntitySchemas.occurrence.parse({
    ...stamp,
    id: 'occ',
    taskId: task.id,
    cycleKey: 'single',
    scheduleRevision: 's1',
  });
  const session = toDooEntitySchemas.focusSession.parse({
    ...value.data.sessions[0],
    occurrenceId: occurrence.id,
  });
  Object.assign(value.state, { selectedTaskId: task.id, selectedOccurrenceId: occurrence.id });
  Object.assign(value.state.snapshot, {
    datasetId: 'fixture',
    tasks: [task],
    occurrences: [occurrence],
  });
  const events: string[] = [];
  const extra = {
    ensureTask: vi.fn(async () => {
      events.push('ensure');
      return true;
    }),
    prepareTaskAction: vi.fn(async () => {
      events.push('prepare');
      return [] as any[];
    }),
    saveTask: vi.fn(async () => {
      events.push('save');
      return true;
    }),
    dirty: vi.fn().mockReturnValue(false),
    validateTaskDraft: vi.fn().mockReturnValue(true),
    taskDefinitions: () => value.state.snapshot.tasks,
    statusChildCount: vi.fn(async () => {
      events.push('count');
      return 0 as number | null;
    }),
    setStatus: vi.fn(async () => {
      events.push('status');
      return {};
    }),
  };
  const request = value.request;
  value.request = vi.fn(async (url: string) =>
    url.includes('kind=occurrence')
      ? { datasetId: 'fixture', occurrences: [occurrence] }
      : request(url),
  ) as typeof value.request;
  const subjectModel = Object.assign(value, extra);
  const confirm = vi.fn().mockResolvedValue(true);
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
  const subject = { ...(component('ToDooFocus', confirm, false) as any), render: () => null };
  const app = renderer.createApp(subject, { model: subjectModel });
  const instance = app.mount({});
  cleanups.push(() => app.unmount());
  const setup = (instance.$ as any).setupState;
  setup.visible = true;
  setup.finishedTaskSession = session;
  return { model: subjectModel, session, occurrence, confirm, events, setup };
}

test('focus completion checks the task draft before resolving the final child scope', async () => {
  const f = completionFixture();
  f.model.prepareTaskAction
    .mockResolvedValueOnce([
      { key: 'task@occ', taskId: 'task', occurrenceId: 'occ', title: '任务', kind: 'task' },
    ])
    .mockResolvedValueOnce([]);
  await f.setup.completeSessionTask(f.session);
  expect(f.model.prepareTaskAction).toHaveBeenCalledWith(['task'], true);
  expect(f.model.saveTask).toHaveBeenCalledOnce();
  expect(f.events.indexOf('save')).toBeLessThan(f.events.indexOf('count'));
  expect(f.model.setStatus).toHaveBeenCalledWith('occ', 'done', false);
  expect(f.setup.finishedTaskSession).toBeUndefined();
});

test('a hidden child draft prevents completing a focus task and leaves its feedback available', async () => {
  const f = completionFixture();
  f.model.prepareTaskAction.mockResolvedValue([
    {
      key: 'child@other-occ',
      taskId: 'child',
      occurrenceId: 'other-occ',
      title: '子任务',
      kind: 'task',
    },
  ]);
  await f.setup.completeSessionTask(f.session);
  expect(f.model.saveTask).not.toHaveBeenCalled();
  expect(f.model.statusChildCount).not.toHaveBeenCalled();
  expect(f.model.setStatus).not.toHaveBeenCalled();
  expect(f.model.state.error).toContain('任务草稿');
  expect(f.setup.finishedTaskSession.id).toBe(f.session.id);
});

test.each([
  'cancel',
  'invalid',
  'failed',
  'new-selection',
  'replaced-feedback',
  'deactivated',
] as const)('focus completion preserves the task for %s', async (reason) => {
  const f = completionFixture();
  f.model.prepareTaskAction.mockResolvedValue([
    { key: 'task@occ', taskId: 'task', occurrenceId: 'occ', title: '任务', kind: 'task' },
  ]);
  if (reason === 'invalid') f.model.validateTaskDraft.mockReturnValue(false);
  if (reason === 'failed') f.model.saveTask.mockResolvedValue(false);
  f.confirm.mockImplementation(async () => {
    if (reason === 'new-selection') f.model.state.selectedOccurrenceId = 'other-occ';
    if (reason === 'replaced-feedback')
      f.setup.finishedTaskSession = { ...f.session, id: 'other-session' };
    if (reason === 'deactivated') f.setup.visible = false;
    return reason !== 'cancel';
  });
  await f.setup.completeSessionTask(f.session);
  expect(f.model.setStatus).not.toHaveBeenCalled();
  expect(f.model.statusChildCount).not.toHaveBeenCalled();
  expect(f.setup.finishedTaskSession).toBeDefined();
});

test('a changed session occurrence while its read is pending cannot complete the replacement', async () => {
  const f = completionFixture();
  f.model.request.mockImplementationOnce(async () => {
    f.session.occurrenceId = 'another-occ';
    return { datasetId: 'fixture', occurrences: [{ ...f.occurrence, id: 'another-occ' }] } as any;
  });
  await f.setup.completeSessionTask(f.session);
  expect(f.model.prepareTaskAction).not.toHaveBeenCalled();
  expect(f.model.setStatus).not.toHaveBeenCalled();
});

test('cancelling the descendant confirmation leaves the focused task incomplete', async () => {
  const f = completionFixture();
  f.model.statusChildCount.mockResolvedValue(2);
  f.confirm.mockResolvedValue(false);
  await f.setup.completeSessionTask(f.session);
  expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('2 个子任务'));
  expect(f.model.setStatus).not.toHaveBeenCalled();
});

function isolatedFocus(
  confirm = vi.fn<(_: string) => Promise<boolean>>().mockResolvedValue(true),
  count = 2,
  extraProps: Record<string, any> = {},
) {
  const subject = Object.assign(model(count), { saveEntity: vi.fn(async () => ({})) });
  subject.state.snapshot.datasetId = 'fixture';
  subject.state.snapshot.version = 'same-version';
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
  const implementation = {
    ...(component('ToDooFocus', confirm, false) as any),
    render: () => null,
  };
  const onTask = vi.fn();
  const app = renderer.createApp(implementation, { ...extraProps, model: subject, onTask });
  const instance = app.mount({});
  cleanups.push(() => app.unmount());
  const setup = (instance.$ as any).setupState;
  setup.visible = true;
  return {
    subject,
    setup,
    confirm,
    onTask,
    setContext: (value: string) => {
      (instance.$ as any).props.context = value;
    },
  };
}

function focusNavigationFixture(acknowledgeImmediately = true) {
  const portalItem = {},
    projectButton = {},
    outside = {};
  const document = {
    activeElement: portalItem,
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('document', document);
  let fixture: ReturnType<typeof isolatedFocus>;
  fixture = isolatedFocus(undefined, 2, {
    context: 'projects',
    contextualNavigation: true,
    onContextChange: (value: string) => {
      if (acknowledgeImmediately) fixture.setContext(value);
    },
  });
  fixture.setup.narrowTimer = true;
  const projects = { contains: vi.fn((element: unknown) => element === projectButton) };
  const records = {
    setAttribute: vi.fn(),
    focus: vi.fn(() => {
      document.activeElement = records;
    }),
    contains: vi.fn(() => false),
  };
  fixture.setup.projectsSection = projects;
  fixture.setup.recordsSection = records;
  return { ...fixture, document, portalItem, projectButton, outside, projects, records };
}

test.each(['all', 'project'] as const)(
  'an explicit %s history action focuses its visible pane even when the menu item is portalled',
  async (action) => {
    const f = focusNavigationFixture();
    await settle();
    expect(f.projects.contains(f.document.activeElement)).toBe(false);
    if (action === 'all') f.setup.viewAllHistory();
    else f.setup.viewTopicHistory({ id: 'topic' });
    await settle();
    expect(f.setup.mobilePane).toBe('history');
    expect(f.records.setAttribute).toHaveBeenCalledWith('tabindex', '-1');
    expect(f.records.focus).toHaveBeenCalledOnce();
    expect(f.records.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(f.subject.execute).not.toHaveBeenCalled();
  },
);

test.each(['all', 'project'] as const)(
  'an explicit %s history action navigates without a DOM and keeps focus optional',
  async (action) => {
    expect(typeof document).toBe('undefined');
    const onContextChange = vi.fn();
    const f = isolatedFocus(undefined, 2, { context: 'projects', onContextChange });
    const projects = { contains: vi.fn(() => false) };
    const records = { contains: vi.fn(() => false), setAttribute: vi.fn(), focus: vi.fn() };
    f.setup.projectsSection = projects;
    f.setup.recordsSection = records;
    await settle();
    if (action === 'all') f.setup.viewAllHistory();
    else f.setup.viewTopicHistory({ id: 'topic' });
    await settle();
    expect(onContextChange).toHaveBeenLastCalledWith('history');
    expect(f.setup.topicFilter).toBe(action === 'all' ? '' : 'topic');
    f.setContext('history');
    await settle();
    expect(f.setup.mobilePane).toBe('history');
    expect(projects.contains).not.toHaveBeenCalled();
    expect(records.focus).not.toHaveBeenCalled();
    expect(f.subject.execute).not.toHaveBeenCalled();
  },
);

test('an external pane update keeps focus on a control outside the leaving pane', async () => {
  const f = focusNavigationFixture();
  await settle();
  f.document.activeElement = f.outside;
  f.setContext('history');
  await settle();
  expect(f.setup.mobilePane).toBe('history');
  expect(f.records.focus).not.toHaveBeenCalled();
  expect(f.document.activeElement).toBe(f.outside);
});

test('a portal navigation keeps its explicit focus request until the controlled context is acknowledged', async () => {
  const f = focusNavigationFixture(false);
  await settle();
  f.setup.viewAllHistory();
  await settle();
  expect(f.setup.mobilePane).toBe('projects');
  expect(f.records.focus).not.toHaveBeenCalled();
  f.setContext('history');
  await settle();
  expect(f.records.focus).toHaveBeenCalledOnce();
});

test('a delayed context acknowledgement cannot take focus after the user moves to another control', async () => {
  const f = focusNavigationFixture(false);
  await settle();
  f.setup.viewAllHistory();
  await settle();
  f.document.activeElement = f.outside;
  f.setContext('history');
  await settle();
  expect(f.records.focus).not.toHaveBeenCalled();
  expect(f.document.activeElement).toBe(f.outside);
});

test('an external pane update still moves focus when it would otherwise remain in hidden content', async () => {
  const f = focusNavigationFixture();
  await settle();
  f.document.activeElement = f.projectButton;
  f.setContext('history');
  await settle();
  expect(f.records.focus).toHaveBeenCalledOnce();
});

test('a history action that is followed by deactivation cannot take focus later', async () => {
  const f = focusNavigationFixture();
  await settle();
  f.setup.viewAllHistory();
  f.setup.visible = false;
  await settle();
  expect(f.records.focus).not.toHaveBeenCalled();
});

async function loadedFocus(confirm?: ReturnType<typeof vi.fn<(_: string) => Promise<boolean>>>) {
  const fixture = isolatedFocus(confirm);
  await fixture.setup.load();
  await fixture.setup.loadTopics();
  return fixture;
}

test('rounded history durations never display sixty leftover minutes', async () => {
  const { setup } = await loadedFocus();
  expect(setup.duration(119.6)).toBe('2 小时');
  expect(setup.duration(59.5)).toBe('1 小时');
  expect(setup.duration(60.4)).toBe('1 小时');
  expect(setup.duration(61.4)).toBe('1 小时 1 分');
});

test('a removed selected project is verified and cleared before starting free focus', async () => {
  const { subject, setup } = await loadedFocus();
  setup.selectedTopic = 'topic';
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation(async (url) =>
    url.includes('kind=focusTopic') ? { focusTopics: [], page: { nextCursor: null } } : native(url),
  );
  await setup.loadTopics();
  expect(subject.request.mock.calls.some(([url]) => url.includes('ids=topic'))).toBe(true);
  expect(setup.selectedTopic).toBe('');
  await setup.start();
  expect(subject.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'start_focus',
      payload: expect.objectContaining({ topicId: null }),
    }),
    expect.anything(),
  );
});

test('a valid selected project on a later catalogue page remains selected after refresh', async () => {
  const { subject, setup } = await loadedFocus();
  const topic = { ...setup.allTopics[0], id: 'later-page-topic', name: '后面的项目' };
  setup.selectedTopic = topic.id;
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation(async (url) => {
    if (!url.includes('kind=focusTopic')) return native(url);
    const query = new URL(url, 'http://fixture').searchParams;
    return {
      focusTopics: query.has('ids') ? [topic] : [],
      page: { nextCursor: query.has('ids') ? null : 'more' },
    };
  });
  await setup.loadTopics();
  expect(setup.selectedTopic).toBe(topic.id);
  expect(setup.selected.name).toBe(topic.name);
  expect(setup.topicCursor).toBe('more');
});

test('background project creation never changes an explicit timer project or free-focus choice', async () => {
  const { subject, setup } = await loadedFocus();
  setup.selectedTopic = 'topic';
  const original = setup.allTopics[0];
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation(async (url) =>
    url.includes('kind=focusTopic')
      ? {
          focusTopics: [{ ...original, id: 'created-elsewhere', name: '其他窗口创建' }, original],
          page: { nextCursor: null },
        }
      : native(url),
  );
  await setup.loadTopics();
  expect(setup.selectedTopic).toBe('topic');
  setup.freeFocus();
  await setup.loadTopics();
  expect(setup.selectedTopic).toBe('');
});

test('a dataset replacement reloads focus even when its version string is unchanged and isolates note drafts', async () => {
  const { subject, setup } = await loadedFocus();
  subject.data.sessions[0].status = 'running';
  await setup.load();
  setup.editActiveNote('原数据里未保存的输入');
  const originalKey = setup.draftKey(subject.data.sessions[0].id);
  setup.selectedTopic = 'topic';
  setup.chosen = 'original-action';
  setup.topicFilter = 'topic';
  setup.sourceSessionId = 'source-only';
  subject.data.sessions = [
    { ...subject.data.sessions[0], revision: 'new-record', note: '新数据已有内容' },
  ];
  subject.data.datasetId = 'replacement';
  subject.state.snapshot.datasetId = 'replacement';
  await settle();
  expect(setup.history.datasetId).toBe('replacement');
  expect(setup.selectedTopic).toBe('');
  expect(setup.chosen).toBe('');
  expect(setup.topicFilter).toBe('');
  expect(setup.sourceSessionId).toBe('');
  expect(setup.sessionNote(setup.active)).toBe('新数据已有内容');
  expect(setup.notes[originalKey]).toBe('原数据里未保存的输入');
  expect(setup.draftIsCurrent(originalKey)).toBe(false);
  await setup.saveRetainedNote(originalKey);
  expect(subject.saveEntity).not.toHaveBeenCalled();
  setup.editActiveNote('新数据自己的输入');
  expect(Object.keys(setup.notes)).toHaveLength(2);
});

test('task navigation finishing after deactivation cannot redirect a later visit', async () => {
  const { subject, setup, onTask } = await loadedFocus();
  const session = { ...setup.items[0], occurrenceId: 'action' };
  let release!: (value: any) => void;
  const pending = new Promise<any>((resolve) => {
    release = resolve;
  });
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation((async (url) =>
    url.includes('kind=occurrence') ? pending : native(url)) as typeof native);
  const action = setup.viewSessionTask(session);
  setup.deactivate();
  setup.visible = true;
  release({ datasetId: 'fixture', occurrences: [{ id: 'action', taskId: 'task' }] });
  await action;
  expect(onTask).not.toHaveBeenCalled();
});

test.each(['dataset', 'revision', 'visit'] as const)(
  'a cancellation confirmation cannot write after its %s changes',
  async (kind) => {
    let approve!: (value: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      approve = resolve;
    });
    const { subject, setup } = await loadedFocus(vi.fn(async () => decision));
    subject.data.sessions[0].status = 'running';
    await setup.load();
    const cancellation = setup.control('cancel');
    if (kind === 'dataset') {
      subject.data.datasetId = 'replacement';
      subject.state.snapshot.datasetId = 'replacement';
      await settle();
    } else if (kind === 'revision')
      setup.history.active = { ...setup.active, revision: 'changed-elsewhere' };
    else {
      setup.deactivate();
      setup.visible = true;
    }
    approve(true);
    await cancellation;
    expect(subject.execute).not.toHaveBeenCalled();
  },
);

test('saving a correction locks its inputs, close action and replacement editor until the command finishes', async () => {
  const { subject, setup } = await loadedFocus();
  setup.correct(setup.items[0]);
  const id = setup.correction.id;
  setup.correctedMinutes = 12;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  subject.execute.mockImplementation(async () => {
    await gate;
    return {};
  });
  const saving = setup.saveCorrection();
  expect(setup.focusBusy).toBe(true);
  setup.closeCorrection();
  setup.correct(setup.items[1]);
  expect(setup.correction.id).toBe(id);
  await setup.saveCorrection();
  expect(subject.execute).toHaveBeenCalledTimes(1);
  release();
  await saving;
  expect(setup.correction).toBeUndefined();
});

test('a correction from another dataset remains readable but cannot be submitted there', async () => {
  const { subject, setup } = await loadedFocus();
  setup.correct(setup.items[0]);
  setup.correctedMinutes = 42;
  subject.data.datasetId = 'replacement';
  subject.state.snapshot.datasetId = 'replacement';
  await settle();
  expect(setup.correctionCurrent).toBe(false);
  await setup.saveCorrection();
  expect(subject.execute).not.toHaveBeenCalled();
  expect(setup.correctedMinutes).toBe(42);
  expect(setup.correctionError).toContain('输入仍保留');
});

test('a retained-note read from an earlier dataset cannot save into its replacement', async () => {
  const { subject, setup } = await loadedFocus();
  subject.data.sessions[0].status = 'running';
  await setup.load();
  const original = setup.active;
  setup.editActiveNote('原来的草稿');
  const key = setup.draftKey(original.id);
  let release!: (value: any) => void;
  const gate = new Promise<any>((resolve) => {
    release = resolve;
  });
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation((async (url) =>
    url.includes('kind=focusSession') ? gate : native(url)) as typeof native);
  const saving = setup.saveRetainedNote(key);
  subject.data.datasetId = 'replacement';
  subject.state.snapshot.datasetId = 'replacement';
  await settle();
  release({ datasetId: 'fixture', focusSessions: [original] });
  await saving;
  expect(subject.saveEntity).not.toHaveBeenCalled();
  expect(setup.notes[key]).toBe('原来的草稿');
});

test('a selected history project outside the catalogue head keeps its readable option on refresh', async () => {
  const { subject, setup } = await loadedFocus();
  const topic = { ...setup.allTopics[0], id: 'later-history-project', name: '历史筛选项目' };
  setup.topicFilter = topic.id;
  const native = subject.request.getMockImplementation()!;
  subject.request.mockImplementation(async (url) => {
    if (!url.includes('kind=focusTopic')) return native(url);
    return {
      focusTopics: new URL(url, 'http://fixture').searchParams.has('ids') ? [topic] : [],
      page: { nextCursor: null },
    };
  });
  await setup.loadTopics();
  expect(setup.topicFilter).toBe(topic.id);
  expect(
    setup.topicOptions.find((option: { value: string }) => option.value === topic.id)?.label,
  ).toBe(topic.name);
  expect(setup.selectedTopic).toBe('');
});

test.each(['paused', 'interrupted'] as const)(
  'a corrected %s session cannot restart counting or discard its manual correction',
  async (status) => {
    const { subject, setup } = await loadedFocus();
    subject.data.sessions[0].status = status;
    subject.data.sessions[0].correctedMinutes = 20;
    await setup.load();
    await setup.control('resume', setup.items[0]);
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.state.error).toContain('已修正');
    expect(setup.items[0].correctedMinutes).toBe(20);
  },
);
