import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooWorkbench } from '../apps/web/to-doo-workbench';
import type { ToDooQuery, ToDooSnapshot } from '../shared/to-doo-contracts';

let root: string, database: ReturnType<typeof openDatabase>, service: ReturnType<typeof createToDooService>;
const targetId = 'context-target-0', occurrenceId = targetId + '-once';
const command = (action: string, payload: unknown) => service.command({ requestId: randomUUID(), action, payload });
function read(url: string) {
  const query: Record<string, unknown> = {};
  new URL(url, 'http://fixture').searchParams.forEach((value, name) => {
    query[name] = ['ids', 'taskIds', 'kinds', 'listIds'].includes(name) ? value.split(',')
      : name === 'limit' ? Number(value) : name === 'includeTree' ? value === 'true'
        : name === 'filter' ? JSON.parse(value) : value;
  });
  return service.snapshot(query as ToDooQuery);
}
function workbench(intercept?: (url: string) => Promise<ToDooSnapshot> | undefined,
  options: { taskContextVisible?: () => boolean } = {}) {
  return createToDooWorkbench(async (url, method = 'GET', body) =>
    method === 'POST' ? service.command(body) : await intercept?.(url) ?? read(url), options);
}
const isTargetContext = (url: string) => new URL(url, 'http://fixture').searchParams.get('taskIds') === targetId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'todoo-selected-context-'));
  const config = { knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only' };
  await mkdir(config.knowledgeRoot);
  database = openDatabase(config.dataRoot);
  service = createToDooService(config, database, noteService(config, database));
  const targetIds = Array.from({ length: 205 }, (_, i) => 'context-target-' + i);
  const backgroundIds = Array.from({ length: 520 }, (_, i) => 'context-background-' + i);
  const entities = [
    ...targetIds.map(id => ({ kind: 'task', entity: { id, title: id } })),
    ...backgroundIds.map(id => ({ kind: 'task', entity: { id, title: id } })),
    ...[...backgroundIds, ...targetIds].map(id => ({ kind: 'occurrence', entity: {
      id: id + '-once', taskId: id, cycleKey: 'once', scheduleRevision: 'fixture-schedule', status: 'todo',
    } })),
  ];
  command('import_entities', { entities });
});
afterEach(async () => {
  service?.close();
  if (database?.open) database.close();
  await rm(root, { recursive: true, force: true });
});

it('opens a task already in the page by reading its execution beyond the global 500 boundary', async () => {
  const model = workbench();
  await model.load({ view: 'tasks', limit: 200 });
  expect(model.state.snapshot!.tasks.some(task => task.id === targetId)).toBe(true);
  expect(model.state.snapshot!.occurrences.some(o => o.taskId === targetId)).toBe(false);
  const page = JSON.parse(JSON.stringify(model.state.snapshot!.page));
  const taskPage = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages!.task));
  expect(await model.ensureTaskContext(targetId)).toBe(true);
  model.selectTask(targetId);
  expect(model.draft()?.occurrence).toMatchObject({ id: occurrenceId, taskId: targetId, status: 'todo' });
  expect(model.state.snapshot!.page).toEqual(page);
  expect(model.state.snapshot!.collectionPages!.task).toEqual(taskPage);
});

it('preserves clean execution context after saving and reloading a bounded page', async () => {
  const model = workbench();
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId);
  model.selectTask(targetId);
  model.draft()!.task.title = 'Saved title beyond the execution boundary';
  await model.saveTask();
  expect(model.state.error).toBe('');
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.dirty()).toBe(false);
  await model.load();
  expect(model.state.error).toBe('');
  expect(model.draft()?.task.title).toBe('Saved title beyond the execution boundary');
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.state.snapshot!.occurrences.some(o => o.id === occurrenceId)).toBe(true);
  expect(model.state.snapshot!.page.limit).toBe(200);
  await model.acceptSnapshot(service.snapshot({ limit: 200 }));
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.state.snapshot!.occurrences.some(o => o.id === occurrenceId)).toBe(true);
});

it('rehydrates the selected execution when a bounded command receipt omits it', async () => {
  const model = workbench();
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId);
  model.selectTask(targetId);
  // A separately loaded bounded collection can contain the definition while its
  // selected execution remains only in the known clean detail draft.
  model.state.snapshot!.occurrences = service.snapshot({ limit: 200 }).occurrences;
  const context = model.captureCommandResultContext();
  const task = service.getEntity('task', targetId)!;
  const result = command('update_task', { id: targetId, expectedRevision: task.revision,
    patch: { title: 'Confirmed bounded receipt' } });
  expect(result.snapshot.occurrences.some(o => o.id === occurrenceId)).toBe(false);
  expect(await model.acceptCommandResult(result, context)).toBe(true);
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.draft()?.task.title).toBe('Confirmed bounded receipt');
});

it('keeps the known context and input when its targeted reload fails', async () => {
  let unavailable = false;
  const model = workbench(url => unavailable && isTargetContext(url)
    ? Promise.reject(Error('context unavailable')) : undefined);
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId);
  model.selectTask(targetId);
  unavailable = true;
  await model.load();
  expect(model.state.error).toBe('context unavailable');
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  model.draft()!.task.description = 'Keep my unfinished input';
  await model.load();
  expect(model.draft()?.task.description).toBe('Keep my unfinished input');
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.dirty()).toBe(true);
});

