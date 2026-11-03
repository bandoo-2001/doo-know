import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as controls from '../apps/web/to-doo-controls';
import * as groups from '../apps/web/to-doo-task-groups';

function editor(
  listId: string | null,
  options?: { kind: string; seed?: Record<string, any>; entity?: Record<string, any> },
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
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-controls') return controls;
      if (id === '../../to-doo-task-groups') return groups;
      if (id === 'ant-design-vue' || id.endsWith('.vue')) return {};
      throw Error(`Unexpected entity dependency: ${id}`);
    },
    output,
    output.exports,
  );
  const component = output.exports.default;
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({
    createComment: () => ({}),
    createElement: () => ({}),
    createText: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
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
  const mounted = app.mount({});
  const state = (
    mounted.$ as unknown as { setupState: { save: () => Promise<void>; form: Record<string, any> } }
  ).setupState;
  return {
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
