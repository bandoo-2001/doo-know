import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as habitRules from '../shared/to-doo-habits';
import * as presentation from '../apps/web/to-doo-habit-presentation';
import * as insights from '../apps/web/to-doo-habit-insights';
import * as workbench from '../apps/web/to-doo-workbench';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';

type HostNode = { children: HostNode[]; parent?: HostNode };
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
});
function detailComponent() {
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooHabitDetail.vue', import.meta.url),
      'utf8',
    ),
  );
  const compiled = compileScript(descriptor, { id: 'habit-detail-unit' });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '../../../../shared/to-doo-habits') return habitRules;
      if (id === '../../to-doo-habit-presentation') return presentation;
      if (id === '../../to-doo-habit-insights') return insights;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === 'ant-design-vue' || id.endsWith('.vue')) return {};
      throw Error('Unexpected habit detail dependency: ' + id);
    },
    module,
    module.exports,
  );
  module.exports.default.render = () => null;
  return module.exports.default;
}
const stamp = {
  revision: 'habit-r1',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
function habit(extra: Record<string, unknown> = {}) {
  return toDooEntitySchemas.habit.parse({
    ...stamp,
    id: 'habit-a',
    name: '阅读',
    startDate: '2026-11-01',
    timeZone: 'Asia/Shanghai',
    goalMode: 'quantity',
    target: 2,
    ...extra,
  });
}
function entry(date: string, amount: number, extra: Record<string, unknown> = {}) {
  return toDooEntitySchemas.habitEntry.parse({
    ...stamp,
    id: date + '-' + String(amount).replace(/[^A-Za-z0-9_-]/g, '_'),
    habitId: 'habit-a',
    localDate: date,
    occurredAt: date + 'T03:00:00Z',
    amount,
    ...extra,
  });
}
function page(
  entries: ReturnType<typeof entry>[],
  version = 'version-1',
  cursor: string | null = null,
) {
  return {
    datasetId: 'detail-fixture',
    version,
    habitEntries: entries,
    page: { nextCursor: cursor },
  };
}
function mount(request: ReturnType<typeof vi.fn>, initialHabit = habit(), ready = true) {
  const props = Vue.reactive({
    model: {
      state: {
        busy: false,
        snapshot: {
          datasetId: 'detail-fixture',
          version: 'version-1',
          settings: { weekStartsOn: 1 },
        },
      },
      request,
    },
    habit: initialHabit,
    date: '2026-11-17',
    nowDate: '2026-11-17',
    ready,
  });
  const node = (): HostNode => ({ children: [] });
  const renderer = Vue.createRenderer<HostNode, HostNode>({
    createElement: node,
    createText: node,
    createComment: node,
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    },
    parentNode: (child) => child.parent || null,
    nextSibling: () => null,
    setText() {},
    setElementText() {},
    patchProp() {},
  });
  const component = detailComponent();
  const app = renderer.createApp({ render: () => Vue.h(component, props) });
  const root = app.mount(node());
  cleanup.push(() => app.unmount());
  const state = (root.$.subTree.component as unknown as { setupState: Record<string, any> })
    .setupState;
  return { state, props };
}

test('complete paginated history counts distinct recorded days and preserves skip and partial states', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      page(
        [
          entry('2026-11-17', 1),
          entry('2026-11-17', 1, { id: 'second-entry' }),
          entry('2026-11-13', 4, { habitId: 'other-habit' }),
        ],
        'version-1',
        'next-page',
      ),
    )
    .mockResolvedValueOnce(
      page([
        entry('2026-11-16', 1),
        entry('2026-11-15', 0, { skipped: true }),
        entry('2026-11-14', 2, { deletedAt: '2026-11-15T00:00:00Z' }),
      ]),
    );
  const { state } = mount(request);
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![0]).toContain('cursor=next-page');
  expect(state.totalDays).toBe(2);
  expect(state.monthDays).toBe(2);
  expect(state.selectedSummary.amount).toBe(2);
  expect(state.calendarDays.find((day: { date: string }) => day.date === '2026-11-17').state).toBe(
    'achieved',
  );
  expect(state.calendarDays.find((day: { date: string }) => day.date === '2026-11-16').state).toBe(
    'recorded',
  );
  expect(state.calendarDays.find((day: { date: string }) => day.date === '2026-11-15').state).toBe(
    'skipped',
  );
  expect(state.calendarDays.find((day: { date: string }) => day.date === '2026-11-18').state).toBe(
    'future',
  );
});

