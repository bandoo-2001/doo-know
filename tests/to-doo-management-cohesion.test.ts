import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as reminders from '../apps/web/to-doo-reminders';
import * as push from '../apps/web/to-doo-push';
import * as clock from '../apps/web/to-doo-time';
import * as contracts from '../shared/to-doo-contracts';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';

type Node = {
  tag: string;
  text: string;
  style: Record<string, any>;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

const Disclosure = Vue.defineComponent({
  props: ['open'],
  setup(props, { slots, expose }) {
    const open = Vue.ref(!!props.open);
    Vue.watch(
      () => props.open,
      (value) => (open.value = !!value),
    );
    expose({ expand: () => (open.value = true) });
    return () =>
      Vue.h('details', { open: open.value }, [
        Vue.h('summary', slots.header?.()),
        slots.default?.(),
      ]);
  },
});
const Form = Vue.defineComponent({
  setup(_, { attrs, slots, expose }) {
    expose({ element: { querySelector: () => null } });
    return () => Vue.h('form', attrs, slots.default?.());
  },
});
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
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue')
        return {
          ...toDooAntStubs,
          Tabs: Object.assign({}, toDooAntStubs.Tabs, { TabPane: toDooAntStubs.TabPane }),
          Menu: Object.assign({}, toDooAntStubs.Menu, { Item: toDooAntStubs.MenuItem }),
        };
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-reminders') return reminders;
      if (id === '../../to-doo-push') return push;
      if (id === '../../to-doo-time') return clock;
      if (id === '../../../../shared/to-doo-contracts') return contracts;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => async () => true };
      if (id.endsWith('ToDooDisclosure.vue')) return { default: Disclosure };
      if (id.endsWith('ToDooFormLayout.vue')) return { default: Form };
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('.vue'))
        return { default: component(id.split('/').at(-1)!.replace('.vue', '')) };
      throw Error('Unexpected management dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(name: string, model: any, section?: string) {
  const node = (tag: string, text = ''): Node => ({
    tag,
    text,
    style: {},
    props: {},
    children: [],
  });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insertStaticContent(text, parent) {
      const child = node('#static', text);
      child.parent = parent;
      parent.children.push(child);
      return [child, child];
    },
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
    setText(child, text) {
      child.text = text;
    },
    setElementText(child, text) {
      child.text = text;
      child.children = [];
    },
    patchProp(child, key, _old, value) {
      child.props[key] = value;
    },
    parentNode: (child) => child.parent || null,
    nextSibling: (child) =>
      child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  });
  const root = node('root');
  const app = renderer.createApp(component(name), { model, ...(section ? { section } : {}) });
  app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node = root): string => parent.text + parent.children.map(text).join('');
  const button = (name: string) =>
    all().find((child) => child.tag === 'button' && text(child).trim() === name)!;
  const disclosure = (name: string) =>
    all().find(
      (child) =>
        child.tag === 'details' &&
        child.children.some((header) => header.tag === 'summary' && text(header).includes(name)),
    )!;
  const visible = (child: Node): boolean =>
    child.style.display !== 'none' && (!child.parent || visible(child.parent));
  return { all, text, button, disclosure, visible };
}
function model() {
  vi.stubGlobal('localStorage', { getItem: () => null });
  const now = new Date().toISOString();
  const stamp = { id: 'settings', revision: 'r1', createdAt: now, updatedAt: now };
  const state = Vue.reactive<any>({
    snapshot: {
      ...Object.fromEntries(Object.values(contracts.TO_DOO_COLLECTIONS).map((name) => [name, []])),
      now,
      settings: contracts.toDooEntitySchemas.settings.parse(stamp),
      statistics: { from: now.slice(0, 10), to: now.slice(0, 10), completedByDay: {}, byList: {} },
    },
    query: {},
    externalDirty: {},
    pendingOperations: [],
    operationLoading: false,
    operationError: '',
    busy: false,
    loading: false,
    error: '',
    notice: '',
  });
  const load = vi.fn(async (query?: any) => {
    if (query) state.query = query;
  });
  return {
    state,
    load,
    saveEntity: vi.fn(),
    loadPendingOperations: vi.fn(),
    request: vi.fn(async (url: string) =>
      url === '/api/to-doo/push'
        ? { enabled: false, ready: false, reason: 'host_inactive', devices: [] }
        : [],
    ),
  };
}

