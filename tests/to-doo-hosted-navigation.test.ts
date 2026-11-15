import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as vueuse from '@vueuse/core';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as contextNavigation from '../apps/web/to-doo-context-navigation';
import * as workspaceLayout from '../apps/web/workspace-layout';
import * as controls from '../apps/web/to-doo-controls';
import * as actionGuards from '../apps/web/to-doo-action-guard';
import * as antDesign from '../apps/web/ant-design';
import * as push from '../apps/web/to-doo-push';
import * as calendarLayout from '../apps/web/to-doo-calendar-layout';
import * as clock from '../apps/web/to-doo-time';
import * as taskGroups from '../apps/web/to-doo-task-groups';
import * as anniversaries from '../shared/to-doo-anniversaries';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas } from '../shared/to-doo-contracts';
import type { ToDooAppSection } from '../apps/web/navigation';

type Node = {
  tag: string;
  props: Record<string, any>;
  children: Node[];
  text: string;
  parent?: Node;
};
const cleanups: (() => void)[] = [];
let settingsTimeZone: string | undefined;
beforeEach(() => {
  settingsTimeZone = undefined;
  vi.stubGlobal('document', {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function snapshot() {
  return {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((key) => [key, []])),
    datasetId: 'hosted-navigation-test',
    version: '1',
    now: '2026-10-29T08:00:00Z',
    settings: toDooEntitySchemas.settings.parse({
      id: 'settings',
      revision: 'r1',
      createdAt: '2026-10-29T08:00:00Z',
      updatedAt: '2026-10-29T08:00:00Z',
      timeZone: settingsTimeZone,
    }),
    lists: [
      toDooEntitySchemas.list.parse({
        id: 'work',
        name: '工作清单',
        revision: 'r1',
        createdAt: '2026-10-29T08:00:00Z',
        updatedAt: '2026-10-29T08:00:00Z',
      }),
    ],
    page: { kind: null, total: 0, limit: 200, nextCursor: null, truncated: false, counts: {} },
    statistics: {
      completed: 0,
      pending: 0,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    warnings: [],
  };
}


// Exercise Ant's controlled open boundary instead of rendering hidden popup content.
const ControlledPopover = Vue.defineComponent({
  inheritAttrs: false,
  props: ['open', 'title'],
  emits: ['update:open', 'openChange'],
  setup: (props, { attrs, slots, emit }) => () => Vue.h('div', attrs, [
    ...(slots.default?.() || []).map((child) => Vue.cloneVNode(child, { onClick: () => {
      emit('update:open', !props.open);
      emit('openChange', !props.open);
    } })),
    props.open ? slots.content?.() : null,
  ]),
});

function component(path: string): Vue.Component {
  const descriptor = parse(
    readFileSync(new URL('../apps/web/components/' + path + '.vue', import.meta.url), 'utf8'),
  ).descriptor;
  const compiled = compileScript(descriptor, { id: path, inlineTemplate: true });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {}, vModelCheckbox: {} };
      if (id === 'ant-design-vue') return {
        ...toDooAntStubs,
        Popover: ControlledPopover,
        ConfigProvider: Vue.defineComponent({ inheritAttrs: false, props: ['theme'], setup: (_, { slots }) => () => slots.default?.() }),
      };
      if (id === '../preferences') return { resolvedTheme: Vue.ref('light') };
      if (id === '../ant-design') return antDesign;
      if (id === '@vueuse/core') return vueuse;
      if (id === '../workspace-layout') return workspaceLayout;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id.endsWith('/to-doo-action-guard')) return actionGuards;
      if (id.endsWith('/to-doo-push')) return push;
      if (id.endsWith('/to-doo-calendar-layout')) return calendarLayout;
      if (id.endsWith('/to-doo-time')) return clock;
      if (id.endsWith('/to-doo-task-groups')) return taskGroups;
      if (id.endsWith('/to-doo-anniversaries')) return anniversaries;
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
      if (id.endsWith('/to-doo-context-navigation')) return contextNavigation;
      if (id.endsWith('/to-doo-contracts')) return { toDooEntitySchemas };
      if (id === '../api')
        return {
          api: async (url: string) => {
            if (url.startsWith('/api/to-doo/state?')) return snapshot();
            if (url === '/api/to-doo/push') return { devices: [], enabled: false };
            if (
              url === '/api/to-doo/calendars/feeds' ||
              url === '/api/to-doo/calendars/connections'
            )
              return [];
            if (url.startsWith('/api/to-doo/operations'))
              return { operations: [], page: { nextCursor: null } };
            throw Error('Unexpected request: ' + url);
          },
        };
      if (
        /ToDoo(Navigation|Settings|Icon|PageHeader|PageToolbar|FormLayout|Calendar)\.vue$/.test(id)
      )
        return {
          __esModule: true,
          default: component('to-doo/' + id.split('/').at(-1)!.replace('.vue', '')),
        };
      if (/ToDoo(EntityEditor|TaskDetail)\.vue$/.test(id))
        return {
          __esModule: true,
          default: Vue.defineComponent({
            props: ['kind', 'seed', 'creating'],
            setup: (props) => () =>
              Vue.h('div', {
                'data-editor-boundary': id.endsWith('ToDooEntityEditor.vue') ? 'entity' : 'task',
                'data-kind': props.kind,
                'data-seed': props.seed,
                'data-creating': props.creating,
              }),
          }),
        };
      if (id.endsWith('.vue'))
        return { __esModule: true, default: Vue.defineComponent({ render: () => null }) };
      if (id.endsWith('.css')) return {};
      throw Error('Unexpected component dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}

const Workspace = component('ToDooWorkspace');
function mount(
  section: ToDooAppSection,
  hostedNavigation?: boolean,
  subject = Workspace,
  extra: Record<string, any> = {},
) {
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    insertStaticContent(content, parent, anchor) {
      const child = node('#static', content);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
      return [child, child];
    },
    createElement: (tag) =>
      Object.assign(node(tag), {
        style: {},
        querySelector: () => null,
        contains: () => false,
        querySelectorAll: () => [],
      }),
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
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent || null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, key, _before, value) => {
      node.props[key] = value;
    },
  });
  const props = Vue.reactive({
    section,
    hostedNavigation,
    tree: [],
    selection: { date: '2026-10-29', calendarView: 'week' as const },
  });
  const events: unknown[][] = [];
  const ref = Vue.ref<any>();
  const root = node('root');
  const app = renderer.createApp({
    render: () =>
      Vue.h(subject, {
        ...props,
        ...extra,
        ref,
        onNavigate: (...args: unknown[]) => events.push(args),
      }),
  });
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  const byClass = (value: string) =>
    all().filter((n) =>
      String(n.props.class || '')
        .split(' ')
        .includes(value),
    );
  const button = (value: string) =>
    all().find((n) => n.tag === 'button' && text(n).trim() === value)!;
  return { all, text, root, byClass, button, events, props, ref };
}
async function settled() {
  for (let i = 0; i < 6; i++) await Vue.nextTick();
}

describe('To Doo unified application navigation', () => {
  it('an unopened directory cannot steal focus from an active field during its initial closed callback', async () => {
    const field = {};
    const close = {
      focus() {
        documentState.activeElement = close;
      },
    };
    const dialog = {
      getClientRects: () => [{}],
      closest: () => null,
      contains: () => false,
      querySelector: () => close,
    };
    const documentState = {
      activeElement: field,
      querySelector: () => null,
      querySelectorAll: () => [dialog],
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal('document', documentState);
    const view = mount('tasks', true);
    await settled();
    function drawerNode(node: any): any {
      if (node?.type === toDooAntStubs.Drawer) return node;
      if (node?.component?.subTree) {
        const found = drawerNode(node.component.subTree);
        if (found) return found;
      }
      for (const child of Array.isArray(node?.children) ? node.children : []) {
        const found = drawerNode(child);
        if (found) return found;
      }
    }
    drawerNode(view.ref.value.$.subTree).props.onAfterOpenChange(false);
    expect(documentState.activeElement).toBe(field);
  });
  it.each([
    'matrix',
    'focus',
    'habits',
    'anniversaries',
    'stats',
    'notifications',
    'settings',
  ] as const)(
    '%s keeps the same app navigation without a second mobile function strip',
    async (section) => {
      const view = mount(section, true);
      await settled();
      expect(view.byClass('todo-sidebar')).toHaveLength(1);
      expect(view.byClass('todo-navigation-trigger')).toHaveLength(1);
      expect(view.byClass('todo-mobile-nav')).toHaveLength(0);
      expect(view.byClass('todo-mobile-tools')).toHaveLength(0);
      expect(view.text(view.byClass('todo-topbar')[0])).toContain('To Doo');
    },
  );

  it.each(['tasks', 'board', 'overview'] as const)(
    '%s exposes stable task destinations and lists in the same navigation',
    async (section) => {
      const view = mount(section, true);
      await settled();
      const sidebar = view.byClass('todo-sidebar')[0];
      expect(sidebar).toBeDefined();
      expect(view.text(sidebar)).toContain('今天');
      expect(view.text(sidebar)).toContain('目标总览');
      expect(view.text(sidebar)).toContain('工作清单');
      expect(view.text(sidebar)).not.toContain('四象限');
      expect(view.text(sidebar)).toContain('设置');
      view.button('工作清单').props.onClick();
      expect(view.events.at(-1)).toEqual(['tasks', { list: 'work', taskFilter: 'all' }]);
    },
  );

  it('calendar date and view controls remain local while its navigation stays stable', async () => {
    const view = mount('calendar', true);
    await settled();
    const sidebar = view.byClass('todo-sidebar')[0];
    expect(view.text(sidebar)).toContain('工作清单');
    await vi.waitFor(() => expect(view.button('月')).toBeDefined());
    view.button('月').props.onClick();
    expect(view.events.at(-1)).toEqual(['calendar', { date: '2026-10-29', calendarView: 'month' }]);
    view.button('显示内容').props.onClick();
    await settled();
    view
      .all()
      .find((n) => n.tag === 'input' && n.props['aria-label'] === '跳转日期')!
      .props.onChange({ target: { value: '2026-11-03' } });
    expect(view.events.at(-1)).toEqual(['calendar', { date: '2026-11-03', calendarView: 'week' }]);
  });

  it.each(['calendar', 'timeline'] as const)(
    '%s exposes one task action and one schedule action that open their respective editors',
    async (section) => {
      settingsTimeZone = 'Asia/Shanghai';
      const view = mount(section, true);
      await vi.waitFor(() => expect(view.button('＋ 预留时间')).toBeDefined());
      const action = (label: string) =>
        view.all().filter((node) => node.tag === 'button' && view.text(node).trim() === label);
      expect(action('＋ 新建任务')).toHaveLength(1);
      expect(action('＋ 预留时间')).toHaveLength(1);

      view.button('＋ 新建任务').props.onClick();
      await settled();
      expect(view.all().filter((node) => node.props['data-editor-boundary'] === 'task')).toEqual([
        expect.objectContaining({ props: expect.objectContaining({ 'data-creating': true }) }),
      ]);
      expect(
        view.all().filter((node) => node.props['data-editor-boundary'] === 'entity'),
      ).toHaveLength(0);

      view
        .all()
        .find((node) => node.props['aria-label'] === '收起任务详情')!
        .props.onClick();
      await settled();
      await vi.waitFor(() => expect(view.button('＋ 预留时间')).toBeDefined());
      view.button('＋ 预留时间').props.onClick();
      await settled();
      expect(
        view.all().filter((node) => node.props['data-editor-boundary'] === 'task'),
      ).toHaveLength(0);
      expect(view.all().filter((node) => node.props['data-editor-boundary'] === 'entity')).toEqual([
        expect.objectContaining({
          props: expect.objectContaining({
            'data-kind': 'timeBlock',
            'data-seed': {
              start: { date: '2026-10-29', time: '09:00', timeZone: 'Asia/Shanghai' },
            },
          }),
        }),
      ]);
    },
  );

  it.each(['calendar', 'timeline'] as const)(
    '%s schedules on the local date when the route has no selected date',
    async (section) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-12T16:30:00Z'));
      settingsTimeZone = 'Asia/Shanghai';
      const view = mount(section, true, Workspace, { selection: { calendarView: 'month' } });
      await settled();
      await vi.waitFor(() => expect(view.button('＋ 预留时间')).toBeDefined());
      view.button('＋ 预留时间').props.onClick();
      await settled();
      const editor = view.all().find((node) => node.props['data-editor-boundary'] === 'entity');
      expect(editor?.props['data-seed']).toEqual({
        start: { date: '2026-11-13', time: '09:00', timeZone: 'Asia/Shanghai' },
      });
    },
  );

  it.each(['calendar', 'timeline'] as const)(
    '%s keeps the schedule action on the current local date after midnight while mounted',
    async (section) => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-11-12T15:59:45Z'));
      settingsTimeZone = 'Asia/Shanghai';
      const view = mount(section, true, Workspace, { selection: { calendarView: 'month' } });
      await settled();
      await vi.waitFor(() => expect(view.button('显示内容')).toBeDefined());
      view.button('显示内容').props.onClick();
      await settled();
      const dateInput = () =>
        view.all().find((node) => node.tag === 'input' && node.props.type === 'date');
      expect(dateInput()?.props.value).toBe('2026-11-12');

      await vi.advanceTimersByTimeAsync(60000);
      await settled();
      expect(dateInput()?.props.value).toBe('2026-11-13');
      await vi.waitFor(() => expect(view.button('＋ 预留时间')).toBeDefined());
      view.button('＋ 预留时间').props.onClick();
      await settled();
      const editor = view.all().find((node) => node.props['data-editor-boundary'] === 'entity');
      expect(editor?.props['data-seed']).toEqual({
        start: { date: '2026-11-13', time: '09:00', timeZone: 'Asia/Shanghai' },
      });
    },
  );

  it('standalone navigation keeps complete feature access', async () => {
    const view = mount('focus');
    await settled();
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('今天');
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('设置');
  });

  it('timeline uses the same navigation to reach the calendar', async () => {
    const view = mount('timeline', true);
    await settled();
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('所有任务');
    view.button('日历').props.onClick();
    expect(view.events.at(-1)?.[0]).toBe('calendar');
  });

  it('protects unsaved settings when the host switches section, preserves the form on cancel', async () => {
    const view = mount('settings', true);
    await settled();
    await vi.waitFor(() =>
      expect(
        view.all().some((n) => n.tag === 'input' && n.props.placeholder === 'Asia/Shanghai'),
      ).toBe(true),
    );
    const zone = view
      .all()
      .find((n) => n.tag === 'input' && n.props.placeholder === 'Asia/Shanghai')!;
    zone.props.onInput({ target: { value: 'Asia/Tokyo' } });
    await Vue.nextTick();
    const pending = view.ref.value.requestSectionLeave('focus');
    await Vue.nextTick();
    expect(view.all().some((n) => n.props['aria-label'] === '尚有未保存内容')).toBe(true);
    view.button('继续编辑').props.onClick();
    expect(await pending).toBe(false);
    expect(view.ref.value.hasUnsavedChanges()).toBe(true);
    expect(await view.ref.value.requestSectionLeave('settings')).toBe(true);
    const discard = view.ref.value.requestSectionLeave('tasks');
    await Vue.nextTick();
    view.button('放弃更改并离开').props.onClick();
    expect(await discard).toBe(true);
    await settled();
    expect(view.ref.value.hasUnsavedChanges()).toBe(false);
  });
});

