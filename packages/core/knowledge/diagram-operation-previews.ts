import { randomUUID } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
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
};
export type FixedDiagramSnapshot = {
  id: string;
  input: FixedDiagramSnapshotInput;
  source: string;
  sourceHash: string;
  renderHash: string;
  expiresAt: number;
};
const lease = 24 * 60 * 60 * 1000;
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
  function validate(input: FixedDiagramSnapshotInput) {
    for (const path of new Set([input.documentPath, ...(input.permissions || [])]))
      authorizePath(principal, path, 'knowledge:write');
    const row = db.prepare('SELECT path,active FROM notes WHERE id=?').get(input.noteId) as
      | { path: string; active: number }
      | undefined;
    if (!row?.active || row.path !== input.documentPath) fail(409, 'VERSION_CONFLICT');
    const path = safePath(config.knowledgeRoot, input.documentPath, 'note');
    const stamp = lstatSync(path, { bigint: true });
    if (
      stamp.mtimeNs.toString() !== input.documentModifiedAt ||
      sha256(readFileSync(path)) !== input.documentHash
    )
      fail(409, 'VERSION_CONFLICT');
    if (
      input.sourcePath &&
      sha256(readBoundDiagramAsset(config, input.sourcePath, 'source')) !== input.sourceHash
    )
      fail(409, 'DIAGRAM_SOURCE_CONFLICT');
  }
  function get(id: string): FixedDiagramSnapshot {
    const row = db.prepare('SELECT * FROM diagram_operation_previews WHERE id=?').get(id) as any;
    if (!row || row.principal !== principal.id || row.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    if (row.expires_at <= Date.now()) fail(409, 'DIAGRAM_PREPARATION_EXPIRED');
    const snapshot = JSON.parse(row.snapshot) as FixedDiagramSnapshot;
    validate(snapshot.input);
    return snapshot;
  }
  function fix(input: FixedDiagramSnapshotInput): FixedDiagramSnapshot {
    input = { ...input, moves: input.moves.map(({ from, to }) => ({ from, to })) };
    validate(input);
    const fingerprint = sha256(JSON.stringify(input));
    const prior = db
      .prepare(
        'SELECT id,expires_at FROM diagram_operation_previews WHERE principal=? AND client_id=? AND fingerprint=?',
      )
      .get(principal.id, principal.clientId, fingerprint) as any;
    if (prior?.expires_at > Date.now()) return get(prior.id);
    if (prior) db.prepare('DELETE FROM diagram_operation_previews WHERE id=?').run(prior.id);
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
    get(id);
    const row = db
      .prepare('SELECT prepared FROM diagram_operation_previews WHERE id=?')
      .get(id) as any;
    if (!row.prepared) return;
    const result = JSON.parse(row.prepared) as PreparedDiagramPrimary;
    for (const [role, asset, hash] of [
      ['source', result.source, result.sourceHash],
      ['preview', result.preview, result.previewHash],
    ] as const)
      if (asset && sha256(readBoundDiagramAsset(config, asset.relativePath, role)) !== hash)
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
      const source =
        fixed.type === 'whiteboard' || fixed.role === 'embedded'
          ? assets.upload(
              fixed.noteId,
              'diagram.' + (kind === 'mermaid' ? 'mmd' : kind === 'svg' ? 'svg' : 'excalidraw'),
              kind === 'svg'
                ? 'image/svg+xml'
                : kind === 'mermaid'
                  ? 'text/plain'
                  : DIAGRAM_SOURCE_MIMES['.excalidraw'],
              Buffer.from(snapshot.source),
              'diagram-operation-' + id + '-source',
            )
          : undefined;
      const preview = assets.upload(
        fixed.noteId,
        'diagram.png',
        'image/png',
        png,
        'diagram-operation-' + id + '-preview',
      );
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
