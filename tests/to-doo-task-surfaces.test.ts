import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as controls from '../apps/web/to-doo-controls';
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
      if (id === 'ant-design-vue') return toDooAntStubs;
      if (id.endsWith('/to-doo-controls')) return controls;
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('ToDooTaskRow.vue')) return { default: component('ToDooTaskRow') };
      if (id.endsWith('.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      throw Error(`Unexpected task component dependency: ${id}`);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(name: string, props: Record<string, any>) {
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

  test('importance and urgency are directly editable without opening more options, independently of priority', async () => {
    const value = model();
    const detail = mount('ToDooTaskDetail', { model: value, tree: [] });
    const visibleField = (label: string) =>
      detail.all().find((n) => {
        if (n.tag !== 'label' || !detail.text(n).startsWith(label)) return false;
        for (let p = n.parent; p; p = p.parent)
          if (p.tag === 'details' && !p.props.open) return false;
        return true;
      });
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
      expect(detail.confirmation.current.value).not.toBeNull();
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
      expect(detail.confirmation.current.value).not.toBeNull();
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
