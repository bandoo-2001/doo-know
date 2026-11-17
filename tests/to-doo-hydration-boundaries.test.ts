import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { watch } from 'vue';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { createToDooWorkbench } from '../apps/web/to-doo-workbench';
import type { ToDooSnapshot } from '../shared/to-doo-contracts';
let f: Fixture, headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
const longId = (prefix: string, index: number) => (prefix + '-' + String(index).padStart(5, '0') + '-').padEnd(128, 'x');
async function command(action: string, payload: unknown) {
  const response = await f.app.inject({ method: 'POST', url: '/api/to-doo/commands', headers,
    payload: { requestId: randomUUID(), action, payload } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function get(url: string) {
  const response = await f.app.inject({ url, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ToDooSnapshot;
}
const seed = async (count: number) => {
  const ids = Array.from({ length: count }, (_, i) => longId('task', i));
  await command('import_entities', { entities: [
    ...ids.map(id => ({ kind: 'task', entity: { id, title: id } })),
    ...ids.map((id, i) => ({ kind: 'occurrence', entity: { id: longId('occ', i), taskId: id,
      cycleKey: 'once', scheduleRevision: 'hydration-fixture', status: 'todo' } })),
  ] });
  return ids;
};
async function calendarFixture() {
  await seed(520);
  const id = longId('calendar-race', 1);
  await command('create_task', { id, title: 'Owned calendar reference',
    plan: { date: '2030-05-17', time: '10:00', timeZone: 'UTC' } });
  const exact = await get('/api/to-doo/state?taskIds=' + id);
  return { id, occurrenceId: exact.occurrences.find(row => row.taskId === id)!.id };
}
beforeEach(async () => { f = await createFixture(); headers = await loginFixtureOwner(f); });
afterEach(async () => f?.close());

it('hydrates all 128-character IDs over real validated API batches and continuation pages', async () => {
  const ids = await seed(520), requests: string[] = [];
  const model = createToDooWorkbench(async (url, method = 'GET', body) => {
    if (method === 'POST') return command((body as any).action, (body as any).payload);
    requests.push(url);
    return get(url);
  });
  const publications: number[] = [];
  const stop = watch(() => model.state.snapshot, snapshot => {
    if (snapshot) publications.push(snapshot.tasks.length);
  }, { flush: 'sync' });
  await model.load({ view: 'focus', limit: 200 });
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.tasks).toHaveLength(500);
  expect(publications).toEqual([200, 500]);
  const initialTaskPage = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages!.task));
  await model.nextCollectionPage('occurrence');
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.tasks.map(row => row.id).sort()).toEqual([...ids].sort());
  expect(model.state.snapshot!.occurrences).toHaveLength(520);
  expect(publications).toEqual([200, 500, 500, 520]);
  stop();
  expect(model.state.snapshot!.collectionPages!.task).toEqual(initialTaskPage);
  const hydration = requests.filter(url => new URL(url, 'http://localhost:3010').searchParams.has('ids'));
  expect(hydration.length).toBeGreaterThan(2);
  for (const url of hydration) {
    const parsed = new URL(url, 'http://localhost:3010');
    expect(parsed.href.length).toBeLessThanOrEqual(8192);
    expect(parsed.searchParams.get('ids')!.length).toBeLessThanOrEqual(8192);
    expect(parsed.searchParams.get('ids')!.split(',').length).toBeLessThanOrEqual(200);
  }
  // URI budgeting does not silently widen the business identifier contract.
  for (const id of ['中文', 'scope:item']) {
    const response = await f.app.inject({ url: '/api/to-doo/state?kind=task&ids=' + encodeURIComponent(id), headers });
    expect(response.statusCode).toBe(400);
  }
});

it('loads long parent identifiers as metadata without adding parent result rows', async () => {
  const parents = Array.from({ length: 100 }, (_, i) => longId('parent', i));
  const children = parents.map((_, i) => longId('child', i));
  await command('import_entities', { entities: [
    ...parents.map(id => ({ kind: 'task', entity: { id, title: 'parent ' + id } })),
    ...children.map((id, i) => ({ kind: 'task', entity: { id, title: 'needle child ' + i, parentTaskId: parents[i] } })),
    ...parents.map((id, i) => ({ kind: 'occurrence', entity: { id: longId('parent-occ', i), taskId: id,
      cycleKey: 'once', scheduleRevision: 'parent-fixture', status: 'todo' } })),
    ...children.map((id, i) => ({ kind: 'occurrence', entity: { id: longId('child-occ', i), taskId: id,
      parentOccurrenceId: longId('parent-occ', i), cycleKey: 'once', scheduleRevision: 'child-fixture', status: 'todo' } })),
  ] });
  const model = createToDooWorkbench(url => get(url));
  await model.load({ view: 'tasks', filter: { query: 'needle child' }, limit: 200 });
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.tasks.map(row => row.id).sort()).toEqual([...children].sort());
  expect(parents.every(id => !!model.state.taskAncestors[id])).toBe(true);
});

