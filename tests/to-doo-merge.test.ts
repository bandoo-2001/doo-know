import { afterEach, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import type { AppConfig } from '../shared/contracts';

const enumerationOrders = vi.hoisted(() => new Map<string, string[]>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      const entries = Reflect.apply(actual.readdirSync, actual, args),
        ids = enumerationOrders.get(String(args[0]));
      if (!ids || !Array.isArray(entries)) return entries;
      const rank = new Map(ids.map((id, index) => [id + '.json', index]));
      const name = (entry: string | Buffer | { name: string | Buffer }) =>
        typeof entry === 'string'
          ? entry
          : Buffer.isBuffer(entry)
            ? entry.toString()
            : String(entry.name);
      return [...entries].sort((left, right) => {
        const a = name(left),
          b = name(right);
        return (rank.get(a) ?? ids.length) - (rank.get(b) ?? ids.length) || a.localeCompare(b);
      });
    }) as typeof actual.readdirSync,
  };
});

const roots: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
const services: ReturnType<typeof createToDooService>[] = [];
afterEach(async () => {
  enumerationOrders.clear();
  for (const service of services.splice(0)) service.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function bind(config: AppConfig) {
  const db = openDatabase(config.dataRoot);
  databases.push(db);
  const service = createToDooService(config, db, noteService(config, db));
  services.push(service);
  return service;
}

/**
 * Directory enumeration order is unspecified. Reorder only the actual Dirents
 * returned for this transaction directory, without faking files or business data.
 * This makes the UUID-order permutations bounded and reproducible.
 */
function enumerateTransactions(directory: string, ids: string[]) {
  enumerationOrders.set(directory, ids);
  return () => enumerationOrders.delete(directory);
}

it.each([
  ['dependent transaction enumerated before its other-branch version', ['a', 'c', 'b']],
  ['both independent branches enumerated before the successor', ['a', 'b', 'c']],
  ['the other branch enumerated first', ['b', 'a', 'c']],
] as const)('preserves a file-merged branch and subsequent migration: %s', async (_name, order) => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-merge-'));
  roots.push(root);
  const config = (name: string): AppConfig => ({
    knowledgeRoot: join(root, name, 'knowledge'),
    dataRoot: join(root, name, 'data'),
    origin: 'http://localhost:3010',
    secret: 'merge-fixture-only-secret',
  });
  const baselineConfig = config('baseline');
  await mkdir(baselineConfig.knowledgeRoot, { recursive: true });
  const baseline = bind(baselineConfig);
  const first = baseline.command({
    requestId: 'baseline-task-one',
    action: 'create_task',
    payload: { title: 'Task one' },
  }).ids[0];
  const second = baseline.command({
    requestId: 'baseline-task-two',
    action: 'create_task',
    payload: { title: 'Task two' },
  }).ids[0];
  const common = (baseline.exportCheckpoint().transactions as { id: string }[]).map((t) => t.id);
  baseline.close();

  const aConfig = config('a'),
    bConfig = config('b');
  await cp(baselineConfig.knowledgeRoot, aConfig.knowledgeRoot, { recursive: true });
  await cp(baselineConfig.knowledgeRoot, bConfig.knowledgeRoot, { recursive: true });
  const a = bind(aConfig),
    b = bind(bConfig);
  const aRequest = {
    requestId: 'branch-a-task-one',
    action: 'update_task',
    payload: {
      id: first,
      expectedRevision: a.getEntity('task', first)!.revision,
      patch: { title: 'Task one from A' },
    },
  };
  const bRequest = {
    requestId: 'branch-b-task-two',
    action: 'update_task',
    payload: {
      id: second,
      expectedRevision: b.getEntity('task', second)!.revision,
      patch: { title: 'Task two from B' },
    },
  };
  const aResult = a.command(aRequest),
    bResult = b.command(bRequest);
  a.close();
  b.close();

  // A correct file-level Git merge: unchanged common files, A's first task,
  // B's second task, and both distinct immutable transaction markers.
  const cConfig = config('c');
  await cp(baselineConfig.knowledgeRoot, cConfig.knowledgeRoot, { recursive: true });
  const portable = '_data/apps/to-doo';
  await cp(
    join(aConfig.knowledgeRoot, portable, 'tasks', first + '.json'),
    join(cConfig.knowledgeRoot, portable, 'tasks', first + '.json'),
  );
  await cp(
    join(bConfig.knowledgeRoot, portable, 'tasks', second + '.json'),
    join(cConfig.knowledgeRoot, portable, 'tasks', second + '.json'),
  );
  for (const [source, id] of [
    [aConfig, aResult.transactionId!],
    [bConfig, bResult.transactionId!],
  ] as const)
    await cp(
      join(source.knowledgeRoot, portable, 'transactions', id + '.json'),
      join(cConfig.knowledgeRoot, portable, 'transactions', id + '.json'),
    );

  // Restore B then A, so the selected global head is A although task two's
  // latest entity version came from B. Both are valid, independent edits.
  const cOrder = enumerateTransactions(join(cConfig.knowledgeRoot, portable, 'transactions'), [
    ...common,
    bResult.transactionId!,
    aResult.transactionId!,
  ]);
  const c = bind(cConfig);
  expect(c.getEntity('task', first)).toMatchObject({ title: 'Task one from A' });
  expect(c.getEntity('task', second)).toMatchObject({ title: 'Task two from B' });
  expect(c.command(aRequest).replayed).toBe(true);
  expect(c.command(bRequest).replayed).toBe(true);
  const cRequest = {
    requestId: 'merged-c-task-two',
    action: 'update_task',
    payload: {
      id: second,
      expectedRevision: c.getEntity('task', second)!.revision,
      patch: { title: 'Task two after merge' },
    },
  };
  const cResult = c.command(cRequest);
  expect(
    c.exportCheckpoint().entities.find((e) => e.kind === 'task' && e.entity.id === second)?.entity,
  ).toMatchObject({ title: 'Task two after merge' });
  const transaction = JSON.parse(
    await readFile(
      join(cConfig.knowledgeRoot, portable, 'transactions', cResult.transactionId! + '.json'),
      'utf8',
    ),
  );
  // Retain diagnostic context without requiring any particular future protocol
  // representation: the user-visible replay below is the actual contract.
  const replayContext = JSON.stringify({
    order,
    parentId: transaction.parentId,
    members: transaction.members.map((m: { id: string; fromRevision: string | null }) => ({
      id: m.id,
      fromRevision: m.fromRevision,
    })),
  });
  c.close();
  cOrder();

  const dConfig = config('d');
  await cp(cConfig.knowledgeRoot, dConfig.knowledgeRoot, { recursive: true });
  const ids = { a: aResult.transactionId!, b: bResult.transactionId!, c: cResult.transactionId! };
  const dOrder = enumerateTransactions(join(dConfig.knowledgeRoot, portable, 'transactions'), [
    ...common,
    ...order.map((key) => ids[key]),
  ]);
  let d: ReturnType<typeof createToDooService> | undefined;
  expect(() => {
    d = bind(dConfig);
  }, replayContext).not.toThrow();
  expect(d!.getEntity('task', first)).toMatchObject({ title: 'Task one from A' });
  expect(d!.getEntity('task', second)).toMatchObject({ title: 'Task two after merge' });
  expect(d!.command(aRequest).replayed).toBe(true);
  expect(d!.command(bRequest).replayed).toBe(true);
  expect(d!.command(cRequest).replayed).toBe(true);
  expect(d!.snapshot().tasks).toHaveLength(2);
  d!.close();
  dOrder();
});
