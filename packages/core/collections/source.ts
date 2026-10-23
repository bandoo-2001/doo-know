import type { AppDatabase } from '../db.js';

export function migrateCollections(db: AppDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_catalog(
      note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      modified_ns TEXT NOT NULL, size_bytes INTEGER NOT NULL, source_version TEXT NOT NULL,
      identity TEXT, source_hash TEXT, summary_version TEXT, title TEXT, summary TEXT, summary_state TEXT
    );
    CREATE INDEX IF NOT EXISTS collection_modified ON collection_catalog(modified_ns DESC,note_id);
    INSERT OR IGNORE INTO index_meta(key,value) VALUES('collection_epoch','1');
    CREATE TRIGGER IF NOT EXISTS collection_source_insert AFTER INSERT ON collection_catalog BEGIN
      UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch'; END;
    CREATE TRIGGER IF NOT EXISTS collection_source_update AFTER UPDATE OF source_version,identity ON collection_catalog
      WHEN NEW.source_version IS NOT OLD.source_version OR NEW.identity IS NOT OLD.identity BEGIN
      UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch'; END;
    CREATE TRIGGER IF NOT EXISTS collection_note_update AFTER UPDATE OF active,path ON notes
      WHEN NEW.active IS NOT OLD.active OR NEW.path IS NOT OLD.path BEGIN
      UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch';
      UPDATE collection_catalog SET summary_version=NULL WHERE note_id=NEW.id AND NEW.active IS NOT OLD.active;
    END;
    CREATE TRIGGER IF NOT EXISTS collection_favorite_insert AFTER INSERT ON note_favorites BEGIN
      UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch'; END;
    CREATE TRIGGER IF NOT EXISTS collection_favorite_delete AFTER DELETE ON note_favorites BEGIN
      UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch'; END;
  `);
  if (
    !(db.pragma('table_info(collection_catalog)') as { name: string }[]).some(
      (column) => column.name === 'source_hash',
    )
  )
    db.exec('ALTER TABLE collection_catalog ADD COLUMN source_hash TEXT');
  const format = db
    .prepare("SELECT value FROM index_meta WHERE key='collection_summary_format'")
    .get() as { value: string } | undefined;
  if (format?.value !== '2') {
    db.transaction(() => {
      db.prepare('UPDATE collection_catalog SET summary_version=NULL').run();
      db.prepare(
        "INSERT INTO index_meta(key,value) VALUES('collection_summary_format','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run();
      db.prepare(
        "UPDATE index_meta SET value=CAST(value AS INTEGER)+1 WHERE key='collection_epoch'",
      ).run();
    }).immediate();
  }
}

export function collectionText(content: string) {
  content = content.slice(0, 8192).replace(/[\uD800-\uDBFF]$/, '');
  const plain = (value: string) =>
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(
        /&(?:nbsp|amp|lt|gt|quot|#39);/g,
        (m) =>
          ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[
            m
          ]!,
      )
      .replace(/\s+/g, ' ')
      .trim();
  content = content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const title = plain(content.match(/^#\s+(.+)$/m)?.[1] || '');
  const body = content
    .replace(/^\s*#\s+[^\r\n]*(?:\r?\n|$)/, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, ' ');
  return {
    title: [...title].slice(0, 256).join(''),
    summary: [...plain(body)].slice(0, 240).join(''),
  };
}

// Metadata observations never read original content. Mutation callers can supply
// content they already hold, so saving also warms the persistent summary cache.
export function observeCollectionSource(
  db: AppDatabase,
  id: string,
  mtime: string,
  size: number,
  content?: string,
  identity?: string,
  hash?: string,
) {
  const previous = db
    .prepare(
      'SELECT identity,source_hash,source_version,modified_ns,size_bytes FROM collection_catalog WHERE note_id=?',
    )
    .get(id) as
    | {
        identity: string | null;
        source_hash: string | null;
        source_version: string;
        modified_ns: string;
        size_bytes: number;
      }
    | undefined;
  const metadataChanged =
    previous &&
    (previous.modified_ns !== mtime.padStart(24, '0') ||
      previous.size_bytes !== size ||
      (identity !== undefined && previous.identity !== identity));
  const sourceHash = hash ?? (metadataChanged ? null : (previous?.source_hash ?? null));
  const sourceIdentity = identity ?? previous?.identity ?? null;
  const knownHashChanged =
    previous?.source_hash != null && hash !== undefined && previous.source_hash !== hash;
  // Learning the first hash enriches an already observed source. Preserve its
  // opaque token so indexing cannot invalidate pinned pages or warm summaries.
  // Later metadata observations must preserve that token as well.
  const version =
    !previous || metadataChanged || knownHashChanged
      ? `${mtime}:${size}:${sourceIdentity ?? ''}:${sourceHash ?? ''}`
      : previous.source_version;
  if (previous?.source_version !== version || previous.source_hash !== sourceHash)
    db.prepare(
      `INSERT INTO collection_catalog(note_id,modified_ns,size_bytes,source_version,identity,source_hash)
    VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET
    modified_ns=excluded.modified_ns,size_bytes=excluded.size_bytes,source_version=excluded.source_version,
    source_hash=excluded.source_hash,
    summary_version=CASE WHEN collection_catalog.source_version<>excluded.source_version
      OR (excluded.identity IS NOT NULL AND collection_catalog.identity IS NOT NULL AND collection_catalog.identity<>excluded.identity)
      THEN NULL ELSE collection_catalog.summary_version END,
    identity=COALESCE(excluded.identity,collection_catalog.identity)`,
    ).run(id, mtime.padStart(24, '0'), size, version, sourceIdentity, sourceHash);
  if (content !== undefined) {
    const text = collectionText(content);
    db.prepare(
      `UPDATE collection_catalog SET title=?,summary=?,summary_state='ready',summary_version=source_version WHERE note_id=?`,
    ).run(text.title, text.summary, id);
  }
}