it('selecting Today from a board returns to the stable task destination', async () => {
  const view = mount('board', true);
  await settled();
  view.button('今天').props.onClick();
  expect(view.events.at(-1)).toEqual(['tasks', { taskFilter: 'today' }]);
});

it('phone overflow navigation keeps a stable More label when an overflow function is active', async () => {
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  const definition = Vue.reactive({
    id: 'to-doo',
    label: 'To Doo',
    activeId: 'habits',
    items: [
      { id: 'tasks', label: '任务', icon: 'task' },
      { id: 'calendar', label: '日历', icon: 'calendar' },
      { id: 'matrix', label: '四象限', icon: 'matrix' },
      { id: 'focus', label: '专注', icon: 'focus' },
      { id: 'habits', label: '习惯', icon: 'habits' },
    ],
    utilities: [],
    onSelect() {},
  });
  const view = mount('habits', true, component('WorkspaceMainMenu'), { definition });
  await settled();
  const more = view.all().find((n) => n.tag === 'button' && n.props['aria-label'] === '更多导航')!;
  expect(view.text(more)).toBe('更多');
  expect(more.props.title).toBe('更多导航');
  expect(more.props['aria-current']).toBe('page');
  definition.activeId = 'tasks';
  await settled();
  expect(view.text(more)).toBe('更多');
});

