import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as groups from '../apps/web/to-doo-task-groups';
import * as controls from '../apps/web/to-doo-controls';
import * as actionGuards from '../apps/web/to-doo-action-guard';
import * as displayPreferences from '../apps/web/to-doo-display-preferences';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas, type ToDooSnapshot } from '../shared/to-doo-contracts';

type Node = {
  tag: string; text: string; props: Record<string, any>; children: Node[];
  style: Record<string, string>; parent?: Node;
};
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));
const settle = async () => { for (let step = 0; step < 6; step++) await Vue.nextTick(); };

function fixture(section: 'tasks' | 'board' = 'tasks') {
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], style: {} });
  const header = node('header'), popup = node('popup-root');
  const headers = [header], headerTarget = Vue.shallowRef(header);
  // A controlled, body-mounted popup tests the same lifecycle boundary as Ant.
  // KeepAlive and both levels of Teleport are the real Vue implementations.
  const Popover = Vue.defineComponent({
    inheritAttrs: false, props: ['open', 'title'], emits: ['update:open', 'openChange'],
    setup: (props, { attrs, emit, slots }) => () => Vue.h('span', attrs, [
      ...(slots.default?.() || []).map(child => Vue.cloneVNode(child, { onClick: () => {
        emit('update:open', !props.open); emit('openChange', !props.open);
      } })),
      props.open ? Vue.h(Vue.Teleport, { to: popup }, slots.content?.()) : null,
    ]),
  });
  const compile = (name: string): Vue.Component => {
    const { descriptor } = parse(readFileSync(new URL(`../apps/web/components/to-doo/${name}.vue`, import.meta.url), 'utf8'));
    const script = compileScript(descriptor, { id: name, inlineTemplate: true });
    const source = ts.transpileModule(script.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const output = { exports: {} as any };
    new Function('require', 'module', 'exports', source)((id: string) => {
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {}, vModelCheckbox: {} };
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
      if (id.endsWith('/to-doo-task-groups')) return groups;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id.endsWith('/to-doo-action-guard')) return actionGuards;
      if (id.endsWith('/to-doo-display-preferences')) return displayPreferences;
      if (id === 'ant-design-vue') return { ...toDooAntStubs, Popover };
      if (id.endsWith('ToDooPageToolbar.vue')) return { default: compile('ToDooPageToolbar') };
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      throw Error('Unexpected toolbar dependency: ' + id);
    }, output, output.exports);
    return output.exports.default;
  };
  const renderer = Vue.createRenderer<Node, Node>({
    querySelector: () => null,
    createElement: tag => node(tag), createText: text => node('#text', text),
    createComment: () => node('#comment'),
    insertStaticContent(content, parent, anchor) {
      const child = node('#static', content); child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
      return [child, child];
    },
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = undefined;
    },
    setText: (child, text) => { child.text = text; },
    setElementText: (child, text) => { child.text = text; child.children = []; },
    parentNode: child => child.parent || null,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    patchProp: (child, key, _before, value) => { child.props[key] = value; },
  });
  const stamp = { revision: 'r1', createdAt: '2026-11-15T08:00:00Z', updatedAt: '2026-11-15T08:00:00Z' };
  const snapshot = {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map(collection => [collection, []])),
    datasetId: 'toolbar', version: '1', now: stamp.createdAt,
    settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings', timeZone: 'UTC' }),
    tasks: [toDooEntitySchemas.task.parse({ ...stamp, id: 'task', title: '待办任务' })],
    occurrences: [toDooEntitySchemas.occurrence.parse({ ...stamp, id: 'occ', taskId: 'task', cycleKey: 'single', scheduleRevision: 's1' })],
    templates: [toDooEntitySchemas.template.parse({ ...stamp, id: 'template', name: '复用模板', tasks: [] })],
    page: { kind: null, total: 1, limit: 200, nextCursor: null, truncated: false, counts: { tasks: 1 } },
    statistics: { completed: 0, pending: 1, overdue: 0, focusMinutes: 0, habitAmount: 0, outcomes: 0, byList: {} },
    warnings: [],
  } as unknown as ToDooSnapshot;
  const request = vi.fn(async () => snapshot);
  const model = workbench.createToDooWorkbench(request);
  model.acceptSnapshot(snapshot); model.selectTask('task', 'occ');
  const shown = Vue.ref(true), density = Vue.ref<'comfortable' | 'compact'>('comfortable');
  const subject = compile('ToDooTaskViews'), subjectRef = Vue.ref<any>();
  const Other = Vue.defineComponent({
    render: () => Vue.h('div', { class: 'timeline-page' }, [
      Vue.h('div', { class: 'todo-task-toolbar', 'aria-label': '任务展示方式' }, '时间线专业视图工具'),
    ]),
  });
  const root = node('root');
  const app = renderer.createApp({
    setup() {
      controls.provideToDooConfirm();
      return () => Vue.h(Vue.KeepAlive, null, {
        default: () => shown.value
          ? Vue.h(subject, { ref: subjectRef, model, tree: [], section, toolbarTarget: headerTarget.value,
              density: density.value, 'onUpdate:density': (next: 'comfortable' | 'compact') => { density.value = next; } })
          : Vue.h(Other),
      });
    },
  });
  app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent: Node): Node[] => [parent, ...parent.children.flatMap(all)];
  const visible = () => [root, ...headers, popup].flatMap(all);
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  const find = (tag: string, label: string) => visible().find(item => item.tag === tag &&
    (item.props['aria-label'] === label || text(item).trim() === label));
  const button = (label: string) => find('button', label)!;
  const byClass = (name: string, target?: Node) => (target ? all(target) : visible())
    .filter(item => String(item.props.class || '').split(' ').includes(name));
  const replaceHeader = () => {
    const next = node('header'); headers.push(next); headerTarget.value = next; return next;
  };
  return { root, header, popup, model, request, shown, density, ref: subjectRef, visible, find, button, byClass, replaceHeader };
}

