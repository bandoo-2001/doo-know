import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { hydrateCalendarTaskPickerPage } from '../apps/web/to-doo-calendar-task-projection';
import type { ToDooFilter, ToDooSnapshot } from '../shared/to-doo-contracts';

let fixture: Fixture, headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeEach(async () => { fixture = await createFixture(); headers = await loginFixtureOwner(fixture); });
afterEach(async () => fixture?.close());
const longId = (prefix: string, index: number) => (prefix + '-' + index + '-').padEnd(128, 'x');
async function command(action: string, payload: unknown) {
  const response = await fixture.app.inject({ method: 'POST', url: '/api/to-doo/commands', headers,
    payload: { requestId: randomUUID(), action, payload } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function get(url: string) {
  const response = await fixture.app.inject({ url, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ToDooSnapshot;
}
function query(filter: ToDooFilter, cursor?: string) {
  const params = new URLSearchParams({ view: 'tasks', kind: 'occurrence', filter: JSON.stringify(filter), limit: '200' });
  if (cursor) params.set('cursor', cursor);
  return '/api/to-doo/state?' + params;
}
const pending: ToDooFilter = { statuses: ['todo', 'doing', 'blocked'], unscheduled: true };

it('pages actual pending executions beyond 500 and hydrates legal long identifiers without changing the execution cursor', async () => {
  const listId = (await command('save_entity', { kind: 'list', entity: { name: '当前清单' } })).ids[0];
  const otherListId = (await command('save_entity', { kind: 'list', entity: { name: '其他清单' } })).ids[0];
  const ids = Array.from({ length: 620 }, (_, index) => longId('picker-task', index));
  await command('import_entities', { entities: [
    ...ids.map(id => ({ kind: 'task', entity: { id, title: id, listId } })),
    ...ids.map((taskId, index) => ({ kind: 'occurrence', entity: { id: longId('picker-occ', index), taskId,
      cycleKey: 'once', scheduleRevision: 'picker-fixture', status: ['todo', 'doing', 'blocked'][index % 3] } })),
  ] });
  for (const [title, extra] of [
    ['already scheduled', { listId, plan: { date: '2030-05-17', time: null, timeZone: 'UTC' } }],
    ['another list', { listId: otherListId }],
  ] as const) await command('create_task', { title, ...extra });
  for (const status of ['done', 'skipped'] as const) {
    const created = await command('create_task', { title: 'already ' + status, listId });
    const occurrence = (await get('/api/to-doo/state?taskIds=' + created.ids[0])).occurrences[0];
    await command('set_occurrence_status', { id: occurrence.id, expectedRevision: occurrence.revision, status });
  }
  const filter: ToDooFilter = { ...pending, listIds: [listId] };
  const seen: string[] = [], requests: string[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await get(query(filter, cursor));
    expect(page.page.kind).toBe('occurrence');
    expect(page.tasks).toEqual([]);
    const metadata = JSON.parse(JSON.stringify({ page: page.page, collectionPages: page.collectionPages,
      settings: page.settings, statistics: page.statistics, version: page.version }));
    const hydrated = await hydrateCalendarTaskPickerPage(page, async url => {
      requests.push(url);
      const data = await get(url);
      // Entity-only lookups must not take ownership of the picker's metadata.
      return { ...data, version: 'lookup-version', page: { ...data.page, total: 1, nextCursor: null } };
    }, filter, () => true);
    expect(hydrated).toBeDefined();
    expect({ page: hydrated!.page, collectionPages: hydrated!.collectionPages, settings: hydrated!.settings,
      statistics: hydrated!.statistics, version: hydrated!.version }).toEqual(metadata);
    expect(hydrated!.tasks.map(row => row.id).sort()).toEqual(page.occurrences.map(row => row.taskId).sort());
    expect(hydrated!.lists.find(row => row.id === listId)?.name).toBe('当前清单');
    seen.push(...hydrated!.occurrences.map(row => row.taskId));
    cursor = hydrated!.page.nextCursor || undefined;
    pages++;
  } while (cursor);
  expect(pages).toBe(4);
  expect(seen.sort()).toEqual([...ids].sort());
  expect(new Set(seen).size).toBe(620);
  expect(requests.filter(url => new URL(url, 'http://localhost:3010').searchParams.get('kind') === 'task').length).toBeGreaterThan(4);
  for (const url of requests) {
    const parsed = new URL(url, 'http://localhost:3010');
    expect(parsed.href.length).toBeLessThanOrEqual(8192);
    expect(parsed.searchParams.get('ids')!.length).toBeLessThanOrEqual(8192);
  }
});

it('keeps distinct executions of the same task pageable instead of exhausting a task cursor at 500 periods', async () => {
  await command('import_entities', { entities: [
    { kind: 'task', entity: { id: 'repeating-task', title: '每个周期独立安排' } },
    ...Array.from({ length: 620 }, (_, index) => ({ kind: 'occurrence', entity: {
      id: 'period-' + index, taskId: 'repeating-task', cycleKey: 'cycle-' + index,
      scheduleRevision: 'picker-periods', status: 'todo', titleOverride: '周期 ' + index,
    } })),
  ] });
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const hydrated = await hydrateCalendarTaskPickerPage(await get(query(pending, cursor)), url => get(url), pending, () => true);
    expect(hydrated!.tasks).toHaveLength(1);
    expect(hydrated!.occurrences.every(row => row.taskId === hydrated!.tasks[0].id)).toBe(true);
    seen.push(...hydrated!.occurrences.map(row => row.id));
    cursor = hydrated!.page.nextCursor || undefined;
  } while (cursor);
  expect(seen).toHaveLength(620);
  expect(new Set(seen).size).toBe(620);
});

it('does not publish partial definitions when a later batch fails', async () => {
  await command('import_entities', { entities: [
    ...Array.from({ length: 100 }, (_, index) => ({ kind: 'task', entity: { id: longId('failure-task', index), title: '待安排' } })),
    ...Array.from({ length: 100 }, (_, index) => ({ kind: 'occurrence', entity: { id: 'failure-occ-' + index,
      taskId: longId('failure-task', index), cycleKey: 'once', scheduleRevision: 'picker-failure', status: 'todo' } })),
  ] });
  const page = await get(query(pending));
  const before = JSON.parse(JSON.stringify(page)); let requests = 0;
  await expect(hydrateCalendarTaskPickerPage(page, async url => {
    if (++requests === 2) throw Error('暂时断开');
    return get(url);
  }, pending, () => true)).rejects.toThrow('暂时断开');
  expect(requests).toBe(2);
  expect(page).toEqual(before);
});

it.each(['scope-left', 'dataset-changed'] as const)('does not adopt a late definition response after %s', async reason => {
  const result = await command('create_task', { title: '只属于原安排窗口' });
  const page = await get(query(pending));
  let current = true;
  const hydrated = await hydrateCalendarTaskPickerPage(page, async url => {
    const data = await get(url);
    current = false;
    return reason === 'dataset-changed' ? { ...data, datasetId: 'other-dataset' } : data;
  }, pending, () => current);
  expect(hydrated).toBeUndefined();
  expect(page.tasks).toEqual([]);
  expect(page.occurrences[0].taskId).toBe(result.ids[0]);
});

it('rejects a different dataset while the original picker is still current', async () => {
  await command('create_task', { title: '保留原选择' });
  const page = await get(query(pending));
  await expect(hydrateCalendarTaskPickerPage(page, async url => ({ ...await get(url), datasetId: 'other-dataset' }),
    pending, () => true)).rejects.toThrow('资料库已变化');
  expect(page.tasks).toEqual([]);
});