it('does not adopt a late execution read after selecting another task', async () => {
  let release!: (value: ToDooSnapshot) => void;
  const pending = new Promise<ToDooSnapshot>(yes => { release = yes; });
  const model = workbench(url => isTargetContext(url) ? pending : undefined);
  await model.load({ view: 'tasks', limit: 200 });
  const opening = model.ensureTaskContext(targetId);
  model.selectTask('context-background-0');
  release(service.snapshot({ taskIds: [targetId], includeTree: true, limit: 500 }));
  expect(await opening).toBe(false);
  expect(model.state.selectedTaskId).toBe('context-background-0');
  expect(model.draft()?.occurrence?.id).toBe('context-background-0-once');
  expect(model.state.snapshot!.occurrences.some(o => o.id === occurrenceId)).toBe(false);
});

it('does not replace a missing selected cycle with another cycle already in the bounded page', async () => {
  const otherId = 'another-cycle-of-the-target';
  command('import_entities', { entities: [{ kind: 'occurrence', entity: {
    id: otherId, taskId: targetId, cycleKey: 'another-cycle', scheduleRevision: 'another-schedule',
    scheduledDate: '2020-01-01', status: 'done',
  } }] });
  let unavailable = false;
  const model = workbench(url => unavailable && isTargetContext(url)
    ? Promise.reject(Error('context unavailable')) : undefined);
  await model.load({ kind: 'occurrence', ids: [otherId], limit: 200 });
  model.selectTask(targetId, occurrenceId);
  expect(model.state.selectedOccurrenceId).toBe(occurrenceId);
  expect(model.draft()?.occurrence).toBeNull();
  await model.ensureTaskContext(targetId, occurrenceId);
  model.selectTask(targetId, occurrenceId);
  unavailable = true;
  await model.load({ kind: 'occurrence', ids: [otherId], limit: 200 });
  model.selectTask(targetId, occurrenceId);
  expect(model.state.snapshot!.tasks.some(task => task.id === targetId)).toBe(true);
  expect(model.state.snapshot!.occurrences.map(o => o.id)).toEqual([otherId]);
  expect(model.state.selectedOccurrenceId).toBe(occurrenceId);
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(model.draft()?.occurrence?.status).toBe('todo');
  expect(model.state.error).toBe('context unavailable');
});

it('rejects a context response belonging to another dataset', async () => {
  const model = workbench(url => isTargetContext(url)
    ? Promise.resolve({ ...read(url), datasetId: 'a-different-dataset' }) : undefined);
  await model.load({ view: 'tasks', limit: 200 });
  const dataset = model.state.snapshot!.datasetId;
  expect(await model.ensureTaskContext(targetId)).toBe(false);
  expect(model.state.snapshot!.datasetId).toBe(dataset);
  expect(model.state.error).toContain('资料库已变化');
  expect(model.state.snapshot!.occurrences.some(o => o.id === occurrenceId)).toBe(false);
});

it('does not restore an old selection when it changes during a bounded reload', async () => {
  let hold = false, release!: (value: ToDooSnapshot) => void, started!: () => void;
  const requested = new Promise<void>(yes => { started = yes; });
  const pending = new Promise<ToDooSnapshot>(yes => { release = yes; });
  const model = workbench(url => {
    if (!hold || !isTargetContext(url)) return;
    started();
    return pending;
  });
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId, occurrenceId);
  model.selectTask(targetId, occurrenceId);
  hold = true;
  const reload = model.load();
  await requested;
  model.selectTask('context-background-0');
  release(service.snapshot({ taskIds: [targetId], includeTree: true, limit: 500 }));
  await reload;
  expect(model.state.selectedTaskId).toBe('context-background-0');
  expect(model.draft()?.occurrence?.id).toBe('context-background-0-once');
});

it('ignores a pending detail graph after a dataset switch', async () => {
  let release!: (value: ToDooSnapshot) => void;
  const pending = new Promise<ToDooSnapshot>(yes => { release = yes; });
  const model = workbench(url => isTargetContext(url) ? pending : undefined);
  await model.load({ view: 'tasks', limit: 200 });
  const opening = model.ensureTaskContext(targetId, occurrenceId);
  const other = service.snapshot({ limit: 200 });
  await model.acceptSnapshot({ ...other, datasetId: 'replacement-dataset' });
  release(service.snapshot({ taskIds: [targetId], includeTree: true, limit: 500 }));
  expect(await opening).toBe(false);
  expect(model.state.snapshot!.datasetId).toBe('replacement-dataset');
  expect(model.state.selectedTaskId).toBe('');
  expect(model.state.snapshot!.occurrences.some(o => o.id === occurrenceId)).toBe(false);
});