test('preset statistics keep dates out of the toolbar until custom is selected', async () => {
  const value = model(),
    view = mount('ToDooReview', value, 'stats');
  const field = () => view.all().find((row) => row.props['aria-label'] === '统计开始日期')!;
  expect(field() && view.visible(field())).toBeFalsy();
  await view.button('自定义').props.onClick();
  await Vue.nextTick();
  const from = view.all().find((row) => row.props['aria-label'] === '统计开始日期')!;
  expect(view.visible(from)).toBe(true);
  from.props.onInput({ target: { value: '2026-10-01' } });
  await view
    .all()
    .find((row) => row.tag === 'form')!
    .props.onSubmit({ preventDefault() {} });
  expect(value.load).toHaveBeenCalledWith(
    expect.objectContaining({ view: 'stats', from: '2026-10-01' }),
  );
  await view.button('近 30 天').props.onClick();
  await Vue.nextTick();
  expect(view.visible(field())).toBe(false);
});

test('existing outcomes do not display an empty-review illustration or zero evidence', () => {
  const value = model();
  value.state.snapshot.outcomes = [
    { id: 'outcome', summary: '已经交付的成果', verification: 'delivered', evidenceRefs: [] },
  ];
  const view = mount('ToDooReview', value, 'stats');
  expect(view.text()).toContain('已经交付的成果');
  expect(view.text()).not.toContain('写下做对的事与下一次调整');
  expect(view.text()).not.toContain('0 份证据');
});

test('filtered notifications keep primary actions while secondary read stays reachable', async () => {
  const value = model();
  value.state.query = { reminderStates: ['unread'] };
  value.state.snapshot.reminderEvents = [
    {
      id: 'reminder',
      sourceType: 'task',
      sourceId: 'task',
      scheduledAt: value.state.snapshot.now,
      userState: 'unread',
      title: '准备报告',
      message: '准备报告',
    },
  ];
  const view = mount('ToDooReview', value, 'notifications');
  const row = view.all().find((child) => child.props['data-reminder-id'] === 'reminder')!;
  const descendants = (parent: Node): Node[] => [parent, ...parent.children.flatMap(descendants)];
  expect(descendants(row).filter((child) => child.tag === 'p')).toHaveLength(0);
  expect(
    descendants(row).filter((child) => String(child.props.class).includes('todo-badge')),
  ).toHaveLength(0);
  expect(view.button('查看任务')).toBeDefined();
  expect(view.button('已处理')).toBeDefined();
  expect(view.button('标为已读')?.props.role).toBe('menuitem');
});

test('date preferences are folded and invalid timezone reveals them before saving', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('日期与提醒')?.props.open).toBe(false);
  view
    .all()
    .find((row) => row.props['aria-label'] === '显示时区')!
    .props.onInput({ target: { value: 'Invalid/Zone' } });
  await view
    .all()
    .find((row) => row.tag === 'form')!
    .props.onSubmit();
  await Vue.nextTick();
  expect(view.disclosure('日期与提醒').props.open).toBe(true);
  expect(view.text()).toContain('请检查显示时区');
  expect(value.saveEntity).not.toHaveBeenCalled();
});

test('recovery and calendar forms are folded while drafts and pending recovery survive', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复')?.props.open).toBe(false);
  expect(view.disclosure('连接外部只读日历')?.props.open).toBe(false);
  expect(view.disclosure('创建 To Doo 只读订阅链接')?.props.open).toBe(false);
  const address = view.all().find((row) => row.tag === 'input' && row.props.type === 'url')!;
  address.props.onInput({ target: { value: 'https://example.test/draft.ics' } });
  await Vue.nextTick();
  expect(
    view.all().find((row) => row.tag === 'input' && row.props.type === 'url')!.props.value,
  ).toBe('https://example.test/draft.ics');
  value.state.pendingOperations = [
    {
      id: 'recover',
      title: '等待关联的笔记',
      state: 'note_saved',
      updatedAt: value.state.snapshot.now,
      noteId: 'note',
    },
  ];
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复').props.open).toBe(true);
  expect(view.button('核对并继续')).toBeDefined();
});

test('host and device configuration is secondary while current status and errors stay visible', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  for (let turn = 0; turn < 5; turn++) await Vue.nextTick();
  expect(view.disclosure('主机与设备管理')?.props.open).toBe(false);
  expect(view.button('启用当前设备桌面提醒')).toBeDefined();
  expect(view.text()).toContain('当前设备需要通过 HTTPS');
});

test('recovery errors reveal the section and never claim the pending records are empty', async () => {
  const value = model();
  value.state.operationError = '成果进度读取失败';
  const view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复').props.open).toBe(true);
  expect(view.button('查看进度')).toBeDefined();
  expect(view.text()).toContain('成果进度读取失败');
  expect(view.text()).not.toContain('当前已读取的记录没有待继续项');
});
