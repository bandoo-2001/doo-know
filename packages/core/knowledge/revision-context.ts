import { constants, openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { DocumentType } from '../../../shared/diagram-resource.js';
import { documentType, isWhiteboard, parseWhiteboard } from '../../../shared/whiteboard.js';
import { fileVersionStamp } from './file-reader.js';
import { limits } from './limits.js';
import { fail } from './errors.js';
import { hasDiagramDeclarationSync } from './diagram-declaration.js';
import type { DiagramVersionResource } from './diagram-publications.js';
import { rebaseRevisionMarkdown } from './revision-relocation.js';

export type RevisionContext = {
  documentType: DocumentType;
  payloadFormat: 'markdown' | 'excalidraw';
  logicalPath: string | null;
  contentHash: string;
  resources: DiagramVersionResource[];
};
type RevisionIntent = {
  id: string;
  note_id: string;
  path: string;
  kind: string;
  revision_id: string | null;
  history_file: string | null;
  original_hash: string | null;
  original_mtime: string | null;
};
type Row = {
  id: string;
  note_id: string;
  file: string;
  document_type: DocumentType | null;
  payload_format: RevisionContext['payloadFormat'] | null;
  logical_path: string | null;
  content_hash: string | null;
  resources_manifest: string | null;
};

export function migrateRevisionContext(db: AppDatabase) {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(revisions)').all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of [
    'document_type',
    'payload_format',
    'logical_path',
    'content_hash',
    'resources_manifest',
  ])
    if (!columns.has(name)) db.exec(`ALTER TABLE revisions ADD COLUMN ${name} TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS diagram_history_restores(
    id TEXT PRIMARY KEY REFERENCES operations(id),note_id TEXT NOT NULL REFERENCES notes(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),principal TEXT NOT NULL,client_id TEXT NOT NULL,
    plan TEXT NOT NULL,prepared_id TEXT,markdown TEXT,status TEXT NOT NULL DEFAULT 'planned',
    expires_at INTEGER NOT NULL)`);
}

/** History file names are opaque storage keys; their .md suffix never determines the payload. */
export function revisionFile(config: AppConfig, file: string) {
  if (!/^[a-zA-Z0-9-]+\.md$/.test(file)) fail(404, 'REVISION_NOT_FOUND');
  return join(config.dataRoot, 'history', file);
}
function inspect(config: AppConfig, file: string, logicalPath: string | null) {
  const path = revisionFile(config, file);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail(409, 'REVISION_CONTENT_CONFLICT');
    const digest = createHash('sha256'),
      bytes = Buffer.allocUnsafe(limits.io);
    let read: number;
    while ((read = readSync(fd, bytes)) > 0) digest.update(bytes.subarray(0, read));
    // Only bounded graph documents need parsing. Ordinary large history is hashed with a fixed buffer.
    let content: string | undefined;
    if (
      before.size <= BigInt(limits.file) &&
      (!logicalPath || isWhiteboard(logicalPath) || hasDiagramDeclarationSync(path))
    ) {
      const value = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < value.length) {
        const count = readSync(fd, value, offset, value.length - offset, offset);
        if (!count) fail(409, 'REVISION_CONTENT_CONFLICT');
        offset += count;
      }
      content = value.toString('utf8');
    }
    if (fileVersionStamp(before) !== fileVersionStamp(fstatSync(fd, { bigint: true })))
      fail(409, 'REVISION_CONTENT_CONFLICT');
    let payloadFormat: RevisionContext['payloadFormat'] =
      logicalPath && isWhiteboard(logicalPath) ? 'excalidraw' : 'markdown';
    if (!logicalPath && content?.trimStart().startsWith('{')) {
      // Old installations may have neither intent nor original path. Valid legacy scene bytes
      // must still go through graph restoration rather than becoming raw JSON in a Markdown note.
      try {
        parseWhiteboard(content);
        payloadFormat = 'excalidraw';
      } catch {
        /* ordinary JSON */
      }
    }
    return {
      contentHash: digest.digest('hex'),
      payloadFormat,
      documentType:
        payloadFormat === 'excalidraw'
          ? ('whiteboard' as const)
          : documentType(logicalPath ?? 'unknown.md', content),
    };
  } finally {
    closeSync(fd);
  }
}
function resources(
  db: AppDatabase,
  noteId: string,
  hash: string,
  path: string | null,
): DiagramVersionResource[] {
  if (!path) return [];
  const row = db
    .prepare(
      'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
    )
    .get(noteId, hash, path) as { manifest: string } | undefined;
  if (!row) return [];
  try {
    const value = JSON.parse(row.manifest).resources;
    if (
      !Array.isArray(value) ||
      !value.every(
        (r) =>
          r &&
          ['source', 'preview'].includes(r.role) &&
          typeof r.path === 'string' &&
          /^[a-f0-9]{64}$/.test(r.hash),
      )
    )
      return [];
    return value;
  } catch {
    return [];
  }
}
function store(db: AppDatabase, revisionId: string, value: RevisionContext) {
  db.prepare(
    'UPDATE revisions SET document_type=?,payload_format=?,logical_path=?,content_hash=?,resources_manifest=? WHERE id=?',
  ).run(
    value.documentType,
    value.payloadFormat,
    value.logicalPath,
    value.contentHash,
    JSON.stringify(value.resources),
    revisionId,
  );
}
/** Called within core.record's transaction, before the current identity changes its logical path. */
export function recordRevisionContext(config: AppConfig, db: AppDatabase, intent: RevisionIntent) {
  if (!intent.revision_id || !intent.history_file) return;
  if (db.prepare('SELECT id FROM revisions WHERE id=?').get(intent.revision_id)) return;
  const current = db.prepare('SELECT path FROM notes WHERE id=?').get(intent.note_id) as
    | { path: string }
    | undefined;
  const logicalPath = current?.path ?? intent.path;
  const value = inspect(config, intent.history_file, logicalPath);
  if (
    intent.original_hash &&
    /^[a-f0-9]{64}$/.test(intent.original_hash) &&
    value.contentHash !== intent.original_hash
  )
    fail(409, 'REVISION_CONTENT_CONFLICT');
  db.prepare('INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)').run(
    intent.revision_id,
    intent.note_id,
    intent.history_file,
    new Date().toISOString(),
    intent.original_mtime ?? '0',
  );
  store(db, intent.revision_id, {
    ...value,
    logicalPath,
    resources: resources(db, intent.note_id, value.contentHash, logicalPath),
  });
}

