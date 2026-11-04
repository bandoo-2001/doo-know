import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as vueuse from '@vueuse/core';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import * as clock from '../apps/web/to-doo-time';
import * as habits from '../shared/to-doo-habits';
import * as habitPresentation from '../apps/web/to-doo-habit-presentation';
import * as anniversaries from '../shared/to-doo-anniversaries';
import * as focusSync from '../apps/web/to-doo-focus-history-sync';
import * as workbench from '../apps/web/to-doo-workbench';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas } from '../shared/to-doo-contracts';

type Node = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const cleanups: (() => void)[] = [];
const mobile = Vue.ref(false);
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  mobile.value = false;
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
function component(name: string): Vue.Component {
  const { descriptor } = parse(
    readFileSync(new URL(`../apps/web/components/to-doo/${name}.vue`, import.meta.url), 'utf8'),
  );
  const compiled = compileScript(descriptor, { id: name, inlineTemplate: true });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {} };
      if (id === '@vueuse/core') return { ...vueuse, useMediaQuery: () => mobile };
      if (id === '../../to-doo-time') return clock;
      if (id === '../../../../shared/to-doo-habits') return habits;
      if (id === '../../to-doo-habit-presentation') return habitPresentation;
      if (id === '../../../../shared/to-doo-anniversaries') return anniversaries;
      if (id === '../../to-doo-focus-history-sync') return focusSync;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => async () => false };
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
        /ToDoo(Hint|PageToolbar|SectionHeader|Focus|FocusTrend|FocusTimerFields|HabitCard|Icon)\.vue$/.test(
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
function mount(name: string, initialProps: Record<string, any>) {
  const props = Vue.reactive(initialProps);
  const target = component(name);
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    insertStaticContent(content, parent) {
      const child = node('#static', content);
      parent.children.push(child);
      return [child, child];
    },
    createElement: (tag) =>
      Object.assign(node(tag), { style: {}, scrollIntoView: vi.fn(), focus: vi.fn() }),
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
      render: () => Vue.h(Vue.KeepAlive, null, { default: () => Vue.h(target, props) }),
    });
  const vm = app.mount(root) as any;
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  return {
    vm,
    props,
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
      return { version: 'r1', focusTopics: topics, habitEntries: [], page: { nextCursor: null } };
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
  return { state, execute: vi.fn(async () => ({})), request, data };
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

// A lost controlled context would leave the user on the wrong pane after a route restore.
test('controlled habits opens history and can restore today without duplicate pane controls', async () => {
  const view = mount('ToDooRhythm', {
    model: model(),
    section: 'habits',
    context: 'history',
    contextualNavigation: true,
  });
  await settle();
  expect(view.all().some((n) => n.props.class === 'todo-panel todo-habit-table')).toBe(true);
  expect(view.all().some((n) => n.props['aria-label'] === '习惯视图')).toBe(false);
  view.props.context = 'today';
  await settle();
  expect(view.all().some((n) => n.props.class === 'todo-habit-cards')).toBe(true);
  expect(view.all().some((n) => n.props.class === 'todo-panel todo-habit-table')).toBe(false);
});

// Each bucket is independently derived: today is not upcoming; an expired one-off is past.
test.each([
  ['all', ['今天纪念日', '下周纪念日', '远期纪念日', '过去纪念日']],
  ['upcoming', ['下周纪念日']],
  ['today', ['今天纪念日']],
  ['past', ['过去纪念日']],
])('anniversary context %s filters real calendar dates', async (context, expected) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  const value = model();
  value.state.snapshot.anniversaries = [
    ['today', '今天纪念日', '2026-11-04'],
    ['soon', '下周纪念日', '2026-11-11'],
    ['later', '远期纪念日', '2026-12-20'],
    ['past', '过去纪念日', '2025-10-12'],
  ].map(([id, name, date]) =>
    toDooEntitySchemas.anniversary.parse({
      id,
      name,
      date,
      calendar: 'gregorian',
      repeatYearly: false,
      revision: 'r1',
      createdAt: '2026-11-04T12:00:00Z',
      updatedAt: '2026-11-04T12:00:00Z',
    }),
  );
  const view = mount('ToDooRhythm', {
    model: value,
    section: 'anniversaries',
    context,
    contextualNavigation: true,
  });
  await settle();
  const names = view
    .all()
    .filter((n) => n.tag === 'article' && String(n.props['aria-label']).startsWith('纪念日 '))
    .map((n) => n.props['aria-label'].replace('纪念日 ', ''))
    .sort();
  expect(names).toEqual([...expected].sort());
});

// Context navigation must reveal the correct mobile pane while preserving the timer.
test('focus context is forwarded through Rhythm to the mobile pane and internal history links update the route', async () => {
  mobile.value = true;
  const changes = vi.fn();
  const view = mount('ToDooRhythm', {
    model: model(),
    section: 'focus',
    context: 'history',
    contextualNavigation: true,
    onContextChange: changes,
  });
  await settle();
  const pane = (label: string) => view.all().find((n) => n.props['aria-label'] === label)!;
  expect((pane('专注项目') as any).style.display).toBe('none');
  expect((pane('专注概览和历史') as any).style.display).not.toBe('none');
  expect(view.all().some((n) => n.props['aria-label'] === '专注页面')).toBe(false);
  expect(pane('专注计时器')).toBeDefined();
  view.props.context = 'projects';
  await settle();
  expect((pane('专注项目') as any).style.display).not.toBe('none');
  button(view, '查看累计 阅读')!.props.onClick();
  await settle();
  expect(changes).toHaveBeenLastCalledWith('history');
  expect(pane('专注计时器')).toBeDefined();
});

// On desktop both panes remain available; context changes select a real section anchor.
test('desktop focus navigation scrolls to a real section and leaves the timer project independent', async () => {
  const view = mount('ToDooRhythm', {
    model: model(),
    section: 'focus',
    context: 'projects',
    contextualNavigation: true,
  });
  await settle();
  button(view, '选择专注项目 阅读')!.props.onClick();
  view.props.context = 'history';
  await settle();
  const records = view.all().find((n) => n.props['aria-label'] === '专注概览和历史')! as any;
  expect(records.scrollIntoView).toHaveBeenCalled();
  const select = view
    .all()
    .find((n) => n.tag === 'select' && n.props['aria-label'] === '专注记录项目')!;
  expect(select.props.value).toBe('');
  const timer = view.all().find((n) => n.props['aria-label'] === '专注计时器')!;
  expect(view.text(timer)).toContain('阅读');
});
