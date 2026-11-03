import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as vueuse from '@vueuse/core';
import * as clock from '../apps/web/to-doo-time';
import * as workbench from '../apps/web/to-doo-workbench';
import * as reminders from '../apps/web/to-doo-reminders';
import * as habits from '../shared/to-doo-habits';
import * as habitPresentation from '../apps/web/to-doo-habit-presentation';
import * as anniversaries from '../shared/to-doo-anniversaries';
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
const controls = Object.fromEntries(
  [
    'Drawer',
    'Button',
    'InputNumber',
    'Modal',
    'Empty',
    'Alert',
    'Segmented',
    'Statistic',
    'Progress',
    'Dropdown',
    'Menu',
    'Tabs',
    'Tag',
    'MenuItem',
  ].map((name) => [name, control(name)]),
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
      if (id === '@vueuse/core') return vueuse;
      if (id === '../../to-doo-time') return clock;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-reminders') return reminders;
      if (id === '../../../../shared/to-doo-habits') return habits;
      if (id === '../../to-doo-habit-presentation') return habitPresentation;
      if (id === '../../../../shared/to-doo-anniversaries') return anniversaries;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => async () => false };
      if (id === 'ant-design-vue')
        return {
          ...controls,
          Input,
          Menu: Object.assign(controls.Menu, { Item: control('MenuItem') }),
          Tabs: Object.assign(controls.Tabs, { TabPane: control('TabPane') }),
        };
      if (id.endsWith('ToDooDateField.vue')) return { default: control('DateField') };
      if (id.endsWith('ToDooSelect.vue')) return { default: control('Select') };
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
    app = renderer.createApp(component(name), props);
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
test('yearly focus values identify whole months rather than their first calendar day', () => {
  const view = mount('ToDooFocusTrend', {
    period: 'year',
    date: '2026-10-30',
    loading: false,
    error: '',
    timeZone: 'UTC',
    trend: {
      period: 'year',
      from: '2026-01-01',
      to: '2026-12-31',
      bucket: 'month',
      totalMinutes: 165,
      points: Array.from({ length: 12 }, (_, index) => ({
        date: `2026-${String(index + 1).padStart(2, '0')}-01`,
        minutes: index === 8 ? 60 : index === 9 ? 105 : 0,
      })),
    },
  });
  expect(view.all().find((node) => node.props['aria-label'] === '2026-10：105 分钟')).toBeDefined();
  expect(view.all().some((node) => node.tag === 'th' && view.text(node) === '月份')).toBe(true);
  const row = view.all().find((node) => node.tag === 'tr' && view.text(node).includes('105 分钟'))!;
  expect(view.text(row)).toBe('2026-10105 分钟');
});

function model() {
  const now = new Date().toISOString(),
    stamp = { id: 'session', revision: 'r1', createdAt: now, updatedAt: now };
  const state = Vue.reactive({
    snapshot: {
      ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((name) => [name, []])),
      settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings' }),
      habitEntries: [] as ReturnType<typeof toDooEntitySchemas.habitEntry.parse>[],
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
  return {
    state,
    execute: vi.fn(async () => ({})),
    removeEntity: vi.fn(),
    request: async (url: string) =>
      url.startsWith('/api/to-doo/focus/history')
        ? {
            datasetId: 'focus-fixture',
            revision: 'r1',
            now: new Date().toISOString(),
            timeZone: 'UTC',
            active:
              state.snapshot.focusSessions.find((session) =>
                ['running', 'paused'].includes(session.status),
              ) ?? null,
            items: state.snapshot.focusSessions,
            overview: {
              today: { completed: 0, minutes: 0 },
              lifetime: { completed: 0, minutes: 0 },
              filtered: { completed: 0, minutes: 0 },
              byTopic: {},
            },
            page: {
              total: state.snapshot.focusSessions.length,
              limit: 50,
              hasMore: false,
              nextCursor: null,
            },
          }
        : {
            focusTopics: [],
            habitEntries: state.snapshot.habitEntries,
            page: { nextCursor: null },
          },
  };
}

async function settle() {
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
}
function ancestor(node: Node, tag: string): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.tag === tag) return parent;
}

test('desktop timer settings preserve the selected action and duration across close and reopen', async () => {
  const value = model(),
    view = mount('ToDooRhythm', { model: value, section: 'focus' });
  await settle();
  expect(
    view.all().filter((n) => n.tag === 'Select' && n.props['aria-label'] === '关联行动'),
  ).toHaveLength(0);
  const settings = view
    .all()
    .find((n) => n.tag === 'Button' && n.props['aria-label'] === '计时设置');
  expect(settings).toBeDefined();
  settings!.props.onClick();
  await settle();
  view
    .all()
    .find((n) => n.tag === 'Select' && n.props['aria-label'] === '关联行动')!
    .props.onChange('linked-action');
  view
    .all()
    .find((n) => n.tag === 'InputNumber' && n.props['aria-label'] === '本次时长')!
    .props['onUpdate:value'](42);
  await settle();
  view.button('收起计时设置').props.onClick();
  await settle();
  settings!.props.onClick();
  await settle();
  const actions = view
    .all()
    .filter((n) => n.tag === 'Select' && n.props['aria-label'] === '关联行动');
  expect(actions).toHaveLength(1);
  expect(actions[0].props.value).toBe('linked-action');
  expect(
    view.all().find((n) => n.tag === 'InputNumber' && n.props['aria-label'] === '本次时长')!.props
      .value,
  ).toBe(42);
});

