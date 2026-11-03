import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
/** Binds a complete scan to every expected semantic chunk, including skipped resume batches. */
export function chunkInventory() {
  const hash = createHash('sha256');
  let count = 0;
  return {
    add(c: {
      ordinal: number;
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
      content: string;
    }) {
      hash.update(
        JSON.stringify([c.ordinal, c.startByte, c.endByte, c.startLine, c.endLine, c.content]) +
          '\n',
      );
      count++;
    },
    finish() {
      return { count, digest: hash.digest('hex') };
    },
  };
}

/** Invalidate the old broad/JSON projections once, retaining note identity and durable jobs. */
export function upgradeDiagramTextIndexes(db: AppDatabase, spaceId?: string) {
  db.transaction(() => {
    const version = db
      .prepare("SELECT value FROM index_meta WHERE key='chunker_projection'")
      .get() as { value: string } | undefined;
    if (version?.value !== 'semantic-spans-v2') {
      // A checkpoint is meaningful only within the chunker version that created it.
      db.prepare(
        "UPDATE index_jobs SET checkpoint=0,status='pending',attempts=0,next_run_at=0,lease_until=NULL,worker_id=NULL,lease_epoch=lease_epoch+1 WHERE status IN ('pending','retry_wait','leased')",
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO index_meta VALUES('chunker_projection','semantic-spans-v2')",
      ).run();
    }
    const legacy = db
      .prepare(
        `SELECT DISTINCT d.note_id,d.content_hash,d.source_revision
      FROM document_state d JOIN chunks c ON c.note_id=d.note_id
      WHERE d.active=1 AND d.content_hash IS NOT NULL AND c.active=1
      AND c.source_hash=d.content_hash AND c.source_revision=d.source_revision AND c.chunker_id NOT LIKE 'semantic-spans-v2:%'
      AND (c.path LIKE '%.excalidraw' OR c.content LIKE '%<!-- dooknow:document %' OR c.chunker_id LIKE 'semantic-spans-v1:%')`,
      )
      .all() as { note_id: string; content_hash: string; source_revision: number }[];
    for (const note of legacy) {
      db.prepare(
        'UPDATE document_state SET text_indexed_hash=NULL,vector_indexed_hash=NULL WHERE note_id=?',
      ).run(note.note_id);
      db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(note.note_id);
      for (const target of ['text', ...(spaceId ? ['vector'] : [])]) {
        db.prepare(
          `INSERT INTO index_jobs(id,note_id,source_revision,source_hash,target,space_id)
          VALUES(?,?,?,?,?,?) ON CONFLICT(note_id,source_revision,source_hash,target,space_id)
          DO UPDATE SET status='pending',checkpoint=0,attempts=0,next_run_at=0,lease_until=NULL,
            worker_id=NULL,lease_epoch=lease_epoch+1,error=NULL`,
        ).run(
          randomUUID(),
          note.note_id,
          note.source_revision,
          note.content_hash,
          target,
          target === 'vector' ? spaceId : '',
        );
      }
    }
    if (legacy.length)
      db.prepare(
        "INSERT INTO index_meta VALUES('index_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      ).run();
  }).immediate();
}
