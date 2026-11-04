import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as controls from '../apps/web/to-doo-controls';
import * as groups from '../apps/web/to-doo-task-groups';
import lunar from 'lunar-javascript';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';

type Node = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const SlotBoundary = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('div', attrs, [slots.default?.(), slots.actions?.()]),
});

function editor(
  listId: string | null,
  options?: {
    kind: string;
    seed?: Record<string, any>;
    entity?: Record<string, any>;
    render?: boolean;
  },
) {
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooEntityEditor.vue', import.meta.url),
      'utf8',
    ),
  );
  const script = compileScript(descriptor, { id: 'entity-editor' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'lunar-javascript') return { default: lunar };
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-controls') return controls;
      if (id === '../../to-doo-task-groups') return groups;
      if (id === 'ant-design-vue') return options?.render ? toDooAntStubs : {};
      if (id.endsWith('.vue'))
        return options?.render ? { default: toDooBoundaryStub(id) || SlotBoundary } : {};
      throw Error(`Unexpected entity dependency: ${id}`);
    },
    output,
    output.exports,
  );
  const component = output.exports.default;
  if (options?.render) {
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename: 'ToDooEntityEditor.vue',
      id: 'entity-editor',
      compilerOptions: { bindingMetadata: script.bindings },
    });
    const rendered = ts.transpileModule(template.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', rendered)(() => Vue, output, output.exports);
    component.render = output.exports.render;
  } else component.render = () => null;
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    createComment: () => node('#comment'),
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
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
  const saveEntity = vi.fn(
    async (_kind: string, _entity: Record<string, any>, _revision?: string) => true,
  );
  const model = {
    state: Vue.reactive({
      snapshot: {
        settings: { timeZone: 'UTC' },
        occurrences: [],
        lists: [{ id: 'list-1', name: 'Goal' }],
      },
      error: '',
    }),
    saveEntity,
    execute: vi.fn(async () => true),
  };
  const closed = vi.fn();
  const app = renderer.createApp(component, {
    kind: options?.kind || 'section',
    seed: options ? options.seed : { name: 'First chapter', listId },
    entity: options?.entity,
    model,
    tree: [],
    onClose: closed,
  });
  const root = node('root');
  const mounted = app.mount(root);
  const state = (
    mounted.$ as unknown as { setupState: { save: () => Promise<void>; form: Record<string, any> } }
  ).setupState;
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node = root): string => parent.text + parent.children.map(text).join('');
  return {
    all,
    text,
    model,
    closed,
    close: () => (state as any).close(),
    setTemplateLines: (value: string) => {
      (state as any).templateLines = value;
    },
    setCompleteOutcome: (value: boolean) => {
      (state as any).completeOutcome = value;
    },
    save: state.save,
    form: state.form,
    unmount: () => app.unmount(),
  };
}

describe('section editor required list', () => {
  it('keeps an unassociated section unsaved after replacing the required select', async () => {
    const form = editor(null);
    try {
      await form.save();
      expect(form.model.saveEntity).not.toHaveBeenCalled();
      expect(form.model.state.error).toContain('目标或清单');
    } finally {
      form.unmount();
    }
  });

  it('saves an associated section with its typed list identifier', async () => {
    const form = editor('list-1');
    try {
      await form.save();
      expect(form.model.saveEntity).toHaveBeenCalledWith(
        'section',
        { name: 'First chapter', listId: 'list-1' },
        undefined,
      );
    } finally {
      form.unmount();
    }
  });
});

it('submits the review interval for core metric capture after its dates have changed', async () => {
  const value = editor(null, {
    kind: 'review',
    seed: { from: '2026-10-24', to: '2026-10-30', metrics: { completed: 999 } },
  });
  try {
    value.form.from = '2026-03-07';
    value.form.to = '2026-03-10';
    await value.save();
    expect(value.model.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'save_entity',
        payload: expect.objectContaining({
          kind: 'review',
          captureMetrics: true,
          entity: expect.objectContaining({ from: '2026-03-07', to: '2026-03-10' }),
        }),
      }),
      '已保存',
    );
    expect(value.model.saveEntity).not.toHaveBeenCalled();
  } finally {
    value.unmount();
  }
});

