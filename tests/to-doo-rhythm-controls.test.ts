import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as vueuse from '@vueuse/core';
import * as clock from '../apps/web/to-doo-time';
import * as focusSync from '../apps/web/to-doo-focus-history-sync';
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
let confirmation = false;
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  confirmation = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  [
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
      if (id === '../../to-doo-focus-history-sync') return focusSync;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-reminders') return reminders;
      if (id === '../../../../shared/to-doo-habits') return habits;
      if (id === '../../to-doo-habit-presentation') return habitPresentation;
      if (id === '../../../../shared/to-doo-anniversaries') return anniversaries;
      if (id === '../../to-doo-controls')
        return { useToDooConfirm: () => async () => confirmation };
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
            active: null,
            items: state.snapshot.focusSessions,
            overview: {
              today: { completed: 0, minutes: 0 },
              lifetime: { completed: 0, minutes: 0 },
              filtered: { completed: 0, minutes: 0 },
              byTopic: {},
            },
            page: { total: 1, limit: 50, hasMore: false, nextCursor: null },
          }
        : {
            focusTopics: [],
            habitEntries: state.snapshot.habitEntries,
            page: { nextCursor: null },
          },
  };
}

test('canceling minute correction writes nothing; saving zero minutes stays numeric', async () => {
  vi.stubGlobal(
    'prompt',
    vi.fn(() => null),
  );
  const value = model(),
    view = mount('ToDooRhythm', { model: value, section: 'focus' });
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
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

test('a long review interval renders late completions from full statistics even when no detail rows are loaded', async () => {
  const value = model();
  Object.assign(value.state.snapshot, {
    statistics: {
      scope: 'period',
      completed: 2,
      focusMinutes: 0,
      outcomes: 0,
      byList: {},
      completedByDay: { '2026-08-01': 1, '2026-10-30': 1 },
    },
    occurrences: [],
  });
  const view = mount('ToDooReview', {
    model: { ...value, load: async () => {} },
    section: 'stats',
  });
  const fields = view.all().filter((node) => node.tag === 'DateField');
  fields[0].props['onUpdate:modelValue']('2026-08-01');
  fields[1].props['onUpdate:modelValue']('2026-10-30');
  await Vue.nextTick();
  const chart = view.all().find((node) => node.props.class === 'todo-completion-chart')!;
  expect(chart.props['aria-label']).toContain('2026-10-30');
  expect(chart.props['aria-label']).toContain('共2项');
  expect(chart.children.filter((node) => node.tag === 'div').length).toBeLessThanOrEqual(31);
});

test('editing unapplied review dates keeps the chart and new review on the displayed statistics interval', async () => {
  const value = model(),
    edit = vi.fn();
  Object.assign(value.state.snapshot, {
    statistics: {
      scope: 'period',
      from: '2026-10-24',
      to: '2026-10-30',
      completed: 1,
      focusMinutes: 25,
      outcomes: 2,
      byList: {},
      completedByDay: { '2026-10-25': 1 },
    },
  });
  const view = mount('ToDooReview', {
    model: { ...value, load: async () => {} },
    section: 'stats',
    onEdit: edit,
  });
  const fields = view.all().filter((node) => node.tag === 'DateField');
  fields[0].props['onUpdate:modelValue']('2026-08-01');
  fields[1].props['onUpdate:modelValue']('2026-08-31');
  await Vue.nextTick();
  const chart = view.all().find((node) => node.props.class === 'todo-completion-chart')!;
  expect(chart.props['aria-label']).toContain('2026-10-24 — 2026-10-30');
  expect(chart.props['aria-label']).toContain('共1项');
  expect(typeof view.vm.createReview).toBe('function');
  view.vm.createReview();
  expect(edit).toHaveBeenCalledWith(
    'review',
    undefined,
    expect.objectContaining({
      from: '2026-10-24',
      to: '2026-10-30',
      metrics: { completed: 1, focusMinutes: 25, outcomes: 2 },
    }),
  );
});

test('a lunar anniversary distinguishes its original lunar date from the next Gregorian date', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  const value = model();
  Object.assign(value.state.snapshot, {
    anniversaries: [
      toDooEntitySchemas.anniversary.parse({
        id: 'mid-autumn',
        revision: 'a1',
        createdAt: '2026-10-30T12:00:00Z',
        updatedAt: '2026-10-30T12:00:00Z',
        name: '中秋',
        date: '2001-08-15',
        calendar: 'lunar',
        repeatYearly: true,
      }),
    ],
  });
  const view = mount('ToDooRhythm', { model: value, section: 'anniversaries' });
  const content = view
    .all()
    .map((node) => node.text)
    .join('');
  expect(content).toContain('农历原日期：2001-08-15');
  expect(content).toContain('下次公历：2027-09-15');
});

test('opening a task notification resolves its exact recurring execution through the reminder domain', async () => {
  const value = model(),
    task = vi.fn();
  const stamp = {
    id: 'notice',
    revision: 'n1',
    createdAt: '2026-10-30T10:00:00Z',
    updatedAt: '2026-10-30T10:00:00Z',
  };
  const event = toDooEntitySchemas.reminderEvent.parse({
    ...stamp,
    sourceType: 'task',
    sourceId: 'task-id',
    occurrenceKey: 'cycle-2',
    ruleId: 'rule',
    scheduleRevision: 's1',
    scheduledAt: '2026-10-30T10:00:00Z',
    firstRaisedAt: '2026-10-30T10:00:00Z',
  });
  Object.assign(value.state.snapshot, { reminderEvents: [event] });
  const view = mount('ToDooReview', {
    model: {
      ...value,
      request: async () => ({ event, taskId: 'task-id', occurrenceId: 'occurrence-2' }),
    },
    section: 'notifications',
    onTask: task,
  });
  await view.button('查看任务').props.onClick();
  expect(task).toHaveBeenCalledWith('task-id', 'occurrence-2');
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
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
  view
    .all()
    .find((n) => n.tag === 'Segmented' && n.props['aria-label'] === '习惯视图')!
    .props['onUpdate:value']('history');
  await Vue.nextTick();
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

test('an ordinary habit card offers a single check-in and hides quantitative inputs', async () => {
  const now = new Date().toISOString();
  const habit = toDooEntitySchemas.habit.parse({
    id: 'sleep',
    revision: 'r1',
    createdAt: now,
    updatedAt: now,
    name: '早睡',
    goalMode: 'checkin',
    startDate: '2026-10-26',
  });
  const record = vi.fn();
  const view = mount('ToDooHabitCard', {
    habit,
    date: '2026-10-30',
    summary: habits.summarizeHabitPeriod(habit, [], '2026-10-30'),
    amount: 0,
    entryCount: 0,
    skipped: false,
    exempt: false,
    ready: true,
    busy: false,
    quantity: 1,
    onRecord: record,
  });
  expect(view.all().filter((n) => n.tag === 'InputNumber')).toHaveLength(0);
  await view.button('打卡').props.onClick();
  expect(record).toHaveBeenCalledOnce();
  Object.assign(view.vm.$.props, { amount: 1, entryCount: 1 });
  await Vue.nextTick();
  expect(view.button('已打卡').props.disabled).toBe(true);
});

function auditHabitFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  const value = model();
  const habit = toDooEntitySchemas.habit.parse({
    id: 'reading',
    revision: 'h1',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    name: '历史阅读',
    startDate: '2026-11-01',
    timeZone: 'UTC',
    target: 20,
    unit: '页',
    goalMode: 'quantity',
  });
  const records = [10, 15, 20].map((amount, i) =>
    toDooEntitySchemas.habitEntry.parse({
      id: 'entry-' + i,
      revision: 'e' + i,
      createdAt: '2026-11-03T00:00:00Z',
      updatedAt: '2026-11-03T00:00:00Z',
      habitId: habit.id,
      localDate: '2026-11-03',
      occurredAt: `2026-11-03T0${i + 1}:00:00Z`,
      amount,
      note: '记录' + i,
      sourceSessionId: i === 1 ? 'focus-session' : null,
    }),
  );
  Object.assign(value.state.snapshot, { habits: [habit], habitEntries: records });
  value.removeEntity.mockImplementation(async (_kind, entry) => {
    entry.deletedAt = '2026-11-03T12:00:00Z';
    return {};
  });
  return { value, records };
}
async function openAuditHistory() {
  const fixture = auditHabitFixture();
  const view = mount('ToDooRhythm', { model: fixture.value, section: 'habits' });
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
  view
    .all()
    .find((n) => n.tag === 'Segmented' && n.props['aria-label'] === '习惯视图')!
    .props['onUpdate:value']('history');
  await Vue.nextTick();
  const cell = view
    .all()
    .find(
      (n) => n.tag === 'button' && n.props['aria-label'] === '历史阅读 2026-11-03 打卡，当前 45 页',
    )!;
  return { ...fixture, view, cell };
}
test('achieved quantitative history retains the actual 45 rather than replacing it with a check', async () => {
  const { view, cell } = await openAuditHistory();
  expect(view.text(cell)).toContain('45');
  expect(view.text(cell)).toContain('✓');
  cell.props.onClick();
  await Vue.nextTick();
  expect(view.text(view.dialog())).toContain('已累计 45 / 20 页');
});
test('correcting one of three day records retains the other two and its focus source', async () => {
  const { value, records, view, cell } = await openAuditHistory();
  cell.props.onClick();
  await Vue.nextTick();
  const rows = view.all().filter((n) => n.tag === 'li' && n.props['data-habit-entry-id']);
  expect(rows).toHaveLength(3);
  const row = rows.find((n) => n.props['data-habit-entry-id'] === 'entry-0')!;
  expect(view.text(row)).toContain('10 页');
  expect(view.text(row)).toContain('01:00');
  expect(view.text(row)).toContain('记录0');
  confirmation = true;
  await view
    .all(row)
    .find((n) => n.tag === 'Button' && view.text(n) === '撤销此条')!
    .props.onClick();
  expect(value.removeEntity).toHaveBeenCalledExactlyOnceWith('habitEntry', records[0]);
  expect(records.filter((e) => !e.deletedAt).map((e) => e.id)).toEqual(['entry-1', 'entry-2']);
  expect(records[1].sourceSessionId).toBe('focus-session');
});
test('habit cards expose the effective local date and zone when workspace today differs', async () => {
  const { value } = auditHabitFixture();
  vi.setSystemTime(new Date('2026-11-03T00:30:00Z'));
  value.state.snapshot.settings.timeZone = 'UTC';
  (value.state.snapshot as any).habits[0].timeZone = 'America/Los_Angeles';
  const view = mount('ToDooRhythm', { model: value, section: 'habits' });
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
  const card = view.all().find((n) => n.tag === 'article')!;
  expect(view.text(card)).toContain('2026-11-02');
  expect(view.text(card)).toContain('America/Los_Angeles');
  await view.button('记录').props.onClick();
  expect(value.execute).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ localDate: '2026-11-02' }) }),
    expect.any(String),
  );
});
test.each(['exclude_today', 'include_today'] as const)(
  'today anniversary reads today with %s and past one-off labels the original date',
  (countMode) => {
    auditHabitFixture();
    const value = model();
    Object.assign(value.state.snapshot, {
      anniversaries: ['2026-11-03', '2026-11-01'].map((date, i) =>
        toDooEntitySchemas.anniversary.parse({
          id: 'ann-' + i,
          revision: 'a1',
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-01T00:00:00Z',
          name: '纪念日' + i,
          date,
          repeatYearly: false,
          countMode,
        }),
      ),
    });
    const view = mount('ToDooRhythm', { model: value, section: 'anniversaries' });
    const cards = view.all().filter((n) => n.tag === 'article');
    expect(view.text(cards.find((n) => view.text(n).includes('纪念日0'))!)).toContain('就是今天');
    const past = view.text(cards.find((n) => view.text(n).includes('纪念日1'))!);
    expect(past).toContain('公历日期：2026-11-01');
    expect(past).not.toContain('下次');
  },
);

