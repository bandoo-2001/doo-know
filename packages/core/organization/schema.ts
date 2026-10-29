import type { AppDatabase } from '../db.js';
export function migrateOrganization(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_library(id INTEGER PRIMARY KEY CHECK(id=1),library_id TEXT NOT NULL,binding_version INTEGER NOT NULL DEFAULT 1,structure_revision TEXT NOT NULL DEFAULT '0',root_identity TEXT NOT NULL,inbox_directory_id TEXT,inventory_hash TEXT NOT NULL DEFAULT '',graph_revision TEXT NOT NULL DEFAULT '0');
  CREATE TABLE IF NOT EXISTS organization_directories(id TEXT PRIMARY KEY,library_id TEXT NOT NULL,parent_id TEXT,path TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,dev TEXT NOT NULL,ino TEXT NOT NULL,birthtime_ns TEXT NOT NULL,subtree_revision TEXT NOT NULL DEFAULT '');
  CREATE UNIQUE INDEX IF NOT EXISTS organization_directory_path ON organization_directories(library_id,path) WHERE active=1;
  CREATE TABLE IF NOT EXISTS organization_jobs(id TEXT PRIMARY KEY REFERENCES operations(id),status TEXT NOT NULL,payload TEXT NOT NULL,manifest TEXT,owner_pid INTEGER,owner_start TEXT,lease_epoch INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,finished_at INTEGER,expires_at INTEGER,undo_of TEXT,undo_id TEXT,error TEXT,cleaned INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS organization_objects(operation_id TEXT NOT NULL REFERENCES organization_jobs(id),ordinal INTEGER NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(operation_id,ordinal));`);
}
export function organizationPending(db: AppDatabase) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_jobs'")
    .get();
  return (
    !!table &&
    !!db
      .prepare(
        "SELECT 1 FROM organization_jobs WHERE status IN ('committing','needs_reconciliation')",
      )
      .get()
  );
}
