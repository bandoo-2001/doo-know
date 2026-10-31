import type { AppConfig } from '../../../shared/contracts.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { AppDatabase } from '../db.js';
import type { DiagramDocumentType } from '../../../shared/diagram-document.js';
import type { PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';

export type DiagramVersionResource = { role: 'source' | 'preview'; path: string; hash: string };
export type DiagramVersionManifest = {
  type: DiagramDocumentType;
  sourceHash: string;
  renderHash: string;
  previewHash: string;
  resources: DiagramVersionResource[];
};
/** A resource belongs to a note by a fixed version/lease, never merely by an arbitrary new link. */
export function hasDiagramResourceProof(
  db: AppDatabase,
  noteId: string,
  path: string,
  hash: string,
  role: 'source' | 'preview',
) {
  const versions = db
    .prepare('SELECT manifest FROM diagram_document_versions WHERE note_id=?')
    .all(noteId) as { manifest: string }[];
  for (const version of versions) {
    try {
      if (
        (JSON.parse(version.manifest) as DiagramVersionManifest).resources.some(
          (resource) => resource.role === role && resource.path === path && resource.hash === hash,
        )
      )
        return true;
    } catch {
      /* A malformed retained manifest grants no authority. */
    }
  }
  const preparations = db
    .prepare('SELECT result FROM diagram_prepared_primaries WHERE note_id=? AND expires_at>?')
    .all(noteId, Date.now()) as { result: string }[];
  for (const row of preparations) {
    try {
      const prepared = JSON.parse(row.result) as PreparedDiagramPrimary,
        asset = role === 'source' ? prepared.source : prepared.preview;
      if (
        asset?.relativePath === path &&
        (role === 'source' ? prepared.sourceHash : prepared.previewHash) === hash
      )
        return true;
    } catch {
      /* Same fail-closed rule for preparation receipts. */
    }
  }
  return false;
}
export function verifyPendingDiagramPublication(
  config: AppConfig,
  db: AppDatabase,
  operationId: string,
) {
  const pending = db
    .prepare('SELECT * FROM diagram_pending_publications WHERE operation_id=?')
    .get(operationId) as
    | {
        note_id: string;
        path: string;
        document_hash: string;
        manifest: string;
        creation_intent_id: string | null;
      }
    | undefined;
  if (!pending) return;
  const manifest = JSON.parse(pending.manifest) as DiagramVersionManifest;
  // Recovery must validate the same immutable resources before it can activate a main file.
  for (const resource of manifest.resources) {
    try {
      if (sha256(readBoundDiagramAsset(config, resource.path, resource.role)) !== resource.hash)
        throw Error();
    } catch {
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT', '固定图形资源缺失或已变化，发布仍待恢复');
    }
  }
  if (pending.creation_intent_id) {
    const creation = db
      .prepare(
        'SELECT status,commit_operation_id FROM diagram_creation_intents WHERE id=? AND note_id=?',
      )
      .get(pending.creation_intent_id, pending.note_id) as
      | { status: string; commit_operation_id: string | null }
      | undefined;
    if (
      !creation ||
      !['prepared', 'reserved', 'published'].includes(creation.status) ||
      creation.commit_operation_id !== operationId
    )
      fail(409, 'CREATION_INTENT_UNAVAILABLE');
  }

  return { pending, manifest };
}
export function recordDiagramPublication(config: AppConfig, db: AppDatabase, operationId: string) {
  const verified = verifyPendingDiagramPublication(config, db, operationId);
  if (!verified) return;
  const { pending, manifest } = verified;
  db.prepare(
    'INSERT OR IGNORE INTO diagram_document_versions(note_id,document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    pending.note_id,
    pending.document_hash,
    pending.path,
    manifest.type,
    manifest.sourceHash,
    manifest.renderHash,
    manifest.previewHash,
    pending.manifest,
    Date.now(),
  );
  db.prepare('UPDATE document_state SET document_type=? WHERE note_id=?').run(
    manifest.type,
    pending.note_id,
  );
  if (pending.creation_intent_id)
    db.prepare(
      "UPDATE diagram_creation_intents SET status='published',published_hash=? WHERE id=? AND note_id=?",
    ).run(pending.document_hash, pending.creation_intent_id, pending.note_id);
}
