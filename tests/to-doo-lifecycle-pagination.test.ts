import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ToDooFilter, ToDooSnapshot } from '../shared/to-doo-contracts';
import { toDooQuickFilter } from '../apps/web/to-doo-presentation';
import { createToDooWorkbench, deriveToDooItems } from '../apps/web/to-doo-workbench';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

let fixture: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
const stamp = '2020-01-02T12:00:00.000Z';
const trashIds = ['trash-a', 'trash-b', 'trash-already-archived'];
const archivedIds = ['archived-a', 'archived-b', 'archived-c'];

async function command(action: string, payload: Record<string, unknown>) {
  const response = await fixture.app.inject({
    method: 'POST', url: '/api/to-doo/commands', headers,
    payload: { requestId: randomUUID(), action, payload },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function snapshot(filter: ToDooFilter, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ view: 'tasks', limit: '200', filter: JSON.stringify(filter), ...extra });
  const response = await fixture.app.inject({ url: '/api/to-doo/state?' + params, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ToDooSnapshot;
}

beforeEach(async () => {
  fixture = await createFixture();
  headers = await loginFixtureOwner(fixture);
  const entities: { kind: string; entity: Record<string, unknown> }[] = [
    { kind: 'list', entity: { id: 'lifecycle-list', name: '原来的项目' } },
  ];
  const taskIds = [...Array.from({ length: 205 }, (_, index) => 'live-' + index), ...trashIds, ...archivedIds];
  for (const id of taskIds) {
    const deleted = trashIds.includes(id), archived = archivedIds.includes(id) || id === 'trash-already-archived';
    entities.push({ kind: 'task', entity: {
      id, title: id, listId: 'lifecycle-list',
      deletedAt: deleted ? stamp : null, archivedAt: archived ? stamp : null,
    } });
    // More than 500 live executions precede the archived/deleted rows. Their
    // own pages must inherit taskScope rather than lose the matching history.
    for (let day = 0; day < 3; day++) entities.push({ kind: 'occurrence', entity: {
      id: id + '-day-' + day, taskId: id, scheduledDate: '2020-01-0' + (day + 1),
      cycleKey: day === 0 ? 'once' : 'history-' + day, scheduleRevision: 'lifecycle-fixture-v1',
      status: deleted || archived ? 'done' : 'todo', completedAt: deleted || archived ? stamp : null,
      deletedAt: deleted ? stamp : null,
    } });
  }
  await command('import_entities', { entities });
});
afterEach(async () => fixture?.close());

it('filters lifecycle scopes before task and execution pagination without changing inclusive queries', async () => {
  for (const [taskScope, ids] of [['trash', trashIds], ['archived', archivedIds]] as const) {
    const data = await snapshot({ taskScope });
    expect(data.tasks.map(task => task.id)).toEqual(ids);
    expect(data.page).toMatchObject({ total: 3, limit: 200, nextCursor: null });
    expect(data.collectionPages?.occurrence).toMatchObject({ total: 9, nextCursor: null });
    expect(data.occurrences).toHaveLength(9);
    expect(data.occurrences.every(row => ids.includes(row.taskId))).toBe(true);
    expect(deriveToDooItems(data, { taskScope })).toHaveLength(9);
    expect(data.lists.find(list => list.id === 'lifecycle-list')?.name).toBe('原来的项目');
  }
  expect((await snapshot({ includeDeleted: true }, { limit: '500' })).tasks).toHaveLength(211);
  expect((await snapshot({ includeArchived: true }, { limit: '500' })).tasks).toHaveLength(208);
  expect((await snapshot({})).page.total).toBe(205);
});

it('counts only matching trash rows, pages them without live rows, and rejects a cursor from another scope', async () => {
  const first = await snapshot({ taskScope: 'trash' }, { limit: '2' });
  expect(first.tasks.map(task => task.id)).toEqual(trashIds.slice(0, 2));
  expect(first.page.total).toBe(3);
  expect(first.page.nextCursor).toBeTruthy();
  const second = await snapshot({ taskScope: 'trash' }, { limit: '2', cursor: first.page.nextCursor! });
  expect(second.tasks.map(task => task.id)).toEqual(trashIds.slice(2));
  expect(second.page.nextCursor).toBeNull();
  const searched = await snapshot({ taskScope: 'trash', query: 'already', listIds: ['lifecycle-list'] });
  expect(searched.tasks.map(task => task.id)).toEqual(['trash-already-archived']);
  expect(searched.page.total).toBe(1);
  const response = await fixture.app.inject({ headers, url: '/api/to-doo/state?' + new URLSearchParams({
    limit: '2', cursor: first.page.nextCursor!, filter: JSON.stringify({ taskScope: 'archived' }),
  }) });
  expect(response.statusCode).toBe(400);
});

it('switches the workbench back to live tasks after restoring or unarchiving a scoped row', async () => {
  const model = createToDooWorkbench(async (url, method = 'GET', body) => {
    const response = await fixture.app.inject({ method, url, headers, ...(body ? { payload: body } : {}) });
    if (response.statusCode !== 200) throw Error(response.body);
    return response.json();
  });
  const loadScope = async (scope: 'trash' | 'archived' | 'all') => {
    model.state.filter = toDooQuickFilter(model.state.filter, scope, '2026-11-17');
    await model.load({ view: 'tasks', limit: 200, filter: model.state.filter });
    expect(model.state.error).toBe('');
  };
  await loadScope('trash');
  expect(new Set(model.items().map(row => row.task.id))).toEqual(new Set(trashIds));
  const deleted = model.state.snapshot!.tasks.find(task => task.id === trashIds[0])!;
  await model.removeEntity('task', deleted, true);
  expect(model.state.error).toBe('');
  expect(model.items().some(row => row.task.id === deleted.id)).toBe(false);
  await loadScope('archived');
  expect(new Set(model.items().map(row => row.task.id))).toEqual(new Set(archivedIds));
  const archived = model.state.snapshot!.tasks.find(task => task.id === archivedIds[0])!;
  await model.batch('patch', { patch: { archivedAt: null } }, [archived.id]);
  expect(model.state.error).toBe('');
  expect(model.items().some(row => row.task.id === archived.id)).toBe(false);
  await loadScope('trash');
  const archivedTombstone = model.state.snapshot!.tasks.find(task => task.id === 'trash-already-archived')!;
  await model.removeEntity('task', archivedTombstone, true);
  expect(model.state.error).toBe('');
  await loadScope('archived');
  expect(model.items().some(row => row.task.id === archivedTombstone.id)).toBe(true);
  await loadScope('all');
  expect(model.state.filter).not.toHaveProperty('taskScope');
  expect(model.state.filter).not.toHaveProperty('includeDeleted');
  expect(model.state.filter).not.toHaveProperty('includeArchived');
  expect(model.state.snapshot!.page.total).toBe(207);
  const restored = await snapshot({}, { ids: deleted.id, kind: 'task' });
  expect(restored.tasks[0]).toMatchObject({ id: deleted.id, deletedAt: null, archivedAt: null });
});
