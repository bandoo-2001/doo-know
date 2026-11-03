import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as groups from '../apps/web/to-doo-task-groups';
import * as anniversaries from '../shared/to-doo-anniversaries';
import * as controls from '../apps/web/to-doo-controls';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import {
  TO_DOO_COLLECTIONS,
  toDooEntitySchemas,
  type ToDooSnapshot,
} from '../shared/to-doo-contracts';

type Node = {
  tag: string;
  props: Record<string, any>;
  children: Node[];
  text: string;
  parent?: Node;
  scrollTop: number;
};
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});

function component(name: string): Vue.Component {
  const { descriptor } = parse(
    readFileSync(new URL(`../apps/web/components/to-doo/${name}.vue`, import.meta.url), 'utf8'),
  );
  const script = compileScript(descriptor, { id: name, inlineTemplate: true });
  const source = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {}, vModelCheckbox: {} };
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
      if (id.endsWith('/to-doo-task-groups')) return groups;
      if (id.endsWith('/to-doo-anniversaries')) return anniversaries;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id === 'ant-design-vue') return toDooAntStubs;
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('ToDooTaskRow.vue')) return { default: component('ToDooTaskRow') };
      if (id.endsWith('ToDooDisclosure.vue')) return { default: component('ToDooDisclosure') };
      if (id.endsWith('.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      throw Error('Unexpected planning dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(name: string, initial: Record<string, any>) {
  const node = (tag: string, text = ''): Node => ({
    tag,
    text,
    props: {},
    children: [],
    scrollTop: 0,
  });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insertStaticContent(content, parent) {
      const child = node('#static', content);
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
    setText: (child, text) => {
      child.text = text;
    },
    setElementText: (child, text) => {
      child.text = text;
      child.children = [];
    },
    patchProp: (child, key, _before, value) => {
      child.props[key] = value;
    },
    parentNode: (child) => child.parent || null,
    nextSibling: (child) =>
      child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  });
  const root = node('root'),
    props = Vue.reactive(initial),
    subject = component(name);
  const app = renderer.createApp({
    setup() {
      controls.provideToDooConfirm();
      return () => Vue.h(subject, props);
    },
  });
  app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  const byClass = (value: string) =>
    all().filter((n) =>
      String(n.props.class || '')
        .split(' ')
        .includes(value),
    );
  const button = (label: string) =>
    all().find(
      (n) => n.tag === 'button' && (n.props['aria-label'] === label || text(n).trim() === label),
    );
  return { root, props, all, text, byClass, button };
}
function model(request?: workbench.ToDooRequest) {
  const stamp = {
    revision: 'r1',
    createdAt: '2026-11-02T08:00:00Z',
    updatedAt: '2026-11-02T08:00:00Z',
  };
  const snapshot = {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((key) => [key, []])),
    datasetId: 'planning',
    version: '1',
    now: '2026-11-02T12:00:00Z',
    settings: toDooEntitySchemas.settings.parse({
      ...stamp,
      id: 'settings',
      timeZone: 'UTC',
      weekStartsOn: 1,
    }),
    lists: [
      toDooEntitySchemas.list.parse({ ...stamp, id: 'work', name: '工作清单', kind: 'list' }),
      toDooEntitySchemas.list.parse({
        ...stamp,
        id: 'goal',
        name: '阅读目标',
        kind: 'goal',
        description: '读完三本书',
        goalDate: '2026-12-31',
        noteRefs: [{ noteId: 'source', title: '参考书' }],
      }),
      toDooEntitySchemas.list.parse({ ...stamp, id: 'empty-goal', name: '新目标', kind: 'goal' }),
    ],
    tasks: [
      toDooEntitySchemas.task.parse({ ...stamp, id: 'todo', title: '今天的行动', listId: 'work' }),
      toDooEntitySchemas.task.parse({
        ...stamp,
        id: 'done',
        title: '已完成的阅读',
        listId: 'goal',
      }),
    ],
    occurrences: [
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-todo',
        taskId: 'todo',
        cycleKey: 'once',
        scheduleRevision: 'r1',
        due: { date: '2026-11-02', timeZone: 'UTC' },
      }),
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-done',
        taskId: 'done',
        cycleKey: 'once',
        scheduleRevision: 'r1',
        status: 'done',
      }),
    ],
    timeBlocks: [
      toDooEntitySchemas.timeBlock.parse({
        ...stamp,
        id: 'morning',
        title: '上午安排',
        start: { date: '2026-11-03', time: '09:00', timeZone: 'UTC' },
        durationMinutes: 30,
      }),
    ],
    calendarEvents: [
      toDooEntitySchemas.calendarEvent.parse({
        ...stamp,
        id: 'external',
        uid: 'external',
        title: '外部会议',
        start: { date: '2026-11-06', time: '10:00', timeZone: 'UTC' },
        end: { date: '2026-11-06', time: '10:30', timeZone: 'UTC' },
      }),
    ],
    page: {
      kind: null,
      total: 2,
      limit: 100,
      nextCursor: null,
      truncated: false,
      counts: { tasks: 2 },
    },
    statistics: {
      completed: 1,
      pending: 1,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {
        work: { completed: 0, total: 2 },
        goal: { completed: 1, total: 3 },
        'empty-goal': { completed: 0, total: 0 },
      },
    },
    warnings: [],
  } as unknown as ToDooSnapshot;
  const value = workbench.createToDooWorkbench(request ?? (async () => snapshot));
  value.acceptSnapshot(snapshot);
  return value;
}
const tick = async () => {
  await Vue.nextTick();
  await Vue.nextTick();
};