test('a deactivated task view removes its teleported toolbar and never duplicates the active page toolbar', async () => {
  const f = fixture('board'); await settle();
  const uid = f.ref.value.$.uid;
  f.model.draft()!.task.description = '切页仍保留的编辑';
  f.model.newTaskDraft().title = '保留新建输入';
  f.model.state.selectedIds = ['task'];
  f.button('任务显示与管理').props.onClick(); await settle();
  f.find('select', '看板分组')!.props.onChange('priority');
  f.find('select', '任务密度')!.props.onChange('compact'); await settle();
  for (let cycle = 0; cycle < 3; cycle++) {
    expect(f.byClass('todo-task-toolbar')).toHaveLength(1);
    expect(f.byClass('todo-task-toolbar', f.header)).toHaveLength(1);
    f.shown.value = false; await settle();
    expect(f.byClass('todo-task-toolbar', f.header)).toHaveLength(0);
    expect(f.byClass('todo-task-toolbar')).toHaveLength(1);
    expect(f.byClass('todo-task-toolbar')[0].props['aria-label']).toBe('任务展示方式');
    expect(f.find('button', '任务显示与管理')).toBeUndefined();
    expect(f.popup.children.filter(child => child.tag !== '#text')).toEqual([]);
    f.shown.value = true; await settle();
    expect(f.ref.value.$.uid).toBe(uid);
    expect(f.find('select', '看板分组')).toBeUndefined();
  }
  f.button('任务显示与管理').props.onClick(); await settle();
  expect(f.find('select', '看板分组')!.props.value).toBe('priority');
  expect(f.density.value).toBe('compact');
  expect(f.model.state.selectedIds).toEqual(['task']);
  expect(f.model.draft()!.task.description).toBe('切页仍保留的编辑');
  expect(f.model.newTaskDraft().title).toBe('保留新建输入');
  expect(f.request).not.toHaveBeenCalled();
});

test.each([
  ['搜索任务', 'todo-task-search-form'], ['筛选', 'todo-task-filter-form'], ['任务显示与管理', 'todo-task-display-form'],
])('the %s popup closes on deactivation and stays closed on return without clearing filters', async (trigger, popupClass) => {
  const f = fixture(); await settle();
  f.model.state.filter.query = '待办';
  f.button(trigger).props.onClick(); await settle();
  expect(f.byClass(popupClass, f.popup)).toHaveLength(1);
  f.shown.value = false; await settle();
  expect(f.byClass(popupClass)).toHaveLength(0);
  f.shown.value = true; await settle();
  expect(f.byClass(popupClass)).toHaveLength(0);
  expect(f.model.state.filter.query).toBe('待办');
  f.button(trigger).props.onClick(); await settle();
  expect(f.byClass(popupClass, f.popup)).toHaveLength(1);
});

test('reactivation targets a replacement header without leaving controls in its previous host', async () => {
  const f = fixture(); await settle();
  expect(f.byClass('todo-task-toolbar', f.header)).toHaveLength(1);
  f.shown.value = false; await settle();
  const replacement = f.replaceHeader(); await settle();
  expect(f.byClass('todo-task-toolbar', f.header)).toHaveLength(0);
  expect(f.byClass('todo-task-toolbar', replacement)).toHaveLength(0);
  f.shown.value = true; await settle();
  expect(f.byClass('todo-task-toolbar', f.header)).toHaveLength(0);
  expect(f.byClass('todo-task-toolbar', replacement)).toHaveLength(1);
  expect(f.byClass('todo-task-toolbar')).toHaveLength(1);
});

test.each(['高级筛选', '从模板新建'])('the %s dialog does not reopen after a task view is reactivated', async (dialog) => {
  const f = fixture(); await settle();
  if (dialog === '高级筛选') {
    f.button('筛选').props.onClick(); await settle();
    f.button('更多筛选条件').props.onClick();
  } else {
    f.button('任务显示与管理').props.onClick(); await settle();
    f.button('从模板新建').props.onClick();
  }
  await settle();
  expect(f.visible().filter(item => item.props.role === 'dialog' && item.props['aria-label'] === dialog)).toHaveLength(1);
  f.shown.value = false; await settle();
  f.shown.value = true; await settle();
  expect(f.visible().filter(item => item.props.role === 'dialog' && item.props['aria-label'] === dialog)).toHaveLength(0);
  expect(f.byClass('todo-task-toolbar')).toHaveLength(1);
});
