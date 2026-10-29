import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as habits from '../shared/to-doo-habits';
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
});
const control = (tag: string) =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        Vue.h(tag, attrs, slots.default?.()),
  });
const controls = Object.fromEntries(
  ['Button', 'InputNumber', 'Modal', 'Empty', 'Alert', 'Segmented', 'Statistic', 'Progress'].map(
    (name) => [name, control(name)],
  ),
);
const Input = Object.assign(control('Input'), { TextArea: control('TextArea') });
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
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../../../shared/to-doo-habits') return habits;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => async () => false };
      if (id === 'ant-design-vue') return { ...controls, Input };
      if (id.endsWith('ToDooDateField.vue')) return { default: control('DateField') };
      if (id.endsWith('ToDooSelect.vue')) return { default: control('Select') };
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
    createElement: node,
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
    app = renderer.createApp(component(name), props);
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  return {
    all,
    text,
    button: (label: string) =>
      all().find((n) => ['button', 'Button'].includes(n.tag) && text(n).trim() === label)!,
    dialog: () => all().find((n) => n.tag === 'Modal' && n.props.open)!,
  };
}
function model() {
  const now = new Date().toISOString(),
    stamp = { id: 'session', revision: 'r1', createdAt: now, updatedAt: now };
  const state = Vue.reactive({
    snapshot: {
      ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((name) => [name, []])),
      settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings' }),
      focusSessions: [
        toDooEntitySchemas.focusSession.parse({
          ...stamp,
          mode: 'stopwatch',
          status: 'finished',
          targetMinutes: null,
          segments: [],
          note: '',
        }),
      ],
    },
    externalDirty: {},
    busy: false,
    error: '',
    notice: '',
    query: {},
  });
  return { state, execute: vi.fn(async () => ({})), removeEntity: vi.fn() };
}

test('canceling minute correction writes nothing; saving zero minutes stays numeric', async () => {
  vi.stubGlobal(
    'prompt',
    vi.fn(() => null),
  );
  const value = model(),
    view = mount('ToDooRhythm', { model: value, section: 'focus' });
  await view.button('修正').props.onClick();
  await Vue.nextTick();
  expect(view.dialog()).toBeDefined();
  view.dialog().props.onCancel();
  await Vue.nextTick();
  expect(value.execute).not.toHaveBeenCalled();
  await view.button('修正').props.onClick();
  await Vue.nextTick();
  view
    .all()
    .find((n) => n.tag === 'InputNumber' && n.props['aria-label'] === '实际专注分钟数')!
    .props['onUpdate:value'](0);
  await view.dialog().props.onOk();
  expect(value.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'control_focus',
      payload: expect.objectContaining({ operation: 'correct', correctedMinutes: 0 }),
    }),
    '实际专注时间已修正',
  );
});

test('clearing an absolute reminder removes its timestamp without throwing', async () => {
  const updates = vi.fn();
  const view = mount('ToDooReminders', {
    modelValue: [
      {
        id: 'reminder',
        anchor: 'absolute',
        offsetMinutes: 0,
        allDayTime: '09:00',
        at: '2026-10-30T08:00:00.000Z',
      },
    ],
    'onUpdate:modelValue': updates,
  });
  const field = view.all().find((n) => n.tag === 'DateField');
  expect(field).toBeDefined();
  expect(() => field!.props.onChange('')).not.toThrow();
  expect(updates).toHaveBeenLastCalledWith([
    expect.objectContaining({ anchor: 'absolute', at: undefined }),
  ]);
});

test('selecting a custom statistics interval keeps the dates and waits for explicit submit', async () => {
  const value = model();
  Object.assign(value.state.snapshot, {
    statistics: { completed: 0, focusMinutes: 0, outcomes: 0, byList: {}, scope: 'period' },
  });
  const load = vi.fn(async () => {});
  const view = mount('ToDooReview', { model: { ...value, load }, section: 'stats' });
  const segment = () => view.all().find((n) => n.tag === 'Segmented')!;
  const fields = () => view.all().filter((n) => n.tag === 'DateField');
  const before = fields().map((n) => n.props.modelValue);
  await segment().props.onChange('custom');
  await Vue.nextTick();
  expect(segment().props.value).toBe('custom');
  expect(fields().map((n) => n.props.modelValue)).toEqual(before);
  expect(load).not.toHaveBeenCalled();
  await segment().props.onChange('month');
  await Vue.nextTick();
  const today = workbench.toDooLocalDate(new Date(), value.state.snapshot.settings.timeZone);
  expect(load).toHaveBeenLastCalledWith(
    expect.objectContaining({
      view: 'stats',
      from: workbench.shiftToDooDate(today, -29),
      to: today,
    }),
  );
});

test('empty habit quantities remain empty and cannot become zero or create a record', async () => {
  const value = model(),
    now = new Date().toISOString();
  Object.assign(value.state.snapshot, {
    habits: [
      toDooEntitySchemas.habit.parse({
        id: 'habit',
        revision: 'r1',
        createdAt: now,
        updatedAt: now,
        name: '读书',
        startDate: '2020-01-01',
        target: 1,
      }),
    ],
  });
  const view = mount('ToDooRhythm', { model: value, section: 'habits' });
  const cell = view
    .all()
    .find(
      (n) => n.tag === 'button' && n.props.class.includes('todo-habit-check') && !n.props.disabled,
    )!;
  cell.props.onClick();
  await Vue.nextTick();
  const field = () =>
    view.all().find((n) => n.tag === 'InputNumber' && n.props['aria-label'] === '习惯数量')!;
  field().props['onUpdate:value'](null);
  await Vue.nextTick();
  expect(field().props.value).toBe('');
  field().props['onUpdate:value']('');
  await Vue.nextTick();
  expect(field().props.value).toBe('');
  await view.dialog().props.onOk();
  await Vue.nextTick();
  expect(value.execute).not.toHaveBeenCalled();
  expect(view.all().find((n) => n.tag === 'Alert' && n.props.type === 'error')?.props.message).toBe(
    '请输入大于 0 的数量',
  );
  field().props['onUpdate:value'](2.5);
  await view.dialog().props.onOk();
  expect(value.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'checkin_habit',
      payload: expect.objectContaining({ habitId: 'habit', amount: 2.5, skipped: false }),
    }),
    '习惯记录已保存',
  );
});
