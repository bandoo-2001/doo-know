import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { SourceVersion } from '../../../shared/knowledge-contracts.js';
import { desiredSpace } from './space.js';
export interface LeasedIndexJob extends SourceVersion {
  id: string;
  target: 'text' | 'vector';
  embeddingSpaceId: string;
  leaseEpoch: number;
  attempts: number;
  workerId: string;
  checkpoint: number;
}
export function indexJobService(
  db: AppDatabase,
  options: { now?: () => number; random?: () => number; spaceId?: string } = {},
) {
  const now = options.now || Date.now,
    random = options.random || Math.random;
  function enqueue(v: SourceVersion, target: 'text' | 'vector') {
    const space = target === 'vector' ? options.spaceId || '' : '';
    db.transaction(() => {
      db.prepare(
        "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND target=? AND (source_revision<>? OR source_hash<>? OR space_id<>?) AND status NOT IN ('done','superseded')",
      ).run(v.noteId, target, v.sourceRevision, v.contentHash, space);
      db.prepare(
        'INSERT OR IGNORE INTO index_jobs(id,note_id,source_revision,source_hash,target,space_id) VALUES(?,?,?,?,?,?)',
      ).run(randomUUID(), v.noteId, v.sourceRevision, v.contentHash, target, space);
    })();
  }
  function claim(
    workerId: string,
    targets: ('text' | 'vector')[] = ['text', 'vector'],
  ): LeasedIndexJob | null {
    if (!targets.length) return null;
    return db
      .transaction(() => {
        if (desiredSpace(db, options.spaceId || '') !== (options.spaceId || '')) return null;
        if (
          db
            .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
            .get() ||
          (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active
        )
          return null;
        const row = db
          .prepare(
            `SELECT j.* FROM index_jobs j JOIN document_state d ON d.note_id=j.note_id JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND d.active=1 AND d.conflict=0 AND j.source_revision=d.source_revision AND j.source_hash=d.content_hash AND j.attempts<10 AND ((j.status IN ('pending','retry_wait') AND j.next_run_at<=?) OR (j.status='leased' AND j.lease_until<=?)) AND j.target IN (?,?) AND (j.target='text' OR j.space_id=?) ORDER BY CASE j.target WHEN 'text' THEN 0 ELSE 1 END,CASE WHEN d.size_bytes<=1048576 THEN 0 ELSE 1 END,j.next_run_at,j.rowid LIMIT 1`,
          )
          .get(
            now(),
            now(),
            targets[0] || '__paused__',
            targets[1] || '__paused__',
            desiredSpace(db, options.spaceId || '') === options.spaceId
              ? options.spaceId || ''
              : '__inactive_space__',
          ) as any;
        if (!row) return null;
        db.prepare(
          "UPDATE index_jobs SET status='leased',worker_id=?,lease_epoch=lease_epoch+1,lease_until=?,attempts=attempts+1 WHERE id=?",
        ).run(workerId, now() + 60000, row.id);
        return {
          id: row.id,
          noteId: row.note_id,
          sourceRevision: row.source_revision,
          contentHash: row.source_hash,
          target: row.target,
          embeddingSpaceId: row.space_id,
          leaseEpoch: row.lease_epoch + 1,
          attempts: row.attempts + 1,
          workerId,
          checkpoint: row.checkpoint,
        };
      })
      .immediate();
  }
  function valid(job: LeasedIndexJob) {
    const row = db
      .prepare(
        'SELECT j.*,d.active,d.content_hash,d.source_revision AS current_revision,d.conflict,n.active AS note_active FROM index_jobs j JOIN document_state d ON d.note_id=j.note_id JOIN notes n ON n.id=j.note_id WHERE j.id=?',
      )
      .get(job.id) as any;
    return (
      !!row &&
      row.status === 'leased' &&
      row.lease_epoch === job.leaseEpoch &&
      row.worker_id === job.workerId &&
      row.lease_until > now() &&
      row.active === 1 &&
      row.note_active === 1 &&
      !row.conflict &&
      row.current_revision === job.sourceRevision &&
      row.content_hash === job.contentHash &&
      desiredSpace(db, options.spaceId || '') === (options.spaceId || '') &&
      (job.target === 'text' ||
        (row.space_id === options.spaceId &&
          desiredSpace(db, options.spaceId || '') === options.spaceId))
    );
  }
  function heartbeat(job: LeasedIndexJob) {
    return (
      db
        .prepare(
          "UPDATE index_jobs SET lease_until=? WHERE id=? AND lease_epoch=? AND worker_id=? AND status='leased' AND lease_until>?",
        )
        .run(now() + 60000, job.id, job.leaseEpoch, job.workerId, now()).changes > 0
    );
  }
  function complete(job: LeasedIndexJob) {
    if (!valid(job)) return 'superseded';
    db.prepare(
      "UPDATE index_jobs SET status='done',lease_until=NULL,error=NULL WHERE id=? AND lease_epoch=? AND worker_id=?",
    ).run(job.id, job.leaseEpoch, job.workerId);
    return 'published';
  }
  function fail(job: LeasedIndexJob, error: string) {
    const latest = db.prepare('SELECT * FROM index_jobs WHERE id=?').get(job.id) as any;
    if (
      !latest ||
      latest.status !== 'leased' ||
      latest.lease_epoch !== job.leaseEpoch ||
      latest.worker_id !== job.workerId
    )
      return;
    const delay =
      Math.min(300000, 2000 * 2 ** Math.min(8, latest.attempts - 1)) *
      (1 + Math.max(0, Math.min(1, random())) * 0.2);
    db.prepare(
      'UPDATE index_jobs SET status=?,next_run_at=?,lease_until=NULL,error=? WHERE id=? AND lease_epoch=?',
    ).run(
      latest.attempts >= 10 ? 'failed' : 'retry_wait',
      now() + Math.floor(delay),
      error.slice(0, 128),
      job.id,
      job.leaseEpoch,
    );
  }
  function defer(job: LeasedIndexJob, code: string) {
    db.prepare(
      "UPDATE index_jobs SET status='pending',lease_until=NULL,attempts=max(0,attempts-1),next_run_at=?,error=? WHERE id=? AND status='leased' AND lease_epoch=? AND worker_id=?",
    ).run(now() + 5000, code, job.id, job.leaseEpoch, job.workerId);
  }
  function checkpoint(job: LeasedIndexJob, count: number) {
    if (!valid(job)) return false;
    db.prepare('UPDATE index_jobs SET checkpoint=? WHERE id=? AND lease_epoch=?').run(
      count,
      job.id,
      job.leaseEpoch,
    );
    return true;
  }
  function preempt(job: LeasedIndexJob) {
    return db.transaction(() => {
      if (job.target !== 'text' || !valid(job)) return false;
      const state = db
        .prepare('SELECT size_bytes FROM document_state WHERE note_id=?')
        .get(job.noteId) as any;
      if (
        state.size_bytes <= 1024 * 1024 ||
        !db
          .prepare(
            "SELECT 1 FROM index_jobs j JOIN document_state d ON d.note_id=j.note_id JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND j.target='text' AND j.status IN ('pending','retry_wait') AND j.next_run_at<=? AND j.note_id<>? AND d.size_bytes<=1048576 AND d.active=1 AND d.conflict=0 AND d.content_hash=j.source_hash AND d.source_revision=j.source_revision LIMIT 1",
          )
          .get(now(), job.noteId)
      )
        return false;
      db.prepare(
        "UPDATE index_jobs SET status='pending',lease_until=NULL,attempts=max(0,attempts-1) WHERE id=? AND lease_epoch=?",
      ).run(job.id, job.leaseEpoch);
      return true;
    })();
  }
  function retry(noteIds?: string[]) {
    let count = 0;
    for (const row of db
      .prepare("SELECT id,note_id FROM index_jobs WHERE status='failed'")
      .all() as any[])
      if (!noteIds || noteIds.includes(row.note_id)) {
        db.prepare(
          "UPDATE index_jobs SET status='pending',attempts=0,next_run_at=0,error=NULL WHERE id=?",
        ).run(row.id);
        count++;
      }
    return count;
  }
  return { enqueue, claim, valid, complete, fail, defer, heartbeat, checkpoint, retry, preempt };
}