test('historical entries retain the rule unit and local clock after a later rule changes timezone', async () => {
  const { value } = auditHabitFixture();
  const habit = (value.state.snapshot as any).habits[0];
  const oldRule = { ...habits.getHabitRule(habit, '2026-11-03'), id: 'old', estimated: false };
  const laterRule = {
    ...oldRule,
    id: 'later',
    effectiveFrom: '2026-11-04',
    timeZone: 'Asia/Shanghai',
    unit: '分钟',
    target: 30,
  };
  Object.assign(habit, {
    timeZone: 'Asia/Shanghai',
    unit: '分钟',
    target: 30,
    ruleVersions: [oldRule, laterRule],
  });
  const view = mount('ToDooRhythm', { model: value, section: 'habits' });
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
  view
    .all()
    .find((n) => n.tag === 'Segmented' && n.props['aria-label'] === '习惯视图')!
    .props['onUpdate:value']('history');
  await Vue.nextTick();
  view
    .all()
    .find(
      (n) => n.tag === 'button' && n.props['aria-label'] === '历史阅读 2026-11-03 打卡，当前 45 页',
    )!
    .props.onClick();
  await Vue.nextTick();
  const row = view
    .all()
    .find((n) => n.tag === 'li' && n.props['data-habit-entry-id'] === 'entry-0')!;
  expect(view.text(row)).toContain('10 页');
  expect(view.text(row)).toContain('01:00');
  expect(view.text(view.dialog())).toContain('记录时区：UTC');
});

