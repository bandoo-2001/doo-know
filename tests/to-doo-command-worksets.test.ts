import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createToDooWorkbench } from '../apps/web/to-doo-workbench';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import type { ToDooCommandResult } from '../shared/to-doo-contracts';

let fixture: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeEach(async () => {
  fixture = await createFixture();
  headers = await loginFixtureOwner(fixture);
});
afterEach(async () => fixture?.close());
async function command(action: string, payload: unknown) {
  const response = await fixture.app.inject({ method: 'POST', url: '/api/to-doo/commands', headers,
    payload: { requestId: randomUUID(), action, payload } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
function workbench(options: {
  afterPost?: (result: ToDooCommandResult) => Promise<void>;
  beforeGet?: (url: string) => Promise<void>;
  endpoint?: () => { fixture: Fixture; headers: Awaited<ReturnType<typeof loginFixtureOwner>> };
} = {}) {
  const reads: string[] = [];
  const model = createToDooWorkbench(async (url, method = 'GET', payload) => {
    if (method === 'GET') { reads.push(url); await options.beforeGet?.(url); }
    const endpoint = options.endpoint?.() || { fixture, headers };
    const response = await endpoint.fixture.app.inject({ method: method as 'GET' | 'POST', url, headers: endpoint.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    if (response.statusCode >= 400)
      throw Object.assign(Error(response.json().error), { status: response.statusCode });
    const result = response.json();
    if (method === 'POST') await options.afterPost?.(result);
    return result;
  });
  return { model, reads };
}

it('continues the current signed execution page after creating a focus project without losing loaded task rows', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await command('import_entities', { entities: Array.from({ length: 205 }, (_, index) => {
    const id = 'background-task-' + String(index).padStart(4, '0');
    return [{ kind: 'task', entity: { id, title: id } },
      ...Array.from({ length: 3 }, (_, execution) => ({ kind: 'occurrence', entity: {
        id: id + '-' + execution, taskId: id, cycleKey: 'cycle-' + execution,
        scheduleRevision: 'source-revision', scheduledDate: day,
      } }))];
  }).flat() });
  const { model, reads } = workbench();
  await model.load({ view: 'focus', limit: 200 });
  await model.nextCollectionPage('task');
  const ids = model.state.snapshot!.tasks.map(task => task.id).sort();
  const page = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages!.occurrence!));
  expect(ids).toHaveLength(205);
  expect(model.state.snapshot!.occurrences).toHaveLength(500);
  expect(page.nextCursor).toEqual(expect.any(String));
  expect(await model.saveEntity('focusTopic', { name: 'New focus project' })).toBeTruthy();
  const immediatelyRetained = model.state.snapshot!.tasks.map(task => task.id).sort();
  await model.nextCollectionPage('occurrence');
  expect(model.state.error).toBe('');
  expect(reads.some(url => new URL(url, 'http://fixture').searchParams.get('cursor') === page.nextCursor)).toBe(true);
  expect(immediatelyRetained).toEqual(ids);
  expect(model.state.snapshot!.tasks.map(task => task.id).sort()).toEqual(ids);
  expect(model.state.snapshot!.occurrences).toHaveLength(615);
  expect(model.state.snapshot!.collectionPages!.occurrence!.nextCursor).toBeNull();
});

it('status completion retains signed scope pages and loaded metadata without changing its precise command receipt', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await command('import_entities', { entities: Array.from({ length: 205 }, (_, index) => {
    const id = 'status-task-' + String(index).padStart(4, '0');
    return [{ kind: 'task', entity: { id, title: id } }, ...Array.from({ length: 3 }, (_, execution) => ({
      kind: 'occurrence', entity: { id: id + '-' + execution, taskId: id,
        cycleKey: 'cycle-' + execution, scheduleRevision: 'status-source', scheduledDate: day },
    }))];
  }).flat() });
  await command('import_entities', { entities: Array.from({ length: 250 }, (_, index) => [
    { kind: 'focusTopic', entity: { id: 'status-topic-' + index, name: 'Topic ' + index } },
    { kind: 'habit', entity: { id: 'status-habit-' + index, name: 'Habit ' + index, startDate: day } },
  ]).flat() });
  let raw: unknown;
  const { model } = workbench({ afterPost: async result => { raw = JSON.parse(JSON.stringify(result.snapshot)); } });
  const filter = { statuses: ['todo', 'doing', 'blocked'] as ('todo' | 'doing' | 'blocked')[] };
  model.state.filter = filter;
  await model.load({ view: 'focus', filter, limit: 200 });
  await model.nextCollectionPage('task');
  await model.nextCollectionPage('focusTopic');
  await model.nextCollectionPage('habit');
  expect(model.state.snapshot!.focusTopics).toHaveLength(250);
  expect(model.state.snapshot!.habits).toHaveLength(250);
  const target = model.state.snapshot!.occurrences[0];
  const result = await model.setStatus(target.id, 'done');
  expect(result).toBeTruthy();
  expect(result!.snapshot).toEqual(raw);
  await model.nextCollectionPage('occurrence');
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.focusTopics).toHaveLength(250);
  expect(model.state.snapshot!.habits).toHaveLength(250);
  expect(model.items()).toHaveLength(614);
  expect(model.state.snapshot!.occurrences.find(row => row.id === target.id)?.status).toBe('done');
  expect(model.state.snapshot!.collectionPages!.occurrence!.nextCursor).toBeNull();
  expect(model.state.pendingMutation).toBeNull();
});

