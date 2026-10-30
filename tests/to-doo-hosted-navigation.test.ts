import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as controls from '../apps/web/to-doo-controls';
import * as push from '../apps/web/to-doo-push';
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
beforeEach(() => {
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => [] });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
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
      if (id === 'ant-design-vue') return toDooAntStubs;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id.endsWith('/to-doo-push')) return push;
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
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
      if (/ToDoo(Navigation|Settings|Icon)\.vue$/.test(id))
        return { default: component('to-doo/' + id.split('/').at(-1)!.replace('.vue', '')) };
      if (id.endsWith('.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      if (id.endsWith('.css')) return {};
      throw Error('Unexpected component dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}

const Workspace = component('ToDooWorkspace');
function mount(section: ToDooAppSection, hostedNavigation?: boolean) {
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
    createElement: (tag) => Object.assign(node(tag), { querySelector: () => null }),
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
      Vue.h(Workspace, { ...props, ref, onNavigate: (...args: unknown[]) => events.push(args) }),
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

describe('To Doo hosted secondary navigation', () => {
  it('an unopened directory cannot steal focus from an active field during its initial closed callback', async () => {
    const field = {};
    const close = { focus() { documentState.activeElement = close; } };
    const dialog = { getClientRects: () => [{}], closest: () => null, contains: () => false, querySelector: () => close };
    const documentState = { activeElement: field, querySelector: () => null, querySelectorAll: () => [dialog] };
    vi.stubGlobal('document', documentState);
    const view = mount('tasks', true);
    await settled();
    function drawerNode(node: any): any {
      if (node?.type === toDooAntStubs.Drawer) return node;
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
    '%s fills the workspace without a duplicate directory or mobile function strip',
    async (section) => {
      const view = mount(section, true);
      await settled();
      expect(view.byClass('todo-sidebar')).toHaveLength(0);
      expect(view.byClass('todo-navigation-trigger')).toHaveLength(0);
      expect(view.byClass('todo-mobile-nav')).toHaveLength(0);
      expect(view.byClass('todo-mobile-tools')).toHaveLength(0);
      expect(view.text(view.byClass('todo-topbar')[0])).toContain('To Doo');
    },
  );

  it.each(['tasks', 'board', 'overview'] as const)(
    '%s keeps task ranges, goals and lists, without repeating main features',
    async (section) => {
      const view = mount(section, true);
      await settled();
      const sidebar = view.byClass('todo-sidebar')[0];
      expect(sidebar).toBeDefined();
      expect(view.text(sidebar)).toContain('今天');
      expect(view.text(sidebar)).toContain('目标总览');
      expect(view.text(sidebar)).toContain('工作清单');
      expect(view.text(sidebar)).not.toContain('四象限');
      expect(view.text(sidebar)).not.toContain('通知中心');
      view.button('工作清单').props.onClick();
      expect(view.events.at(-1)).toEqual(['tasks', { list: 'work', taskFilter: 'all' }]);
    },
  );

  it('calendar directory routes real dates and month/week/timeline choices', async () => {
    const view = mount('calendar', true);
    await settled();
    const sidebar = view.byClass('todo-sidebar')[0];
    expect(view.text(sidebar)).not.toContain('工作清单');
    view.button('月视图').props.onClick();
    expect(view.events.at(-1)).toEqual(['calendar', { date: '2026-10-29', calendarView: 'month' }]);
    view.button('时间线').props.onClick();
    expect(view.events.at(-1)).toEqual(['timeline', { date: '2026-10-29', calendarView: 'week' }]);
    view
      .all()
      .find((n) => n.tag === 'input' && n.props.type === 'date')!
      .props.onChange({ target: { value: '2026-11-03' } });
    expect(view.events.at(-1)).toEqual(['calendar', { date: '2026-11-03', calendarView: 'week' }]);
  });

  it('standalone navigation keeps complete feature access', async () => {
    const view = mount('focus');
    await settled();
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('四象限');
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('设置');
  });

  it('timeline keeps its date directory and can return to a calendar week', async () => {
    const view = mount('timeline', true);
    await settled();
    expect(view.text(view.byClass('todo-sidebar')[0])).toContain('日历视图');
    view.button('周视图').props.onClick();
    expect(view.events.at(-1)).toEqual(['calendar', { date: '2026-10-29', calendarView: 'week' }]);
  });

  it('protects unsaved settings when the host switches section, preserves the form on cancel', async () => {
    const view = mount('settings', true);
    await settled();
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
