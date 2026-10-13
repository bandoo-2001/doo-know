import type { AppDatabase } from '../db.js';
import type { SourceVersion } from '../../shared/knowledge-contracts.js';
export function observeSource(
  db: AppDatabase,
  noteId: string,
  hash: string,
  mtimeNs: string,
  size: number,
): SourceVersion {
  return db.transaction(() => {
    const old = db
      .prepare('SELECT content_hash,source_revision FROM document_state WHERE note_id=?')
      .get(noteId) as { content_hash: string; source_revision: number } | undefined;
    const revision = (old?.source_revision || 0) + (old?.content_hash === hash ? 0 : 1);
    db.prepare(
      `INSERT INTO document_state(note_id,content_hash,mtime_ns,size_bytes,source_revision,last_checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET content_hash=excluded.content_hash,mtime_ns=excluded.mtime_ns,size_bytes=excluded.size_bytes,source_revision=excluded.source_revision,active=1,last_checked_at=excluded.last_checked_at`,
    ).run(noteId, hash, mtimeNs, size, revision, new Date().toISOString());
    if (old?.content_hash !== hash)
      db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(noteId);
    return { noteId, sourceRevision: revision, contentHash: hash };
  })();
}