it('shows the actual review snapshot, including zero, without inventing unsupported statistics', () => {
  const value = editor(null, {
    kind: 'review',
    render: true,
    seed: {
      from: '2026-11-02',
      to: '2026-11-08',
      capturedAt: '2026-11-04T08:15:00.000Z',
      metrics: { completed: 8, focusMinutes: 125, outcomes: 0, pending: 42 },
    },
  });
  try {
    const statistics = value.all().find((node) => node.props['aria-label'] === '统计快照');
    expect(statistics).toBeDefined();
    expect(value.text(statistics)).toContain('已完成8');
    expect(value.text(statistics)).toContain('专注125分钟');
    expect(value.text(statistics)).toContain('成果0');
    expect(value.text(statistics)).not.toContain('42');
    expect(value.text(statistics)).not.toContain('待办');
    expect(value.text(statistics)).toMatch(/保存时.*所选日期.*重新统计/);
    expect(value.text(statistics)).toMatch(/与本次复盘.*保存/);
  } finally {
    value.unmount();
  }
});

it('shows an existing review snapshot date and leaves absent metric values absent', async () => {
  const value = editor(null, {
    kind: 'review',
    render: true,
    entity: {
      name: '上周复盘',
      revision: 'review-r1',
      from: '2026-10-26',
      to: '2026-11-01',
      capturedAt: '2026-11-02T08:15:00.000Z',
      metrics: { completed: 3 },
    },
  });
  try {
    const statistics = value.all().find((node) => node.props['aria-label'] === '统计快照');
    expect(statistics).toBeDefined();
    expect(value.text(statistics)).toContain('已完成3');
    expect(value.text(statistics)).not.toContain('专注');
    expect(value.text(statistics)).not.toContain('成果');
    const timestamp = value.all().find((node) => node.tag === 'time');
    expect(timestamp?.props.datetime).toBe('2026-11-02T08:15:00.000Z');
    expect(value.text(timestamp)).toContain('2026');
    await value.save();
    expect(value.model.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          captureMetrics: true,
          expectedRevision: 'review-r1',
          entity: expect.objectContaining({ metrics: { completed: 3 } }),
        }),
      }),
      '已保存',
    );
  } finally {
    value.unmount();
  }
});

it.each([
  ['list', '#647be8'],
  ['tag', '#647be8'],
  ['focusTopic', '#4566c6'],
])('chooses and saves the %s color through its accessible field', async (kind, initialColor) => {
  const value = editor(null, { kind, seed: { name: '深度工作' }, render: true });
  try {
    const input = value.all().find((node) => node.tag === 'input' && node.props.type === 'color');
    expect(input).toBeDefined();
    expect(input?.props['aria-label']).toBe('颜色');
    expect(input?.props.value).toBe(initialColor);
    input!.props.onInput({ target: { value: '#81c784' } });
    await Vue.nextTick();
    expect(input?.props.value).toBe('#81c784');
    await value.save();
    expect(value.model.saveEntity).toHaveBeenCalledWith(
      kind,
      expect.objectContaining({ name: '深度工作', color: '#81c784' }),
      undefined,
    );
  } finally {
    value.unmount();
  }
});

it.each(['list', 'tag', 'focusTopic'])(
  'preserves an existing %s color when saving other edits',
  async (kind) => {
    const value = editor(null, {
      kind,
      entity: { name: '原名称', color: '#a855f7', revision: 'entity-r1' },
      render: true,
    });
    try {
      const input = value.all().find((node) => node.tag === 'input' && node.props.type === 'color');
      expect(input?.props.value).toBe('#a855f7');
      value.form.name = '修改名称';
      await value.save();
      expect(value.model.saveEntity).toHaveBeenCalledWith(
        kind,
        expect.objectContaining({ name: '修改名称', color: '#a855f7' }),
        'entity-r1',
      );
    } finally {
      value.unmount();
    }
  },
);

it.each(['timeBlock', 'calendarEvent'])(
  'an all-day %s saves empty clock values without erasing its timed draft',
  async (kind) => {
    const value = editor(null, {
      kind,
      seed: {
        title: '全天安排',
        start: { date: '2030-04-03', time: '10:30', timeZone: 'Asia/Shanghai' },
        ...(kind === 'calendarEvent'
          ? { end: { date: '2030-04-04', time: '11:00', timeZone: 'Asia/Shanghai' } }
          : {}),
      },
    });
    try {
      value.form.allDay = true;
      await value.save();
      expect(value.model.saveEntity.mock.calls[0][1].start.time).toBeNull();
      if (kind === 'calendarEvent')
        expect(value.model.saveEntity.mock.calls[0][1].end.time).toBeNull();
      expect(value.form.start.time).toBe('10:30');
      value.form.allDay = false;
      await value.save();
      expect(value.model.saveEntity.mock.calls[1][1].start.time).toBe('10:30');
    } finally {
      value.unmount();
    }
  },
);