it('matrix keeps a plain title and returns to Today through the shared navigation', async () => {
  const view = mount('matrix', true);
  await settled();
  expect(view.byClass('todo-sidebar')).toHaveLength(1);
  expect(view.all().filter((n) => n.props['aria-label'] === '切换任务范围')).toHaveLength(0);
  view.button('今天').props.onClick();
  expect(view.events.at(-1)).toEqual(['tasks', { taskFilter: 'today' }]);
});


it('custom common modules persist without removing any module or task-management scope', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const items = [
    ['calendar', '日历', ''], ['habits', '习惯', ''], ['focus', '专注', ''],
    ['overview', '目标总览', ''], ['stats', '统计与复盘', ''], ['anniversaries', '纪念日', ''],
  ];
  const extra = { quickView: 'all', lists: [], items, listLoading: false, listError: false, hasMoreLists: false };
  const subject = component('to-doo/ToDooNavigation');
  const view = mount('tasks', false, subject, extra);
  const common = () => view.all().find((node) => node.tag === 'section' && node.props['aria-label'] === '计划与执行')!;
  const pinned = () => view.all(common()).filter((node) => node.tag === 'button' && node.props['aria-label'] === '目标总览');
  expect(pinned()).toHaveLength(0);
  view.all().find((node) => node.tag === 'button' && node.props['aria-label'] === '自定义常用入口')!.props.onClick();
  await settled();
  view.all().find((node) => node.tag === 'input' && node.parent && view.text(node.parent) === '目标总览')!.props.onChange({ target: { checked: true } });
  await settled();
  expect(pinned()).toHaveLength(1);
  expect(JSON.parse(saved.get('to-doo.navigation-pins.v1')!)).toContain('overview');
  const restored = mount('tasks', false, subject, extra);
  await settled();
  const commonAgain = restored.all().find((node) => node.tag === 'section' && node.props['aria-label'] === '计划与执行')!;
  expect(restored.all(commonAgain).some((node) => node.tag === 'button' && node.props['aria-label'] === '目标总览')).toBe(true);
  for (const label of ['日历', '习惯', '专注', '目标总览', '统计与复盘', '纪念日', '逾期', '未安排', '受阻', '已归档', '回收站']) {
    expect(restored.all().filter((node) => node.tag === 'button' && node.props['aria-label'] === label)).toHaveLength(1);
  }
  expect(restored.text(restored.byClass('todo-navigation-more')[0])).toContain('任务范围');
  expect(restored.text(restored.byClass('todo-navigation-more')[0])).toContain('历史管理');
});

