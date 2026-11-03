import { hasDiagramResourceProof } from './diagram-publications.js';
import type { AppDatabase } from '../db.js';
import { sha256 as sourceDigest } from './operations.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath, canAccessPath } from '../agent/auth.js';
import { validateRelative } from '../files.js';
import { localReference } from '../render.js';
import { isSharePrincipal } from '../share-policy.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';

/** Every consumer gets original source bytes; Markdown note.content never masquerades as JSON. */
export function readPrimaryDiagramState(
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  principal: Principal,
  noteId: string,
) {
  const row = notes.row(noteId);
  authorizePath(principal, row.path);
  if (isSharePrincipal(principal)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
  const note = notes.getNote(noteId),
    parsed = parseDiagramDocument(note.content);
  if (parsed.status !== 'diagram')
    fail(422, 'INVALID_DIAGRAM_DOCUMENT', '请使用 Markdown 源码恢复图形文档');
  const source = parsed.primary.source;
  let sourceContent: string, sourcePath: string | undefined;
  if (source.format === 'excalidraw') {
    sourcePath = localReference(note.relativePath, source.path);
    if (!sourcePath) fail(400, 'INVALID_DIAGRAM_SOURCE');
    validateRelative(sourcePath, 'asset');
    if (
      !canAccessPath(principal, sourcePath) &&
      !hasDiagramResourceProof(db, noteId, sourcePath, parsed.primary.binding.sourceHash, 'source')
    )
      fail(403, 'FORBIDDEN');
    try {
      sourceContent = assets.file(sourcePath).bytes.toString('utf8');
      if (
        !canAccessPath(principal, sourcePath) &&
        sourceDigest(sourceContent) !== parsed.primary.binding.sourceHash
      )
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    } catch {
      return fail(409, 'DIAGRAM_SOURCE_UNAVAILABLE', '图形编辑数据不可用，请核对原始附件');
    }
  } else sourceContent = source.content;
  return {
    note,
    parsed,
    sourceContent,
    sourcePath,
    documentHash: sha256(note.content),
    sourceHash: sha256(sourceContent),
  };
}