it('keeps loaded focus projects and repositions a changed collection cursor after edit, deletion and insertion', async () => {
  await command('import_entities', { entities: Array.from({ length: 350 }, (_, index) => ({
    kind: 'focusTopic', entity: { id: 'topic-' + String(index).padStart(4, '0'),
      name: 'Project ' + index },
  })) });
  const { model } = workbench();
  await model.load({ kind: 'focusTopic', view: 'focus', limit: 100 });
  await model.nextCollectionPage('focusTopic');
  await model.nextCollectionPage('focusTopic');
  const known = model.state.snapshot!.focusTopics.map(row => row.id);
  expect(known).toHaveLength(300);
  const edited = model.state.snapshot!.focusTopics.find(row => row.id === 'topic-0250')!;
  await model.saveEntity('focusTopic', { ...edited, name: 'Edited tail project' }, edited.revision);
  expect(model.state.snapshot!.focusTopics.find(row => row.id === edited.id)?.name).toBe('Edited tail project');
  expect(known.every(id => model.state.snapshot!.focusTopics.some(row => row.id === id))).toBe(true);
  const deleted = model.state.snapshot!.focusTopics.find(row => row.id === 'topic-0005')!;
  await model.execute({ action: 'delete_entity', payload: { kind: 'focusTopic', id: deleted.id,
    expectedRevision: deleted.revision, cascade: false } });
  expect(model.state.snapshot!.focusTopics.some(row => row.id === deleted.id)).toBe(false);
  await model.nextCollectionPage('focusTopic');
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.focusTopics).toHaveLength(349);
  expect(new Set(model.state.snapshot!.focusTopics.map(row => row.id)).size).toBe(349);
  await model.saveEntity('focusTopic', { id: 'inserted-project', name: 'Inserted project' });
  expect(model.state.snapshot!.focusTopics).toHaveLength(350);
  expect(model.state.snapshot!.collectionPages!.focusTopic!.nextCursor).toBeNull();
});

