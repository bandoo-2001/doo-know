import type { AppDatabase } from '../db.js';
import { defaultBlogDesign } from '../../../shared/blog-design.js';

export function migrateBlog(db: AppDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_design_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,draft_json TEXT NOT NULL,published_json TEXT NOT NULL,published_revision INTEGER NOT NULL,published_at TEXT);
    CREATE TABLE IF NOT EXISTS blog_design_history(revision INTEGER PRIMARY KEY,design_json TEXT NOT NULL,published_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS blog_design_media(hash TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS blog_settings(id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL);
    INSERT OR IGNORE INTO blog_settings VALUES(1,'{"version":1,"enabled":false,"title":"我的博客","description":"","author":"","baseUrl":"","about":"","theme":"light"}');
    CREATE TABLE IF NOT EXISTS blog_posts(
      id TEXT PRIMARY KEY, source_note_id TEXT NOT NULL UNIQUE REFERENCES notes(id),
      slug TEXT NOT NULL UNIQUE, metadata_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK(state IN ('draft','published','withdrawn')),
      current_version_id TEXT, published_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS blog_versions(
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
      source_modified_at TEXT NOT NULL, source_hash TEXT NOT NULL, metadata_json TEXT NOT NULL,
      html TEXT NOT NULL, headings_json TEXT NOT NULL, cover_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS blog_blobs(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS blog_version_resources(
      version_id TEXT NOT NULL REFERENCES blog_versions(id) ON DELETE CASCADE,
      hash TEXT NOT NULL REFERENCES blog_blobs(hash), PRIMARY KEY(version_id,hash));
    CREATE TABLE IF NOT EXISTS blog_receipts(
      actor TEXT NOT NULL, client_id TEXT NOT NULL, request_id TEXT NOT NULL,
      kind TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      operation_id TEXT, source_note_id TEXT,
      PRIMARY KEY(actor,client_id,request_id));
    CREATE TRIGGER IF NOT EXISTS blog_source_withdraw AFTER UPDATE OF active ON notes
      WHEN OLD.active=1 AND NEW.active=0 BEGIN
      UPDATE blog_posts SET state='withdrawn',version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE source_note_id=NEW.id AND state='published';
    END;
  `);
  const design = JSON.stringify(defaultBlogDesign());
  db.prepare('INSERT OR IGNORE INTO blog_design_state VALUES(1,1,?,?,0,NULL)').run(design, design);
  const columns = db.prepare('PRAGMA table_info(blog_receipts)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'operation_id'))
    db.exec('ALTER TABLE blog_receipts ADD COLUMN operation_id TEXT');
  if (!columns.some((c) => c.name === 'source_note_id'))
    db.exec('ALTER TABLE blog_receipts ADD COLUMN source_note_id TEXT');
}