const pinnableNavigationItems = [
  ['calendar', '日历', ''], ['habits', '习惯', ''], ['focus', '专注', ''],
  ['overview', '目标总览', ''], ['stats', '统计与复盘', ''], ['anniversaries', '纪念日', ''],
];
const pinnableNavigationLabels = [
  '日历', '习惯', '专注', '目标总览', '统计与复盘', '纪念日', '逾期', '未安排', '受阻',
];
function mountPinnableNavigation(extra: Record<string, any> = {}) {
  return mount('tasks', false, component('to-doo/ToDooNavigation'), {
    quickView: 'all', lists: [], items: pinnableNavigationItems,
    listLoading: false, listError: false, hasMoreLists: false, ...extra,
  });
}
function commonNavigation(view: ReturnType<typeof mount>) {
  return view.all().find((node) => node.tag === 'section' && node.props['aria-label'] === '计划与执行')!;
}
function commonNavigationLabels(view: ReturnType<typeof mount>) {
  return view.all(commonNavigation(view))
    .filter((node) => node.tag === 'button' && pinnableNavigationLabels.includes(node.props['aria-label']))
    .map((node) => node.props['aria-label']);
}
async function openNavigationPins(view: ReturnType<typeof mount>) {
  view.all().find((node) => node.tag === 'button' && node.props['aria-label'] === '自定义常用入口')!.props.onClick();
  await settled();
}
function navigationPin(view: ReturnType<typeof mount>, label: string) {
  return view.all().find((node) => node.tag === 'input' && node.parent && view.text(node.parent).trim() === label)!;
}