test.each([
  { skipped: false, amount: 7, unit: '杯', marker: '✓', label: '打卡', want: '7 杯' },
  { skipped: true, amount: 0, unit: '次', marker: '跳', label: '已跳过', want: '0 次' },
])(
  'a saved $label entry exposes its actual amount and historical unit',
  async ({ skipped, amount, unit, marker, label, want }) => {
    const { value, records } = auditHabitFixture();
    Object.assign((value.state.snapshot as any).habits[0], {
      goalMode: 'checkin',
      target: 1,
      unit,
    });
    records[0].amount = amount;
    records[0].skipped = skipped;
    value.state.snapshot.habitEntries = [records[0]];
    const view = mount('ToDooRhythm', { model: value, section: 'habits' });
    for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
    view
      .all()
      .find((n) => n.tag === 'Segmented' && n.props['aria-label'] === '习惯视图')!
      .props['onUpdate:value']('history');
    await Vue.nextTick();
    const cell = view
      .all()
      .find(
        (n) =>
          n.tag === 'button' &&
          n.props['aria-label'] === '历史阅读 2026-11-03 打卡，当前 ' + amount + ' ' + unit,
      )!;
    expect(view.text(cell)).toBe(marker);
    cell.props.onClick();
    await Vue.nextTick();
    const row = view
      .all()
      .find((n) => n.tag === 'li' && n.props['data-habit-entry-id'] === 'entry-0')!;
    expect(view.text(row)).toContain(want);
    expect(view.text(row)).toContain(label);
  },
);