it('prepares and reconciles a long-ID batch receipt through bounded real API reads', async () => {
  await seed(520);
  const ids = Array.from({ length: 100 }, (_, i) => longId('patch-target', i));
  await command('import_entities', { entities: [
    ...ids.map((id, i) => ({ kind: 'task', entity: { id, title: 'Patch owned long task ' + i } })),
    ...ids.map((id, i) => ({ kind: 'occurrence', entity: { id: longId('patch-occ', i), taskId: id,
      cycleKey: 'once', scheduleRevision: 'patch-fixture', status: 'todo' } })),
  ] });
  const reads: string[] = [];
  const model = createToDooWorkbench(async (url, method = 'GET', body) => {
    if (method === 'POST') return command((body as any).action, (body as any).payload);
    reads.push(url);
    return get(url);
  });
  const filter = { query: 'Patch owned long task' };
  model.state.filter = filter;
  await model.load({ view: 'tasks', filter, limit: 200 });
  const page = JSON.parse(JSON.stringify(model.state.snapshot!.page));
  model.state.selectedIds = [...ids];
  await model.batch('patch', { patch: { priority: 'high' } });
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.tasks).toHaveLength(100);
  expect(model.state.snapshot!.tasks.every(task => task.priority === 'high')).toBe(true);
  expect(model.state.snapshot!.page).toEqual(page);
  expect(reads.some(url => new URL(url, 'http://localhost:3010').searchParams.has('taskIds'))).toBe(true);
  expect(reads.some(url => new URL(url, 'http://localhost:3010').searchParams.has('ids'))).toBe(true);
  for (const url of reads) expect(new URL(url, 'http://localhost:3010').href.length).toBeLessThanOrEqual(8192);
});

it('hydrates a calendar block execution before its task without changing any page ownership', async () => {
  await seed(520);
  const targetId = longId('calendar-target', 1);
  const saved = await command('create_task', { id: targetId, title: 'Calendar projection after 500 executions',
    plan: { date: '2030-05-17', time: '10:00', timeZone: 'UTC' } });
  const exact = await get('/api/to-doo/state?taskIds=' + targetId);
  const occurrence = exact.occurrences.find(row => row.taskId === targetId)!;
  const query = 'view=calendar&from=2030-05-01&to=2030-05-31&limit=200';
  const before = await get('/api/to-doo/state?' + query);
  expect(before.timeBlocks.some(row => row.occurrenceId === occurrence.id)).toBe(true);
  expect(before.occurrences.some(row => row.id === occurrence.id)).toBe(false);
  expect(before.tasks.some(row => row.id === saved.ids[0])).toBe(false);
  const model = createToDooWorkbench(url => get(url));
  await model.load({ view: 'calendar', from: '2030-05-01', to: '2030-05-31', limit: 200 });
  expect(model.state.error).toBe('');
  const item = model.items().find(row => row.task.id === targetId)!;
  expect(item.title).toBe('Calendar projection after 500 executions');
  expect(item.blocks).toHaveLength(1);
  expect(item.blocks[0].start.date).toBe('2030-05-17');
  expect(model.state.snapshot!.page).toEqual(before.page);
  expect(model.state.snapshot!.collectionPages).toEqual(before.collectionPages);
  expect(model.state.detailPages).toEqual({});
  expect(model.state.detailCollectionPages).toEqual({});
});

