import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export function openDatabase(dataRoot: string) {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const path = join(dataRoot, 'app.sqlite');
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,path TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,trash_path TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS active_note_path ON notes(path) WHERE active=1;
 CREATE TABLE IF NOT EXISTS shares(note_id TEXT PRIMARY KEY REFERENCES notes(id),token TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),file TEXT NOT NULL,created_at TEXT NOT NULL,modified_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL);
 CREATE TABLE IF NOT EXISTS maintenance(id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL);
 INSERT OR IGNORE INTO maintenance VALUES(1,0);`);
  return db;
}
export type AppDatabase = ReturnType<typeof openDatabase>;