it('repositions the default primary task page after deletion without borrowing a kind-specific cursor', async () => {
  await command('import_entities', { entities: Array.from({ length: 250 }, (_, index) => ({
    kind: 'task', entity: { id: 'primary-' + String(index).padStart(4, '0'), title: 'Task ' + index },
  })) });
  const { model } = workbench();
  await model.load({ view: 'tasks', limit: 100 });
  await model.nextPage();
  expect(model.state.snapshot!.tasks).toHaveLength(200);
  expect(model.state.snapshot!.page.kind).toBeNull();
  const target = model.state.snapshot!.tasks[0];
  expect(await model.execute({ action: 'delete_entity', payload: { kind: 'task', id: target.id,
    expectedRevision: target.revision, cascade: true } }), model.state.error).toBeTruthy();
  expect(model.state.snapshot!.tasks.find(row => row.id === target.id), JSON.stringify({ warning: model.state.localWarning,
    error: model.state.error, page: model.state.snapshot!.page })).toBeUndefined();
  await model.nextPage();
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.tasks).toHaveLength(249);
  expect(new Set(model.state.snapshot!.tasks.map(row => row.id)).size).toBe(249);
  expect(model.state.snapshot!.tasks.some(row => row.id === target.id)).toBe(false);
  expect(model.state.snapshot!.page).toMatchObject({ kind: null, total: 249, nextCursor: null });
});

it('retains a loaded habit window while moving rows out of its list scope and returns the confirmed moved entity', async () => {
  await command('import_entities', { entities: [
    { kind: 'list', entity: { id: 'list-a', name: 'A' } },
    { kind: 'list', entity: { id: 'list-b', name: 'B' } },
    ...Array.from({ length: 250 }, (_, index) => ({ kind: 'habit', entity: {
      id: 'habit-' + String(index).padStart(4, '0'), name: 'Habit ' + index,
      startDate: new Date().toISOString().slice(0, 10), listId: 'list-a',
    } })),
  ] });
  const { model } = workbench();
  await model.load({ kind: 'habit', view: 'habits', listIds: ['list-a'], limit: 100 });
  await model.nextCollectionPage('habit');
  await model.nextCollectionPage('habit');
  expect(model.state.snapshot!.habits).toHaveLength(250);
  const moved = model.state.snapshot!.habits.find(row => row.id === 'habit-0200')!;
  const result = await model.saveEntity('habit', { ...moved, listId: 'list-b' }, moved.revision);
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.habits).toHaveLength(249);
  expect(model.state.snapshot!.habits.some(row => row.id === moved.id)).toBe(false);
  expect(result?.snapshot.habits.find(row => row.id === moved.id)?.listId).toBe('list-b');
  expect(model.state.snapshot!.page).toMatchObject({ kind: 'habit', total: 249, nextCursor: null });
});

it('keeps collection cursor ownership when a non-task entity lookup is accepted', async () => {
  await command('import_entities', { entities: Array.from({ length: 205 }, (_, index) => ({
    kind: 'focusTopic', entity: { id: 'known-topic-' + index, name: 'Known ' + index },
  })) });
  const { model } = workbench();
  await model.load({ kind: 'focusTopic', view: 'focus', limit: 100 });
  const before = JSON.parse(JSON.stringify(model.state.snapshot!.collectionPages));
  const response = await fixture.app.inject({ url: '/api/to-doo/state?kind=focusTopic&ids=known-topic-204&limit=1', headers });
  expect(response.statusCode).toBe(200);
  model.acceptSnapshot(response.json(), true);
  expect(model.state.snapshot!.collectionPages).toEqual(before);
  await model.nextCollectionPage('focusTopic');
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.focusTopics.length).toBeGreaterThanOrEqual(200);
});

