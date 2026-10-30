import type { AppDatabase } from '../db.js';
export function migrateAnalysis(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS graph_analysis_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO graph_analysis_meta VALUES('paused','0');
    CREATE TABLE IF NOT EXISTS graph_analysis_jobs(note_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'queued',epoch INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL DEFAULT 0,error TEXT,checkpoint INTEGER NOT NULL DEFAULT 0,observed_fingerprint TEXT,owner_pid INTEGER,owner_start TEXT);
    CREATE INDEX IF NOT EXISTS graph_analysis_ready ON graph_analysis_jobs(state,next_run);
    CREATE TABLE IF NOT EXISTS graph_analysis_sources(note_id TEXT PRIMARY KEY,path TEXT NOT NULL,fingerprint TEXT NOT NULL,source_revision INTEGER,managed_hash TEXT,config_hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS graph_knowledge_user(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
    INSERT OR IGNORE INTO graph_knowledge_user VALUES(1,'{"version":0,"views":[],"decisions":{},"merges":{},"aliases":{},"manual":[],"requests":{}}');`);
  if (
    !(db.prepare('PRAGMA table_info(graph_analysis_jobs)').all() as { name: string }[]).some(
      (c) => c.name === 'observed_fingerprint',
    )
  )
    db.exec('ALTER TABLE graph_analysis_jobs ADD COLUMN observed_fingerprint TEXT');
  for (const [name, type] of [
    ['owner_pid', 'INTEGER'],
    ['owner_start', 'TEXT'],
  ])
    if (
      !(db.prepare('PRAGMA table_info(graph_analysis_jobs)').all() as { name: string }[]).some(
        (c) => c.name === name,
      )
    )
      db.exec(`ALTER TABLE graph_analysis_jobs ADD COLUMN ${name} ${type}`);
  const queue = (id: string) =>
    `DELETE FROM graph_analysis_sources WHERE note_id=${id}; INSERT INTO graph_analysis_jobs(note_id) VALUES(${id}) ON CONFLICT(note_id) DO UPDATE SET state='queued',epoch=epoch+1,attempts=0,lease_until=0,next_run=0,error=NULL,checkpoint=0;`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS graph_analysis_note_insert AFTER INSERT ON notes BEGIN ${queue('NEW.id')} END;
    CREATE TRIGGER IF NOT EXISTS graph_analysis_note_update AFTER UPDATE OF path,active ON notes WHEN NEW.path IS NOT OLD.path OR NEW.active IS NOT OLD.active BEGIN ${queue('NEW.id')} END;
    CREATE TRIGGER IF NOT EXISTS graph_analysis_note_delete AFTER DELETE ON notes BEGIN DELETE FROM graph_analysis_sources WHERE note_id=OLD.id; DELETE FROM graph_analysis_jobs WHERE note_id=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS graph_analysis_state_insert AFTER INSERT ON document_state BEGIN ${queue('NEW.note_id')} END;
    CREATE TRIGGER IF NOT EXISTS graph_analysis_state_update AFTER UPDATE OF content_hash,source_revision,active,conflict,mtime_ns ON document_state WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.source_revision IS NOT OLD.source_revision OR NEW.active IS NOT OLD.active OR NEW.conflict IS NOT OLD.conflict OR NEW.mtime_ns IS NOT OLD.mtime_ns BEGIN ${queue('NEW.note_id')} END;`);
  db.exec(
    "INSERT OR IGNORE INTO graph_analysis_jobs(note_id) SELECT id FROM notes WHERE active=1 AND lower(path) LIKE '%.md'",
  );
}