test('overview leads with today and gives goal progress only to populated goals', () => {
  const overview = mount('ToDooTaskViews', { model: model(), section: 'overview', tree: [] });
  const headings = overview
    .all()
    .filter((n) => n.tag === 'h2')
    .map(overview.text);
  expect(headings[0]).toContain('今天的行动');
  expect(overview.byClass('todo-goal').map(overview.text)).toEqual([
    expect.stringContaining('阅读目标'),
    expect.stringContaining('新目标'),
  ]);
  expect(overview.byClass('todo-overview-list').map(overview.text)).toEqual([
    expect.stringContaining('工作清单'),
  ]);
  expect(overview.all().filter((n) => n.tag === 'progress')).toHaveLength(1);
  expect(overview.text(overview.root)).not.toMatch(/0 份资料|持续推进|把下一步行动放在这里|0\/0/);
  expect(overview.text(overview.root)).toContain('2026-12-31');
  expect(overview.text(overview.root)).toContain('1 份资料');
});

test('matrix hides completed rows until the user reveals them', async () => {
  const matrix = mount('ToDooTaskViews', {
    model: model(),
    section: 'matrix',
    tree: [],
    creating: true,
  });
  expect(matrix.byClass('todo-task-name').map(matrix.text)).toEqual(['今天的行动']);
  matrix.button('显示已完成任务')!.props.onClick();
  await tick();
  expect(matrix.byClass('todo-task-name').map(matrix.text)).toContain('已完成的阅读');
  matrix.button('隐藏已完成任务')!.props.onClick();
  await tick();
  expect(matrix.byClass('todo-task-name').map(matrix.text)).not.toContain('已完成的阅读');
});

test.each(['builtin', 'status', 'search'] as const)(
  'matrix retains completed results for an explicit %s filter',
  (filter) => {
    const value = model();
    if (filter === 'status') value.state.filter.statuses = ['done'];
    if (filter === 'search') value.state.filter.query = '已完成';
    const matrix = mount('ToDooTaskViews', {
      model: value,
      section: 'matrix',
      tree: [],
      creating: true,
      quickView: filter === 'builtin' ? 'done' : 'all',
    });
    expect(matrix.byClass('todo-task-name').map(matrix.text)).toContain('已完成的阅读');
  },
);