it('does not let a late metadata receipt replace a newer query and clears only the confirmed pending command', async () => {
  await command('import_entities', { entities: [
    { kind: 'list', entity: { id: 'list-a', name: 'A' } },
    { kind: 'list', entity: { id: 'list-b', name: 'B' } },
    { kind: 'focusTopic', entity: { id: 'project-a', name: 'A', listId: 'list-a' } },
    { kind: 'focusTopic', entity: { id: 'project-b', name: 'B', listId: 'list-b' } },
  ] });
  let finish!: () => void, committed!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const ack = new Promise<void>(resolve => { committed = resolve; });
  const { model } = workbench({ afterPost: async () => { committed(); await held; } });
  await model.load({ kind: 'focusTopic', listIds: ['list-a'], limit: 1 });
  const old = model.state.snapshot!.focusTopics[0];
  const saving = model.saveEntity('focusTopic', { ...old, name: 'Saved in A' }, old.revision);
  await ack;
  await model.load({ kind: 'focusTopic', listIds: ['list-b'], limit: 1 });
  const newer = JSON.parse(JSON.stringify(model.state.snapshot));
  finish(); await saving;
  expect(model.state.snapshot).toEqual(newer);
  expect(model.state.pendingMutation).toBeNull();
  expect(model.state.query.listIds).toEqual(['list-b']);
});

it('updates scoped statistics and the owner unread badge after marking more than 200 events read', async () => {
  const own = await command('save_entity', { kind: 'list', entity: { name: 'Own list' } });
  const outside = await command('save_entity', { kind: 'list', entity: { name: 'Outside list' } });
  const task = await command('create_task', { title: 'Notice source', listId: own.ids[0] });
  await command('create_task', { title: 'Outside task', listId: outside.ids[0] });
  const now = new Date();
  const ids = Array.from({ length: 206 }, (_, index) => 'notice-' + index);
  await command('import_entities', { entities: [...ids, 'future-notice'].map(id => ({ kind: 'reminderEvent', entity: {
    id, sourceType: 'task', sourceId: task.ids[0], occurrenceKey: 'once', scheduleRevision: 'notice-rule', ruleId: 'notice-rule',
    scheduledAt: new Date(now.getTime() + (id === 'future-notice' ? 86400000 : -1000)).toISOString(),
    firstRaisedAt: id === 'future-notice' ? null : now.toISOString(), title: id,
  } })) });
  const { model } = workbench();
  await model.load({ view: 'notifications', kind: 'reminderEvent', listIds: [own.ids[0]], raisedOnly: true,
    reminderStates: ['unread'], limit: 100 });
  await model.nextCollectionPage('reminderEvent');
  expect(model.state.snapshot!.reminderEvents).toHaveLength(200);
  expect(model.state.snapshot!.statistics.pending).toBe(1);
  expect(model.state.snapshot!.reminderUnreadCount).toBe(206);
  await model.execute({ action: 'read_reminders', payload: { ids: [...ids, 'future-notice'], datasetId: model.state.snapshot!.datasetId } });
  expect(model.state.snapshot!.reminderEvents).toHaveLength(0);
  expect(model.state.snapshot!.reminderUnreadCount).toBe(0);
  expect(model.state.snapshot!.statistics.pending).toBe(1);
  expect(model.state.snapshot!.page).toMatchObject({ total: 0, nextCursor: null });
  const future = await fixture.app.inject({ url: '/api/to-doo/state?kind=reminderEvent&ids=future-notice', headers });
  expect(future.json().reminderEvents[0].userState).toBe('unread');
});

it('obtains a new effective query when a settings write changes the calendar time zone', async () => {
  const { model, reads } = workbench();
  await model.load({ view: 'calendar', limit: 100 });
  const before = model.state.snapshot!.settings;
  await model.saveEntity('settings', { ...before, timeZone: 'Pacific/Kiritimati' }, before.revision);
  expect(model.state.pendingMutation).toBeNull();
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.settings.timeZone).toBe('Pacific/Kiritimati');
  expect(reads.filter(path => { const q = new URL(path, 'http://fixture').searchParams;
    return q.get('view') === 'calendar' && !q.has('cursor'); }).length).toBeGreaterThanOrEqual(2);
  expect(model.state.query.cursor).toBeUndefined();
});

