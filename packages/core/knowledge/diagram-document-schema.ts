import type { AppDatabase } from '../db.js';

/** Additive migration: reservations are deliberately separate from discoverable notes. */
export function migrateDiagramDocuments(db: AppDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagram_creation_intents (
      id TEXT PRIMARY KEY,
      note_id TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK(document_type IN ('whiteboard','mindmap','flowchart')),
      principal TEXT NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','prepared','published','cancelled','expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      published_hash TEXT,
      UNIQUE(principal,client_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS diagram_reserved_path ON diagram_creation_intents(path)
      WHERE status IN ('reserved','prepared');
  `);
}
