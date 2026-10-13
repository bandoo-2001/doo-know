import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { indexJobService } from './jobs.js';
export function setDesiredEmbeddingSpace(db: AppDatabase, config: AppConfig) {
  const space = config.embeddingSpaceId || '';
  const old = (
    db.prepare("SELECT value FROM index_meta WHERE key='desired_embedding_space'").get() as any
  )?.value;
  if (!space && old === undefined) return;
  if (old === space) return;
  const active = db
    .prepare(
      "SELECT g.space_id FROM vector_generations g JOIN index_meta m ON m.value=g.id AND m.key='active_generation'",
    )
    .get() as { space_id: string } | undefined;
  if (old === undefined && active?.space_id === space) {
    db.prepare("INSERT INTO index_meta VALUES('desired_embedding_space',?)").run(space);
    return;
  }
  db.transaction(() => {
    db.prepare(
      "INSERT INTO index_meta VALUES('desired_embedding_space',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(space);
    db.prepare(
      "UPDATE index_jobs SET status='superseded',lease_epoch=lease_epoch+1 WHERE target='vector' AND space_id<>? AND status NOT IN ('done','superseded')",
    ).run(space);
    db.prepare('UPDATE document_state SET vector_indexed_hash=NULL').run();
    if (old !== undefined) {
      db.prepare('UPDATE document_state SET text_indexed_hash=NULL').run();
      db.prepare(
        "UPDATE index_jobs SET status='pending',attempts=0,checkpoint=0,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE target='text' AND status<>'superseded'",
      ).run();
    }
    if (space) {
      const jobs = indexJobService(db, { spaceId: space });
      for (const n of db
        .prepare(
          'SELECT * FROM document_state WHERE active=1 AND conflict=0 AND content_hash IS NOT NULL',
        )
        .iterate() as Iterable<any>)
        jobs.enqueue(
          { noteId: n.note_id, contentHash: n.content_hash, sourceRevision: n.source_revision },
          'vector',
        );
    }
  })();
}
export function desiredSpace(db: AppDatabase, fallback = '') {
  return (
    (db.prepare("SELECT value FROM index_meta WHERE key='desired_embedding_space'").get() as any)
      ?.value ?? fallback
  );
}