it.each(['occurrence', 'focusTopic'] as const)('retains a same-generation %s append accepted during metadata read-back', async kind => {
  const day = new Date().toISOString().slice(0, 10);
  await command('import_entities', { entities: Array.from({ length: 205 }, (_, index) => {
    const id = 'append-task-' + index;
    return [{ kind: 'task', entity: { id, title: id } }, ...Array.from({ length: 3 }, (_, execution) => ({
      kind: 'occurrence', entity: { id: id + '-' + execution, taskId: id,
        cycleKey: 'cycle-' + execution, scheduleRevision: 'append-source', scheduledDate: day },
    }))];
  }).flat() });
  await command('import_entities', { entities: Array.from({ length: 250 }, (_, index) => ({
    kind: 'focusTopic', entity: { id: 'append-topic-' + index, name: 'Topic ' + index },
  })) });
  let committed = false, blocked = false, finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { model } = workbench({ afterPost: async () => { committed = true; }, beforeGet: async url => {
    if (committed && !blocked && new URL(url, 'http://fixture').searchParams.get('kinds') === 'settings') {
      blocked = true; entered(); await held;
    }
  } });
  await model.load({ view: 'focus', limit: 200 });
  const saving = model.saveEntity('focusTopic', { id: 'new-append-project', name: 'New project' });
  try {
    await started;
    await model.nextCollectionPage(kind);
    const accepted = kind === 'occurrence' ? model.state.snapshot!.occurrences.map(row => row.id)
      : model.state.snapshot!.focusTopics.map(row => row.id);
    expect(accepted.length).toBe(kind === 'occurrence' ? 615 : 251);
    finish(); await saving;
    const retained = kind === 'occurrence' ? model.state.snapshot!.occurrences.map(row => row.id)
      : model.state.snapshot!.focusTopics.map(row => row.id);
    expect(accepted.every(id => retained.includes(id))).toBe(true);
    expect(model.state.snapshot!.collectionPages![kind]!.nextCursor).toBeNull();
    expect(model.state.snapshot!.focusTopics.some(row => row.id === 'new-append-project')).toBe(true);
    expect(model.state.pendingMutation).toBeNull();
  } finally { finish(); await saving; }
});

it('updates inherited reminder and habit-entry scopes when only their source parent moves lists', async () => {
  await command('import_entities', { entities: [
    { kind: 'list', entity: { id: 'source-a', name: 'A' } },
    { kind: 'list', entity: { id: 'source-b', name: 'B' } },
  ] });
  const task = await command('create_task', { title: 'Reminder task', listId: 'source-a' });
  const habit = await command('save_entity', { kind: 'habit', entity: { id: 'source-habit', name: 'Reminder habit',
    startDate: new Date().toISOString().slice(0, 10), listId: 'source-a' } });
  await command('checkin_habit', { habitId: habit.ids[0], localDate: new Date().toISOString().slice(0, 10), amount: 1 });
  const at = new Date().toISOString();
  await command('import_entities', { entities: [['habit', habit.ids[0]], ['task', task.ids[0]]].map(([sourceType,sourceId]) => ({
    kind: 'reminderEvent', entity: { id: sourceType + '-scope-event', sourceType, sourceId,
      occurrenceKey: 'once', scheduleRevision: 'scope-rule', ruleId: 'scope-rule', scheduledAt: at,
      firstRaisedAt: at, title: sourceType + ' reminder' },
  })) });
  const { model } = workbench();
  await model.load({ view: 'stats', kinds: ['habit', 'habitEntry', 'reminderEvent'], listIds: ['source-a'], limit: 100 });
  expect(model.state.snapshot!.habitEntries).toHaveLength(1);
  expect(model.state.snapshot!.reminderEvents).toHaveLength(2);
  const before = model.state.snapshot!.habits[0];
  const moved = await model.saveEntity('habit', { ...before, listId: 'source-b' }, before.revision);
  expect(model.state.snapshot!.habitEntries).toHaveLength(0);
  expect(model.state.snapshot!.reminderEvents.map(row => row.id)).toEqual(['task-scope-event']);
  expect(model.state.snapshot!.statistics.habitAmount).toBe(0);
  const current = moved!.snapshot.habits.find(row => row.id === before.id)!;
  await model.saveEntity('habit', { ...current, listId: 'source-a' }, current.revision);
  expect(model.state.snapshot!.habitEntries).toHaveLength(1);
  expect(model.state.snapshot!.reminderEvents).toHaveLength(2);
  const taskBefore = task.snapshot.tasks.find((row: { id: string }) => row.id === task.ids[0]);
  await model.execute({ action: 'update_task', payload: { id: task.ids[0], expectedRevision: taskBefore.revision,
    patch: { listId: 'source-b' } } });
  expect(model.state.error).toBe('');
  expect(model.state.snapshot!.reminderEvents.map(row => row.id)).toEqual(['habit-scope-event']);
  expect(model.state.snapshot!.statistics.pending).toBe(0);
  expect(model.state.snapshot!.reminderUnreadCount).toBe(2);
});