it('a new habit uses its chosen start date as the initial rule effective date', async () => {
  const value = editor(null, { kind: 'habit', seed: { name: '阅读' } });
  try {
    value.form.startDate = '2030-04-03';
    await value.save();
    expect(value.model.saveEntity.mock.calls[0][1]).toMatchObject({
      startDate: '2030-04-03',
      effectiveFrom: '2030-04-03',
    });
  } finally {
    value.unmount();
  }
});

it('creates an ordinary habit without requiring a quantity or a unit', async () => {
  const value = editor(null, { kind: 'habit', seed: { name: '早睡' } });
  try {
    await value.save();
    expect(value.model.saveEntity.mock.calls[0][1]).toMatchObject({
      goalMode: 'checkin',
      target: 1,
      unit: '次',
      frequency: 'daily',
    });
  } finally {
    value.unmount();
  }
});

it('retains the quantity meaning of an existing habit without a goal mode', async () => {
  const value = editor(null, {
    kind: 'habit',
    entity: { name: '阅读', startDate: '2026-10-26', frequency: 'daily', target: 20, unit: '页' },
  });
  try {
    await value.save();
    expect(value.model.saveEntity.mock.calls[0][1]).toMatchObject({ target: 20, unit: '页' });
    expect(value.model.saveEntity.mock.calls[0][1].goalMode).not.toBe('checkin');
  } finally {
    value.unmount();
  }
});

it.each(['template', 'outcome'])(
  'closing a %s with secondary edits preserves them when discard is declined',
  async (kind) => {
    const value = editor(null, {
      kind,
      seed:
        kind === 'template'
          ? { name: '准备工作', tasks: [] }
          : { summary: '完成', occurrenceId: 'occ-a' },
    });
    try {
      if (kind === 'template') value.setTemplateLines('准备材料\n核对结果');
      else value.setCompleteOutcome(true);
      await value.close();
      expect(value.closed).not.toHaveBeenCalled();
      expect(value.model.saveEntity).not.toHaveBeenCalled();
    } finally {
      value.unmount();
    }
  },
);

it.each([
  ['2024-02-31', false],
  ['2024-02-30', true],
  ['2023-02-30', true],
])(
  'rejects the actual invalid lunar date %s (leap=%s) before saving',
  async (date, lunarLeapMonth) => {
    const value = editor(null, {
      kind: 'anniversary',
      seed: { name: '农历', calendar: 'lunar', date, lunarLeapMonth, leapPolicy: 'previous_day' },
    });
    try {
      await value.save();
      expect(value.model.saveEntity).not.toHaveBeenCalled();
      expect(value.model.state.error).toMatch(/农历.*(日期|闰月)/);
    } finally {
      value.unmount();
    }
  },
);
it.each([
  ['2024-02-30', false],
  ['2023-02-01', true],
])('saves valid lunar %s with the existing date and leap payload', async (date, lunarLeapMonth) => {
  const value = editor(null, {
    kind: 'anniversary',
    seed: { name: '农历', calendar: 'lunar', date, lunarLeapMonth, leapPolicy: 'skip' },
  });
  try {
    await value.save();
    expect(value.model.saveEntity).toHaveBeenCalledWith(
      'anniversary',
      expect.objectContaining({ date, lunarLeapMonth, leapPolicy: 'skip' }),
      undefined,
    );
  } finally {
    value.unmount();
  }
});

it('editing habit rules defaults to the habit local day across midnight rather than the workspace date', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T00:30:00Z'));
  const value = editor(null, {
    kind: 'habit',
    entity: {
      name: '本地习惯',
      timeZone: 'America/Los_Angeles',
      startDate: '2026-10-01',
      target: 20,
      unit: '页',
      frequency: 'daily',
    },
  });
  try {
    value.form.target = 30;
    await value.save();
    expect(value.model.saveEntity).toHaveBeenCalledWith(
      'habit',
      expect.objectContaining({ effectiveFrom: '2026-11-02' }),
      undefined,
    );
  } finally {
    value.unmount();
    vi.useRealTimers();
  }
});