it('ignores a late calendar reference after navigating to a lightweight view', async () => {
  const target = await calendarFixture();
  let started!: () => void, release!: (value: ToDooSnapshot) => void;
  const requested = new Promise<void>(yes => { started = yes; });
  const pending = new Promise<ToDooSnapshot>(yes => { release = yes; });
  let owned: ToDooSnapshot | undefined;
  const model = createToDooWorkbench(async url => {
    const q = new URL(url, 'http://localhost:3010').searchParams;
    if (q.get('kind') === 'occurrence' && q.get('ids') === target.occurrenceId) {
      owned = await get(url);
      started();
      return pending;
    }
    return get(url);
  });
  const calendar = model.load({ view: 'calendar', from: '2030-05-01', to: '2030-05-31', limit: 200 });
  await requested;
  await model.load({ view: 'habits', kinds: ['habit'], limit: 200 });
  release(owned!);
  await calendar;
  expect(model.state.query.view).toBe('habits');
  expect(model.state.snapshot!.tasks).toHaveLength(0);
  expect(model.state.snapshot!.occurrences).toHaveLength(0);
  expect(model.state.snapshot!.timeBlocks).toHaveLength(0);
  expect(model.state.detailCollectionPages).toEqual({});
});

it('rejects a calendar lookup from another dataset without adopting its entities', async () => {
  const target = await calendarFixture();
  const original = (await get('/api/to-doo/state?kind=settings')).datasetId;
  const model = createToDooWorkbench(async url => {
    const data = await get(url), q = new URL(url, 'http://localhost:3010').searchParams;
    return q.get('kind') === 'occurrence' && q.get('ids') === target.occurrenceId
      ? { ...data, datasetId: 'foreign-calendar-dataset' } : data;
  });
  await model.load({ view: 'calendar', from: '2030-05-01', to: '2030-05-31', limit: 200 });
  expect(model.state.error).toContain('资料库已变化');
  expect(model.state.snapshot!.datasetId).toBe(original);
  expect(model.state.snapshot!.occurrences.some(row => row.id === target.occurrenceId)).toBe(false);
  expect(model.state.snapshot!.tasks.some(row => row.id === target.id)).toBe(false);
});

it('does not publish an early partial definition batch when a later batch fails', async () => {
  await seed(520);
  let lookups = 0;
  const model = createToDooWorkbench(url => {
    const q = new URL(url, 'http://localhost:3010').searchParams;
    if (q.get('kind') === 'task' && q.has('ids') && ++lookups === 2)
      return Promise.reject(Error('definition lookup failed'));
    return get(url);
  });
  await model.load({ view: 'focus', limit: 200 });
  expect(lookups).toBe(2);
  expect(model.state.error).toBe('definition lookup failed');
  expect(model.state.snapshot!.tasks).toHaveLength(200);
});

