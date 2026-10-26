import type { AppDatabase } from '../db.js';
import {
  operationHasLiveWorkspaceWriter,
  workspaceOperation,
  workspacePermit,
} from '../workspace/gate.js';
import { fail } from './errors.js';

function initialize(db: AppDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS note_write_leases(note_id TEXT PRIMARY KEY,owner TEXT NOT NULL,lease_until INTEGER NOT NULL)',
  );
}
function leaseIsActive(
  db: AppDatabase,
  lease: { owner: string; lease_until: number },
  excludedToken?: string,
) {
  const operationId = lease.owner.split(':')[0];
  // A paused synchronous writer cannot heartbeat. Process identity, not elapsed
  // time, determines whether its filesystem commit can still resume.
  if (operationHasLiveWorkspaceWriter(db, operationId, excludedToken)) return true;
  const operation = db.prepare('SELECT status FROM operations WHERE id=?').get(operationId) as
    | { status: string }
    | undefined;
  return (
    lease.lease_until > Date.now() &&
    !['succeeded', 'failed', 'cancelled'].includes(operation?.status || '')
  );
}
export function assertWritable(
  db: AppDatabase,
  noteId?: string,
  ownIntent?: string,
  owner?: string,
) {
  if (
    (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
    db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
  )
    fail(503, 'SYNC_IN_PROGRESS', '工作区维护中', true);
  if (
    noteId &&
    db
      .prepare(
        "SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted') AND id<>?",
      )
      .get(noteId, ownIntent || '')
  )
    fail(409, 'OPERATION_OUTCOME_UNKNOWN', '请先核对未完成的写入', true);
  if (noteId && db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'").get()) {
    const lease = db
      .prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?')
      .get(noteId) as { owner: string; lease_until: number } | undefined;
    if (lease && lease.owner !== owner && leaseIsActive(db, lease))
      fail(409, 'OPERATION_IN_PROGRESS');
  }
}

// owner is the operation UUID, optionally followed by a worker epoch/recovery
// token. The immediate transaction makes intent checks and ownership indivisible.
export function acquireNoteWrite(
  db: AppDatabase,
  noteId: string,
  owner: string,
  ownIntent?: string,
) {
  initialize(db);
  db.transaction(() => {
    const lease = db
      .prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?')
      .get(noteId) as { owner: string; lease_until: number } | undefined;
    // Retry has already bound its own workspace gate to the operation. Exclude
    // only that gate; another live original/retry still owns publication.
    const ownGate = workspacePermit(db, false);
    if (lease) {
      const operationId = lease.owner.split(':')[0];
      const live = operationHasLiveWorkspaceWriter(db, operationId, ownGate);
      const abandonedRetry = ownIntent === operationId && !live;
      if (live || (!abandonedRetry && leaseIsActive(db, lease, ownGate)))
        fail(409, 'OPERATION_IN_PROGRESS');
    }
    assertWritable(db, noteId, ownIntent, lease?.owner);
    db.prepare(
      'INSERT INTO note_write_leases VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until',
    ).run(noteId, owner, Date.now() + 60000);
    workspaceOperation(db, owner.split(':')[0]);
  }).immediate();
}
export function releaseNoteWrite(db: AppDatabase, noteId: string, owner: string) {
  db.prepare('DELETE FROM note_write_leases WHERE note_id=? AND owner=?').run(noteId, owner);
}
