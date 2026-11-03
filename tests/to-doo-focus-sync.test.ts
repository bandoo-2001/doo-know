import { reconcileFocusHistory } from '../apps/web/to-doo-focus-history-sync';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { createToDooInterop } from '../packages/core/to-doo/interop';

let root: string;
let config: { knowledgeRoot: string; dataRoot: string; origin: string; secret: string };
let db: ReturnType<typeof openDatabase>;
let service: ReturnType<typeof createToDooService>;
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const save = (kind: string, entity: Record<string, unknown>, expectedRevision?: string) =>
  command('save_entity', { kind, entity, expectedRevision });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  root = await mkdtemp(join(tmpdir(), 'to-doo-focus-history-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'focus-history-fixture-only',
  };
  await mkdir(config.knowledgeRoot);
  db = openDatabase(config.dataRoot);
  service = createToDooService(config, db, noteService(config, db));
});
afterEach(async () => {
  service?.close();
  if (db?.open) db.close();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const seed = (count: number, prefix = 'old', offset = 0) => {
  for (let index = 0; index < count; index++)
    save('focusSession', {
      id: `${prefix}-${index}`,
      mode: 'stopwatch',
      status: 'finished',
      segments: [
        {
          start: new Date(
            Date.parse('2026-10-01T08:00:00Z') + (index + offset) * 60000,
          ).toISOString(),
          end: new Date(
            Date.parse('2026-10-01T08:00:00Z') + (index + offset + 1) * 60000,
          ).toISOString(),
        },
      ],
    });
};

it('bounded reconciliation preserves an old keyset cursor until its range is proven and resumes without losing records', async () => {
  seed(120);
  const old = service.focusHistory({ limit: 50 });
  const second = service.focusHistory({ limit: 50, cursor: old.page.nextCursor! });
  old.items.push(...second.items);
  old.page = second.page;
  const tailCursor = old.page.nextCursor;
  seed(125, 'new', 200);
  const head = service.focusHistory({ limit: 50 });
  const read = vi.fn(async (cursor: string) => service.focusHistory({ limit: 50, cursor }));
  const partial = await reconcileFocusHistory(old, head, read, undefined, 2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(partial.pending).toBeDefined();
  expect(partial.history.items).toHaveLength(200);
  expect(partial.history.items.some((row) => row.id === 'old-20')).toBe(true);
  expect(partial.history.page.nextCursor).toBe(tailCursor);
  const result = await reconcileFocusHistory(partial.history, head, read, partial.pending, 4);
  expect(result.pending).toBeUndefined();
  expect(result.history.items).toHaveLength(245);
  expect(result.history.page.hasMore).toBe(false);
  expect(new Set(result.history.items.map((row) => row.id)).size).toBe(245);
  expect(result.history.items[0].id).toBe('new-124');
});

it('a complete loaded list scans to EOF to find backdated insertions and removes deleted or moved rows', async () => {
  seed(65);
  const old = service.focusHistory({ limit: 50 });
  const second = service.focusHistory({ limit: 50, cursor: old.page.nextCursor! });
  old.items.push(...second.items);
  old.page = second.page;
  save('focusSession', {
    id: 'backdated',
    mode: 'stopwatch',
    status: 'finished',
    segments: [{ start: '2020-01-01T00:00:00Z', end: '2020-01-01T00:01:00Z' }],
  });
  const deleted = service.getEntity('focusSession', 'old-12')!;
  save('focusSession', { ...deleted, deletedAt: '2026-10-30T12:00:00Z' }, deleted.revision);
  const head = service.focusHistory({ limit: 50 });
  const result = await reconcileFocusHistory(old, head, async (cursor) =>
    service.focusHistory({ limit: 50, cursor }),
  );
  expect(result.history.items).toHaveLength(65);
  expect(result.history.items.at(-1)?.id).toBe('backdated');
  expect(result.history.items.some((row) => row.id === 'old-12')).toBe(false);
});

it.each(['dataset', 'revision'])(
  'rejects a %s change during a multi-page scan without mutating the loaded list',
  async (field) => {
    seed(70);
    const old = service.focusHistory({ limit: 50 });
    const originalIds = old.items.map((row) => row.id);
    seed(51, 'new', 200);
    const head = service.focusHistory({ limit: 50 });
    await expect(
      reconcileFocusHistory(old, head, async (cursor) => ({
        ...service.focusHistory({ limit: 50, cursor }),
        [field === 'dataset' ? 'datasetId' : 'revision']: 'different',
      })),
    ).rejects.toThrow('正在更新');
    expect(old.items.map((row) => row.id)).toEqual(originalIds);
  },
);

it('rebinds loaded-tail cursors after trend query changes even at the same revision', async () => {
  seed(120);
  const old = service.focusHistory({ limit: 50 });
  const second = service.focusHistory({ limit: 50, cursor: old.page.nextCursor! });
  old.items.push(...second.items);
  old.page = second.page;
  const head = service.focusHistory({ limit: 50, trendPeriod: 'month' });
  const result = await reconcileFocusHistory(
    old,
    head,
    async (cursor) => service.focusHistory({ limit: 50, trendPeriod: 'month', cursor }),
    undefined,
    20,
    true,
  );
  expect(result.history.items).toHaveLength(100);
  const next = service.focusHistory({
    limit: 50,
    trendPeriod: 'month',
    cursor: result.history.page.nextCursor!,
  });
  expect(next.items).toHaveLength(20);
});
