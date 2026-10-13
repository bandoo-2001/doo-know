import { currentAgentConfig } from '../agent/config.js';
import { open, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { AppConfig } from '../../shared/contracts.js';
import type { NoteService } from '../notes.js';
import type {
  Principal,
  PatchInput,
  FileOperation,
  FileReply,
  PatchResult,
} from '../../shared/knowledge-contracts.js';
import { safePath } from '../files.js';
import { authorizePath } from '../agent/auth.js';
import { assertWritable, mutationCore, fsyncDirectory } from './core.js';
import { beginOperation, findOperation, releaseSnapshotRef } from './operations.js';
import { KnowledgeError, fail } from './errors.js';
import { limits } from './limits.js';
import { readBlocks, writeAll, hashFile } from './file-reader.js';
import { validateEdits, resolveEdits } from './file-patch.js';
import type { SnapshotService } from './snapshots.js';
export function fileJobService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  snapshots: SnapshotService,
) {
  let tail = Promise.resolve(),
    closing = false;
  const core = mutationCore(config, db);
  db.exec(
    'CREATE TABLE IF NOT EXISTS note_write_leases(note_id TEXT PRIMARY KEY,owner TEXT NOT NULL,lease_until INTEGER NOT NULL)',
  );
  function authorized(p: Principal, id: string) {
    const n = notes.row(id, true);
    authorizePath(p, n.path, 'knowledge:write');
    if (p.id !== 'web-owner') {
      const policy = currentAgentConfig(config)?.policies.find(
        (x) => x.id === p.id && x.clientId === p.clientId,
      );
      if (!policy) fail(403, 'FORBIDDEN');
      authorizePath(policy, n.path, 'knowledge:write');
    }
    return n;
  }
  function operation(p: Principal, id: string): FileOperation {
    const result = findOperation(db, p, { id }) as any,
      row = db.prepare('SELECT * FROM file_operations WHERE id=?').get(id) as any;
    if (!row) fail(404, 'OPERATION_NOT_FOUND');
    const n = notes.row(row.note_id, true);
    authorizePath(p, n.path, row.kind === 'patch' ? 'knowledge:write' : 'knowledge:read');
    return {
      ...result,
      kind: row.kind,
      ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
    };
  }
  async function run(p: Principal, id: string, input: PatchInput, opId: string) {
    const now = Date.now(),
      claimed = db
        .prepare(
          "UPDATE file_operations SET status='running',started_at=?,deadline=?,lease_until=?,lease_epoch=lease_epoch+1,worker_id=? WHERE id=? AND status='queued' AND deadline>?",
        )
        .run(now, now + 300000, now + 60000, 'file-worker', opId, now);
    if (!claimed.changes) {
      const expired = db
        .prepare(
          "UPDATE file_operations SET status='failed',error='TASK_DEADLINE' WHERE id=? AND status='queued' AND deadline<=?",
        )
        .run(opId, now);
      if (expired.changes) {
        db.prepare(
          "UPDATE operations SET status='failed',error='TASK_DEADLINE' WHERE id=? AND status='queued'",
        ).run(opId);
        releaseSnapshotRef(db, opId);
      }
      return;
    }
    const epoch = (
      db.prepare('SELECT lease_epoch FROM file_operations WHERE id=?').get(opId) as any
    ).lease_epoch;
    db.prepare("UPDATE operations SET status='running' WHERE id=?").run(opId);
    const signal = AbortSignal.timeout(300000);
    let temp: string | undefined,
      fd: Awaited<ReturnType<typeof open>> | undefined,
      history: Awaited<ReturnType<typeof open>> | undefined;
    const heartbeat = setInterval(() => {
      if (db.open)
        db.prepare(
          "UPDATE file_operations SET lease_until=? WHERE id=? AND lease_epoch=? AND status='running'",
        ).run(Date.now() + 60000, opId, epoch);
    }, 15000);
    heartbeat.unref();
    try {
      const n = authorized(p, id),
        payload = JSON.parse(
          (db.prepare('SELECT payload FROM file_operations WHERE id=?').get(opId) as any).payload,
        );
      let restoreFile: string | undefined;
      if (payload.restoreRevision) {
        const revision = db
          .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
          .get(payload.restoreRevision, id) as any;
        if (!revision || !/^[a-zA-Z0-9-]+\.md$/.test(revision.file))
          fail(404, 'REVISION_NOT_FOUND');
        restoreFile = join(config.dataRoot, 'history', revision.file);
        let ready = await snapshots.available(p, id, {});
        while ('operation' in ready) {
          signal.throwIfAborted();
          if (!['queued', 'running'].includes(ready.operation.status)) fail(409, 'SNAPSHOT_FAILED');
          await new Promise((resolve) => setTimeout(resolve, 50));
          ready = await snapshots.available(p, id, {});
        }
        if (ready.modified_at !== input.expectedModifiedAt) fail(409, 'VERSION_CONFLICT');
        input = {
          ...input,
          snapshotId: ready.id,
          expectedContentHash: ready.source_hash,
          edits: [
            {
              type: 'replace_range',
              startByte: 0,
              endByte: ready.size_bytes,
              expectedRangeHash: ready.source_hash,
              insert: '',
            },
          ],
        };
        db.transaction(() => {
          db.prepare(
            'UPDATE file_operations SET snapshot_id=?,payload=? WHERE id=? AND lease_epoch=?',
          ).run(ready.id, JSON.stringify({ ...payload, input }), opId, epoch);
          db.prepare('UPDATE read_snapshots SET refs=refs+1 WHERE id=?').run(ready.id);
        })();
      }
      const snapshot = await snapshots.check(p, id, input.snapshotId);
      assertWritable(db);
      if (
        snapshot.source_hash !== input.expectedContentHash ||
        snapshot.modified_at !== input.expectedModifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      const edits = restoreFile ? [] : await resolveEdits(snapshot, input.edits, signal),
        size = restoreFile
          ? Number((await stat(restoreFile)).size)
          : snapshot.size_bytes +
            edits.reduce((n, e) => n + e.insert.length - (e.end - e.start), 0);
      if (size > limits.file) fail(413, 'FILE_TOO_LARGE');
      const file = safePath(config.knowledgeRoot, n.path, 'note');
      temp = join(dirname(file), `.doo-${opId}-${epoch}.tmp`);
      fd = await open(temp, 'wx', Number((await stat(file)).mode) & 0o777);
      const hash = createHash('sha256');
      let written = 0;
      const write = async (bytes: Buffer) => {
        signal.throwIfAborted();
        const active = db
          .prepare('SELECT status,lease_epoch,lease_until,deadline FROM file_operations WHERE id=?')
          .get(opId) as any;
        if (active.deadline <= Date.now()) fail(504, 'TASK_DEADLINE');
        if (
          active.status !== 'running' ||
          active.lease_epoch !== epoch ||
          active.lease_until <= Date.now()
        )
          fail(409, 'TASK_CANCELLED');
        if (written + bytes.length > limits.file) fail(413, 'FILE_TOO_LARGE');
        await writeAll(fd!, bytes);
        hash.update(bytes);
        written += bytes.length;
      };
      let offset = 0;
      if (restoreFile) {
        for await (const bytes of readBlocks(restoreFile, 0, undefined, signal)) await write(bytes);
        offset = snapshot.size_bytes;
      }
      for (const e of edits) {
        for await (const bytes of readBlocks(snapshot.path, offset, e.start, signal))
          await write(bytes);
        await write(e.insert);
        offset = e.end;
      }
      for await (const bytes of readBlocks(snapshot.path, offset, undefined, signal))
        await write(bytes);
      await fd.sync();
      await fd.close();
      fd = undefined;
      const targetHash = hash.digest('hex');
      await mkdir(join(config.dataRoot, 'history'), { recursive: true, mode: 0o700 });
      history = await open(join(config.dataRoot, 'history', `${opId}-${epoch}.md`), 'wx', 0o600);
      for await (const bytes of readBlocks(snapshot.path, 0, undefined, signal))
        await writeAll(history, bytes);
      await history.sync();
      await history.close();
      history = undefined;
      db.transaction(() => {
        const lock = db
          .prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?')
          .get(id) as any;
        if (lock && lock.owner !== `${opId}:${epoch}` && lock.lease_until > Date.now())
          fail(409, 'OPERATION_IN_PROGRESS');
        db.prepare(
          'INSERT INTO note_write_leases VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until',
        ).run(id, `${opId}:${epoch}`, Date.now() + 60000);
      })();
      authorized(p, id);
      assertWritable(db);
      await snapshots.check(p, id, input.snapshotId);
      if ((await hashFile(file, signal)) !== input.expectedContentHash)
        fail(409, 'VERSION_CONFLICT');
      if (
        (
          await stat(safePath(config.knowledgeRoot, n.path, 'note'), { bigint: true })
        ).mtimeNs.toString() !== input.expectedModifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      db.transaction(() => {
        const job = db.prepare('SELECT * FROM file_operations WHERE id=?').get(opId) as any;
        if (job.deadline <= Date.now()) fail(504, 'TASK_DEADLINE');
        if (
          job.status !== 'running' ||
          job.lease_epoch !== epoch ||
          job.lease_until <= Date.now() ||
          job.deadline <= Date.now()
        )
          fail(409, 'TASK_CANCELLED');
        db.prepare(
          'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,temp_path,revision_id,history_file) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          opId,
          id,
          n.path,
          'patch',
          input.expectedContentHash,
          input.expectedModifiedAt,
          targetHash,
          temp,
          opId,
          `${opId}-${epoch}.md`,
        );
        db.prepare("UPDATE file_operations SET status='committing' WHERE id=?").run(opId);
        db.prepare("UPDATE operations SET status='committing' WHERE id=?").run(opId);
      })();
      await rename(temp, file);
      temp = undefined;
      fsyncDirectory(dirname(file));
      const result = core.record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(opId) as any,
      ) as any;
      result.editCount = restoreFile ? 1 : edits.length;
      db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), opId);
      db.prepare("UPDATE file_operations SET status='succeeded' WHERE id=?").run(opId);
    } catch (e) {
      const ownership = db
        .prepare('SELECT lease_epoch FROM file_operations WHERE id=?')
        .get(opId) as any;
      if (ownership?.lease_epoch !== epoch) return;
      const op = db.prepare('SELECT status FROM operations WHERE id=?').get(opId) as any;
      const code =
        e instanceof KnowledgeError
          ? e.code
          : (e as NodeJS.ErrnoException).code === 'ENOSPC'
            ? 'INSUFFICIENT_STORAGE'
            : signal.aborted
              ? 'TASK_DEADLINE'
              : 'PATCH_FAILED';
      const status =
        op.status === 'cancelled'
          ? 'cancelled'
          : op.status === 'committing'
            ? 'needs_reconciliation'
            : 'failed';
      db.prepare('UPDATE operations SET status=?,error=? WHERE id=?').run(status, code, opId);
      db.prepare('UPDATE file_operations SET status=?,error=? WHERE id=?').run(status, code, opId);
    } finally {
      clearInterval(heartbeat);
      await fd?.close();
      await history?.close();
      const op = db.prepare('SELECT status FROM operations WHERE id=?').get(opId) as any;
      const ownership = db
        .prepare('SELECT lease_epoch FROM file_operations WHERE id=?')
        .get(opId) as any;
      if (temp && ownership?.lease_epoch !== epoch) await unlink(temp).catch(() => {});
      if (
        ownership?.lease_epoch === epoch &&
        !['committing', 'needs_reconciliation'].includes(op.status)
      ) {
        if (temp) await unlink(temp).catch(() => {});
        releaseSnapshotRef(db, opId);
      }
      db.prepare('DELETE FROM note_write_leases WHERE note_id=? AND owner=?').run(
        id,
        `${opId}:${epoch}`,
      );
    }
  }
  async function submit(
    p: Principal,
    id: string,
    input: PatchInput,
    channel: 'mcp' | 'web' = 'mcp',
  ): Promise<FileReply<PatchResult>> {
    const n = authorized(p, id);
    assertWritable(db);
    validateEdits(input?.edits, channel === 'mcp' ? 32768 : 128 * 1024);
    const { requestId, ...params } = input;
    const op = beginOperation(db, p, 'patch', requestId, { id, ...params });
    if (!op.fresh) return { kind: 'accepted', operation: operation(p, op.operation.id) };
    try {
      const snapshot = await snapshots.check(p, id, input.snapshotId);
      if (
        snapshot.source_hash !== input.expectedContentHash ||
        snapshot.modified_at !== input.expectedModifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      if (snapshot.size_bytes <= limits.ordinary) await resolveEdits(snapshot, input.edits);
      db.transaction(() => {
        db.prepare(
          'INSERT INTO file_operations(id,note_id,kind,status,snapshot_id,payload,created_at,deadline) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          op.operation.id,
          id,
          'patch',
          'queued',
          snapshot.id,
          JSON.stringify({ input, principal: p }),
          Date.now(),
          Date.now() + 300000,
        );
        db.prepare(
          'UPDATE read_snapshots SET refs=refs+1,expires_at=max(expires_at,?) WHERE id=?',
        ).run(Date.now() + 600000, snapshot.id);
        db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(op.operation.id);
      })();
      if (!closing && config.fileTasks?.embedded !== false)
        tail = tail.then(() => run(p, id, input, op.operation.id));
      return { kind: 'accepted', operation: operation(p, op.operation.id) };
    } catch (e) {
      db.prepare("UPDATE operations SET status='failed',error=? WHERE id=?").run(
        e instanceof KnowledgeError ? e.code : 'INVALID_PATCH',
        op.operation.id,
      );
      throw e;
    }
  }
  function cancel(p: Principal, id: string) {
    const op = operation(p, id);
    if (['committing', 'needs_reconciliation'].includes(op.status))
      fail(409, 'OPERATION_COMMITTING', '提交开始后请查询最终结果');
    db.transaction(() => {
      const wasQueued = op.status === 'queued';
      db.prepare(
        "UPDATE file_operations SET status='cancelled' WHERE id=? AND status IN ('queued','running')",
      ).run(id);
      db.prepare(
        "UPDATE operations SET status='cancelled' WHERE id=? AND status IN ('queued','running')",
      ).run(id);
      if (wasQueued) releaseSnapshotRef(db, id);
    })();
    return operation(p, id);
  }
  async function restore(
    p: Principal,
    id: string,
    revisionId: string,
    expectedModifiedAt: string,
    requestId: string,
  ): Promise<FileReply<PatchResult>> {
    authorized(p, id);
    assertWritable(db);
    if (typeof expectedModifiedAt !== 'string' || !/^\d+$/.test(expectedModifiedAt))
      fail(400, 'INVALID_VERSION');
    const revision = db
      .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
      .get(revisionId, id) as any;
    if (!revision) fail(404, 'REVISION_NOT_FOUND');
    const op = beginOperation(db, p, 'restore_revision', requestId, {
      id,
      revisionId,
      expectedModifiedAt,
    });
    if (!op.fresh) return { kind: 'accepted', operation: operation(p, op.operation.id) };
    const input: PatchInput = {
      snapshotId: '',
      expectedModifiedAt,
      expectedContentHash: '',
      requestId,
      edits: [],
    };
    db.prepare(
      'INSERT INTO file_operations(id,note_id,kind,status,payload,created_at,deadline) VALUES(?,?,?,?,?,?,?)',
    ).run(
      op.operation.id,
      id,
      'patch',
      'queued',
      JSON.stringify({ input, principal: p, restoreRevision: revisionId }),
      Date.now(),
      Date.now() + 300000,
    );
    db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(op.operation.id);
    if (!closing && config.fileTasks?.embedded !== false)
      tail = tail.then(() => run(p, id, input, op.operation.id));
    return { kind: 'accepted', operation: operation(p, op.operation.id) };
  }
  async function drain() {
    await tail;
  }
  async function close() {
    closing = true;
    await tail;
  }
  async function recover() {
    db.prepare(
      "UPDATE file_operations SET status=(SELECT status FROM operations WHERE operations.id=file_operations.id) WHERE kind='patch' AND (SELECT status FROM operations WHERE operations.id=file_operations.id) IN ('succeeded','failed','cancelled')",
    ).run();
    for (const row of db
      .prepare(
        "SELECT id FROM file_operations WHERE kind='patch' AND status IN ('succeeded','failed','cancelled') AND snapshot_ref_released=0",
      )
      .all() as { id: string }[])
      releaseSnapshotRef(db, row.id);
    db.prepare(
      "UPDATE file_operations SET status='queued',lease_epoch=lease_epoch+1 WHERE kind='patch' AND status='running' AND lease_until<=? AND NOT EXISTS(SELECT 1 FROM write_intents WHERE write_intents.id=file_operations.id)",
    ).run(Date.now());
    db.prepare(
      "UPDATE operations SET status='queued' WHERE id IN (SELECT id FROM file_operations WHERE kind='patch' AND status='queued')",
    ).run();
    if (config.fileTasks?.embedded === false) return;
    for (const row of db
      .prepare(
        "SELECT * FROM file_operations WHERE kind='patch' AND status='queued' ORDER BY created_at",
      )
      .all() as any[]) {
      const payload = JSON.parse(row.payload);
      tail = tail.then(() => run(payload.principal, row.note_id, payload.input, row.id));
    }
  }
  return { submit, operation, cancel, close, recover, restore, drain };
}