/** Lazily backfill proven old contexts; never pretend the note's current directory is historical. */
export function revisionContext(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  revisionId: string,
): RevisionContext {
  const row = db
    .prepare('SELECT * FROM revisions WHERE id=? AND note_id=?')
    .get(revisionId, noteId) as Row | undefined;
  if (!row) fail(404, 'REVISION_NOT_FOUND');
  let path = row.logical_path;
  if (!row.content_hash) {
    const intent = db
      .prepare(
        'SELECT path,kind FROM write_intents WHERE revision_id=? AND note_id=? ORDER BY rowid LIMIT 1',
      )
      .get(revisionId, noteId) as { path: string; kind: string } | undefined;
    // Move/migration intents record their destination. Without a saved context it is not evidence
    // of the original path. Ordinary update/patch intents do retain the original logical path.
    path =
      intent && !['move', 'restore', 'whiteboard-migrate'].includes(intent.kind)
        ? intent.path
        : null;
    const value = inspect(config, row.file, path);
    const context = {
      ...value,
      logicalPath: path,
      resources: resources(db, noteId, value.contentHash, path),
    };
    store(db, revisionId, context);
    return context;
  }
  const checked = inspect(config, row.file, path);
  if (checked.contentHash !== row.content_hash) fail(409, 'REVISION_CONTENT_CONFLICT');
  let retained: DiagramVersionResource[];
  try {
    retained = JSON.parse(row.resources_manifest ?? '[]');
  } catch {
    return fail(409, 'REVISION_CONTEXT_INVALID');
  }
  if (!Array.isArray(retained)) fail(409, 'REVISION_CONTEXT_INVALID');
  return {
    documentType: row.document_type ?? checked.documentType,
    payloadFormat: row.payload_format ?? checked.payloadFormat,
    logicalPath: path,
    contentHash: row.content_hash,
    resources: retained,
  };
}

/** Shared by small saves and background restore jobs. Old JSON never enters a Markdown writer. */
export function revisionRestoreSource(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  revisionId: string,
  targetPath: string,
) {
  const context = revisionContext(config, db, noteId, revisionId);
  const row = db
    .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
    .get(revisionId, noteId) as { file: string };
  const file = revisionFile(config, row.file);
  if (context.payloadFormat === 'excalidraw' && !isWhiteboard(targetPath))
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '旧白板历史需要重新准备完整 Markdown 图形版本', false, {
      noteId,
      revisionId,
      payloadFormat: context.payloadFormat,
    });
  if (context.payloadFormat === 'markdown' && isWhiteboard(targetPath))
    fail(409, 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED');
  if (context.logicalPath && posix.dirname(context.logicalPath) !== posix.dirname(targetPath)) {
    if (context.documentType !== 'markdown')
      fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '跨目录图形历史需要重新准备预览', false, {
        noteId,
        revisionId,
      });
    const original = readFileSync(file, 'utf8');
    if (createHash('sha256').update(original).digest('hex') !== context.contentHash)
      fail(409, 'REVISION_CONTENT_CONFLICT');
    const content = rebaseRevisionMarkdown(original, context.logicalPath, targetPath);
    return { file, context, ...(content !== original ? { content } : {}) };
  }
  return { file, context };
}
