import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { posix } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { parseWhiteboard, MAX_WHITEBOARD_BYTES } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath, requireScope } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { safePath } from '../files.js';
import { localReference } from '../render.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { readPrimaryDiagramState } from './primary-diagram-state.js';
import { revisionContext } from './revision-context.js';
import { revisionIdentityMapping } from './revision-identities.js';
import { noteIdAtPath } from './note-path-aliases.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';

/** Convert only an explicitly chosen old scene backed by this note's migration evidence.
 * No publication occurs here; the normal final-source PNG preparation still gates saving. */
export function legacyDraftConversionService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  principal: Principal,
) {
  return (
    noteId: string,
    input: {
      draft: string;
      baseRevision: string;
      expectedDocumentHash: string;
      expectedSourceHash: string;
    },
  ) => {
    if (isSharePrincipal(principal)) fail(403, 'FORBIDDEN');
    requireScope(principal, 'knowledge:write');
    const row = notes.row(noteId);
    authorizePath(principal, row.path, 'knowledge:write');
    const current = readPrimaryDiagramState(db, notes, assets, principal, noteId);
    if (current.note.publication) fail(409, 'OPERATION_OUTCOME_UNKNOWN');
    if (current.parsed.type !== 'whiteboard') fail(409, 'DIAGRAM_TYPE_MISMATCH');
    if (current.documentHash !== input.expectedDocumentHash) fail(409, 'VERSION_CONFLICT');
    if (current.sourceHash !== input.expectedSourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
    const migration = db
      .prepare(
        "SELECT old_path,plan,prepared,commit_operation_id FROM whiteboard_migrations WHERE note_id=? AND status IN ('committed','references_pending') ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(noteId) as
      | { old_path: string; plan: string; prepared: string; commit_operation_id: string }
      | undefined;
    if (!migration)
      fail(409, 'LEGACY_DRAFT_MIGRATION_UNAVAILABLE', '没有可核对的旧白板迁移记录，草稿已保留');
    const fixed = JSON.parse(migration.plan),
      prepared = JSON.parse(migration.prepared);
    let base: string | undefined;
    try {
      base = /^\d+$/.test(input.baseRevision)
        ? input.baseRevision
        : JSON.parse(input.baseRevision)?.[0];
    } catch {}
    if (base !== fixed.oldModifiedAt)
      fail(409, 'LEGACY_DRAFT_VERSION_CONFLICT', '草稿原始版本无法与迁移原件对应，草稿已保留');
    if (
      current.sourceHash !== prepared.sourceHash ||
      current.parsed.primary.binding.renderHash !== prepared.renderHash
    )
      fail(409, 'DIAGRAM_SOURCE_CONFLICT', '迁移后的图形已有新编辑，草稿已保留，请先核对两版');
    let scene: ReturnType<typeof parseWhiteboard>;
    try {
      scene = parseWhiteboard(input.draft);
    } catch {
      return fail(400, 'INVALID_LEGACY_DRAFT');
    }
    if (![1, 2].includes(scene.version)) fail(409, 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED');
    if (scene.dooknow?.id && scene.dooknow.id !== noteId)
      fail(409, 'LEGACY_DRAFT_IDENTITY_CONFLICT');
    const context = revisionContext(config, db, noteId, migration.commit_operation_id),
      mapping = revisionIdentityMapping(config, db, context.references, principal);
    mapping.set(migration.old_path, current.note.relativePath);
    for (const element of scene.elements) {
      if (typeof element.link !== 'string') continue;
      const old = localReference(migration.old_path, element.link);
      if (!old || mapping.has(old)) continue;
      const targetId = noteIdAtPath(db, old, principal),
        target = targetId
          ? (
              db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(targetId) as
                | { path: string }
                | undefined
            )?.path
          : old;
      if (!target) fail(409, 'LEGACY_DRAFT_REFERENCE_UNAVAILABLE');
      authorizePath(principal, target);
      if (
        !existsSync(
          safePath(
            config.knowledgeRoot,
            target,
            isCompatibleAssetPath(target) ? 'asset' : 'note',
            true,
          ),
        )
      )
        fail(409, 'LEGACY_DRAFT_REFERENCE_UNAVAILABLE', '草稿引用资源已变化，草稿已保留');
      mapping.set(old, target);
    }
    const targetSource = posix.join(
      posix.dirname(current.note.relativePath),
      DOO_ASSETS_DIRECTORY,
      'legacy-draft.excalidraw',
    );
    const source = rewriteLibraryReferences(
      input.draft,
      migration.old_path,
      targetSource,
      [...mapping].map(([from, to]) => ({ from, to })),
      true,
    ).content;
    if (Buffer.byteLength(source) > MAX_WHITEBOARD_BYTES)
      fail(413, 'LEGACY_DRAFT_TOO_LARGE', '重定位后的草稿超过白板大小上限，原草稿仍保留');
    return {
      source,
      sourceHash: sha256(source),
      expectedDocumentHash: current.documentHash,
      expectedSourceHash: current.sourceHash,
    };
  };
}