it('keeps newer accepted command values, later entities and current metadata when publishing buffered definitions', async () => {
  await seed(520);
  const editedId = longId('task', 200);
  let lookups = 0, started!: () => void, release!: (value: ToDooSnapshot) => void;
  let held: ToDooSnapshot | undefined;
  const pending = new Promise<ToDooSnapshot>(yes => { release = yes; });
  const requested = new Promise<void>(yes => { started = yes; });
  const model = createToDooWorkbench(async url => {
    const q = new URL(url, 'http://localhost:3010').searchParams;
    const data = await get(url);
    if (q.get('kind') === 'task' && q.has('ids') && q.get('limit') === '200' && ++lookups === 2) {
      held = data;
      started();
      return pending;
    }
    return data;
  });
  const loading = model.load({ view: 'focus', limit: 200 });
  await requested;
  expect(model.state.snapshot!.tasks.some(row => row.id === editedId)).toBe(false);
  const before = await get('/api/to-doo/state?kind=task&ids=' + editedId);
  const changed = await command('update_task', { id: editedId, expectedRevision: before.tasks[0].revision,
    patch: { title: 'Newer accepted title' } });
  expect(changed.changed.some((row: { kind: string; id: string }) => row.kind === 'task' && row.id === editedId)).toBe(true);
  // A normal targeted write-back can arrive while a separate scope hydration
  // is still waiting. Keep its fresh entity and the rest of that scope's refs.
  await model.ensureTask(editedId);
  const late = await command('create_task', { title: 'Added while hydration waited' });
  await model.ensureTask(late.ids[0]);
  const metadata = JSON.parse(JSON.stringify({ version: model.state.snapshot!.version,
    page: model.state.snapshot!.page, collectionPages: model.state.snapshot!.collectionPages,
    statistics: model.state.snapshot!.statistics, settings: model.state.snapshot!.settings,
    detailPages: model.state.detailPages, detailCollectionPages: model.state.detailCollectionPages }));
  let publications = 0;
  const stop = watch(() => model.state.snapshot, () => { publications++; }, { flush: 'sync' });
  release(held!);
  await loading;
  stop();
  expect(publications).toBe(1);
  expect(model.state.snapshot!.tasks.find(row => row.id === editedId)?.title).toBe('Newer accepted title');
  expect(model.state.snapshot!.tasks.some(row => row.id === late.ids[0])).toBe(true);
  expect(new Set(model.state.snapshot!.tasks.map(row => row.id)).size).toBe(model.state.snapshot!.tasks.length);
  expect({ version: model.state.snapshot!.version, page: model.state.snapshot!.page,
    collectionPages: model.state.snapshot!.collectionPages, statistics: model.state.snapshot!.statistics,
    settings: model.state.snapshot!.settings, detailPages: model.state.detailPages,
    detailCollectionPages: model.state.detailCollectionPages }).toEqual(metadata);
});

it('publishes a multi-batch block-reference stage and its definition stage once each', async () => {
  await seed(520);
  const ids = Array.from({ length: 200 }, (_, i) => longId('calendar-many-task', i));
  await command('import_entities', { entities: [
    ...ids.map(id => ({ kind: 'task', entity: { id, title: id } })),
    ...ids.map((id, i) => ({ kind: 'occurrence', entity: { id: longId('calendar-many-occ', i), taskId: id,
      cycleKey: 'once', scheduleRevision: 'many-references', status: 'todo' } })),
    ...ids.map((_, i) => ({ kind: 'timeBlock', entity: { id: longId('calendar-many-block', i),
      occurrenceId: longId('calendar-many-occ', i), start: { date: '2030-05-17', time: '10:00', timeZone: 'UTC' },
      durationMinutes: 25 } })),
  ] });
  const model = createToDooWorkbench(url => get(url));
  const publications: [number, number][] = [];
  const stop = watch(() => model.state.snapshot, snapshot => {
    if (snapshot) publications.push([snapshot.tasks.length, snapshot.occurrences.length]);
  }, { flush: 'sync' });
  await model.load({ view: 'calendar', from: '2030-05-01', to: '2030-05-31', limit: 200 });
  stop();
  expect(model.state.error).toBe('');
  expect(publications).toEqual([[200, 500], [200, 700], [700, 700]]);
  expect(model.items().filter(row => row.blocks.length)).toHaveLength(200);
});
