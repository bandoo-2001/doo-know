import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as time from '../apps/web/to-doo-time';
import * as habits from '../shared/to-doo-habits';
import { toDooAntStubs } from './support/to-doo-ant-stubs';
import {
  TO_DOO_COLLECTIONS,
  toDooEntitySchemas,
  type ToDooEntityMap,
  type ToDooFocusHistory,
  type ToDooSnapshot,
} from '../shared/to-doo-contracts';

type Node = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function mount(model: workbench.ToDooWorkbench, keepAlive = false) {
  const sourceFile = new URL(
    '../apps/web/components/to-doo/ToDooTaskOverviewSummary.vue',
    import.meta.url,
  );
  const { descriptor } = parse(readFileSync(sourceFile, 'utf8'));
  const script = compileScript(descriptor, { id: 'overview-summary', inlineTemplate: true });
  const source = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue') return toDooAntStubs;
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-time')) return time;
      if (id.endsWith('/to-doo-habits')) return habits;
      if (id.endsWith('ToDooIcon.vue'))
        return { default: Vue.defineComponent({ render: () => Vue.h('svg') }) };
      throw Error('Unexpected overview dependency: ' + id);
    },
    output,
    output.exports,
  );
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    },
    setText: (child, text) => {
      child.text = text;
    },
    setElementText: (child, text) => {
      child.text = text;
      child.children = [];
    },
    patchProp: (child, key, _old, value) => {
      child.props[key] = value;
    },
    parentNode: (child) => child.parent || null,
    nextSibling: (child) =>
      child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    insertStaticContent(content, parent) {
      const child = node('#static', content);
      child.parent = parent;
      parent.children.push(child);
      return [child, child];
    },
  });
  const root = node('root');
  const shown = Vue.ref(true);
  const app = keepAlive
    ? renderer.createApp({
        setup: () => () =>
          Vue.h(Vue.KeepAlive, null, {
            default: () => (shown.value ? Vue.h(output.exports.default, { model }) : null),
          }),
      })
    : renderer.createApp(output.exports.default, { model });
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent = root): string => parent.text + parent.children.map(text).join('');
  return {
    root,
    all,
    text,
    show: (visible: boolean) => {
      shown.value = visible;
    },
  };
}

const stamp = {
  revision: 'r1',
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
};
function snapshot(patch: Partial<ToDooSnapshot> = {}): ToDooSnapshot {
  return {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((collection) => [collection, []])),
    datasetId: 'overview-data',
    version: 'v1',
    now: '2026-11-06T12:00:00Z',
    settings: toDooEntitySchemas.settings.parse({
      ...stamp,
      id: 'settings',
      timeZone: 'UTC',
      weekStartsOn: 1,
    }),
    statistics: {
      completed: 0,
      pending: 0,
      overdue: 0,
      focusMinutes: 9999,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    page: { kind: null, total: 0, limit: 200, nextCursor: null, truncated: false, counts: {} },
    warnings: [],
    ...patch,
  } as ToDooSnapshot;
}
function habit(id: string, patch: Partial<ToDooEntityMap['habit']> = {}) {
  return toDooEntitySchemas.habit.parse({
    ...stamp,
    id,
    name: id,
    startDate: '2026-11-01',
    goalMode: 'checkin',
    ...patch,
  });
}
function entry(id: string, habitId: string, patch: Partial<ToDooEntityMap['habitEntry']> = {}) {
  return toDooEntitySchemas.habitEntry.parse({
    ...stamp,
    id,
    habitId,
    localDate: '2026-11-06',
    occurredAt: '2026-11-06T08:00:00Z',
    amount: 1,
    ...patch,
  });
}
function focus(minutes = 125): ToDooFocusHistory {
  return {
    datasetId: 'overview-data',
    revision: 'v1',
    now: '2026-11-06T12:00:00Z',
    timeZone: 'UTC',
    items: [],
    active: null,
    overview: {
      today: { completed: 0, minutes: 0 },
      lifetime: { completed: 100, minutes: 9999 },
      filtered: { completed: 4, minutes },
      byTopic: {},
    },
    page: { total: 40, limit: 1, hasMore: true, nextCursor: 'not-needed-for-aggregate' },
  };
}
async function settle() {
  for (let i = 0; i < 15; i++) await Vue.nextTick();
}