it.each([
  ['overdue', '逾期'], ['unscheduled', '未安排'], ['blocked', '受阻'],
])('pinning the %s task scope moves one real quick-view entry and persists beside legacy module pins', async (scope, label) => {
  const saved = new Map([['to-doo.navigation-pins.v1', '["focus","stats"]']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const quick = vi.fn();
  const view = mountPinnableNavigation({ quickView: scope, onQuick: quick });
  const more = () => view.byClass('todo-navigation-more')[0];
  const scopeEntries = (parent: Node) => view.all(parent).filter((node) => node.tag === 'button' && node.props['aria-label'] === label);
  expect(commonNavigationLabels(view)).toEqual(['专注', '统计与复盘']);
  expect(scopeEntries(more())).toHaveLength(1);
  expect(more().props.open).toBe(true);
  await openNavigationPins(view);
  expect(view.all(commonNavigation(view)).filter((node) => node.tag === 'input')).toHaveLength(9);
  navigationPin(view, label).props.onChange({ target: { checked: true } });
  await settled();
  const pinned = scopeEntries(commonNavigation(view));
  expect(pinned).toHaveLength(1);
  expect(pinned[0].props['aria-current']).toBe('page');
  expect(scopeEntries(more())).toHaveLength(0);
  expect(more().props.open).toBeUndefined();
  pinned[0].props.onClick();
  expect(quick).toHaveBeenCalledOnce();
  expect(quick).toHaveBeenCalledWith(scope);
  expect(JSON.parse(saved.get('to-doo.navigation-pins.v1')!)).toEqual(['focus', 'stats', scope]);

  const restored = mountPinnableNavigation({ quickView: scope });
  await settled();
  expect(commonNavigationLabels(restored)).toEqual(['专注', '统计与复盘', label]);
  expect(restored.all().filter((node) => node.tag === 'button' && node.props['aria-label'] === label)).toHaveLength(1);
  await openNavigationPins(restored);
  navigationPin(restored, label).props.onChange({ target: { checked: false } });
  await settled();
  expect(commonNavigationLabels(restored)).toEqual(['专注', '统计与复盘']);
  const unpinned = restored.all(restored.byClass('todo-navigation-more')[0])
    .filter((node) => node.tag === 'button' && node.props['aria-label'] === label);
  expect(unpinned).toHaveLength(1);
  expect(unpinned[0].props['aria-current']).toBe('page');
  expect(JSON.parse(saved.get('to-doo.navigation-pins.v1')!)).toEqual(['focus', 'stats']);
});

it.each([
  ['legacy modules', '["overview","focus"]', ['专注', '目标总览']],
  ['mixed known and malformed entries', '["focus",null,"overdue","overdue","unknown"]', ['专注', '逾期']],
  ['intentional empty selection', '[]', []],
  ['malformed JSON', '{broken', ['日历', '习惯', '专注']],
  ['unexpected object', '{"pins":["overdue"]}', ['日历', '习惯', '专注']],
  ['unsupported entries only', '[null,10,"unknown"]', ['日历', '习惯', '专注']],
])('reading %s navigation preferences retains usable entries without rewriting browser storage', async (_name, stored, expected) => {
  const write = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: write });
  const view = mountPinnableNavigation();
  await settled();
  expect(commonNavigationLabels(view)).toEqual(expected);
  expect(write).not.toHaveBeenCalled();
  for (const label of pinnableNavigationLabels) {
    expect(view.all().filter((node) => node.tag === 'button' && node.props['aria-label'] === label)).toHaveLength(1);
  }
});

it('denied pin storage preserves the original defaults and lets task scopes remain usable for this session', async () => {
  const write = vi.fn(() => { throw Error('storage denied'); });
  vi.stubGlobal('localStorage', {
    getItem() { throw Error('storage denied'); },
    setItem: write,
  });
  const quick = vi.fn();
  const view = mountPinnableNavigation({ onQuick: quick });
  expect(commonNavigationLabels(view)).toEqual(['日历', '习惯', '专注']);
  await openNavigationPins(view);
  navigationPin(view, '受阻').props.onChange({ target: { checked: true } });
  await settled();
  expect(commonNavigationLabels(view)).toEqual(['日历', '习惯', '专注', '受阻']);
  const entry = view.all(commonNavigation(view)).find((node) => node.tag === 'button' && node.props['aria-label'] === '受阻')!;
  entry.props.onClick();
  expect(quick).toHaveBeenCalledOnce();
  expect(quick).toHaveBeenCalledWith('blocked');
  expect(write).toHaveBeenCalledOnce();
});
