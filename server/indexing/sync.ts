import { workspaceExec } from '../workspace/exec.js';
import {
  workspaceExclusive,
  operationHasLiveWorkspaceWriter,
  workspaceOperation,
} from '../workspace/gate.js';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { reconcileService } from './reconcile.js';
import { git, gitState } from './git-state.js';
import { KnowledgeError, fail } from '../knowledge/errors.js';
export function syncService(
  config: AppConfig,
  db: AppDatabase,
  indexing: ReturnType<typeof reconcileService>,
) {
  const owner = `local-sync:${process.pid}:${randomUUID()}`;
  async function recover() {
    const expired = db
      .prepare(
        "SELECT id FROM sync_runs WHERE status IN ('running','needs_reconciliation') AND lease_until<=?",
      )
      .all(Date.now()) as { id: string }[];
    const recoverable = expired.filter((run) => !operationHasLiveWorkspaceWriter(db, run.id));
    if (!recoverable.length) return { recovered: 0, unapplied: 0, conflicted: 0 };
    await indexing.reconcile(undefined, true);
    for (const run of recoverable)
      db.prepare(
        "UPDATE sync_runs SET status='recovered',finished_at=? WHERE id=? AND lease_until<=?",
      ).run(Date.now(), run.id, Date.now());
    return { recovered: recoverable.length, unapplied: 0, conflicted: 0 };
  }
  async function pull() {
    if (!config.gitSyncEnabled) fail(403, 'LOCAL_SYNC_DISABLED');
    await recover();
    const id = randomUUID(),
      before = await gitState(config.knowledgeRoot);
    workspaceOperation(db, id);
    db.transaction(() => {
      if (
        db
          .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
          .get() ||
        (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active
      )
        fail(503, 'SYNC_IN_PROGRESS');
      db.prepare(
        'INSERT INTO sync_runs(id,owner,status,before_head,lease_until,started_at) VALUES(?,?,?,?,?,?)',
      ).run(id, owner, 'running', before.head, Date.now() + 60000, Date.now());
    }).immediate();
    const heartbeat = setInterval(
      () =>
        db
          .prepare("UPDATE sync_runs SET lease_until=? WHERE id=? AND owner=? AND status='running'")
          .run(Date.now() + 60000, id, owner),
      15000,
    );
    heartbeat.unref();
    let error: string | null = null,
      after = before.head,
      status = 'succeeded';
    try {
      const current = await gitState(config.knowledgeRoot);
      if (current.filters) fail(409, 'UNTRUSTED_GIT_FILTER');
      if (current.conflicts.length) fail(409, 'GIT_CONFLICT');
      if (current.dirty) fail(409, 'DIRTY_WORKTREE');
      const pulled = await workspaceExec(
        db,
        config.knowledgeRoot,
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'protocol.ext.allow=never',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          '--no-pager',
          'pull',
          '--ff-only',
          '--no-rebase',
        ],
        { timeoutMs: 120000, maxBytes: 8 * 1024 * 1024 },
      );
      if (pulled.code !== 0) fail(409, 'GIT_SYNC_FAILED');
      after = (await gitState(config.knowledgeRoot)).head;
    } catch (e) {
      status = 'failed';
      error = e instanceof KnowledgeError ? e.code : 'GIT_SYNC_FAILED';
    } finally {
      clearInterval(heartbeat);
      try {
        await indexing.reconcile(undefined, true);
        db.prepare(
          'UPDATE sync_runs SET status=?,after_head=?,finished_at=?,error=? WHERE id=? AND owner=?',
        ).run(status, after, Date.now(), error, id, owner);
      } catch {
        status = 'needs_reconciliation';
        error = 'SOURCE_UNAVAILABLE';
        db.prepare(
          "UPDATE sync_runs SET status='needs_reconciliation',error=?,lease_until=? WHERE id=? AND owner=?",
        ).run(error, Date.now(), id, owner);
      }
    }
    return { id, status, beforeHead: before.head, afterHead: after, error };
  }
  return {
    pull: () => workspaceExclusive(db, { kind: 'sync.pull' }, pull),
    recover: () =>
      db
        .prepare(
          "SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation') AND lease_until<=?",
        )
        .get(Date.now())
        ? workspaceExclusive(db, { kind: 'sync.recover' }, recover)
        : Promise.resolve({ recovered: 0, unapplied: 0, conflicted: 0 }),
  };
}