it('keeps the task history cursor when an exact selected cycle lies beyond 500 periods', async () => {
  const lateId = 'context-late-cycle';
  command('import_entities', { entities: [...Array.from({ length: 600 }, (_, i) => ({
    kind: 'occurrence', entity: { id: 'context-history-' + i, taskId: targetId,
      cycleKey: 'history-' + i, scheduleRevision: 'history-schedule',
      scheduledDate: '2020-01-01', status: 'done' },
  })), { kind: 'occurrence', entity: { id: lateId, taskId: targetId,
    cycleKey: 'late-cycle', scheduleRevision: 'late-schedule', status: 'todo' } }] });
  const model = workbench();
  await model.load({ view: 'tasks', limit: 200 });
  const outerPage = JSON.parse(JSON.stringify(model.state.snapshot!.page));
  const outerPages = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages));
  const graph = service.snapshot({ taskIds: [targetId], includeTree: true, limit: 500, filter: { includeArchived: true } });
  expect(graph.occurrences.some(row => row.id === lateId)).toBe(false);
  expect(graph.collectionPages!.occurrence!.total).toBe(602);
  expect(graph.collectionPages!.occurrence!.nextCursor).toBeTruthy();
  expect(await model.ensureTaskContext(targetId, lateId)).toBe(true);
  model.selectTask(targetId, lateId);
  expect(model.draft()?.occurrence?.id).toBe(lateId);
  expect(model.state.detailPages[targetId]).toEqual(graph.page);
  expect(model.state.detailCollectionPages[targetId].occurrence).toEqual(graph.collectionPages!.occurrence);
  expect(model.state.snapshot!.page).toEqual(outerPage);
  expect(model.state.snapshot!.collectionPages).toEqual(outerPages);
  await model.nextTaskCollectionPage(targetId, 'occurrence');
  expect(model.state.error).toBe('');
  expect(model.state.detailCollectionPages[targetId].occurrence).toMatchObject({ total: 602, nextCursor: null });
  expect(model.state.snapshot!.occurrences.filter(row => row.taskId === targetId)).toHaveLength(602);
  expect(model.draft()?.occurrence?.id).toBe(lateId);
  expect(model.state.snapshot!.page).toEqual(outerPage);
});

it('does not recreate or select an execution confirmed deleted by the exact read', async () => {
  const model = workbench();
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId);
  model.selectTask(targetId);
  const entry = service.getEntity('occurrence', occurrenceId)!;
  command('delete_entity', { kind: 'occurrence', id: entry.id, expectedRevision: entry.revision });
  expect(await model.ensureTaskContext(targetId, occurrenceId, undefined, true)).toBe(false);
  expect(model.state.error).toContain('已删除');
  expect(model.draft()?.occurrence).toBeNull();
  expect(service.getEntity('occurrence', occurrenceId)?.deletedAt).toBeTruthy();
  expect(service.snapshot({ taskIds: [targetId] }).occurrences).toHaveLength(0);
});

it('reads an archived task in its archive scope without admitting a subsequently deleted task', async () => {
  const task = service.getEntity('task', targetId)!;
  command('update_task', { id: targetId, expectedRevision: task.revision,
    patch: { archivedAt: '2026-11-17T00:00:00.000Z' } });
  const filter = { includeArchived: true, taskScope: 'archived' as const };
  const model = workbench();
  model.state.filter = filter;
  await model.load({ view: 'tasks', filter, limit: 200 });
  expect(model.state.snapshot!.tasks.some(row => row.id === targetId)).toBe(true);
  expect(await model.ensureTaskContext(targetId, occurrenceId, undefined, true)).toBe(true);
  model.selectTask(targetId, occurrenceId);
  expect(model.draft()?.task.archivedAt).toBeTruthy();
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  const archived = service.getEntity('task', targetId)!;
  command('delete_entity', { kind: 'task', id: targetId, expectedRevision: archived.revision });
  expect(await model.ensureTaskContext(targetId, occurrenceId, undefined, true)).toBe(false);
  expect(service.getEntity('task', targetId)?.deletedAt).toBeTruthy();
  expect(service.snapshot({ taskIds: [targetId], filter: { includeArchived: true } }).tasks).toHaveLength(0);
});

it('does not load a closed task graph on a lightweight page, while explicit and visible detail reads still work', async () => {
  let visible = true;
  const reads: string[] = [];
  const model = workbench(url => { reads.push(url); return undefined; }, { taskContextVisible: () => visible });
  await model.load({ view: 'tasks', limit: 200 });
  await model.ensureTaskContext(targetId, occurrenceId);
  model.selectTask(targetId, occurrenceId);
  visible = false;
  reads.length = 0;
  const lightweight: ToDooQuery = { view: 'focus', kinds: ['focusTopic', 'focusSession'], limit: 200 };
  await model.load(lightweight);
  expect(reads.some(isTargetContext)).toBe(false);
  expect(model.state.snapshot!.tasks).toHaveLength(0);
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
  expect(await model.ensureTaskContext(targetId, occurrenceId)).toBe(true);
  expect(reads.some(isTargetContext)).toBe(true);
  visible = true;
  reads.length = 0;
  await model.load(lightweight);
  expect(reads.some(isTargetContext)).toBe(true);
  expect(model.draft()?.occurrence?.id).toBe(occurrenceId);
});
