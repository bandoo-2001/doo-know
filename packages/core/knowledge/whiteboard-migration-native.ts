import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';
import { diagramRendererVersions } from '../../../shared/diagram-primary.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { isWhiteboard } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { authorizePath } from '../agent/auth.js';
import { readDocument } from '../files.js';
import { localReference, references } from '../render.js';
import {
  collectNativeLinkChanges,
  type NativePreviewNeed,
  type NativeDocumentRewrite,
} from './native-link-plans.js';
import { diagramOperationPreviewRegistry } from './diagram-operation-previews.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { immutableMigrationFile, type MigrationRow } from './diagram-migration-journal.js';
export type MigrationNativeResource = { path: string; hash: string; role: 'source' | 'preview' };
export type MigrationNativeRewrite = NativeDocumentRewrite & {
  noteId: string;
  path: string;
  before: string;
  beforeHash: string;
  beforeModifiedAt: string;
  beforeResources: MigrationNativeResource[];
  afterResources: MigrationNativeResource[];
  beforeLegacy?: NativeDocumentRewrite['legacy'];
  beforeVersions: {
    document_hash: string;
    path: string;
    document_type: string;
    source_hash: string;
    render_hash: string;
    preview_hash: string;
    manifest: string;
    created_at: number;
  }[];
};
function resources(config: AppConfig, path: string, content: string): MigrationNativeResource[] {
  const found = new Map<string, MigrationNativeResource>();
  const parsed = parseDiagramDocument(content);
  for (const url of references(content)) {
    const target = localReference(path, url);
    if (!target?.split('/').includes('assets') || !/(?:\.png|\.excalidraw)$/i.test(target))
      continue;
    const role = target.endsWith('.png') ? 'preview' : 'source';
    found.set(target, {
      path: target,
      hash: sha256(readBoundDiagramAsset(config, target, role)),
      role,
    });
  }
  if (parsed.status === 'diagram')
    for (const [relative, hash, role] of [
      [parsed.primary.previewPath, parsed.primary.binding.previewHash, 'preview'],
      ...(parsed.primary.source.format === 'excalidraw'
        ? [[parsed.primary.source.path, parsed.primary.binding.sourceHash, 'source']]
        : []),
    ] as [string, string, 'source' | 'preview'][]) {
      const target = localReference(path, relative);
      if (!target) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      const actual = sha256(readBoundDiagramAsset(config, target, role));
      if (actual !== hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      found.set(target, { path: target, hash, role });
    }
  return [...found.values()];
}
/** Recollect only before cutover. Persist final bytes/proofs and original versions before activating the target. */
export function refreshMigrationNative(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  row: MigrationRow,
) {
  const fixed = JSON.parse(row.plan),
    moves = [{ from: row.old_path, to: row.new_path }],
    registry = diagramOperationPreviewRegistry(config, db, p);
  // Staging before cutover does not write references. Rebuild those bytes only when
  // their stable writer has never started; an issued/unknown receipt keeps its old baseline.
  const staged = JSON.parse(row.references_json) as {
    noteId: string;
    status: string;
    after?: string;
  }[];
  if (staged.length) {
    if (row.commit_operation_id) fail(409, 'REFERENCE_CONFLICT');
    for (const reference of staged) {
      const operation = db
        .prepare("SELECT 1 FROM operations WHERE kind='update' AND request_id=?")
        .get('migration-ref-' + row.id + '-' + reference.noteId);
      if (operation || reference.status === 'rewritten') fail(409, 'REFERENCE_CONFLICT');
      if (!reference.after) continue;
      const entry = fixed.inbound.find((x: any) => x.noteId === reference.noteId);
      if (!entry) fail(409, 'REFERENCE_CONFLICT');
      const current = notes.row(reference.noteId);
      authorizePath(p, current.path, 'knowledge:write');
      const document = readDocument(config.knowledgeRoot, current.path, {
        allowDiagramLarge: true,
      });
      entry.path = current.path;
      entry.hash = sha256(document.content);
      entry.modifiedAt = document.modifiedAt;
    }
  }
  const collected = collectNativeLinkChanges(config, db, p, moves, {
    excludeNoteIds: [row.note_id],
  });
  const needs: NativePreviewNeed[] = [...collected.needs],
    rewrites: MigrationNativeRewrite[] = [];
  // Rollback of a legacy source also requires an original-source PNG, even if it had none yet.
  for (const entry of fixed.inbound.filter((x: any) => x.native)) {
    if (!isWhiteboard(entry.path)) continue;
    const doc = readDocument(config.knowledgeRoot, entry.path),
      old = db
        .prepare(
          'SELECT manifest FROM legacy_diagram_previews WHERE note_id=? AND document_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        )
        .get(entry.noteId, sha256(doc.content)) as { manifest: string } | undefined;
    let manifest = old ? JSON.parse(old.manifest) : undefined;
    if (manifest) {
      const path = localReference(entry.path, manifest.preview.path);
      if (!path || sha256(readBoundDiagramAsset(config, path, 'preview')) !== manifest.preview.hash)
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
    if (!manifest) {
      const snapshot = registry.fix({
          noteId: entry.noteId,
          role: 'primary',
          documentPath: entry.path,
          documentHash: sha256(doc.content),
          documentModifiedAt: doc.modifiedAt,
          sourceHash: sha256(doc.content),
          finalSource: doc.content,
          type: 'whiteboard',
          title: entry.path
            .split('/')
            .at(-1)!
            .replace(/\.excalidraw$/i, ''),
          renderer: diagramRendererVersions.whiteboard,
          config: {},
          moves: [],
          context: { migrationId: row.id, purpose: 'rollback-original' },
        }),
        prepared = registry.prepared(snapshot.id);
      if (!prepared)
        needs.push({
          noteId: entry.noteId,
          role: 'primary',
          documentHash: sha256(doc.content),
          sourceHash: snapshot.sourceHash,
          renderHash: snapshot.renderHash,
          snapshotId: snapshot.id,
        });
      else
        manifest = {
          documentHash: sha256(doc.content),
          title: prepared.title,
          renderer: prepared.renderer,
          config: prepared.config,
          renderHash: prepared.renderHash,
          preview: { path: prepared.preview.markdownPath, hash: prepared.previewHash },
        };
    }
    if (manifest)
      fixed.originalLegacyPreviews = { ...fixed.originalLegacyPreviews, [entry.noteId]: manifest };
  }
  for (const [noteId, rewrite] of collected.rewrites) {
    const n = notes.row(noteId);
    authorizePath(p, n.path, 'knowledge:write');
    const before = readDocument(config.knowledgeRoot, n.path, { allowDiagramLarge: true }),
      beforeHash = sha256(before.content);
    const old = fixed.inbound.find((x: any) => x.noteId === noteId);
    // The final rewrite must keep its own baseline, including ordinary embedded-native sources.
    if (!old)
      fixed.inbound.push({
        noteId,
        path: n.path,
        hash: beforeHash,
        modifiedAt: before.modifiedAt,
        native: true,
      });
    else if (old.native && (old.hash !== beforeHash || old.modifiedAt !== before.modifiedAt)) {
      old.hash = beforeHash;
      old.modifiedAt = before.modifiedAt;
    }
    const beforeResources = resources(config, n.path, before.content),
      afterResources = resources(config, n.path, rewrite.content),
      beforeLegacy = fixed.originalLegacyPreviews?.[noteId];
    if (beforeLegacy) {
      const path = localReference(n.path, beforeLegacy.preview.path);
      if (!path) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      beforeResources.push({ path, hash: beforeLegacy.preview.hash, role: 'preview' });
    }
    const beforeVersions = db
      .prepare(
        'SELECT document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at FROM diagram_document_versions WHERE note_id=? AND document_hash=?',
      )
      .all(noteId, beforeHash) as MigrationNativeRewrite['beforeVersions'];
    rewrites.push({
      ...rewrite,
      noteId,
      path: n.path,
      before: before.content,
      beforeHash,
      beforeModifiedAt: before.modifiedAt,
      beforeResources,
      afterResources,
      beforeLegacy,
      beforeVersions,
    });
  }
  fixed.nativePreviewNeeds = needs;
  fixed.nativeRewrites = rewrites;
  db.prepare('UPDATE whiteboard_migrations SET plan=?,status=? WHERE id=?').run(
    JSON.stringify(fixed),
    needs.length ? 'awaiting-native-previews' : row.prepared ? 'prepared' : 'planned',
    row.id,
  );
  if (staged.length)
    db.prepare("UPDATE whiteboard_migrations SET references_json='[]' WHERE id=?").run(row.id);
  if (!needs.length)
    for (const rewrite of rewrites) {
      immutableMigrationFile(
        join(
          config.dataRoot,
          'whiteboard-migrations',
          row.id,
          'references',
          rewrite.noteId + '-' + rewrite.beforeHash + '.original',
        ),
        rewrite.before,
      );
      for (const resource of rewrite.beforeResources)
        immutableMigrationFile(
          join(
            config.dataRoot,
            'whiteboard-migrations',
            row.id,
            'resources',
            resource.hash + '.asset',
          ),
          readBoundDiagramAsset(config, resource.path, resource.role).toString('base64'),
        );
    }
  return { fixed, ready: needs.length === 0 };
}
export function verifyNativeMigrationResources(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  fixed: any,
  side: 'before' | 'after',
) {
  for (const rewrite of (fixed.nativeRewrites || []) as MigrationNativeRewrite[]) {
    authorizePath(p, rewrite.path, 'knowledge:write');
    for (const resource of side === 'before' ? rewrite.beforeResources : rewrite.afterResources) {
      if (sha256(readBoundDiagramAsset(config, resource.path, resource.role)) !== resource.hash)
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
  }
}
export function recordMigrationNativeProof(
  db: AppDatabase,
  fixed: any,
  noteId: string,
  side: 'before' | 'after',
) {
  const rewrite = (fixed.nativeRewrites || []).find(
    (x: MigrationNativeRewrite) => x.noteId === noteId,
  ) as MigrationNativeRewrite | undefined;
  if (!rewrite) return;
  const legacy = side === 'before' ? rewrite.beforeLegacy : rewrite.legacy;
  if (legacy)
    db.prepare(
      'INSERT OR REPLACE INTO legacy_diagram_previews(note_id,document_hash,render_hash,manifest,created_at) VALUES(?,?,?,?,?)',
    ).run(noteId, legacy.documentHash, legacy.renderHash, JSON.stringify(legacy), Date.now());
  if (side === 'before')
    for (const v of rewrite.beforeVersions)
      db.prepare(
        'INSERT OR IGNORE INTO diagram_document_versions(note_id,document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        noteId,
        v.document_hash,
        v.path,
        v.document_type,
        v.source_hash,
        v.render_hash,
        v.preview_hash,
        v.manifest,
        v.created_at,
      );
}

/** A committing migration is a retention root for its already-issued exact preparation tuple. */
export function retainMigrationNativePreparations(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  fixed: any,
) {
  verifyNativeMigrationResources(config, db, p, fixed, 'after');
  for (const rewrite of (fixed.nativeRewrites || []) as MigrationNativeRewrite[]) {
    const prepared = rewrite.primary;
    if (!prepared) continue;
    const issued = db
      .prepare(
        "SELECT result FROM operations WHERE id=? AND principal=? AND client_id=? AND status='succeeded'",
      )
      .get(prepared.id, p.id, p.clientId) as { result: string } | undefined;
    if (!issued) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    const proof = JSON.parse(issued.result) as PreparedDiagramPrimary;
    if (
      proof.noteId !== rewrite.noteId ||
      proof.sourceHash !== prepared.sourceHash ||
      proof.renderHash !== prepared.renderHash ||
      proof.previewHash !== prepared.previewHash ||
      proof.source?.relativePath !== prepared.source?.relativePath ||
      proof.preview.relativePath !== prepared.preview.relativePath
    )
      fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    const result = db
      .prepare(
        'UPDATE diagram_prepared_primaries SET expires_at=max(expires_at,?) WHERE id=? AND note_id=? AND source_hash=? AND render_hash=? AND preview_hash=? AND document_hash=? AND baseline_source_hash=?',
      )
      .run(
        Date.now() + 60 * 60 * 1000,
        prepared.id,
        rewrite.noteId,
        prepared.sourceHash,
        prepared.renderHash,
        prepared.previewHash,
        prepared.documentHash,
        prepared.baselineSourceHash,
      );
    if (!result.changes) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
  }
}