test('calendar display settings retain layer choices when folded', async () => {
  const calendar = mount('ToDooCalendar', { model: model(), date: '2026-11-04', view: 'month' });
  expect(calendar.byClass('todo-calendar-display-panel')).toHaveLength(0);
  calendar.button('显示内容')!.props.onClick();
  await tick();
  const external = calendar
    .all()
    .find((n) => n.tag === 'label' && calendar.text(n) === '外部日历')!
    .children.find((n) => n.tag === 'input')!;
  external.props.onChange({ target: { checked: false } });
  await tick();
  expect(
    calendar
      .byClass('todo-calendar-event')
      .filter((n) => String(n.props.class).includes('external')),
  ).toHaveLength(0);
  calendar.button('显示内容')!.props.onClick();
  await tick();
  expect(calendar.byClass('todo-calendar-display-panel')).toHaveLength(0);
  calendar.button('显示内容')!.props.onClick();
  await tick();
  expect(
    calendar
      .all()
      .find((n) => n.tag === 'label' && calendar.text(n) === '外部日历')!
      .children.find((n) => n.tag === 'input')!.props.checked,
  ).toBe(false);
});

test('mobile agenda keeps occupied dates, today and anchor while empty dates remain recoverable', async () => {
  const calendar = mount('ToDooCalendar', { model: model(), date: '2026-11-04', view: 'month' });
  expect(calendar.byClass('todo-agenda-day').map((n) => n.props['data-date'])).toEqual([
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-06',
  ]);
  calendar.button('显示空白日期')!.props.onClick();
  await tick();
  expect(calendar.byClass('todo-agenda-day')).toHaveLength(30);
  expect(
    calendar
      .byClass('todo-agenda-day')
      .every((day) =>
        calendar.all(day).some((n) => n.tag === 'button' && calendar.text(n).includes('添加安排')),
      ),
  ).toBe(true);
  calendar.button('隐藏空白日期')!.props.onClick();
  await tick();
  expect(calendar.byClass('todo-agenda-day')).toHaveLength(4);
});

test('week initializes near work hours without overriding later manual scrolling', async () => {
  const value = model();
  const calendar = mount('ToDooCalendar', { model: value, date: '2026-11-04', view: 'week' });
  await tick();
  const viewport = calendar.byClass('todo-week-viewport')[0]!;
  expect(viewport).toBeDefined();
  expect(viewport.scrollTop).toBe(8 * 46);
  expect(calendar.byClass('todo-week-slot')).toHaveLength(7 * 24);
  viewport.scrollTop = 120;
  value.state.snapshot!.timeBlocks[0]!.start.time = '07:00';
  await tick();
  expect(viewport.scrollTop).toBe(120);
  calendar.props.date = '2026-11-11';
  await tick();
  expect(viewport.scrollTop).toBe(8 * 46);
});

test.each([false, true])(
  'week waits for its range snapshot and respects manual scrolling while loading (%s)',
  async (manual) => {
    let deliver!: (snapshot: ToDooSnapshot) => void;
    const value = model(
      () =>
        new Promise<ToDooSnapshot>((resolve) => {
          deliver = resolve;
        }),
    );
    value.state.query = { view: 'calendar', from: '2026-11-02', to: '2026-11-08' };
    const calendar = mount('ToDooCalendar', { model: value, date: '2026-11-04', view: 'week' });
    await tick();
    const viewport = calendar.byClass('todo-week-viewport')[0]!;
    calendar.props.date = '2026-11-11';
    const loading = value.load({ view: 'calendar', from: '2026-11-09', to: '2026-11-15' });
    await tick();
    if (manual) {
      viewport.scrollTop = 150;
      viewport.props.onScrollPassive({ target: viewport });
    }
    const arrived = JSON.parse(JSON.stringify(value.state.snapshot!)) as ToDooSnapshot;
    arrived.timeBlocks[0]!.start = { date: '2026-11-10', time: '20:00', timeZone: 'UTC' };
    deliver(arrived);
    await loading;
    await tick();
    expect(viewport.scrollTop).toBe(manual ? 150 : 19 * 46);
    value.state.snapshot!.timeBlocks[0]!.start.time = '21:00';
    calendar.button('显示内容')!.props.onClick();
    await tick();
    expect(viewport.scrollTop).toBe(manual ? 150 : 19 * 46);
  },
);