test('overview counts scheduled local-today habits across pages and uses the full weekly focus aggregate without changing the workbench', async () => {
  const requests: string[] = [];
  const initial = snapshot();
  const value = workbench.createToDooWorkbench(async (url, method = 'GET') => {
    expect(method).toBe('GET');
    requests.push(url);
    const query = new URL(url, 'http://localhost').searchParams;
    if (url.startsWith('/api/to-doo/focus/history')) return focus();
    if (query.get('kind') === 'habit') {
      if (query.has('cursor'))
        return snapshot({
          habits: [
            habit('weekly', { frequency: 'weekly', target: 3 }),
            habit('ended', { endDate: '2026-11-05' }),
          ],
        });
      return snapshot({
        habits: [
          habit('done'),
          habit('rest', { weekdays: [1] }),
          habit('quantity', { goalMode: 'quantity', target: 10 }),
          habit('paused', { pausedDates: ['2026-11-06'] }),
        ],
        page: { ...initial.page, nextCursor: 'habits-page-2', truncated: true },
      });
    }
    if (query.get('kind') === 'habitEntry') {
      expect(query.get('from')).toBe('2026-11-02');
      expect(query.get('to')).toBe('2026-11-08');
      if (query.has('cursor'))
        return snapshot({
          habitEntries: [
            entry('weekly-today', 'weekly'),
            entry('quantity-2', 'quantity', { amount: 6 }),
          ],
        });
      return snapshot({
        habitEntries: [
          entry('done-entry', 'done'),
          entry('quantity-1', 'quantity', { amount: 4 }),
          entry('weekly-monday', 'weekly', { localDate: '2026-11-02' }),
        ],
        page: { ...initial.page, nextCursor: 'entries-page-2', truncated: true },
      });
    }
    throw Error('Unexpected read: ' + url);
  });
  value.acceptSnapshot(initial);
  const before = JSON.stringify(value.state);
  const view = mount(value);
  await settle();
  expect(view.text()).toContain('3 / 3');
  expect(view.text()).toContain('2 小时 5 分钟');
  const focusQuery = new URL(
    requests.find((url) => url.startsWith('/api/to-doo/focus/history'))!,
    'http://localhost',
  ).searchParams;
  expect(Object.fromEntries(focusQuery)).toMatchObject({
    from: '2026-11-02',
    to: '2026-11-08',
    limit: '1',
  });
  expect(JSON.stringify(value.state)).toBe(before);
});

test('failed reads show a retry instead of zero values, and retry recovers actual empty totals', async () => {
  let failed = true;
  const value = workbench.createToDooWorkbench(async (url) => {
    if (failed) throw Error('网络不可用');
    return url.startsWith('/api/to-doo/focus/history') ? focus(0) : snapshot();
  });
  value.acceptSnapshot(snapshot());
  const view = mount(value);
  await settle();
  expect(view.all().some((node) => node.props.role === 'alert')).toBe(true);
  expect(view.text()).not.toContain('0 / 0');
  failed = false;
  const retry = view
    .all()
    .find((node) => node.tag === 'button' && node.props['aria-label'] === '重试读取习惯与专注概览');
  expect(retry).toBeDefined();
  retry!.props.onClick();
  await settle();
  expect(view.text()).toContain('0 / 0');
  expect(view.text()).toContain('0 分钟');
  expect(view.all().some((node) => node.props.role === 'alert')).toBe(false);
});

test('a response from another dataset never appears as this account’s summary', async () => {
  const value = workbench.createToDooWorkbench(async (url) =>
    url.startsWith('/api/to-doo/focus/history')
      ? { ...focus(), datasetId: 'other-data' }
      : snapshot(),
  );
  value.acceptSnapshot(snapshot());
  const view = mount(value);
  await settle();
  expect(view.all().some((node) => node.props.role === 'alert')).toBe(true);
  expect(view.text()).not.toContain('2 小时 5 分钟');
});

test('a habit’s local midnight refreshes its today count before the workspace date changes', async () => {
  vi.setSystemTime(new Date('2026-11-06T14:59:30Z'));
  const value = workbench.createToDooWorkbench(async (url) => {
    if (url.startsWith('/api/to-doo/focus/history')) return focus(0);
    const kind = new URL(url, 'http://localhost').searchParams.get('kind');
    return kind === 'habit'
      ? snapshot({ habits: [habit('tokyo', { timeZone: 'Asia/Tokyo' })] })
      : snapshot({ habitEntries: [entry('tokyo-entry', 'tokyo')] });
  });
  value.acceptSnapshot(snapshot());
  const view = mount(value);
  await settle();
  expect(view.text()).toContain('1 / 1');
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  expect(view.text()).toContain('0 / 1');
});

