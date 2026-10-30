import type { AppDatabase } from '../db.js';
/** Derived cache only: deleting these tables never changes library sources. */
export function migrateGraph(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS graph_sources(
    note_id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
    title TEXT NOT NULL, targets TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS graph_source_path ON graph_sources(path);
    CREATE TABLE IF NOT EXISTS graph_failures(note_id TEXT PRIMARY KEY,path TEXT NOT NULL);`);
}
