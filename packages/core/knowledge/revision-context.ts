import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { DocumentType } from '../../../shared/diagram-resource.js';
import { documentType } from '../../../shared/whiteboard.js';
import { fileVersionStamp } from './file-reader.js';
import { limits } from './limits.js';
import { fail } from './errors.js';
import { hasDiagramDeclarationSync } from './diagram-declaration.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { scanRevisionDestinations, revisionDestinationUrl } from './revision-relocation.js';
import { captureRevisionReferences, retainRevisionResourceIds, revisionIdentityMapping, type RevisionResource, type RevisionReferences } from './revision-identities.js';
import { revisionNativeEdits } from './revision-native-restore.js';
import { webPrincipal } from './core.js';

export type RevisionContext = {
  documentType: DocumentType;
  payloadFormat: 'markdown';
  logicalPath: string | null;
  contentHash: string;
  resources: RevisionResource[];
  references: RevisionReferences;
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
  references_manifest: string | null;
  created_at: string;
};

export function initializeRevisionContext(db: AppDatabase) {
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
      (!logicalPath || hasDiagramDeclarationSync(path))
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
    const payloadFormat = 'markdown' as const;
    return {
      contentHash: digest.digest('hex'),
      payloadFormat,
      documentType: documentType(logicalPath ?? 'unknown.md', content),
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
): RevisionResource[] {
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
    'UPDATE revisions SET document_type=?,payload_format=?,logical_path=?,content_hash=?,resources_manifest=?,references_manifest=? WHERE id=?',
  ).run(
    value.documentType,
    value.payloadFormat,
    value.logicalPath,
    value.contentHash,
    JSON.stringify(value.resources),
    JSON.stringify(value.references),
    revisionId,
  );
}
function publishedLogicalPath(db: AppDatabase, noteId: string, hash: string, createdAt: string) {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return null;
  const row = db
    .prepare(
      'SELECT path FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND created_at<=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
    )
    .get(noteId, hash, at) as { path: string } | undefined;
  return row?.path ?? null;
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
  const retained = retainRevisionResourceIds(
    db,
    resources(db, intent.note_id, value.contentHash, logicalPath),
  );
  store(db, intent.revision_id, {
    ...value,
    logicalPath,
    resources: retained,
    references: captureRevisionReferences(
      config,
      db,
      intent.note_id,
      logicalPath,
      revisionFile(config, intent.history_file),
      retained,
      undefined,
      value.contentHash,
    ),
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
  let path =
    row.logical_path ??
    (row.content_hash ? publishedLogicalPath(db, noteId, row.content_hash, row.created_at) : null);
  if (!row.content_hash) {
    const intent = db
      .prepare(
        'SELECT id,path,kind FROM write_intents WHERE revision_id=? AND note_id=? ORDER BY rowid LIMIT 1',
      )
      .get(revisionId, noteId) as { id: string; path: string; kind: string } | undefined;
    // Move intents record their destination. Without a saved context it is not evidence
    // of the original path. Ordinary update/patch intents do retain the original logical path.
    path =
      path ??
      (intent &&
      !['move', 'restore'].includes(intent.kind)
        ? intent.path
        : null);
    if (!path && intent) {
      if (intent.kind === 'move') {
        const operation = db
          .prepare("SELECT result FROM operations WHERE id=? AND status='succeeded'")
          .get(intent.id) as { result: string } | undefined;
        try {
          const from = JSON.parse(operation?.result ?? '{}').previousRelativePath;
          if (typeof from === 'string') path = from;
        } catch {
          /* Unknown result is not logical-path evidence. */
        }
      }
    }
    let value = inspect(config, row.file, path);
    if (!path) {
      path = publishedLogicalPath(db, noteId, value.contentHash, row.created_at);
      if (path) value = inspect(config, row.file, path);
    }
    const since = Number.isFinite(Date.parse(row.created_at))
      ? Date.parse(row.created_at)
      : undefined;
    const retained = retainRevisionResourceIds(
      db,
      resources(db, noteId, value.contentHash, path),
      since,
    );
    const context = {
      ...value,
      logicalPath: path,
      resources: retained,
      references: captureRevisionReferences(
        config,
        db,
        noteId,
        path,
        revisionFile(config, row.file),
        retained,
        since,
        value.contentHash,
      ),
    };
    store(db, revisionId, context);
    return context;
  }
  const checked = inspect(config, row.file, path);
  if (checked.contentHash !== row.content_hash) fail(409, 'REVISION_CONTENT_CONFLICT');
  let retained: RevisionResource[];
  try {
    retained = JSON.parse(row.resources_manifest ?? '[]');
  } catch {
    return fail(409, 'REVISION_CONTEXT_INVALID');
  }
  if (
    !Array.isArray(retained) ||
    !retained.every(
      (resource) =>
        resource &&
        ['source', 'preview'].includes(resource.role) &&
        typeof resource.path === 'string' &&
        /^[a-f0-9]{64}$/.test(resource.hash) &&
        (resource.assetId === undefined || typeof resource.assetId === 'string'),
    )
  )
    fail(409, 'REVISION_CONTEXT_INVALID');
  const since = Number.isFinite(Date.parse(row.created_at))
    ? Date.parse(row.created_at)
    : undefined;
  retained = retainRevisionResourceIds(db, retained, since);
  let references: RevisionReferences;
  if (row.references_manifest) {
    try {
      references = JSON.parse(row.references_manifest);
      if (
        references.version !== 1 ||
        typeof references.complete !== 'boolean' ||
        !Array.isArray(references.items) ||
        !references.items.every(
          (ref) =>
            ref &&
            typeof ref.path === 'string' &&
            (ref.noteId === undefined || typeof ref.noteId === 'string') &&
            (ref.assetId === undefined || typeof ref.assetId === 'string') &&
            !(ref.noteId && ref.assetId) &&
            (ref.hash === undefined || /^[a-f0-9]{64}$/.test(ref.hash)) &&
            (!ref.assetId || !!ref.hash),
        )
      )
        throw Error();
    } catch {
      return fail(409, 'REVISION_CONTEXT_INVALID');
    }
  } else
    references = captureRevisionReferences(
      config,
      db,
      noteId,
      path,
      revisionFile(config, row.file),
      retained,
      since,
      row.content_hash,
    );
  const context = {
    documentType: row.document_type ?? checked.documentType,
    payloadFormat: row.payload_format ?? checked.payloadFormat,
    logicalPath: path,
    contentHash: row.content_hash,
    resources: retained,
    references,
  };
  if (!row.references_manifest || JSON.stringify(retained) !== row.resources_manifest)
    store(db, revisionId, context);
  return context;
}

/** Shared by small saves and background restore jobs. Old JSON never enters a Markdown writer. */
export function revisionRestoreSource(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  revisionId: string,
  targetPath: string,
  principal?: Principal,
) {
  const context = revisionContext(config, db, noteId, revisionId);
  const row = db
    .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
    .get(revisionId, noteId) as { file: string };
  const file = revisionFile(config, row.file);
  const mapping = revisionIdentityMapping(config, db, context.references, principal);
  if (!context.logicalPath) {
    const scanned = scanRevisionDestinations(file);
    if (scanned.contentHash !== context.contentHash) fail(409, 'REVISION_CONTENT_CONFLICT');
    if (
      scanned.spans.some((span) => span.url && !/^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(span.url)) ||
      scanned.nativeGroups.length ||
      !scanned.complete
    )
      fail(409, 'REVISION_PATH_UNKNOWN');
  }
  if (
    context.logicalPath &&
    (context.references.items.some((ref) => ref.native) ||
      posix.dirname(context.logicalPath) !== posix.dirname(targetPath) ||
      [...mapping].some(([from, to]) => from !== to))
  ) {
    if (context.documentType !== 'markdown')
      fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '跨目录图形历史需要重新准备预览', false, {
        noteId,
        revisionId,
      });
    const scanned = scanRevisionDestinations(file);
    if (scanned.contentHash !== context.contentHash) fail(409, 'REVISION_CONTENT_CONFLICT');
    if (!context.references.complete || !scanned.complete)
      fail(409, 'REVISION_REFERENCE_CONTEXT_INCOMPLETE');
    const overrides = new Map<string, string>();
    const pairs = context.references.items
      .filter((ref) => ref.native && ref.previewPath && ref.hash)
      .map((ref) => ({
        start: -1,
        end: -1,
        sourcePath: posix.relative(posix.dirname(context.logicalPath!), ref.path),
        previewPath: posix.relative(posix.dirname(context.logicalPath!), ref.previewPath!),
        sourceHash: ref.hash!,
        code: '',
        codeHash: '',
        pair: true as const,
      }));
    const nativeEdits = revisionNativeEdits(
      config,
      db,
      principal ?? webPrincipal,
      noteId,
      revisionId,
      context.contentHash,
      context.logicalPath,
      targetPath,
      [...scanned.nativeGroups, ...pairs],
      mapping,
      overrides,
    );
    for (const [from, to] of overrides) mapping.set(from, to);
    const edits = [
      ...nativeEdits,
      ...scanned.spans.flatMap((span) => {
        if (nativeEdits.some((edit) => span.startByte >= edit.start && span.endByte <= edit.end))
          return [];
        const text = revisionDestinationUrl(span, context.logicalPath!, targetPath, mapping);
        return text === undefined ? [] : [{ start: span.startByte, end: span.endByte, text }];
      }),
    ];
    if (!edits.length) return { file, context };
    if (statSync(file).size > limits.ordinary) return { file, context, edits };
    const original = readFileSync(file);
    if (createHash('sha256').update(original).digest('hex') !== context.contentHash)
      fail(409, 'REVISION_CONTENT_CONFLICT');
    const parts: Buffer[] = [];
    let offset = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      parts.push(original.subarray(offset, edit.start), Buffer.from(edit.text));
      offset = edit.end;
    }
    parts.push(original.subarray(offset));
    return { file, context, content: Buffer.concat(parts).toString('utf8') };
  }
  return { file, context };
}
