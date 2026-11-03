import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { fsyncDirectory } from './core.js';
import { assertRoot } from '../indexing/reconcile.js';
import {
  archivedNoteDiagramFile,
  authorizeArchivedNoteOperation,
  type ArchivedNoteDiagramContext,
} from './archived-note-diagram-context.js';
import { lifecyclePrincipal } from './lifecycle-access.js';
import { join, posix } from 'node:path';
import {
  archivedDiagramRoot,
  archivedTreeInventory,
  type ArchivedDiagramContext,
} from './archived-diagram-context.js';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { DiagramDocumentType } from '../../../shared/diagram-document.js';
import type { PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import type { assetService } from '../assets.js';
import { authorizePath } from '../agent/auth.js';
import { safePath } from '../files.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { validateDiagramSource, validatePng, DIAGRAM_SOURCE_MIMES } from './diagram-artifacts.js';
import { sha256, beginOperation, completeOperation } from './operations.js';
import { fail } from './errors.js';

export type FixedDiagramSnapshotInput = {
  noteId: string;
  role: 'primary' | 'embedded';
  kind?: 'svg' | 'mermaid' | 'excalidraw';
  documentPath: string;
  documentHash: string;
  documentModifiedAt: string;
  sourcePath?: string;
  sourceHash: string;
  finalSource: string;
  type: DiagramDocumentType;
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  moves: { from: string; to: string }[];
  permissions?: string[];
  context?: unknown;
  archive?: ArchivedDiagramContext;
  noteTrash?: ArchivedNoteDiagramContext;
};
export type FixedDiagramSnapshot = {
  id: string;
  workspace: string;
  input: FixedDiagramSnapshotInput;
  source: string;
  sourceHash: string;
  renderHash: string;
  expiresAt: number;
};
const lease = 24 * 60 * 60 * 1000;
export function diagramOperationWorkspace(config: AppConfig, db: AppDatabase) {
  assertRoot(config, db);
  const root = (
    db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as {
      value: string;
    }
  ).value;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='organization_library'").get();
  const library = table
    ? db.prepare('SELECT library_id,binding_version FROM organization_library WHERE id=1').get()
    : undefined;
  return sha256(JSON.stringify([root, library]));
}

/** A frozen final-source lease shared by native relocation, migration and delivery.
 * Publication remains the caller's responsibility and uses its recoverable journal. */
export function diagramOperationPreviewRegistry(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  assets?: ReturnType<typeof assetService>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS diagram_operation_previews (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, client_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL, prepared TEXT,
    expires_at INTEGER NOT NULL, UNIQUE(principal,client_id,fingerprint)
  )`);
  const workspace = () => diagramOperationWorkspace(config, db);
  function validate(input: FixedDiagramSnapshotInput) {
    if (input.noteTrash) {
      authorizeArchivedNoteOperation(
        config,
        db,
        principal,
        input.noteId,
        [input.documentPath, ...(input.permissions ?? [])],
        input.noteTrash.targets.map((t) => t.path),
        true,
      );
      if (
        input.noteTrash.noteId !== input.noteId ||
        input.noteTrash.logicalPath !== input.documentPath ||
        input.noteTrash.hash !== input.documentHash
      )
        fail(409, 'TRASH_CHANGED');
      if (
        input.sourcePath &&
        !input.noteTrash.resources.some(
          (r) => r.path === input.sourcePath && r.hash === input.sourceHash,
        )
      )
        fail(409, 'DIAGRAM_SOURCE_CONFLICT');
      for (const t of input.noteTrash.targets)
        if (
          !db
            .prepare('SELECT 1 FROM notes WHERE id=? AND path=? AND active=1')
            .get(t.noteId, t.path)
        )
          fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
    }
    const actor = input.noteTrash
      ? lifecyclePrincipal(db, principal, 'note', input.noteId, input.documentPath)
      : principal;
    for (const path of new Set([input.documentPath, ...(input.permissions || [])]))
      authorizePath(
        input.noteTrash ? lifecyclePrincipal(db, actor, 'note', input.noteId, path) : actor,
        path,
        'knowledge:write',
      );
    const row = db.prepare('SELECT path,active FROM notes WHERE id=?').get(input.noteId) as
      | { path: string; active: number }
      | undefined;
    if (
      !row ||
      (input.archive || input.noteTrash ? row.active : !row.active) ||
      row.path !== input.documentPath
    )
      fail(409, 'VERSION_CONFLICT');
    if (input.archive && input.noteTrash) fail(400, 'INVALID_INPUT');
    const archiveRoot = input.archive ? archivedDiagramRoot(config, db, input.archive) : undefined;
    if (archiveRoot && archivedTreeInventory(archiveRoot) !== input.archive!.inventory)
      fail(409, 'TRASH_CHANGED');
    const path = input.noteTrash
      ? archivedNoteDiagramFile(config, db, input.noteTrash)
      : archiveRoot
        ? safePath(
            archiveRoot,
            input.documentPath.slice(input.archive!.logicalRoot.length + 1),
            'note',
          )
        : safePath(config.knowledgeRoot, input.documentPath, 'note');
    const stamp = lstatSync(path, { bigint: true });
    if (
      stamp.mtimeNs.toString() !== input.documentModifiedAt ||
      sha256(readFileSync(path)) !== input.documentHash
    )
      fail(409, 'VERSION_CONFLICT');
    if (
      input.sourcePath &&
      sha256(
        readBoundDiagramAsset(
          archiveRoot && input.sourcePath.startsWith(input.archive!.logicalRoot + '/')
            ? { ...config, knowledgeRoot: archiveRoot }
            : config,
          archiveRoot && input.sourcePath.startsWith(input.archive!.logicalRoot + '/')
            ? input.sourcePath.slice(input.archive!.logicalRoot.length + 1)
            : input.sourcePath,
          'source',
        ),
      ) !== input.sourceHash
    )
      fail(409, 'DIAGRAM_SOURCE_CONFLICT');
  }
  function get(id: string): FixedDiagramSnapshot {
    const row = db.prepare('SELECT * FROM diagram_operation_previews WHERE id=?').get(id) as any;
    if (!row || row.principal !== principal.id || row.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    if (row.expires_at <= Date.now()) fail(409, 'DIAGRAM_PREPARATION_EXPIRED');
    const snapshot = JSON.parse(row.snapshot) as FixedDiagramSnapshot;
    if (snapshot.workspace !== workspace()) fail(409, 'LIBRARY_BINDING_CHANGED');
    validate(snapshot.input);
    return snapshot;
  }
  function fix(input: FixedDiagramSnapshotInput): FixedDiagramSnapshot {
    input = { ...input, moves: input.moves.map(({ from, to }) => ({ from, to })) };
    const binding = workspace();
    validate(input);
    const fingerprint = sha256(JSON.stringify([binding, input]));
    const prior = db
      .prepare(
        'SELECT id,expires_at FROM diagram_operation_previews WHERE principal=? AND client_id=? AND fingerprint=?',
      )
      .get(principal.id, principal.clientId, fingerprint) as any;
    if (prior?.expires_at > Date.now()) return get(prior.id);
    if (prior)
      db.prepare(
        "UPDATE diagram_operation_previews SET fingerprint=fingerprint||':'||id WHERE id=?",
      ).run(prior.id);
    const sourceHash = sha256(input.finalSource);
    const renderHash = sha256(
      serializeDiagramRenderInput({
        type: input.type,
        sourceHash,
        title: input.title,
        renderer: input.renderer,
        config: input.config,
      }),
    );
    const snapshot: FixedDiagramSnapshot = {
      id: randomUUID(),
      workspace: binding,
      input,
      source: input.finalSource,
      sourceHash,
      renderHash,
      expiresAt: Date.now() + lease,
    };
    db.prepare(
      'INSERT INTO diagram_operation_previews(id,principal,client_id,fingerprint,snapshot,expires_at) VALUES(?,?,?,?,?,?)',
    ).run(
      snapshot.id,
      principal.id,
      principal.clientId,
      fingerprint,
      JSON.stringify(snapshot),
      snapshot.expiresAt,
    );
    return snapshot;
  }
  function prepared(id: string): PreparedDiagramPrimary | undefined {
    const snapshot = get(id);
    const row = db
      .prepare('SELECT prepared FROM diagram_operation_previews WHERE id=?')
      .get(id) as any;
    if (!row.prepared) return;
    const result = JSON.parse(row.prepared) as PreparedDiagramPrimary;
    if (snapshot.input.noteTrash) {
      const receipt = db
        .prepare(
          "SELECT result FROM operations WHERE id=? AND principal=? AND client_id=? AND status='succeeded'",
        )
        .get(result.id, principal.id, principal.clientId) as { result: string } | undefined;
      if (!receipt || sha256(receipt.result) !== sha256(JSON.stringify(result)))
        fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
      if (
        snapshot.input.role === 'primary' &&
        !db
          .prepare('SELECT 1 FROM diagram_prepared_primaries WHERE id=? AND note_id=? AND result=?')
          .get(result.id, result.noteId, JSON.stringify(result))
      )
        fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    }
    for (const [role, asset, hash] of [
      ['source', result.source, result.sourceHash],
      ['preview', result.preview, result.previewHash],
    ] as const)
      if (
        asset &&
        sha256(
          snapshot.input.archive || snapshot.input.noteTrash
            ? readFileSync(join(config.dataRoot, 'diagram-operation-previews', id, role))
            : readBoundDiagramAsset(config, asset.relativePath, role),
        ) !== hash
      )
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    return result;
  }
  function prepare(
    id: string,
    input: { sourceHash: string; pngBase64: string; requestId: string },
  ): PreparedDiagramPrimary {
    return workspaceWriteSync(db, { kind: 'diagram-operation.prepare' }, () => {
      const snapshot = get(id),
        fixed = snapshot.input;
      if (input.sourceHash !== snapshot.sourceHash) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
      if (typeof input.pngBase64 !== 'string' || input.pngBase64.length > 14 * 1024 * 1024)
        fail(413, 'DIAGRAM_PREVIEW_TOO_LARGE');
      const png = Buffer.from(input.pngBase64, 'base64');
      if (png.toString('base64') !== input.pngBase64) fail(400, 'INVALID_DIAGRAM_PNG');
      validatePng(png);
      const previewHash = sha256(png),
        prior = prepared(id);
      if (prior) {
        if (prior.previewHash !== previewHash) fail(409, 'IDEMPOTENCY_CONFLICT');
        return prior;
      }
      if (!assets) fail(500, 'DIAGRAM_ASSETS_UNAVAILABLE');
      const kind =
        fixed.kind ??
        (fixed.type === 'whiteboard'
          ? 'excalidraw'
          : fixed.type === 'flowchart'
            ? 'mermaid'
            : undefined);
      if (kind) validateDiagramSource(kind, Buffer.from(snapshot.source));
      const { operation } = beginOperation(
        db,
        principal,
        fixed.role === 'embedded'
          ? 'diagram-artifacts:' + fixed.noteId
          : 'diagram-operation.prepare',
        input.requestId,
        { snapshotId: id, sourceHash: snapshot.sourceHash, previewHash },
      );
      const upload = (name: string, mime: string, bytes: Buffer, role: 'source' | 'preview') => {
        if (!fixed.archive && !fixed.noteTrash)
          return assets!.upload(
            fixed.noteId,
            name,
            mime,
            bytes,
            'diagram-operation-' + id + '-' + role,
          );
        const directory = join(config.dataRoot, 'diagram-operation-previews', id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        fsyncDirectory(config.dataRoot);
        fsyncDirectory(join(config.dataRoot, 'diagram-operation-previews'));
        fsyncDirectory(directory);
        const file = join(directory, role);
        if (existsSync(file)) {
          if (sha256(readFileSync(file)) !== sha256(bytes)) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        } else {
          const fd = openSync(file, 'wx', 0o600);
          try {
            writeFileSync(fd, bytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        fsyncDirectory(directory);
        const assetId = randomUUID(),
          path = posix.join(
            posix.dirname(fixed.documentPath),
            DOO_ASSETS_DIRECTORY,
            'diagram-' + sha256(id + '-' + role) + posix.extname(name),
          );
        return {
          id: assetId,
          relativePath: path,
          markdownPath: posix.relative(posix.dirname(fixed.documentPath), path),
          mime,
        };
      };
      const source =
        fixed.type === 'whiteboard' || fixed.role === 'embedded'
          ? upload(
              'diagram.' + (kind === 'mermaid' ? 'mmd' : kind === 'svg' ? 'svg' : 'excalidraw'),
              kind === 'svg'
                ? 'image/svg+xml'
                : kind === 'mermaid'
                  ? 'text/plain'
                  : DIAGRAM_SOURCE_MIMES['.excalidraw'],
              Buffer.from(snapshot.source),
              'source',
            )
          : undefined;
      const preview = upload('diagram.png', 'image/png', png, 'preview');
      const result: PreparedDiagramPrimary = {
        id: operation.id,
        noteId: fixed.noteId,
        type: fixed.type,
        documentHash: fixed.documentHash,
        baselineSourceHash: fixed.sourceHash,
        sourceHash: snapshot.sourceHash,
        renderHash: snapshot.renderHash,
        previewHash,
        title: fixed.title,
        renderer: fixed.renderer,
        config: fixed.config,
        preview,
        ...(source ? { source } : {}),
        expiresAt: snapshot.expiresAt,
      };
      db.transaction(() => {
        if (fixed.noteTrash) validate(fixed);
        if (fixed.role === 'primary')
          db.prepare(
            'INSERT INTO diagram_prepared_primaries(id,note_id,principal,client_id,document_hash,baseline_source_hash,source_hash,render_hash,preview_hash,result,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            result.id,
            fixed.noteId,
            principal.id,
            principal.clientId,
            fixed.documentHash,
            fixed.sourceHash,
            result.sourceHash,
            result.renderHash,
            result.previewHash,
            JSON.stringify(result),
            Date.now(),
            result.expiresAt,
          );
        db.prepare('UPDATE diagram_operation_previews SET prepared=? WHERE id=?').run(
          JSON.stringify(result),
          id,
        );
        completeOperation(db, operation.id, result);
      }).immediate();
      return result;
    });
  }
  function metadata(id: string) {
    const snapshot = get(id),
      i = snapshot.input;
    return {
      id: snapshot.id,
      noteId: i.noteId,
      role: i.role,
      kind: i.kind,
      type: i.type,
      documentHash: i.documentHash,
      baselineSourceHash: i.sourceHash,
      sourceHash: snapshot.sourceHash,
      renderHash: snapshot.renderHash,
      title: i.title,
      renderer: i.renderer,
      config: i.config,
      sourceSizeBytes: Buffer.byteLength(snapshot.source),
      expiresAt: snapshot.expiresAt,
    };
  }
  function readSource(id: string, input: { offset: number; maxBytes?: number }) {
    const snapshot = get(id),
      bytes = Buffer.from(snapshot.source),
      max = input.maxBytes ?? 16384;
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > bytes.length ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > 32768
    )
      fail(400, 'INVALID_SOURCE_READ_BUDGET');
    const end = Math.min(bytes.length, input.offset + max);
    return {
      id,
      sourceHash: snapshot.sourceHash,
      offset: input.offset,
      nextOffset: end,
      totalBytes: bytes.length,
      encoding: 'base64' as const,
      content: bytes.subarray(input.offset, end).toString('base64'),
      eof: end === bytes.length,
    };
  }
  return { fix, get, prepared, prepare, metadata, readSource };
}