test('weekly achievement does not mark every calendar day completed and parent readiness only gates recording', async () => {
  const request = vi.fn().mockResolvedValue(page([entry('2026-11-16', 1), entry('2026-11-17', 2)]));
  const { state, props } = mount(request, habit({ frequency: 'weekly', target: 3 }), false);
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.selectedSummary.status).toBe('achieved');
  expect(state.totalDays).toBe(2);
  expect(state.ready).toBe(true);
  expect(state.recordDisabled).toBe(true);
  expect(
    state.calendarDays.filter((day: { state: string }) => day.state === 'recorded'),
  ).toHaveLength(2);
  expect(
    state.calendarDays.filter((day: { state: string }) => day.state === 'achieved'),
  ).toHaveLength(0);
  props.ready = true;
  await Vue.nextTick();
  expect(state.recordDisabled).toBe(false);
});

test('action progress distinguishes the selected day from a completed weekly target', async () => {
  const request = vi.fn().mockResolvedValue(page([entry('2026-11-16', 3)]));
  const { state } = mount(request, habit({ frequency: 'weekly', target: 3 }));
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.selectedDayAmount).toBe(0);
  expect(state.selectedSummary.amount).toBe(3);
  expect(state.selectedPlan.remaining).toBe(0);
  expect(state.nextStep).toContain('所选周期的目标已达成');
  expect(state.trend.days.filter((day: { recorded: boolean }) => day.recorded)).toHaveLength(1);
  expect(state.trend.current.total).toBe(3);
});

test('ordinary check-ins show one action per recorded date and historical plans do not offer future days', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      page([entry('2026-11-17', 1), entry('2026-11-17', 1, { id: 'second-check-in' })]),
    );
  const { state, props } = mount(request, habit({ goalMode: 'checkin', target: 1 }));
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.selectedDayAmount).toBe(1);
  expect(state.trend.current.total).toBe(1);
  props.date = '2026-11-16';
  await Vue.nextTick();
  expect(state.selectedPlan.ended).toBe(true);
  expect(state.selectedPlan.remainingDates).toBe(0);
  expect(state.nextStep).toContain('这个周期还差');
  expect(request).toHaveBeenCalledTimes(1);
});

test('changing snapshot versions between pages rejects incomplete totals', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([entry('2026-11-17', 1)], 'version-1', 'next-page'))
    .mockResolvedValueOnce(page([entry('2026-11-16', 1)], 'version-2'));
  const { state } = mount(request);
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.error).toContain('读取期间记录有更新');
  expect(state.values).toEqual([]);
  expect(state.ready).toBe(false);
  expect(state.recordDisabled).toBe(true);
});

test('selecting another date reuses complete history while a snapshot change refreshes it', async () => {
  const request = vi.fn().mockResolvedValue(page([entry('2026-11-17', 2)]));
  const { state, props } = mount(request);
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(request).toHaveBeenCalledTimes(1);
  props.date = '2026-11-16';
  await Vue.nextTick();
  expect(state.month).toBe('2026-11');
  expect(state.selectedSummary.amount).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
  props.model.state.snapshot.version = 'version-2';
  await Vue.nextTick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
});

test('a late request for a previously selected habit cannot replace the new habit history', async () => {
  let resolveOld!: (result: ReturnType<typeof page>) => void;
  const pending = new Promise<ReturnType<typeof page>>((resolve) => {
    resolveOld = resolve;
  });
  const request = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(page([entry('2026-11-17', 1, { habitId: 'habit-b' })]));
  const { state, props } = mount(request);
  props.habit = habit({ id: 'habit-b', name: '散步' });
  await Vue.nextTick();
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.totalDays).toBe(1);
  resolveOld(page([entry('2026-11-17', 1), entry('2026-11-16', 1)]));
  await Vue.nextTick();
  await Vue.nextTick();
  expect(state.values.map((record: ReturnType<typeof entry>) => record.habitId)).toEqual([
    'habit-b',
  ]);
});

test('a response from another data space never becomes a visible habit history', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ ...page([entry('2026-11-17', 2)]), datasetId: 'another-dataset' });
  const { state } = mount(request);
  await vi.waitFor(() => expect(state.loading).toBe(false));
  expect(state.error).toContain('数据空间已变化');
  expect(state.values).toEqual([]);
  expect(state.ready).toBe(false);
  expect(state.recordDisabled).toBe(true);
});