test('a running session keeps linked action context and unsaved-note status visible outside settings', async () => {
  const value = model();
  Object.assign(value.state.snapshot.focusSessions[0], {
    status: 'running',
    occurrenceId: 'linked-action',
    taskTitle: '写完阅读摘要',
    note: '已保存内容',
  });
  const view = mount('ToDooRhythm', { model: value, section: 'focus' });
  await settle();
  const context = view.all().find((n) => n.props.class === 'todo-focus-timer-context')!;
  expect(view.text(context)).toContain('写完阅读摘要');
  const settings = view
    .all()
    .find((n) => n.tag === 'Button' && n.props['aria-label'] === '计时设置');
  expect(settings).toBeDefined();
  settings!.props.onClick();
  await settle();
  const note = view
    .all()
    .find((n) => n.tag === 'TextArea' && n.props['aria-label'] === '本次专注记录')!;
  note.props['onUpdate:value']('尚未保存的补充');
  await settle();
  view.button('收起计时设置').props.onClick();
  await settle();
  expect(view.text(context)).toContain('记录未保存');
  expect(value.state.externalDirty).toMatchObject({ focus: true });
  settings!.props.onClick();
  await settle();
  expect(
    view.all().find((n) => n.tag === 'TextArea' && n.props['aria-label'] === '本次专注记录')!.props
      .value,
  ).toBe('尚未保存的补充');
});

test('history record creation remains available on demand with its original session seed', async () => {
  const edit = vi.fn(),
    value = model();
  value.state.snapshot.focusSessions[0].note = '阅读总结';
  const view = mount('ToDooRhythm', { model: value, section: 'focus', onEdit: edit });
  await settle();
  const record = view.button('记录');
  expect(ancestor(record, 'details')).toBeDefined();
  expect(ancestor(view.button('修正'), 'details')).toBe(ancestor(record, 'details'));
  record.props.onClick();
  expect(edit).toHaveBeenCalledWith(
    'record',
    undefined,
    expect.objectContaining({ content: '阅读总结', sourceSessionId: 'session' }),
  );
});

test('empty focus history omits loaded-count chrome while keeping today and cumulative totals', async () => {
  const value = model();
  value.state.snapshot.focusSessions = [];
  const view = mount('ToDooRhythm', { model: value, section: 'focus' });
  await settle();
  expect(view.all().filter((n) => n.tag === 'Statistic')).toHaveLength(4);
  expect(view.all().filter((n) => n.tag === 'p' && view.text(n).includes('已载入'))).toHaveLength(
    0,
  );
  const policy = view
    .all()
    .find((n) => n.tag === 'p' && view.text(n).includes('完成次数按开始日计算'))!;
  expect(ancestor(policy, 'details')).toBeDefined();
});

test('anniversaries keep lunar origins visible and place additional content in a nonempty disclosure', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const value = model();
  const stamp = {
    revision: 'a1',
    createdAt: '2026-10-30T12:00:00Z',
    updatedAt: '2026-10-30T12:00:00Z',
  };
  Object.assign(value.state.snapshot, {
    anniversaries: [
      toDooEntitySchemas.anniversary.parse({
        ...stamp,
        id: 'lunar',
        name: '中秋',
        date: '2001-08-15',
        calendar: 'lunar',
        repeatYearly: true,
        description: '家人团聚',
      }),
      toDooEntitySchemas.anniversary.parse({
        ...stamp,
        id: 'solar',
        name: '见面',
        date: '2026-11-05',
        calendar: 'gregorian',
        repeatYearly: false,
      }),
    ],
  });
  const view = mount('ToDooRhythm', { model: value, section: 'anniversaries' });
  const lunar = view.all().find((n) => n.tag === 'article' && view.text(n).includes('中秋'))!;
  const solar = view.all().find((n) => n.tag === 'article' && view.text(n).includes('见面'))!;
  const original = view
    .all(lunar)
    .find((n) => n.tag === 'p' && view.text(n).includes('农历原日期：2001-08-15'))!;
  expect(original).toBeDefined();
  expect(ancestor(original, 'details')).toBeUndefined();
  const description = view
    .all(lunar)
    .find((n) => n.tag === 'p' && view.text(n).includes('家人团聚'))!;
  expect(ancestor(description, 'details')).toBeDefined();
  expect(view.all(solar).filter((n) => n.tag === 'details')).toHaveLength(0);
  expect(view.text(solar)).not.toContain('重要日子');
  expect(view.text(solar)).not.toContain('公历原日期：');
  expect(view.text(solar)).toContain('下次公历：2026-11-05');
});
