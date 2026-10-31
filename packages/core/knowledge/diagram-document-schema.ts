import type { AppDatabase } from '../db.js';

/** Additive migration: reservations are deliberately separate from discoverable notes. */
export function migrateDiagramDocuments(db: AppDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whiteboard_migrations (
      id TEXT PRIMARY KEY REFERENCES operations(id),note_id TEXT NOT NULL REFERENCES notes(id),
      principal TEXT NOT NULL,client_id TEXT NOT NULL,old_path TEXT NOT NULL,new_path TEXT NOT NULL,
      status TEXT NOT NULL,plan TEXT NOT NULL,prepared TEXT,markdown TEXT,backup_path TEXT NOT NULL,
      commit_operation_id TEXT,rollback_operation_id TEXT,references_json TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS whiteboard_migration_active_note ON whiteboard_migrations(note_id) WHERE status <> 'rolled_back';
    CREATE UNIQUE INDEX IF NOT EXISTS whiteboard_migration_target ON whiteboard_migrations(new_path) WHERE status <> 'rolled_back';
    CREATE TABLE IF NOT EXISTS note_path_aliases(path TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),migration_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_diagram_previews (
      note_id TEXT NOT NULL REFERENCES notes(id),
      document_hash TEXT NOT NULL,
      render_hash TEXT NOT NULL,
      manifest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(note_id,document_hash,render_hash)
    );
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
  // A byte-identical document can be published in more than one logical directory.
  // Keep its original historical context while registering the relocated context.
  const versionColumns = db.prepare('PRAGMA table_info(diagram_document_versions)').all() as { name: string; pk: number }[];
  if (!versionColumns.some((column) => column.name === 'path' && column.pk)) {
    db.transaction(() => {
      db.exec(`ALTER TABLE diagram_document_versions RENAME TO diagram_document_versions_old;
        DROP INDEX IF EXISTS diagram_published_bindings;
        CREATE TABLE diagram_document_versions(note_id TEXT NOT NULL REFERENCES notes(id),document_hash TEXT NOT NULL,path TEXT NOT NULL,document_type TEXT NOT NULL,source_hash TEXT NOT NULL,render_hash TEXT NOT NULL,preview_hash TEXT NOT NULL,manifest TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(note_id,document_hash,path));
        INSERT INTO diagram_document_versions SELECT * FROM diagram_document_versions_old;
        DROP TABLE diagram_document_versions_old;
        CREATE INDEX diagram_published_bindings ON diagram_document_versions(note_id,source_hash,render_hash,preview_hash);`);
    }).immediate();
  }
  const intentColumns = db.prepare('PRAGMA table_info(diagram_creation_intents)').all() as {
    name: string;
  }[];
  if (!intentColumns.some((column) => column.name === 'commit_operation_id'))
    db.exec('ALTER TABLE diagram_creation_intents ADD COLUMN commit_operation_id TEXT');
  const columns = db.prepare('PRAGMA table_info(document_state)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'document_type'))
    db.exec("ALTER TABLE document_state ADD COLUMN document_type TEXT NOT NULL DEFAULT 'markdown'");
  const folderColumns = db.prepare('PRAGMA table_info(folder_trash)').all() as { name: string }[];
  if (!folderColumns.some((column) => column.name === 'diagram_plan'))
    db.exec('ALTER TABLE folder_trash ADD COLUMN diagram_plan TEXT');
  if (!folderColumns.some((column) => column.name === 'assets_json'))
    db.exec('ALTER TABLE folder_trash ADD COLUMN assets_json TEXT');
}
