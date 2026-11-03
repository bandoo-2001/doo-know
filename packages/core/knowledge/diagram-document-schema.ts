import type { AppDatabase } from '../db.js';

/** Initialize the current diagram schema; reservations stay separate from discoverable notes. */
export function initializeDiagramDocuments(db: AppDatabase) {
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
      commit_operation_id TEXT,
      UNIQUE(principal,client_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS diagram_reserved_path ON diagram_creation_intents(path)
      WHERE status IN ('reserved','prepared');
    CREATE TABLE IF NOT EXISTS diagram_prepared_primaries (
      id TEXT PRIMARY KEY REFERENCES operations(id),
      note_id TEXT NOT NULL,
      creation_intent_id TEXT REFERENCES diagram_creation_intents(id),
      principal TEXT NOT NULL,
      client_id TEXT NOT NULL,
      document_hash TEXT,
      baseline_source_hash TEXT,
      source_hash TEXT NOT NULL,
      render_hash TEXT NOT NULL,
      preview_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS diagram_prepared_versions ON diagram_prepared_primaries(note_id,source_hash,render_hash,preview_hash);
    CREATE TABLE IF NOT EXISTS diagram_pending_publications(operation_id TEXT PRIMARY KEY REFERENCES operations(id),note_id TEXT NOT NULL,path TEXT NOT NULL,document_hash TEXT NOT NULL,creation_intent_id TEXT,manifest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS diagram_document_versions(note_id TEXT NOT NULL REFERENCES notes(id),document_hash TEXT NOT NULL,path TEXT NOT NULL,document_type TEXT NOT NULL,source_hash TEXT NOT NULL,render_hash TEXT NOT NULL,preview_hash TEXT NOT NULL,manifest TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(note_id,document_hash,path));
    CREATE INDEX IF NOT EXISTS diagram_published_bindings ON diagram_document_versions(note_id,source_hash,render_hash,preview_hash);
  `);
}
