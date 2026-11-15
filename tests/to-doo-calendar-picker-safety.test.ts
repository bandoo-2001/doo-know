import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import * as actionGuards from '../apps/web/to-doo-action-guard';
import { TO_DOO_COLLECTIONS, toDooEntitySchemas } from '../shared/to-doo-contracts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));

async function fixture() {
  const stamp = { revision: 'r1', createdAt: '2026-11-03T12:00:00Z', updatedAt: '2026-11-03T12:00:00Z' };
  const snapshot = {
    ...Object.fromEntries(Object.values(TO_DOO_COLLECTIONS).map(name => [name, []])),
    datasetId: 'picker', version: '1',
    settings: toDooEntitySchemas.settings.parse({ ...stamp, id: 'settings', timeZone: 'UTC' }),
    tasks: [toDooEntitySchemas.task.parse({ ...stamp, id: 'task', title: '待安排的任务' })],
    occurrences: [toDooEntitySchemas.occurrence.parse({ ...stamp, id: 'occ', taskId: 'task', cycleKey: 'single', scheduleRevision: 's1' })],
    lists: [], page: { nextCursor: null },
  };
  const plan = toDooEntitySchemas.plan.parse({
    ...stamp, id: 'plan', name: '安排预览',
    changes: [{ occurrenceId: 'occ', expectedRevision: 'r1', start: { date: '2026-11-04', time: null, timeZone: 'UTC' }, durationMinutes: 30 }],
    expectedRevisions: { 'task:task': 'r1', 'task:linked': 'r1', 'occurrence:occ': 'r1' },
  });
  const state = Vue.reactive<any>({
    snapshot: JSON.parse(JSON.stringify(snapshot)), filter: {},
    selectedTaskId: 'task', selectedOccurrenceId: 'occ',
    busy: false, pendingMutation: null, preview: null, error: '', notice: '',
  });
  const model = {
    state,
    taskDefinitions: () => snapshot.tasks,
    validateTaskDraft: vi.fn().mockReturnValue(true), dirty: vi.fn().mockReturnValue(false),
    prepareTaskAction: vi.fn().mockResolvedValue([]), saveTask: vi.fn().mockResolvedValue(true),
    request: vi.fn().mockImplementation(async () => JSON.parse(JSON.stringify(snapshot))),
    retryPending: vi.fn().mockImplementation(async () => { state.pendingMutation = null; return { ids: [] }; }),
    execute: vi.fn().mockImplementation(async (input: { action: string }) => {
      if (input.action === 'preview_plan') {
        state.preview = JSON.parse(JSON.stringify(plan));
        return { preview: state.preview };
      }
      state.preview = null;
      return { ids: ['block'] };
    }),
  };
  const confirm = vi.fn().mockResolvedValue(true);
  const { descriptor } = parse(readFileSync(new URL('../apps/web/components/to-doo/ToDooCalendarTaskPicker.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'picker-safety' });
  const source = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'vue') return Vue;
    if (id.endsWith('/to-doo-action-guard')) return actionGuards;
    if (id.endsWith('/to-doo-controls')) return { useToDooConfirm: () => confirm };
    if (id === 'ant-design-vue' || id.endsWith('.vue')) return {};
    throw Error('Unexpected picker dependency: ' + id);
  }, output, output.exports);
  const renderer = Vue.createRenderer<any, any>({
    createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const scheduled = vi.fn(), close = vi.fn();
  const app = renderer.createApp({ ...output.exports.default, render: () => null }, {
    model, date: '2026-11-04', onScheduled: scheduled, onClose: close,
  });
  const instance = app.mount({});
  cleanup.push(() => app.unmount());
  const setup = (instance.$ as any).setupState;
  for (let step = 0; step < 4; step++) await Vue.nextTick();
  setup.selected = 'occ';
  await Vue.nextTick();
  return { model, state, plan, setup, confirm, scheduled, close };
}

test('a clean picker schedules only after checking the selected task and the entire verified graph', async () => {
  const f = await fixture();
  await f.setup.schedule();
  expect(f.model.prepareTaskAction.mock.calls).toEqual([[['task'], false], [['task', 'linked'], false]]);
  expect(f.model.execute.mock.calls.map(([input]) => input.action)).toEqual(['preview_plan', 'apply_plan']);
  expect(f.scheduled).toHaveBeenCalledWith('2026-11-04');
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.confirm).not.toHaveBeenCalled();
});

test('a hidden period draft prevents picker preview and application without an implicit save', async () => {
  const f = await fixture();
  f.model.prepareTaskAction.mockResolvedValue([{ key: 'task@old-occ', taskId: 'task', occurrenceId: 'old-occ', title: '旧周期', kind: 'task' }]);
  await f.setup.schedule();
  expect(f.model.execute).not.toHaveBeenCalled();
  expect(f.model.saveTask).not.toHaveBeenCalled();
  expect(f.setup.error).toContain('任务草稿');
  expect(f.scheduled).not.toHaveBeenCalled();
});

test('a linked task draft discovered by the preview prevents applying that proposal', async () => {
  const f = await fixture();
  f.model.prepareTaskAction.mockResolvedValueOnce([]).mockResolvedValueOnce([{ key: 'linked@linked-occ', taskId: 'linked', occurrenceId: 'linked-occ', title: '前置任务', kind: 'task' }]);
  await f.setup.schedule();
  expect(f.model.execute.mock.calls.map(([input]) => input.action)).toEqual(['preview_plan']);
  expect(f.scheduled).not.toHaveBeenCalled();
  expect(f.setup.error).toContain('任务草稿');
});

test.each(['before-preview', 'after-preview', 'changes-series-selection'] as const)('saving a picker draft %s requires a refreshed selection instead of using stale revisions', async (phase) => {
  const f = await fixture();
  const blocker = [{ key: 'task@occ', taskId: 'task', occurrenceId: 'occ', title: '任务', kind: 'task' }];
  if (phase === 'after-preview') f.model.prepareTaskAction.mockResolvedValueOnce([]);
  if (phase === 'changes-series-selection') f.model.saveTask.mockImplementation(async () => {
    f.state.selectedOccurrenceId = 'regenerated-period';
    return true;
  });
  f.model.prepareTaskAction.mockResolvedValueOnce(blocker).mockResolvedValueOnce([]);
  await f.setup.schedule();
  expect(f.model.saveTask).toHaveBeenCalledOnce();
  expect(f.model.execute.mock.calls.some(([input]) => input.action === 'apply_plan')).toBe(false);
  expect(f.setup.selected).toBe('');
  expect(f.setup.prepared).toBeUndefined();
  expect(f.setup.error).toContain('重新选择任务并确认安排');
  expect(f.scheduled).not.toHaveBeenCalled();
});

test.each(['date', 'task', 'detail-selection', 'dataset'] as const)('changing the %s while preparation is pending cannot redirect the picker write', async (change) => {
  const f = await fixture();
  f.model.prepareTaskAction.mockImplementation(async () => {
    if (change === 'date') f.setup.date = '2026-12-01';
    if (change === 'task') f.setup.selected = 'other-occ';
    if (change === 'detail-selection') f.state.selectedOccurrenceId = 'other-occ';
    if (change === 'dataset') f.state.snapshot.datasetId = 'other-dataset';
    return [];
  });
  await f.setup.schedule();
  expect(f.model.execute).not.toHaveBeenCalled();
  expect(f.scheduled).not.toHaveBeenCalled();
});

test('an unknown original apply retries its original receipt without saving drafts or building another proposal', async () => {
  const f = await fixture();
  f.setup.prepared = f.plan;
  f.state.pendingMutation = { requestId: 'same-request', action: 'apply_plan', payload: { plan: f.plan } };
  await f.setup.schedule();
  expect(f.model.retryPending).toHaveBeenCalledOnce();
  expect(f.model.prepareTaskAction).not.toHaveBeenCalled();
  expect(f.model.saveTask).not.toHaveBeenCalled();
  expect(f.model.execute).not.toHaveBeenCalled();
  expect(f.scheduled).toHaveBeenCalledWith('2026-11-04');
});