test('habit pages from different revisions never produce a partial success count', async () => {
  const initial = snapshot();
  const value = workbench.createToDooWorkbench(async (url) => {
    if (url.startsWith('/api/to-doo/focus/history')) return focus();
    const query = new URL(url, 'http://localhost').searchParams;
    if (query.has('cursor'))
      return snapshot({ version: 'changed-version', habits: [habit('new')] });
    return snapshot({
      habits: [habit('first')],
      page: { ...initial.page, nextCursor: 'next', truncated: true },
    });
  });
  value.acceptSnapshot(initial);
  const view = mount(value);
  await settle();
  expect(view.all().some((node) => node.props.role === 'alert')).toBe(true);
  expect(view.text()).not.toContain('0 / 2');
});

test('a running focus refreshes only its aggregate each minute, retains the strip during reads, and stops after cancellation', async () => {
  const requests: string[] = [];
  const started = Date.now();
  let nextReply: ((value: ToDooFocusHistory) => void) | undefined;
  const session = toDooEntitySchemas.focusSession.parse({
    ...stamp,
    id: 'running-focus',
    mode: 'stopwatch',
    status: 'running',
    segments: [{ start: new Date(started - 5 * 60000).toISOString(), end: null }],
  });
  const value = workbench.createToDooWorkbench(async (url) => {
    requests.push(url);
    if (!url.startsWith('/api/to-doo/focus/history')) return snapshot();
    if (requests.filter((read) => read.startsWith('/api/to-doo/focus/history')).length === 1)
      return { ...focus(5), active: session };
    return new Promise<ToDooFocusHistory>((resolve) => {
      nextReply = resolve;
    });
  });
  value.acceptSnapshot(snapshot());
  const view = mount(value);
  await settle();
  expect(view.text()).toContain('5 分钟');
  const initialHabitReads = requests.filter((url) => url.startsWith('/api/to-doo/state')).length;
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  expect(nextReply).toBeDefined();
  expect(view.text()).toContain('5 分钟');
  expect(view.text()).toContain('0 / 0');
  expect(view.text()).not.toContain('正在读取');
  expect(requests.filter((url) => url.startsWith('/api/to-doo/state'))).toHaveLength(
    initialHabitReads,
  );
  nextReply!({ ...focus(6), active: session });
  await settle();
  expect(view.text()).toContain('6 分钟');
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  nextReply!(focus(6));
  await settle();
  const afterCancellation = requests.length;
  await vi.advanceTimersByTimeAsync(120000);
  await settle();
  expect(requests).toHaveLength(afterCancellation);
});

test('deactivating overview invalidates an outstanding focus refresh and pauses further polling', async () => {
  let reads = 0,
    pending: ((value: ToDooFocusHistory) => void) | undefined;
  const session = toDooEntitySchemas.focusSession.parse({
    ...stamp,
    id: 'running-focus',
    mode: 'stopwatch',
    status: 'running',
    segments: [{ start: '2026-11-06T11:55:00Z', end: null }],
  });
  const value = workbench.createToDooWorkbench(async (url) => {
    if (!url.startsWith('/api/to-doo/focus/history')) return snapshot();
    reads++;
    if (reads === 1) return { ...focus(5), active: session };
    if (reads === 2)
      return new Promise<ToDooFocusHistory>((resolve) => {
        pending = resolve;
      });
    return focus(7);
  });
  value.acceptSnapshot(snapshot());
  const view = mount(value, true);
  await settle();
  const displayed = view
    .all()
    .find((node) => node.tag === 'strong' && view.text(node) === '5 分钟')!;
  expect(displayed).toBeDefined();
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  expect(pending).toBeDefined();
  view.show(false);
  await settle();
  pending!({ ...focus(99), active: session });
  await settle();
  expect(view.text(displayed)).toBe('5 分钟');
  const pausedReads = reads;
  await vi.advanceTimersByTimeAsync(120000);
  await settle();
  expect(reads).toBe(pausedReads);
  view.show(true);
  await settle();
  expect(view.text()).toContain('7 分钟');
  expect(view.text()).not.toContain('99 分钟');
});
