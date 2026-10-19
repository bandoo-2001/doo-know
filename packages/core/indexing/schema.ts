import type { AppDatabase } from '../db.js';
export function migrateKnowledge(db: AppDatabase) {
  db.transaction(() =>
    db.exec(`
 CREATE TABLE IF NOT EXISTS knowledge_schema(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_state(note_id TEXT PRIMARY KEY REFERENCES notes(id),content_hash TEXT,mtime_ns TEXT,size_bytes INTEGER NOT NULL DEFAULT 0,source_revision INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,text_indexed_hash TEXT,vector_indexed_hash TEXT,last_checked_at TEXT,conflict INTEGER NOT NULL DEFAULT 0,longest_line_bytes INTEGER,title TEXT);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client_id TEXT NOT NULL,kind TEXT NOT NULL,request_id TEXT NOT NULL,params_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(principal,client_id,kind,request_id));
 CREATE TABLE IF NOT EXISTS write_intents(id TEXT PRIMARY KEY REFERENCES operations(id),note_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,original_hash TEXT,original_mtime TEXT,target_hash TEXT,temp_path TEXT,revision_id TEXT,history_file TEXT,status TEXT NOT NULL DEFAULT 'prepared');
 CREATE TABLE IF NOT EXISTS index_jobs(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,target TEXT NOT NULL,space_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,lease_epoch INTEGER NOT NULL DEFAULT 0,worker_id TEXT,error TEXT,checkpoint INTEGER NOT NULL DEFAULT 0,UNIQUE(note_id,source_revision,source_hash,target,space_id));
 CREATE INDEX IF NOT EXISTS pending_index_jobs ON index_jobs(status,next_run_at);
 CREATE TABLE IF NOT EXISTS read_snapshots(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),source_hash TEXT NOT NULL,modified_at TEXT NOT NULL,path TEXT NOT NULL,size_bytes INTEGER NOT NULL,longest_line_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,refs INTEGER NOT NULL DEFAULT 0,principal TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS snapshot_offsets(snapshot_id TEXT NOT NULL REFERENCES read_snapshots(id) ON DELETE CASCADE,line INTEGER NOT NULL,byte INTEGER NOT NULL,PRIMARY KEY(snapshot_id,line));
 CREATE TABLE IF NOT EXISTS outline_offsets(snapshot_id TEXT NOT NULL REFERENCES read_snapshots(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,title TEXT NOT NULL,level INTEGER NOT NULL,line INTEGER NOT NULL,byte INTEGER NOT NULL,PRIMARY KEY(snapshot_id,ordinal));
 CREATE TABLE IF NOT EXISTS read_sessions(id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES read_snapshots(id) ON DELETE CASCADE,principal TEXT NOT NULL,client_id TEXT NOT NULL,channel TEXT NOT NULL,pages INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS read_pages(session_id TEXT NOT NULL REFERENCES read_sessions(id) ON DELETE CASCADE,page_key TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(session_id,page_key));
 CREATE TABLE IF NOT EXISTS read_rates(principal TEXT NOT NULL,client_id TEXT NOT NULL,channel TEXT NOT NULL,window INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(principal,client_id,channel,window));
 CREATE TABLE IF NOT EXISTS file_operations(id TEXT PRIMARY KEY REFERENCES operations(id),note_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,snapshot_id TEXT,payload TEXT,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,lease_until INTEGER,lease_epoch INTEGER NOT NULL DEFAULT 0,worker_id TEXT,started_at INTEGER,error TEXT);
 CREATE TABLE IF NOT EXISTS sync_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,status TEXT NOT NULL,before_head TEXT,after_head TEXT,lease_until INTEGER NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,error TEXT);
 CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS document_search_epoch AFTER UPDATE OF active,source_revision,conflict,mtime_ns ON document_state WHEN NEW.active IS NOT OLD.active OR NEW.source_revision IS NOT OLD.source_revision OR NEW.conflict IS NOT OLD.conflict OR NEW.mtime_ns IS NOT OLD.mtime_ns BEGIN INSERT INTO index_meta VALUES('index_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1; END;
 CREATE TRIGGER IF NOT EXISTS note_search_epoch AFTER UPDATE OF active,path ON notes WHEN NEW.active IS NOT OLD.active OR NEW.path IS NOT OLD.path BEGIN INSERT INTO index_meta VALUES('index_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1; END;
 CREATE TABLE IF NOT EXISTS chunks(rowid INTEGER PRIMARY KEY,chunk_id TEXT NOT NULL UNIQUE,note_id TEXT NOT NULL REFERENCES notes(id),source_hash TEXT NOT NULL,source_revision INTEGER NOT NULL,chunker_id TEXT NOT NULL,ordinal INTEGER NOT NULL,heading_path TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,content TEXT NOT NULL,input_hash TEXT NOT NULL,title TEXT NOT NULL,path TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS chunks_document ON chunks(note_id,source_hash,active);
 CREATE INDEX IF NOT EXISTS vector_active_chunks ON chunks(chunk_id,active,source_revision,path);
 CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title,path,heading,body,tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS chunk_terms(term TEXT NOT NULL,chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,PRIMARY KEY(term,chunk_id));
 CREATE INDEX IF NOT EXISTS chunk_terms_by_chunk ON chunk_terms(chunk_id);
 CREATE TABLE IF NOT EXISTS note_tags(note_id TEXT NOT NULL REFERENCES notes(id),source_revision INTEGER NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(note_id,source_revision,tag));
 CREATE INDEX IF NOT EXISTS tags_by_value ON note_tags(tag,note_id,source_revision);
 CREATE TABLE IF NOT EXISTS embedding_spaces(id TEXT PRIMARY KEY,dimensions INTEGER NOT NULL,metadata TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS vector_generations(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,manifest_path TEXT NOT NULL,checksum TEXT NOT NULL,status TEXT NOT NULL,base_generation TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS vector_rows(generation TEXT NOT NULL,row INTEGER NOT NULL,chunk_id TEXT NOT NULL,note_id TEXT NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(generation,row));
 INSERT OR IGNORE INTO knowledge_schema VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 `),
  ).immediate();
  const chunkColumns = db.pragma('table_info(chunks)') as { name: string }[];
  for (const column of ['start_byte', 'end_byte'])
    if (!chunkColumns.some((c) => c.name === column))
      db.exec(`ALTER TABLE chunks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  const snapshotColumns = db.pragma('table_info(read_snapshots)') as { name: string }[];
  if (!snapshotColumns.some((c) => c.name === 'source_revision'))
    db.exec('ALTER TABLE read_snapshots ADD COLUMN source_revision INTEGER');
  const taskColumns = db.pragma('table_info(file_operations)') as { name: string }[];
  if (!taskColumns.some((c) => c.name === 'snapshot_ref_released'))
    db.exec(
      'ALTER TABLE file_operations ADD COLUMN snapshot_ref_released INTEGER NOT NULL DEFAULT 0',
    );
  if (!snapshotColumns.some((c) => c.name === 'source_key')) {
    db.exec("ALTER TABLE read_snapshots ADD COLUMN source_key TEXT NOT NULL DEFAULT 'live'");
    db.exec("UPDATE read_snapshots SET source_key=note_id WHERE source_key='live'");
  }
}
