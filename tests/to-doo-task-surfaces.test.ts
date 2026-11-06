import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as controls from '../apps/web/to-doo-controls';
import * as groups from '../apps/web/to-doo-task-groups';
import * as menus from '../apps/web/to-doo-menu';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';
import {
  TO_DOO_COLLECTIONS,
  toDooCommandSchema,
  toDooEntitySchemas,
  type ToDooCommand,
  type ToDooSnapshot,
} from '../shared/to-doo-contracts';

type Node = {
  tag: string;
  style: Record<string, string>;
  props: Record<string, any>;
  children: Node[];
  text: string;
  parent?: Node;
};
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

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
      if (id === 'vue') return { ...Vue, vModelText: {}, vModelSelect: {}, vModelCheckbox: {} };
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-presentation') return presentation;
      if (id === '../../to-doo-task-groups') return groups;
      if (id === '../../to-doo-menu') return menus;
      if (id === 'ant-design-vue') return toDooAntStubs;
      if (id.endsWith('/to-doo-controls')) return controls;
      if (id.endsWith('ToDooDisclosure.vue')) return { default: component('ToDooDisclosure') };
      if (id.endsWith('ToDooHint.vue')) return { default: component('ToDooHint') };
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('ToDooTaskRow.vue')) return { default: component('ToDooTaskRow') };
      if (id.endsWith('ToDooTaskMenu.vue')) return { default: component('ToDooTaskMenu') };
      if (id.endsWith('ToDooTaskGroupMenu.vue'))
        return { default: component('ToDooTaskGroupMenu') };
      if (id.endsWith('.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      throw Error(`Unexpected task component dependency: ${id}`);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(name: string, props: Record<string, any>) {
  const node = (tag: string, text = ''): Node => ({
    tag,
    style: {},
    text,
    props: {},
    children: [],
  });
  const renderer = Vue.createRenderer<Node, Node>({
    insertStaticContent(content, parent, anchor) {
      const child = node('#static', content);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
      return [child, child];
    },
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
  const root = node('root');
  const subject = component(name);
  const shown = Vue.ref(true);
  let confirmation!: ReturnType<typeof controls.provideToDooConfirm>;
  const app = renderer.createApp({
    setup() {
      confirmation = controls.provideToDooConfirm();
      return () => (shown.value ? Vue.h(subject, props) : null);
    },
  });
  app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  const byClass = (name: string) =>
    all().filter((n) =>
      String(n.props.class || '')
        .split(' ')
        .includes(name),
    );
  return {
    root,
    all,
    text,
    byClass,
    confirmation,
    hide: () => {
      shown.value = false;
    },
  };
}
function model() {
  const stamp = {
    id: 'task-a',
    revision: 'r1',
    createdAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
  };
  const snapshot = {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map((name) => [name, []])),
    datasetId: 'test',
    version: '1',
    now: stamp.createdAt,
    settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings' }),
    tasks: [
      toDooEntitySchemas.task.parse({
        ...stamp,
        title: '准备报告',
        priority: 'high',
        importance: 'important',
        urgentOverride: false,
      }),
    ],
    occurrences: [
      toDooEntitySchemas.occurrence.parse({
        ...stamp,
        id: 'occ-a',
        taskId: 'task-a',
        cycleKey: 'once',
        scheduleRevision: 'r1',
        due: { date: '2026-10-30', timeZone: 'UTC' },
      }),
    ],
    page: {
      kind: null,
      total: 1,
      limit: 100,
      nextCursor: null,
      truncated: false,
      counts: { tasks: 1 },
    },
    statistics: {
      completed: 0,
      pending: 1,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    warnings: [],
  } as unknown as ToDooSnapshot;
  const model = workbench.createToDooWorkbench(async () => snapshot);
  model.acceptSnapshot(snapshot);
  model.selectTask('task-a', 'occ-a');
  return model;
}

function confirmationModel() {
  const snapshot = JSON.parse(JSON.stringify(model().state.snapshot)) as ToDooSnapshot;
  const stamp = snapshot.tasks[0]!;
  snapshot.tasks.push(
    toDooEntitySchemas.task.parse({ ...stamp, id: 'task-b', title: '另一份报告' }),
    toDooEntitySchemas.task.parse({
      ...stamp,
      id: 'child-a',
      title: '报告子任务',
      parentTaskId: 'task-a',
    }),
  );
  snapshot.occurrences.push(
    toDooEntitySchemas.occurrence.parse({
      ...snapshot.occurrences[0],
      id: 'occ-b',
      taskId: 'task-b',
    }),
    toDooEntitySchemas.occurrence.parse({
      ...snapshot.occurrences[0],
      id: 'occ-child-a',
      taskId: 'child-a',
    }),
  );
  const writes: ToDooCommand[] = [];
  const value = workbench.createToDooWorkbench(async (_url, method = 'GET', body) => {
    if (method === 'GET') return structuredClone(snapshot);
    const command = toDooCommandSchema.parse(body);
    writes.push(command);
    if (command.action === 'set_occurrence_status') {
      snapshot.occurrences.find((item) => item.id === command.payload.id)!.status =
        command.payload.status;
    } else if (command.action === 'delete_entity' && command.payload.kind === 'task') {
      snapshot.tasks.find((item) => item.id === command.payload.id)!.deletedAt = snapshot.now;
    } else throw Error('Unexpected confirmation command: ' + command.action);
    return {
      requestId: command.requestId,
      snapshot: structuredClone(snapshot),
      changed: [],
      ids: [],
    };
  });
  value.acceptSnapshot(snapshot);
  value.selectTask('task-a', 'occ-a');
  return { value, writes };
}

describe('task surface controls', () => {
  test('empty optional settings are absent from the main detail while their editors remain reachable', () => {
    const value = model();
    value.draft()!.task.priority = 'none';
    value.draft()!.occurrence!.due = null;
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    expect(detail.byClass('todo-detail-shortcuts')).toHaveLength(0);
    expect(
      detail.all().some((node) => node.tag === 'button' && node.props['aria-label'] === '添加属性'),
    ).toBe(true);
    expect(
      detail
        .all()
        .some((node) => node.tag === 'button' && node.props['aria-label'] === '编辑重复规则'),
    ).toBe(true);
  });

  test('existing subtasks appear in primary content without expanding advanced details', () => {
    const { value } = confirmationModel();
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    const primary = detail.byClass('todo-primary-children')[0];
    expect(primary).toBeDefined();
    expect(detail.text(primary)).toContain('报告子任务');
    expect(
      detail
        .all()
        .find((node) => node.tag === 'summary' && detail.text(node).startsWith('更多详情'))!.parent!
        .parent!.props['active-key'],
    ).toEqual([]);
  });
  test.each([
    ['编辑重复规则', '重复规则'],
    ['编辑任务提醒', '更多选项：标签、提醒、依赖与来源'],
    ['编辑关联资料', '关联资料'],
  ])('%s reveals the existing editor in one click and can reopen it', async (label, title) => {
    const value = model();
    const before = JSON.stringify(value.draft());
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    const shortcut = detail
      .all()
      .find((node) => node.tag === 'button' && node.props['aria-label'] === label);
    expect(shortcut).toBeDefined();
    const collapse = (name: string) =>
      detail.all().find((node) => node.tag === 'summary' && detail.text(node).startsWith(name))!
        .parent!.parent!;
    const active = (name: string) => collapse(name).props['active-key'];
    expect(active('更多详情')).toEqual([]);
    expect(active(title)).toEqual([]);

    await shortcut!.props.onClick();
    await Vue.nextTick();
    expect(active('更多详情')).toEqual(['content']);
    expect(active(title)).toEqual(['content']);
    expect(collapse('更多详情').props['open-animation']).toEqual({ css: false });
    expect(collapse(title).props['open-animation']).toEqual({ css: false });
    expect(JSON.stringify(value.draft())).toBe(before);
    expect(value.dirty()).toBe(false);

    collapse('更多详情').props.onChange([]);
    collapse(title).props.onChange([]);
    await Vue.nextTick();
    expect(collapse('更多详情').props['open-animation']).toBeUndefined();
    expect(collapse(title).props['open-animation']).toBeUndefined();
    await shortcut!.props.onClick();
    await Vue.nextTick();
    expect(active('更多详情')).toEqual(['content']);
    expect(active(title)).toEqual(['content']);
  });

  test('shortcut summaries reflect the current draft without duplicating editors', async () => {
    const value = model();
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    const shortcuts = () => detail.byClass('todo-detail-shortcuts')[0]!;
    expect(shortcuts()).toBeUndefined();
    const repeat = detail
      .all()
      .filter(
        (node) =>
          node.tag === 'select' &&
          node.parent?.tag === 'label' &&
          detail.text(node.parent).startsWith('重复'),
      );
    expect(repeat).toHaveLength(1);
    repeat[0].props.onChange({ target: { value: 'weekly' } });
    value.draft()!.task.reminders.push({
      id: 'reminder-a',
      anchor: 'due',
      offsetMinutes: -30,
      allDayTime: '09:00',
    });
    value.draft()!.task.noteRefs.push({ noteId: 'note-a', role: 'material', title: '报告材料' });
    await Vue.nextTick();
    expect(detail.text(shortcuts())).toContain('每周');
    expect(detail.text(shortcuts())).toContain('1 条提醒');
    expect(detail.text(shortcuts())).toContain('1 份资料');
    expect(
      detail.all().filter((node) => node.tag === 'summary' && detail.text(node) === '关联资料1'),
    ).toHaveLength(1);
  });

  test('row priority remains readable alongside its separate deadline', () => {
    const value = model();
    const row = mount('ToDooTaskRow', {
      item: value.items()[0],
      today: '2026-10-29',
      timeZone: 'UTC',
    });
    expect(row.byClass('todo-priority-label').map(row.text)).toEqual(['高优先级']);
    expect(row.all().some((n) => n.props['aria-label'] === '截止 2026-10-30')).toBe(true);
  });

  test.each([false, true])(
    'a default-priority row omits empty metadata when its list is hidden: %s',
    (hideList) => {
      const item = model().items()[0]!;
      item.task.priority = 'none';
      item.list = hideList
        ? toDooEntitySchemas.list.parse({
            id: 'work',
            revision: 'r1',
            createdAt: item.task.createdAt,
            updatedAt: item.task.updatedAt,
            name: '工作',
          })
        : undefined;
      const row = mount('ToDooTaskRow', { item, hideList, today: '2026-10-29' });
      const body = row.byClass('todo-task-body')[0]!;
      expect(row.text(body)).toBe('准备报告');
      expect(body.children.filter((node) => node.tag === 'small')).toHaveLength(0);
      expect(row.byClass('todo-priority-label')).toHaveLength(0);
    },
  );

  test.each([
    ['list', '工作'],
    ['references', '▤ 1'],
    ['recurrence', '↻'],
    ['blocked', '受阻'],
    ['unavailable', '执行记录尚未载入'],
  ])('a default-priority row retains its %s indicator on its own', (indicator, expected) => {
    const item = model().items()[0]!;
    item.task = toDooEntitySchemas.task.parse({
      ...item.task,
      priority: 'none',
      noteRefs:
        indicator === 'references'
          ? [{ noteId: 'note-a', role: 'material', title: '报告材料' }]
          : [],
      recurrence:
        indicator === 'recurrence'
          ? { id: 'daily', frequency: 'daily', anchorDate: '2026-10-29' }
          : null,
    });
    item.list =
      indicator === 'list'
        ? toDooEntitySchemas.list.parse({
            id: 'work',
            revision: 'r1',
            createdAt: item.task.createdAt,
            updatedAt: item.task.updatedAt,
            name: '工作',
          })
        : undefined;
    if (indicator === 'blocked') item.status = 'blocked';
    if (indicator === 'unavailable') {
      item.status = 'unavailable';
      item.occurrence = null;
    }
    const row = mount('ToDooTaskRow', { item, today: '2026-10-29' });
    const body = row.byClass('todo-task-body')[0]!;
    expect(row.text(body)).toBe('准备报告' + expected);
    expect(body.children.filter((node) => node.tag === 'small')).toHaveLength(1);
    expect(row.byClass('todo-priority-label')).toHaveLength(0);
    if (indicator === 'unavailable')
      expect(row.byClass('todo-check')[0]!.props.disabled).toBe(true);
  });

  test('importance and urgency remain editable in their compact group, independently of priority', async () => {
    const value = model();
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    const visibleField = (label: string) =>
      detail.all().find((n) => {
        if (n.tag !== 'label' || !detail.text(n).startsWith(label)) return false;
        return true;
      });
    const classification = detail.byClass('todo-classification')[0]!;
    expect(classification).toBeDefined();
    expect(visibleField('重要程度')).toBeDefined();
    expect(visibleField('紧急程度')).toBeDefined();
    const priority = detail
      .all()
      .find((n) => n.tag === 'select' && n.props['aria-label'] === '优先级')!;
    expect(priority).toBeDefined();
    priority.props.onChange({ target: { value: 'low' } });
    await Vue.nextTick();
    expect(value.draft()?.task).toMatchObject({
      priority: 'low',
      importance: 'important',
      urgentOverride: false,
    });
    expect(value.dirty()).toBe(true);
  });

  test('matrix drag preserves classification payload and leaves priority untouched', async () => {
    const value = model(),
      execute = vi.spyOn(value, 'execute').mockResolvedValue(undefined);
    const matrix = mount('ToDooTaskViews', {
      model: value,
      section: 'matrix',
      tree: [],
      creating: true,
    });
    const zones = matrix.byClass('todo-quadrant');
    expect(zones.map(matrix.text)).toEqual([
      expect.stringContaining('立即行动'),
      expect.stringContaining('安排计划'),
      expect.stringContaining('协调处理'),
      expect.stringContaining('留待以后'),
    ]);
    expect(matrix.text(zones[1])).toContain('准备报告');
    await zones[2].props.onDrop({
      preventDefault() {},
      dataTransfer: { getData: () => value.items()[0].key },
    });
    expect(execute).toHaveBeenCalledWith({
      action: 'update_task',
      payload: {
        id: 'task-a',
        expectedRevision: 'r1',
        patch: { importance: 'normal', urgentOverride: true },
      },
    });
  });

  test.each([
    ['false', false],
    ['null', null],
  ] as const)(
    'urgency selection %s keeps its domain value and independent priority',
    async (input, expected) => {
      const value = model();
      const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
      const urgency = detail
        .all()
        .find((node) => node.tag === 'select' && node.props['aria-label'] === '紧急程度')!;
      urgency.props.onChange({ target: { value: input } });
      await Vue.nextTick();
      expect(value.draft()?.task.urgentOverride).toBe(expected);
      expect(value.draft()?.task.priority).toBe('high');
      expect(value.draft()?.task.importance).toBe('important');
    },
  );

  test('segmented view navigation preserves list and query state', () => {
    const value = model(),
      navigate = vi.fn();
    value.state.filter = { listIds: ['work'], query: '报告' };
    const view = mount('ToDooTaskViews', {
      model: value,
      section: 'tasks',
      tree: [],
      creating: true,
      onNavigate: navigate,
    });
    const switcher = view.all().find((n) => n.props['aria-label'] === '任务展示方式')!;
    const board = switcher.children.find((n) => view.text(n) === '看板')!;
    expect(board).toBeDefined();
    board.props.onClick();
    expect(navigate).toHaveBeenCalledWith('board');
    expect(value.state.filter).toEqual({ listIds: ['work'], query: '报告' });
  });

  test.each(['标记完成', '删除'])(
    'pending %s confirmation does not act on a task opened later',
    async (action) => {
      const { value, writes } = confirmationModel();
      const close = vi.fn();
      const detail = mount('ToDooTaskDetail', { model: value, tree: [], onClose: close });
      const button = detail
        .all()
        .find((item) => item.tag === 'button' && detail.text(item).trim() === action)!;
      const pending = button.props.onClick();
      await vi.waitFor(() => expect(detail.confirmation.current.value).not.toBeNull());
      expect(writes).toEqual([]);

      value.selectTask('task-b', 'occ-b');
      await Vue.nextTick();
      detail.confirmation.finish(true);
      await pending;
      await Vue.nextTick();

      expect(writes).toEqual([]);
      expect(value.state.selectedTaskId).toBe('task-b');
      expect(value.draft()?.task.title).toBe('另一份报告');
      expect(value.draft()?.task.deletedAt).toBeNull();
      expect(value.draft()?.occurrence?.status).toBe('todo');
      expect(close).not.toHaveBeenCalled();
    },
  );

  test('pending delete confirmation aborts after its detail unmounts', async () => {
    const { value, writes } = confirmationModel();
    const close = vi.fn();
    const detail = mount('ToDooTaskDetail', { model: value, tree: [], onClose: close });
    const button = detail
      .all()
      .find((item) => item.tag === 'button' && detail.text(item).trim() === '删除')!;
    const pending = button.props.onClick();
    expect(detail.confirmation.current.value).not.toBeNull();
    detail.hide();
    await Vue.nextTick();
    detail.confirmation.finish(true);
    await pending;

    expect(writes).toEqual([]);
    expect(value.state.snapshot?.tasks.find((item) => item.id === 'task-a')?.deletedAt).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  test.each(['标记完成', '删除'])(
    'confirming %s still acts on the unchanged original detail',
    async (action) => {
      const { value, writes } = confirmationModel();
      const close = vi.fn();
      const detail = mount('ToDooTaskDetail', { model: value, tree: [], onClose: close });
      const button = detail
        .all()
        .find((item) => item.tag === 'button' && detail.text(item).trim() === action)!;
      const pending = button.props.onClick();
      await vi.waitFor(() => expect(detail.confirmation.current.value).not.toBeNull());
      detail.confirmation.finish(true);
      await pending;

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject(
        action === '删除'
          ? { action: 'delete_entity', payload: { kind: 'task', id: 'task-a' } }
          : {
              action: 'set_occurrence_status',
              payload: { id: 'occ-a', status: 'done', cascade: true },
            },
      );
      expect(
        value.state.snapshot?.tasks.find((item) => item.id === 'task-b')?.deletedAt,
      ).toBeNull();
      expect(value.state.snapshot?.occurrences.find((item) => item.id === 'occ-b')?.status).toBe(
        'todo',
      );
      if (action === '删除') expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe('task audit context regressions', () => {
  test('overview today agrees with the Today range when yesterday plan has today deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    try {
      const value = model();
      value.state.snapshot!.settings.timeZone = 'UTC';
      value.state.snapshot!.timeBlocks.push(
        toDooEntitySchemas.timeBlock.parse({
          id: 'old-plan',
          revision: 'r1',
          createdAt: '2026-10-29T08:00:00Z',
          updatedAt: '2026-10-29T08:00:00Z',
          occurrenceId: 'occ-a',
          start: { date: '2026-10-29', time: '10:00', timeZone: 'UTC' },
          durationMinutes: 30,
        }),
      );
      const overview = mount('ToDooTaskViews', { model: value, section: 'overview', tree: [] });
      const todayTitles = overview.byClass('todo-task-name').map(overview.text);
      value.state.filter = presentation.toDooQuickFilter({}, 'today', '2026-10-30');
      expect(value.items().map((i) => i.title)).toEqual(['准备报告']);
      expect(todayTitles).toEqual(['准备报告']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Today add explicitly carries the displayed date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    try {
      const value = model(),
        create = vi.fn();
      value.state.snapshot!.settings.timeZone = 'UTC';
      const overview = mount('ToDooTaskViews', {
        model: value,
        section: 'overview',
        tree: [],
        onCreate: create,
      });
      overview
        .all()
        .find((n) => n.props['aria-label'] === '新建今日行动')!
        .props.onClick();
      expect(create).toHaveBeenCalledWith(
        undefined,
        undefined,
        expect.objectContaining({ planDate: '2026-10-30' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('board column add carries its initial status', () => {
    const value = model(),
      create = vi.fn();
    const board = mount('ToDooTaskViews', {
      model: value,
      section: 'board',
      tree: [],
      creating: true,
      onCreate: create,
    });
    const doing = board
      .byClass('todo-board-column')
      .find((n) => board.text(n).startsWith('进行中'))!;
    const add = board
      .all(doing)
      .find((n) => n.tag === 'button' && board.text(n).trim() === '＋ 添加任务')!;
    add.props.onClick();
    expect(create).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ initialStatus: 'doing' }),
    );
  });

  test('cancelled and skipped remain visible as terminal states outside pending count', () => {
    const value = model(),
      data = value.state.snapshot!;
    for (const status of ['cancelled', 'skipped'] as const) {
      data.tasks.push({ ...data.tasks[0], id: status, title: status });
      data.occurrences.push({
        ...data.occurrences[0],
        id: 'occ-' + status,
        taskId: status,
        status,
      });
    }
    const view = mount('ToDooTaskViews', {
      model: value,
      section: 'tasks',
      tree: [],
      creating: true,
    });
    expect(view.text(view.byClass('todo-task-list-heading')[0])).toContain('1 项');
    expect(view.text(view.root)).toContain('已取消');
    expect(view.text(view.root)).toContain('已跳过');
  });

  test('an earlier time today is overdue in the row and detail', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    try {
      const value = model();
      value.state.snapshot!.occurrences[0].due = {
        date: '2026-10-30',
        time: '08:00',
        timeZone: 'UTC',
      };
      value.selectTask('task-a', 'occ-a');
      const row = mount('ToDooTaskRow', {
        item: value.items()[0],
        today: '2026-10-30',
        timeZone: 'UTC',
      });
      expect(
        row.all().some((n) => n.props['aria-label'] === '截止 2026-10-30 08:00（已逾期）'),
      ).toBe(true);
      const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
      expect(detail.byClass('is-overdue').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

test('task menu parent completion asks and uses the version guarded cascade', async () => {
  const { value, writes } = confirmationModel();
  const menu = mount('ToDooTaskMenu', {
    model: value,
    item: value.items().find((i) => i.task.id === 'task-a'),
  });
  const done = menu.all().find((n) => n.tag === 'button' && menu.text(n).trim() === '已完成')!;
  const pending = done.props.onClick();
  await vi.waitFor(() => expect(menu.confirmation.current.value).not.toBeNull());
  expect(writes).toEqual([]);
  menu.confirmation.finish(true);
  await pending;
  expect(writes[0]).toMatchObject({
    action: 'set_occurrence_status',
    payload: {
      id: 'occ-a',
      status: 'done',
      cascade: true,
      expectedOccurrenceIds: expect.arrayContaining(['occ-a', 'occ-child-a']),
      expectedRevisions: { 'task-a': 'r1', 'child-a': 'r1', 'occ-a': 'r1', 'occ-child-a': 'r1' },
    },
  });
});

test('matrix offers direct classification and manual override reset independently of priority', async () => {
  const value = model(),
    execute = vi.spyOn(value, 'execute').mockResolvedValue(undefined);
  const matrix = mount('ToDooTaskViews', {
    model: value,
    section: 'matrix',
    tree: [],
    creating: true,
  });
  expect(matrix.text(matrix.root)).toContain('手动不紧急');
  const select = matrix
    .all()
    .find((n) => n.tag === 'select' && n.props['aria-label'] === '设置象限 准备报告')!;
  expect(select).toBeDefined();
  select.props.onChange({ target: { value: '2' } });
  await Vue.nextTick();
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'update_task',
      payload: {
        id: 'task-a',
        expectedRevision: 'r1',
        patch: { importance: 'normal', urgentOverride: true },
      },
    }),
  );
  const reset = matrix.all().find((n) => n.props['aria-label'] === '恢复自动紧急判断 准备报告')!;
  await reset.props.onClick();
  expect(execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'update_task',
      payload: { id: 'task-a', expectedRevision: 'r1', patch: { urgentOverride: null } },
    }),
  );
});

test('task reader explains immediate status actions and the lifetime of unsaved text', () => {
  const value = model();
  value.draft()!.task.title = '当前页面的输入';
  const closed = vi.fn();
  const detail = mount('ToDooTaskDetail', { model: value, tree: [], onClose: closed });
  expect(detail.text(detail.root)).toContain('执行状态和菜单操作立即生效');
  expect(detail.text(detail.root)).toContain('刷新前请保存');
  detail
    .all()
    .find((n) => n.props['aria-label'] === '关闭任务详情')!
    .props.onClick();
  expect(closed).toHaveBeenCalledOnce();
  expect(value.draft()!.task.title).toBe('当前页面的输入');
  expect(value.dirty()).toBe(true);
});

test.each([
  ['list', 'client', { listId: 'client' }],
  ['priority', 'high', { priority: 'high' }],
  ['tag', 'urgent', { tagIds: ['urgent'] }],
] as const)(
  'board %s column creation passes the actual column value',
  async (grouping, column, seed) => {
    const value = model(),
      create = vi.fn(),
      data = value.state.snapshot!;
    data.lists.push(
      toDooEntitySchemas.list.parse({
        id: 'client',
        revision: 'r1',
        createdAt: data.now,
        updatedAt: data.now,
        name: '客户事项',
      }),
    );
    data.tags.push(
      toDooEntitySchemas.tag.parse({
        id: 'urgent',
        revision: 'r1',
        createdAt: data.now,
        updatedAt: data.now,
        name: '紧要',
      }),
    );
    const board = mount('ToDooTaskViews', {
      model: value,
      section: 'board',
      tree: [],
      creating: true,
      onCreate: create,
    });
    board
      .all()
      .find((n) => n.tag === 'select' && n.props['aria-label'] === '看板分组')!
      .props.onChange({ target: { value: grouping } });
    await Vue.nextTick();
    const target = board
      .byClass('todo-board-column')
      .find((n) => n.props.id === 'todo-board-' + grouping + '-' + column);
    // Locate by visible heading before stable jump targets exist so the pre-fix test
    // still reaches its missing-context assertion.
    const label = grouping === 'list' ? '客户事项' : grouping === 'priority' ? '高' : '紧要';
    const section =
      target || board.byClass('todo-board-column').find((n) => board.text(n).startsWith(label))!;
    board
      .all(section)
      .find((n) => n.tag === 'button' && board.text(n).trim() === '＋ 添加任务')!
      .props.onClick();
    expect(create).toHaveBeenCalledWith(undefined, undefined, expect.objectContaining(seed));
  },
);

test.each(['menu', 'tasks', 'board', 'detail'] as const)(
  'the %s completion entry discovers an unloaded child before confirming',
  async (entry) => {
    const { value, writes } = confirmationModel();
    const visible = structuredClone(Vue.toRaw(value.state.snapshot!));
    visible.tasks = visible.tasks.filter((task) => task.id === 'task-a');
    visible.occurrences = visible.occurrences.filter((occurrence) => occurrence.id === 'occ-a');
    value.acceptSnapshot(visible);
    value.selectTask('task-a', 'occ-a');
    const view =
      entry === 'menu'
        ? mount('ToDooTaskMenu', { model: value, item: value.items()[0] })
        : entry === 'detail'
          ? mount('ToDooTaskDetail', { model: value, tree: [] })
          : mount('ToDooTaskViews', { model: value, section: entry, tree: [], creating: true });
    const button =
      entry === 'menu'
        ? view.all().find((n) => n.tag === 'button' && view.text(n).trim() === '已完成')!
        : view
            .all()
            .find(
              (n) =>
                n.tag === 'button' &&
                n.props['aria-label'] === (entry === 'detail' ? '标记完成' : '完成 准备报告'),
            )!;
    const pending = button.props.onClick();
    await vi.waitFor(() => expect(view.confirmation.current.value).not.toBeNull());
    expect(writes).toEqual([]);
    view.confirmation.finish(false);
    await pending;
    expect(writes).toEqual([]);
    const confirmed = button.props.onClick();
    await vi.waitFor(() => expect(view.confirmation.current.value).not.toBeNull());
    view.confirmation.finish(true);
    await confirmed;
    await vi.waitFor(() =>
      expect(writes[0]).toMatchObject({
        action: 'set_occurrence_status',
        payload: {
          id: 'occ-a',
          status: 'done',
          cascade: true,
          expectedOccurrenceIds: expect.arrayContaining(['occ-a', 'occ-child-a']),
        },
      }),
    );
  },
);
