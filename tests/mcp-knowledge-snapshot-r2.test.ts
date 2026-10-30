import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { snapshotService } from '../packages/core/knowledge/snapshots.js';
import { hostClient } from '../plugins/mcp/server/service.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await pluginRuntimeFixture();
  closes.push(f.close);
  await writeFile(
    join(f.config.knowledgeRoot, '00-Inbox/concurrent.md'),
    'x'.repeat(12 * 1024 * 1024) + '\nsecond line\n',
  );
  f.platform.get().notes.scan();
  const note = f.db
    .prepare("SELECT id FROM notes WHERE path='00-Inbox/concurrent.md' AND active=1")
    .get() as { id: string };
  const k = f.platform.get().knowledge,
    db2 = openDatabase(f.config.dataRoot),
    other = snapshotService(
      f.platform.get().config,
      db2,
      noteService(f.platform.get().config, db2),
    );
  closes.push(async () => {
    await other.close();
    db2.close();
  });
  return { ...f, note, k, other };
}

it('R2 isolates a same-note export snapshot from an ordinary 12-MiB range reader before cleanup', async () => {
  const f = await fixture(),
    jobId = randomUUID();
  const accepted = await f.k.snapshots.available(f.principal, f.note.id, {}, jobId);
  expect(accepted).toHaveProperty('operation');
  await f.k.snapshots.drain();
  if (!('operation' in accepted)) throw Error('expected export preparation');
  const exportId = f.k.snapshots.operation(accepted.operation.operationId).snapshotId!;
  const reader = f.k.snapshots
    .read(f.principal, f.note.id, { range: { startLine: 2, endLine: 2 } })
    .then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  await new Promise((r) => setTimeout(r, 10));
  await f.other.releaseExport(f.principal, f.note.id, exportId, jobId);
  let outcome: any = await reader;
  expect(outcome.error).toBeUndefined();
  if (outcome.result.kind === 'accepted') {
    await f.k.snapshots.drain();
    outcome = {
      result: await f.k.snapshots.read(f.principal, f.note.id, {
        range: { startLine: 2, endLine: 2 },
      }),
    };
  }
  expect(outcome.result).toMatchObject({ kind: 'ready', data: { content: 'second line\n' } });
  expect(outcome.result.data.snapshotId).not.toBe(exportId);
  expect(f.db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(exportId)).toBeUndefined();
});

it('R2 does not reuse export preparation or explicit export IDs in ordinary read and outline workflows', async () => {
  const f = await fixture(),
    jobId = randomUUID();
  const exported = await f.k.snapshots.available(f.principal, f.note.id, {}, jobId);
  if (!('operation' in exported)) throw Error('expected export preparation');
  const ordinary = await f.k.snapshots.outline(f.principal, f.note.id);
  expect(ordinary.kind).toBe('accepted');
  if (ordinary.kind !== 'accepted') throw Error('expected ordinary preparation');
  expect(ordinary.operation.operationId).not.toBe(exported.operation.operationId);
  await f.k.snapshots.drain();
  const exportId = f.k.snapshots.operation(exported.operation.operationId).snapshotId!;
  await expect(
    f.k.snapshots.read(f.principal, f.note.id, { snapshotId: exportId }),
  ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
  expect(await f.k.snapshots.check(f.principal, f.note.id, exportId, jobId)).toMatchObject({
    id: exportId,
  });
  const outline: any = await f.k.snapshots.outline(f.principal, f.note.id);
  expect(outline).toMatchObject({ kind: 'ready' });
  expect(outline.data.snapshotId).not.toBe(exportId);
});

it('R2 keeps the ordinary reader safe after host cancellation while a second DB connection releases export staging', async () => {
  const f = await fixture(),
    jobId = randomUUID();
  await f.k.snapshots.prepare(f.principal, f.note.id, 'ordinary-' + randomUUID());
  await f.k.snapshots.drain();
  const exported = await f.k.snapshots.prepare(
    f.principal,
    f.note.id,
    'mcp-export-' + jobId + ':' + randomUUID(),
    jobId,
  );
  await f.k.snapshots.drain();
  const exportId = f.k.snapshots.operation(exported.operationId).snapshotId!;
  const controller = new AbortController(),
    tasks: Promise<unknown>[] = [];
  const client = hostClient(
    () => f.services,
    () => ({}),
    (task) => {
      tasks.push(task);
      return task;
    },
  );
  const cancelled = client
    .readPage(
      f.principal,
      { noteId: f.note.id, range: { startLine: 2, endLine: 2 } },
      { signal: controller.signal },
    )
    .catch((error) => error);
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  expect(await cancelled).toMatchObject({ code: 'CALL_CANCELLED' });
  await f.other.releaseExport(f.principal, f.note.id, exportId, jobId);
  const results: any[] = await Promise.all(tasks);
  expect(results[0]).toMatchObject({ kind: 'ready', data: { content: 'second line\n' } });
  expect(results[0].data.snapshotId).not.toBe(exportId);
  expect(f.db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(exportId)).toBeUndefined();
  expect((f.db.prepare('SELECT count(*) n FROM read_leases').get() as any).n).toBe(0);
});
