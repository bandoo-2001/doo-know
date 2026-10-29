import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';

let root: string;
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-search-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'search-fixture',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
});

afterEach(async () => {
  service?.close();
  if (db?.open) db.close();
  await rm(root, { recursive: true, force: true });
});

const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const save = (kind: string, entity: Record<string, unknown>) =>
  command('save_entity', { kind, entity }).ids[0]!;
const dateRange = { from: '2026-10-29', to: '2026-10-29' };

function task(title: string, extra: Record<string, unknown> = {}) {
  const id = command('create_task', { title, ...extra }).ids[0]!;
  const occurrence = service.snapshot({ taskIds: [id] }).occurrences[0]!;
  const blockId = save('timeBlock', {
    occurrenceId: occurrence.id,
    title: '工作时段',
    start: { date: '2026-10-29', time: '10:00', timeZone: 'UTC' },
  });
  return { id, occurrenceId: occurrence.id, blockId };
}

it('keeps matching tasks usable with their occurrences, blocks and navigation metadata', () => {
  const listId = save('list', { name: '工作清单' });
  const otherList = save('list', { name: '其他清单' });
  const sectionId = save('section', { name: '下一步', listId });
  const tagId = save('tag', { name: '工作' });
  const savedView = save('view', { name: '我的视图', filter: {} });
  const match = task('季度发布确认', { listId, sectionId, tagIds: [tagId] });
  task('无关任务', { listId: otherList });

  const state = service.snapshot({ ...dateRange, filter: { query: '季度发布确认' } });
  expect(state.tasks.map((item) => item.id)).toEqual([match.id]);
  expect(state.occurrences.map((item) => item.id)).toEqual([match.occurrenceId]);
  expect(state.timeBlocks.map((item) => item.id)).toEqual([match.blockId]);
  expect(state.lists.map((item) => item.id)).toEqual([listId, otherList]);
  expect(state.sections.map((item) => item.id)).toEqual([sectionId]);
  expect(state.tags.map((item) => item.id)).toEqual([tagId]);
  expect(state.views.map((item) => item.id)).toEqual([savedView]);
});

it.each(['description', 'criteria'] as const)(
  'finds a task and its execution context from its %s text',
  (field) => {
    const query = '可检索的独有内容';
    const match = task('普通任务', { [field]: query });
    task('无关任务');
    const state = service.snapshot({ ...dateRange, filter: { query } });
    expect(state.tasks.map((item) => item.id)).toEqual([match.id]);
    expect(state.occurrences.map((item) => item.id)).toEqual([match.occurrenceId]);
    expect(state.timeBlocks.map((item) => item.id)).toEqual([match.blockId]);
  },
);

it('finds a task and its context through a live occurrence title override', () => {
  const match = task('普通系列标题');
  const occurrence = service.snapshot({ taskIds: [match.id] }).occurrences[0]!;
  command('save_entity', {
    kind: 'occurrence',
    entity: { ...occurrence, titleOverride: '本次专属标题' },
    expectedRevision: occurrence.revision,
  });
  const state = service.snapshot({ ...dateRange, filter: { query: '本次专属标题' } });
  expect(state.tasks.map((item) => item.id)).toEqual([match.id]);
  expect(state.occurrences.map((item) => item.id)).toEqual([match.occurrenceId]);
  expect(state.timeBlocks.map((item) => item.id)).toEqual([match.blockId]);
});

it.each(['record', 'outcome'] as const)(
  'does not infer a task match from private %s content',
  (kind) => {
    const listId = save('list', { name: 'Task scope' });
    const privateListId = save('list', { name: 'Private content scope' });
    const match = task('Ordinary task', { listId });
    const query = 'PRIVATE_KEYWORD_42';
    const id = save(
      kind,
      kind === 'record'
        ? {
            taskId: match.id,
            listId: privateListId,
            content: query,
            occurredAt: '2026-10-29T10:00:00Z',
          }
        : { occurrenceId: match.occurrenceId, listId: privateListId, summary: query },
    );
    for (const listIds of [undefined, [listId]]) {
      const state = service.snapshot({ kind: 'task', listIds, filter: { query } });
      expect(state.tasks).toHaveLength(0);
      expect(state.page.total).toBe(0);
    }
    const state = service.snapshot({ ...dateRange, filter: { query } });
    expect(state.tasks).toHaveLength(0);
    expect(state.occurrences).toHaveLength(0);
    expect(state.timeBlocks).toHaveLength(0);
    const own = service.snapshot({ kind, filter: { query } });
    expect((kind === 'record' ? own.records : own.outcomes).map((item) => item.id)).toEqual([id]);
  },
);

it('treats wildcard characters, backslashes and SQL text as literal search input', () => {
  const match = task('100%_ ready\\draft');
  task('100xx ready draft');
  for (const query of ['%_', '\\draft', '100%_ ready\\draft']) {
    const state = service.snapshot({ ...dateRange, filter: { query } });
    expect(
      state.tasks.map((item) => item.id),
      query,
    ).toEqual([match.id]);
    expect(
      state.occurrences.map((item) => item.id),
      query,
    ).toEqual([match.occurrenceId]);
  }
  expect(service.snapshot({ filter: { query: "' OR 1=1 --" } }).tasks).toHaveLength(0);
  expect(service.snapshot().tasks).toHaveLength(2);
});

it('keeps pagination and list scope when related task content matches the query', () => {
  const listId = save('list', { name: '允许的清单' });
  const otherList = save('list', { name: '范围外的清单' });
  const allowed = [task('Shared keyword A', { listId }), task('Shared keyword B', { listId })];
  task('Shared keyword outside', { listId: otherList });
  const query = { ...dateRange, listIds: [listId], filter: { query: 'Shared keyword' }, limit: 1 };
  const first = service.snapshot(query);
  const second = service.snapshot({ ...query, cursor: first.page.nextCursor! });
  expect(first.page.total).toBe(2);
  expect(first.tasks.map((item) => item.id)).toEqual([allowed[0]!.id]);
  expect(second.tasks.map((item) => item.id)).toEqual([allowed[1]!.id]);
  expect(second.page.nextCursor).toBeNull();
  expect(first.lists.map((item) => item.id)).toEqual([listId]);
  expect(first.occurrences.map((item) => item.id)).toEqual(
    allowed.map((item) => item.occurrenceId),
  );
  expect(first.timeBlocks.map((item) => item.id)).toEqual([allowed[0]!.blockId]);

  const occurrences = service.snapshot({ ...query, kind: 'occurrence' });
  const more = service.snapshot({
    ...query,
    kind: 'occurrence',
    cursor: occurrences.page.nextCursor!,
  });
  expect(occurrences.page.total).toBe(2);
  expect(occurrences.occurrences.map((item) => item.id)).toEqual([allowed[0]!.occurrenceId]);
  expect(more.occurrences.map((item) => item.id)).toEqual([allowed[1]!.occurrenceId]);
  expect(more.page.nextCursor).toBeNull();
});
