import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  readSync,
  writeSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { PreparedDiagramAsset } from '../../../shared/diagram-primary.js';
import { fsyncDirectory } from './core.js';
import { fileVersionStamp } from './file-reader.js';
import {
  revisionContext,
  recordRevisionContext,
  type RevisionContext,
} from './revision-context.js';
import { revisionFileDigest, revisionIdentityMapping } from './revision-identities.js';
import {
  archivedNoteDiagramFile,
  authorizeArchivedNoteOperation,
  type ArchivedNoteDiagramContext,
} from './archived-note-diagram-context.js';
import { collectNativeLinkChanges } from './native-link-plans.js';
import {
  diagramOperationPreviewRegistry,
  diagramOperationWorkspace,
} from './diagram-operation-previews.js';
import { planDiagramRelocation, type DiagramRelocation } from './diagram-relocation.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { safePath, validateRelative } from '../files.js';
import { scanRevisionDestinations } from './revision-relocation.js';
import { limits } from './limits.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { hasDiagramDeclarationSync } from './diagram-declaration.js';
export type NoteTrashRestorePlan = {
  version: 1;
  operationId: string;
  noteId: string;
  path: string;
  workspace: string;
  original: ArchivedNoteDiagramContext;
  afterHash: string;
  afterFile: string;
  afterStamp: string;
  assets: {
    asset: PreparedDiagramAsset;
    stage: string;
    hash: string;
    temporary?: { dev: string; ino: string; mode: string };
    published?: { dev: string; ino: string; mode: string; mtime: string; stamp?: string };
  }[];
  receipts: { id: string; hash: string; primary: boolean }[];
  resources: { path: string; hash: string; role: 'source' | 'preview' }[];
  references: { path: string; hash: string }[];
  targets: { noteId: string; path: string }[];
  diagram?: DiagramRelocation;
  legacy?: unknown;
  committing: boolean;
};
function schema(db: AppDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS note_trash_restore_plans(operation_id TEXT PRIMARY KEY,plan TEXT NOT NULL)',
  );
}
function store(db: AppDatabase, plan: NoteTrashRestorePlan) {
  schema(db);
  db.prepare(
    'INSERT INTO note_trash_restore_plans(operation_id,plan) VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET plan=excluded.plan',
  ).run(plan.operationId, JSON.stringify(plan));
}
export function noteTrashRestorePlan(db: AppDatabase, id: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_trash_restore_plans'").get())
    return;
  const row = db
    .prepare('SELECT plan FROM note_trash_restore_plans WHERE operation_id=?')
    .get(id) as any;
  return row ? (JSON.parse(row.plan) as NoteTrashRestorePlan) : undefined;
}
function durableCopy(source: string, dest: string, hash: string) {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  if (existsSync(dest)) {
    const s = lstatSync(dest);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || revisionFileDigest(dest) !== hash)
      fail(409, 'RESTORE_CONFLICT');
    return;
  }
  copyFileSync(source, dest, constants.COPYFILE_EXCL);
  const fd = openSync(dest, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (revisionFileDigest(dest) !== hash) fail(409, 'RESTORE_CONFLICT');
  fsyncDirectory(dirname(dest));
  fsyncDirectory(dirname(dirname(dest)));
}
/** Captured before active=0, so stable targets cannot be confused with replacements at old paths. */
export function captureNoteArchiveContext(
  config: AppConfig,
  db: AppDatabase,
  intent: {
    id: string;
    note_id: string;
    path: string;
    original_mtime: string | null;
    original_hash?: string | null;
    temp_path: string | null;
  },
) {
  archiveSchema(db);
  if (db.prepare('SELECT 1 FROM note_archive_contexts WHERE archive_id=?').get(intent.id)) return;
  const hash = revisionFileDigest(intent.temp_path!),
    file = intent.id + '.md';
  if (intent.original_hash && intent.original_hash !== hash) fail(409, 'RESTORE_CONFLICT');
  durableCopy(intent.temp_path!, join(config.dataRoot, 'history', file), hash);
  db.prepare('UPDATE write_intents SET original_hash=? WHERE id=?').run(hash, intent.id);
  recordRevisionContext(config, db, {
    ...intent,
    kind: 'archive',
    original_hash: hash,
    revision_id: intent.id,
    history_file: file,
  });
  retainArchiveContext(config, db, intent.id, intent.note_id, file);
}
function archiveSchema(db: AppDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS note_archive_contexts(archive_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,file TEXT NOT NULL,context TEXT NOT NULL)',
  );
}
function retainArchiveContext(
  config: AppConfig,
  db: AppDatabase,
  id: string,
  noteId: string,
  file: string,
) {
  const context = revisionContext(config, db, noteId, id);
  db.prepare(
    'INSERT INTO note_archive_contexts(archive_id,note_id,file,context) VALUES(?,?,?,?)',
  ).run(id, noteId, file, JSON.stringify(context));
  // Archive evidence has its own lifecycle and must not add an edit to visible revision history.
  db.prepare('DELETE FROM revisions WHERE id=?').run(id);
  return context;
}
function archiveRevision(config: AppConfig, db: AppDatabase, noteId: string, source: string) {
  archiveSchema(db);
  const row = db
    .prepare(
      "SELECT w.*,o.created_at FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.note_id=? AND w.kind='archive' AND w.status='recorded' AND w.path=(SELECT path FROM notes WHERE id=w.note_id) ORDER BY w.rowid DESC LIMIT 1",
    )
    .get(noteId) as any;
  if (!row) {
    const scanned = scanRevisionDestinations(source);
    if (
      /\.excalidraw$/i.test(source) ||
      hasDiagramDeclarationSync(source) ||
      scanned.nativeGroups.length ||
      scanned.spans.some((span) => /\.excalidraw(?:[?#]|$)/i.test(span.url))
    )
      fail(409, 'REVISION_REFERENCE_CONTEXT_INCOMPLETE');
    return;
  }
  if (basename(row.temp_path ?? '') !== basename(source)) fail(409, 'RESTORE_CONFLICT');
  const retained = db
    .prepare('SELECT context,file FROM note_archive_contexts WHERE archive_id=? AND note_id=?')
    .get(row.id, noteId) as any;
  if (retained) {
    const context = JSON.parse(retained.context) as RevisionContext;
    if (revisionFileDigest(join(config.dataRoot, 'history', retained.file)) !== context.contentHash)
      fail(409, 'REVISION_CONTENT_CONFLICT');
    return context;
  }
  if (!row.revision_id) {
    const hash = revisionFileDigest(source),
      file = row.id + '.md';
    if (row.original_hash && row.original_hash !== hash) fail(409, 'REVISION_CONTENT_CONFLICT');
    if (
      !row.original_hash &&
      !db
        .prepare(
          'SELECT 1 FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
        )
        .get(noteId, hash, row.path)
    ) {
      const scanned = scanRevisionDestinations(source);
      if (scanned.spans.length || scanned.nativeGroups.length || /\.excalidraw$/i.test(row.path))
        fail(409, 'REVISION_REFERENCE_CONTEXT_INCOMPLETE');
      return;
    }
    durableCopy(source, join(config.dataRoot, 'history', file), hash);
    // Old contexts are reconstructed only from exact publication hashes and recorded identity changes.
    db.prepare(
      'INSERT OR IGNORE INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)',
    ).run(row.id, noteId, file, new Date(row.created_at).toISOString(), row.original_mtime ?? '0');
    db.prepare('UPDATE write_intents SET revision_id=? WHERE id=?').run(row.id, row.id);
    // Only this temporary row is needed to reuse the historical evidence backfill rules.
    row.revision_id = row.id;
  }
  const context = retainArchiveContext(
    config,
    db,
    row.revision_id,
    noteId,
    row.revision_id + '.md',
  );
  db.prepare('UPDATE write_intents SET revision_id=NULL,history_file=NULL WHERE id=?').run(row.id);
  return context;
}
function writeAfter(config: AppConfig, operationId: string, bytes: string) {
  const file = join(config.dataRoot, 'note-restores', operationId, 'after');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    if (revisionFileDigest(file) !== sha256(bytes)) fail(409, 'RESTORE_CONFLICT');
    return file;
  }
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(file));
  fsyncDirectory(dirname(dirname(file)));
  fsyncDirectory(config.dataRoot);
  return file;
}
export function prepareNoteTrashRestore(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: {
    operationId: string;
    noteId: string;
    from: string;
    to: string;
    source: string;
    trashFile: string;
  },
): { plan: NoteTrashRestorePlan | undefined; targets: ArchivedNoteDiagramContext['targets'] } {
  const context = archiveRevision(config, db, input.noteId, input.source);
  if (!context) return { plan: undefined, targets: [] };
  if (
    context.contentHash !== revisionFileDigest(input.source) ||
    context.logicalPath !== input.from
  )
    fail(409, 'RESTORE_CONFLICT');
  const mapping = revisionIdentityMapping(
    config,
    db,
    {
      ...context.references,
      items: context.references.items.filter((ref) => ref.noteId !== input.noteId),
    },
    p,
  );
  const targets = context.references.items.flatMap((ref) =>
    ref.noteId && ref.noteId !== input.noteId
      ? [{ noteId: ref.noteId, path: mapping.get(ref.path) ?? ref.path }]
      : [],
  );
  mapping.set(input.from, input.to);
  const moves = [...mapping]
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }));
  if (!moves.length) return { plan: undefined, targets };
  if (!context.references.complete) fail(409, 'REVISION_REFERENCE_CONTEXT_INCOMPLETE');
  const original: ArchivedNoteDiagramContext = {
    noteId: input.noteId,
    logicalPath: input.from,
    trashFile: input.trashFile,
    hash: context.contentHash,
    stamp: fileVersionStamp(lstatSync(input.source, { bigint: true })),
    resources: context.references.items.flatMap((r) =>
      r.hash
        ? [
            {
              path: mapping.get(r.path) ?? r.path,
              hash: r.hash,
              stamp: fileVersionStamp(
                lstatSync(safePath(config.knowledgeRoot, mapping.get(r.path) ?? r.path, 'asset'), {
                  bigint: true,
                }),
              ),
            },
          ]
        : [],
    ),
    targets: context.references.items.flatMap((r) =>
      r.noteId && r.noteId !== input.noteId
        ? [{ noteId: r.noteId, path: mapping.get(r.path) ?? r.path }]
        : [],
    ),
  };
  const plan: NoteTrashRestorePlan = {
    version: 1,
    operationId: input.operationId,
    noteId: input.noteId,
    path: input.to,
    workspace: diagramOperationWorkspace(config, db),
    original,
    afterHash: '',
    afterFile: '',
    afterStamp: '',
    assets: [],
    receipts: [],
    resources: context.resources.map((r) => ({ ...r, path: mapping.get(r.path) ?? r.path })),
    references: context.references.items.flatMap((r) =>
      r.hash ? [{ path: mapping.get(r.path) ?? r.path, hash: r.hash }] : [],
    ),
    targets: context.references.items.flatMap((r) =>
      r.noteId && r.noteId !== input.noteId
        ? [{ noteId: r.noteId, path: mapping.get(r.path) ?? r.path }]
        : [],
    ),
    committing: false,
  };
  if (lstatSync(input.source).size > limits.file) {
    const scanned = scanRevisionDestinations(input.source);
    if (scanned.contentHash !== context.contentHash) fail(409, 'RESTORE_CONFLICT');
    if (
      context.documentType === 'markdown' &&
      scanned.complete &&
      !scanned.spans.length &&
      !scanned.nativeGroups.length
    )
      return { plan: undefined, targets };
    fail(413, 'FILE_TOO_LARGE');
  }
  {
    const changes = collectNativeLinkChanges(config, db, p, moves, {
      notes: [{ id: input.noteId, path: input.from }],
      noteTrash: original,
      referenceMapping: mapping,
    });
    if (changes.needs.length)
      fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请为恢复笔记的最终原生源码准备预览', false, {
        documents: changes.needs,
        planId: changes.needs[0].snapshotId,
      });
    const rewrite = changes.rewrites.get(input.noteId),
      before = readFileSync(input.source, 'utf8'),
      after = rewrite?.content ?? before;
    const registry = diagramOperationPreviewRegistry(config, db, p);
    for (const id of rewrite?.snapshotIds ?? []) {
      const prepared = registry.prepared(id)!,
        snapshot = registry.get(id);
      plan.receipts.push({
        id: prepared.id,
        hash: sha256(JSON.stringify(prepared)),
        primary: snapshot.input.role === 'primary',
      });
      for (const [role, asset, hash] of [
        ['source', prepared.source, prepared.sourceHash],
        ['preview', prepared.preview, prepared.previewHash],
      ] as const)
        if (asset && !plan.assets.some((a) => a.asset.relativePath === asset.relativePath))
          plan.assets.push({ asset, stage: join('diagram-operation-previews', id, role), hash });
    }
    const readAsset: typeof readBoundDiagramAsset = (cfg, path, role) => {
      const staged = plan.assets.find((a) => a.asset.relativePath === path);
      return staged
        ? readFileSync(join(config.dataRoot, staged.stage))
        : readBoundDiagramAsset(cfg, mapping.get(path) ?? path, role);
    };
    plan.diagram = planDiagramRelocation(
      config,
      db,
      input.noteId,
      before,
      after,
      input.from,
      input.to,
      moves,
      readAsset,
      rewrite?.primary,
    );
    plan.legacy = rewrite?.legacy;
    plan.afterFile = writeAfter(config, input.operationId, after);
  }
  plan.afterHash = revisionFileDigest(plan.afterFile);
  plan.afterStamp = fileVersionStamp(lstatSync(plan.afterFile, { bigint: true }));
  archivedNoteDiagramFile(config, db, original);
  store(db, plan);
  return { plan, targets };
}
export function verifyNoteTrashRestore(
  config: AppConfig,
  db: AppDatabase,
  plan: NoteTrashRestorePlan,
) {
  if (plan.workspace !== diagramOperationWorkspace(config, db))
    fail(409, 'LIBRARY_BINDING_CHANGED');
  archivedNoteDiagramFile(config, db, plan.original);
  const after = lstatSync(plan.afterFile, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    (after.mode & 0o777n) !== 0o600n ||
    fileVersionStamp(after) !== plan.afterStamp ||
    revisionFileDigest(plan.afterFile) !== plan.afterHash
  )
    fail(409, 'RESTORE_CONFLICT');
  for (const asset of plan.assets) {
    const path = join(config.dataRoot, asset.stage),
      s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      revisionFileDigest(path) !== asset.hash
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    if (asset.published?.stamp) {
      const published = safePath(config.knowledgeRoot, asset.asset.relativePath, 'asset');
      if (
        fileVersionStamp(lstatSync(published, { bigint: true })) !== asset.published.stamp ||
        revisionFileDigest(published) !== asset.hash
      )
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
  }
  for (const resource of plan.resources)
    if (sha256(readBoundDiagramAsset(config, resource.path, resource.role)) !== resource.hash)
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  for (const reference of plan.references)
    if (
      revisionFileDigest(safePath(config.knowledgeRoot, reference.path, 'asset')) !== reference.hash
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  for (const target of plan.targets)
    if (
      !db
        .prepare('SELECT 1 FROM notes WHERE id=? AND path=? AND active=1')
        .get(target.noteId, target.path)
    )
      fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
  for (const receipt of plan.receipts) {
    const operation = db
      .prepare("SELECT result FROM operations WHERE id=? AND status='succeeded'")
      .get(receipt.id) as { result: string } | undefined;
    if (!operation || sha256(operation.result) !== receipt.hash)
      fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    if (receipt.primary) {
      const prepared = db
        .prepare('SELECT result FROM diagram_prepared_primaries WHERE id=? AND note_id=?')
        .get(receipt.id, plan.noteId) as { result: string } | undefined;
      if (!prepared || sha256(prepared.result) !== receipt.hash)
        fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    }
  }
}
export function commitNoteRestore(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: {
    operationId: string;
    noteId: string;
    from: string;
    path: string;
    source: string;
    sourceHash: string;
    sourceStamp: string;
    targetHash: string;
    targets: ArchivedNoteDiagramContext['targets'];
  },
  plan?: NoteTrashRestorePlan,
) {
  db.transaction(() => {
    if (plan) verifyNoteTrashRestore(config, db, plan);
    if (
      fileVersionStamp(lstatSync(input.source, { bigint: true })) !== input.sourceStamp ||
      revisionFileDigest(input.source) !== input.sourceHash
    )
      fail(409, 'RESTORE_CONFLICT');
    for (const target of input.targets)
      if (
        !db
          .prepare('SELECT 1 FROM notes WHERE id=? AND path=? AND active=1')
          .get(target.noteId, target.path)
      )
        fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
    authorizeArchivedNoteOperation(
      config,
      db,
      p,
      input.noteId,
      [input.from, input.path],
      input.targets.map((t) => t.path),
      true,
    );
    // Root and persisted rights are checked in the same immediate transaction as the durable marker.
    const workspace = diagramOperationWorkspace(config, db);
    if (plan && plan.workspace !== workspace) fail(409, 'LIBRARY_BINDING_CHANGED');
    if (plan) {
      plan.committing = true;
      store(db, plan);
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS note_restore_commits(operation_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,path TEXT NOT NULL,target_hash TEXT NOT NULL,workspace TEXT NOT NULL,targets TEXT NOT NULL)',
    );
    if (
      !(db.prepare('PRAGMA table_info(note_restore_commits)').all() as { name: string }[]).some(
        (column) => column.name === 'targets',
      )
    )
      db.exec('ALTER TABLE note_restore_commits ADD COLUMN targets TEXT');
    db.prepare(
      'INSERT INTO note_restore_commits(operation_id,note_id,path,target_hash,workspace,targets) VALUES(?,?,?,?,?,?)',
    ).run(
      input.operationId,
      input.noteId,
      input.path,
      input.targetHash,
      workspace,
      JSON.stringify(input.targets),
    );
    const changed = db
      .prepare(
        "UPDATE operations SET status='committing',error=NULL WHERE id=? AND status='prepared'",
      )
      .run(input.operationId).changes;
    if (changed !== 1) fail(409, 'OPERATION_ALREADY_RESOLVED');
  }).immediate();
}
export function assertNoteRestoreCommitted(
  config: AppConfig,
  db: AppDatabase,
  intent: { id: string; note_id: string; path: string; target_hash: string | null },
) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_restore_commits'").get();
  const marker = exists
    ? (db.prepare('SELECT * FROM note_restore_commits WHERE operation_id=?').get(intent.id) as any)
    : undefined;
  if (
    !marker ||
    marker.note_id !== intent.note_id ||
    marker.path !== intent.path ||
    marker.target_hash !== intent.target_hash ||
    typeof marker.targets !== 'string' ||
    marker.workspace !== diagramOperationWorkspace(config, db)
  )
    fail(409, 'RESTORE_CONFLICT', '恢复操作尚未通过最终授权核对');
  for (const target of JSON.parse(marker.targets) as ArchivedNoteDiagramContext['targets'])
    if (
      !db
        .prepare('SELECT 1 FROM notes WHERE id=? AND path=? AND active=1')
        .get(target.noteId, target.path)
    )
      fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
}
export function noteTrashRestorePending(db: AppDatabase) {
  return (
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_trash_restore_plans'").get() &&
    !!db
      .prepare(
        "SELECT 1 FROM note_trash_restore_plans p JOIN operations o ON o.id=p.operation_id WHERE json_extract(p.plan,'$.committing')=1 AND o.status<>'succeeded' LIMIT 1",
      )
      .get()
  );
}
/** Own the inode and desired mode durably before copying bytes into the public parent. */
function prepareOwnedAssetTemp(
  config: AppConfig,
  db: AppDatabase,
  plan: NoteTrashRestorePlan,
  entry: NoteTrashRestorePlan['assets'][number],
  temp: string,
) {
  if (!existsSync(temp)) {
    if (entry.temporary || entry.published) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const owned = fstatSync(fd, { bigint: true });
      if (!owned.isFile() || (owned.mode & 0o777n) !== 0o600n)
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      entry.temporary = {
        dev: String(owned.dev),
        ino: String(owned.ino),
        mode: String(owned.mode),
      };
      fsyncDirectory(dirname(temp));
      store(db, plan);
      const source = openSync(
          join(config.dataRoot, entry.stage),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        ),
        buffer = Buffer.alloc(limits.io),
        hash = createHash('sha256');
      try {
        const before = fstatSync(source, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        let count: number;
        while ((count = readSync(source, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, count));
          let offset = 0;
          while (offset < count) offset += writeSync(fd, buffer, offset, count - offset);
        }
        if (
          hash.digest('hex') !== entry.hash ||
          fileVersionStamp(before) !== fileVersionStamp(fstatSync(source, { bigint: true }))
        )
          fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        fsyncSync(fd);
      } finally {
        closeSync(source);
      }
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(temp));
  }
  const s = lstatSync(temp, { bigint: true }),
    owned = entry.temporary;
  if (
    !owned ||
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1n ||
    (s.mode & 0o777n) !== 0o600n ||
    String(s.dev) !== owned.dev ||
    String(s.ino) !== owned.ino ||
    String(s.mode) !== owned.mode ||
    revisionFileDigest(temp) !== entry.hash
  )
    fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  return s;
}
export function publishNoteTrashRestoreAssets(
  config: AppConfig,
  db: AppDatabase,
  plan: NoteTrashRestorePlan,
) {
  if (!plan.committing) fail(409, 'RESTORE_CONFLICT');
  verifyNoteTrashRestore(config, db, plan);
  for (const entry of plan.assets) {
    validateRelative(entry.asset.relativePath, 'asset');
    const assetParent = safePath(
      config.knowledgeRoot,
      dirname(entry.asset.relativePath),
      'asset',
      true,
    );
    if (!existsSync(assetParent)) {
      mkdirSync(assetParent, { mode: 0o700 });
      fsyncDirectory(dirname(assetParent));
    }
    const path = join(assetParent, basename(entry.asset.relativePath)),
      parent = dirname(path),
      temp = join(parent, '.doo-note-restore-' + plan.operationId + '-' + entry.asset.id + '.tmp');
    if (!existsSync(parent)) {
      mkdirSync(parent, { mode: 0o700 });
      fsyncDirectory(dirname(parent));
    }
    if (!existsSync(path)) {
      const s = prepareOwnedAssetTemp(config, db, plan, entry, temp);
      entry.published = {
        dev: String(s.dev),
        ino: String(s.ino),
        mode: String(s.mode),
        mtime: String(s.mtimeNs),
      };
      store(db, plan);
      try {
        linkSync(temp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'NAME_CONFLICT');
        throw e;
      }
      fsyncDirectory(parent);
      unlinkSync(temp);
      fsyncDirectory(parent);
    }
    if (existsSync(temp)) {
      const temporary = lstatSync(temp, { bigint: true }),
        published = lstatSync(path, { bigint: true });
      if (
        !temporary.isFile() ||
        temporary.isSymbolicLink() ||
        temporary.dev !== published.dev ||
        temporary.ino !== published.ino ||
        temporary.nlink !== 2n ||
        revisionFileDigest(temp) !== entry.hash
      )
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      unlinkSync(temp);
      fsyncDirectory(parent);
    }
    const s = lstatSync(path, { bigint: true });
    if (
      !entry.published ||
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1n ||
      String(s.dev) !== entry.published.dev ||
      String(s.ino) !== entry.published.ino ||
      String(s.mode) !== entry.published.mode ||
      String(s.mtimeNs) !== entry.published.mtime ||
      revisionFileDigest(path) !== entry.hash
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const stamp = fileVersionStamp(s);
    if (entry.published.stamp && entry.published.stamp !== stamp)
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    if (!entry.published.stamp) {
      entry.published.stamp = stamp;
      store(db, plan);
    }
    const rows = db
      .prepare('SELECT id,path FROM assets WHERE id=? OR path=?')
      .all(entry.asset.id, entry.asset.relativePath) as any[];
    if (rows.some((row) => row.id !== entry.asset.id || row.path !== entry.asset.relativePath))
      fail(409, 'NAME_CONFLICT');
    db.prepare('INSERT OR IGNORE INTO assets(id,path) VALUES(?,?)').run(
      entry.asset.id,
      entry.asset.relativePath,
    );
  }
  if (plan.diagram) {
    const d = plan.diagram;
    db.prepare(
      'INSERT INTO diagram_pending_publications(operation_id,note_id,path,document_hash,manifest) VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET manifest=excluded.manifest',
    ).run(plan.operationId, plan.noteId, plan.path, plan.afterHash, JSON.stringify(d.manifest));
  }
  if (plan.legacy) {
    const m = plan.legacy as any;
    db.prepare(
      'INSERT OR REPLACE INTO legacy_diagram_previews(note_id,document_hash,render_hash,manifest,created_at) VALUES(?,?,?,?,?)',
    ).run(plan.noteId, m.documentHash, m.renderHash, JSON.stringify(m), Date.now());
  }
  verifyNoteTrashRestore(config, db, plan);
}