it('retains the confirmed new settings acknowledgement when its effective-scope reload fails', async () => {
  let committed = false, rejectReads = false, writes = 0;
  const { model } = workbench({ afterPost: async () => { committed = true; rejectReads = true; writes++; },
    beforeGet: async () => { if (committed && rejectReads) throw Error('New scope unavailable'); } });
  await model.load({ view: 'calendar', limit: 100 });
  const before = model.state.snapshot!.settings;
  const result = await model.saveEntity('settings', { ...before, timeZone: 'Pacific/Kiritimati' }, before.revision);
  expect(result!.snapshot.settings.timeZone).toBe('Pacific/Kiritimati');
  expect(model.state.pendingMutation).toBeNull();
  expect(model.state.localWarning).toMatch(/已保存.*无法载入/);
  await model.retryPending();
  expect(writes).toBe(1);
  rejectReads = false;
  await model.load({ view: 'calendar', limit: 100 });
  expect(model.state.snapshot!.settings.timeZone).toBe('Pacific/Kiritimati');
});

it('does not adopt an old-dataset metadata response into a newly opened dataset', async () => {
  const other = await createFixture();
  const otherHeaders = await loginFixtureOwner(other);
  const seed = await other.app.inject({ method: 'POST', url: '/api/to-doo/commands', headers: otherHeaders,
    payload: { requestId: randomUUID(), action: 'save_entity', payload: { kind: 'focusTopic',
      entity: { id: 'shared-project', name: 'New dataset value' } } } });
  expect(seed.statusCode).toBe(200);
  await command('save_entity', { kind: 'focusTopic', entity: { id: 'shared-project', name: 'Original dataset' } });
  let endpoint = { fixture, headers }, finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { model } = workbench({ endpoint: () => endpoint, afterPost: async () => { entered(); await held; } });
  let saving: ReturnType<typeof model.saveEntity> | undefined;
  try {
    await model.load({ kind: 'focusTopic', limit: 100 });
    const previousDataset = model.state.snapshot!.datasetId, before = model.state.snapshot!.focusTopics[0];
    saving = model.saveEntity('focusTopic', { ...before, name: 'Committed to original' }, before.revision);
    await started;
    endpoint = { fixture: other, headers: otherHeaders };
    await model.load({ kind: 'focusTopic', limit: 100 });
    expect(model.state.snapshot!.datasetId).not.toBe(previousDataset);
    const current = JSON.parse(JSON.stringify(model.state.snapshot));
    finish(); await saving;
    expect(model.state.snapshot).toEqual(current);
    expect(model.state.snapshot!.focusTopics[0].name).toBe('New dataset value');
    expect(model.state.pendingMutation).toBeNull();
  } finally { finish(); await saving; await other.close(); }
});
