import { posix } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { WhiteboardMigrationPreflight } from '../../../shared/whiteboard-migration.js';
import { documentTitle, isWhiteboard, parseWhiteboard } from '../../../shared/whiteboard.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { authorizePath, canAccessPath } from '../agent/auth.js';
import { readDocument, safePath } from '../files.js';
import { localReference, renderMarkdownReferences } from '../render.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { validateDiagramSource } from './diagram-artifacts.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { hasUnaffectedPublishedNativeLinks } from './native-link-proof.js';

export function preflightWhiteboardMigration(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  id: string,
): WhiteboardMigrationPreflight {
  const row = notes.row(id);
  authorizePath(p, row.path, 'knowledge:write');
  if (!isWhiteboard(row.path)) fail(409, 'MIGRATION_NOT_LEGACY');
  const old = readDocument(config.knowledgeRoot, row.path, { allowDiagramLarge: true }),
    newPath = row.path.replace(/\.excalidraw$/i, '.md');
  const result: WhiteboardMigrationPreflight = {
    noteId: id,
    oldPath: row.path,
    newPath,
    oldHash: sha256(old.content),
    oldModifiedAt: old.modifiedAt,
    source: old.content,
    sourceHash: sha256(old.content),
    title: documentTitle(row.path),
    inbound: [],
    issues: [],
  };
  if (
    existsSync(safePath(config.knowledgeRoot, newPath, 'note', true)) ||
    db
      .prepare(
        "SELECT 1 FROM diagram_creation_intents WHERE path=? AND status IN ('reserved','prepared') AND expires_at>?",
      )
      .get(newPath, Date.now())
  )
    result.issues.push({ code: 'NAME_CONFLICT', path: newPath });
  if (
    db
      .prepare(
        "SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted')",
      )
      .get(id)
  )
    result.issues.push({ code: 'OPERATION_OUTCOME_UNKNOWN' });
  if (
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'").get() &&
    db
      .prepare('SELECT 1 FROM note_write_leases WHERE note_id=? AND lease_until>?')
      .get(id, Date.now())
  )
    result.issues.push({ code: 'OPERATION_IN_PROGRESS' });
  try {
    const scene = JSON.parse(old.content);
    validateDiagramSource('excalidraw', Buffer.from(old.content));
    if (![1, 2].includes(scene.version))
      result.issues.push({ code: 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED' });
    for (const element of scene.elements) {
      if (
        element.type === 'image' &&
        !element.isDeleted &&
        (!element.fileId || !scene.files?.[element.fileId])
      )
        result.issues.push({ code: 'MISSING_REFERENCE', path: String(element.fileId || 'image') });
    }
    for (const element of scene.elements)
      if (
        typeof element.link === 'string' &&
        element.link &&
        !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(element.link)
      ) {
        const target = localReference(row.path, element.link);
        if (!target) {
          result.issues.push({ code: 'INVALID_NATIVE_REFERENCE' });
          continue;
        }
        if (!canAccessPath(p, target)) {
          result.issues.push({ code: 'FORBIDDEN_REFERENCE', path: target });
          continue;
        }
        if (
          !existsSync(
            safePath(
              config.knowledgeRoot,
              target,
              target.includes('/assets/') ? 'asset' : 'note',
              true,
            ),
          )
        )
          result.issues.push({ code: 'MISSING_REFERENCE', path: target });
        const suffix = element.link.match(/[?#].*$/)?.[0] || '';
        // Legacy links use the main document directory; final sources use the assets directory.
        element.link =
          posix.relative(
            posix.join(posix.dirname(newPath), 'assets'),
            target === row.path ? newPath : target,
          ) + suffix;
      }
    result.source = JSON.stringify(scene);
    result.sourceHash = sha256(result.source);
  } catch {
    result.issues.push({ code: 'INVALID_WHITEBOARD' });
  }
  for (const other of db.prepare('SELECT id,path FROM notes WHERE active=1 AND id<>?').all(id) as {
    id: string;
    path: string;
  }[]) {
    if (!canAccessPath(p, other.path)) continue;
    try {
      const doc = readDocument(config.knowledgeRoot, other.path, { allowDiagramLarge: true });
      let native = false,
        found = false,
        quarantined = false;
      if (isWhiteboard(other.path)) {
        native = true;
        found = parseWhiteboard(doc.content).elements.some(
          (e) => typeof e.link === 'string' && localReference(other.path, e.link) === row.path,
        );
      } else {
        const parsed = parseDiagramDocument(doc.content);
        if (parsed.status === 'diagram' && parsed.primary.source.format === 'excalidraw') {
          const sourcePath = localReference(other.path, parsed.primary.source.path);
          if (sourcePath) {
            try {
              const bytes = readBoundDiagramAsset(config, sourcePath, 'source');
              if (sha256(bytes) !== parsed.primary.binding.sourceHash)
                throw Error('Source changed');
              const source = parseWhiteboard(bytes.toString('utf8'));
              found = source.elements.some(
                (e) =>
                  typeof e.link === 'string' && localReference(sourcePath, e.link) === row.path,
              );
              native = found;
            } catch (error) {
              if (
                !hasUnaffectedPublishedNativeLinks(db, {
                  noteId: other.id,
                  documentHash: sha256(doc.content),
                  documentPath: other.path,
                  sourcePath,
                  sourceHash: parsed.primary.binding.sourceHash,
                  moves: [{ from: row.path, to: newPath }],
                })
              )
                throw error;
              quarantined = true;
            }
          }
        }
        found ||=
          markdownDestinationSpans(doc.content).some(
            (s) => localReference(other.path, s.url) === row.path,
          ) ||
          renderMarkdownReferences(doc.content).some(
            (ref) => ref === id || localReference(other.path, ref) === row.path,
          );
        if (found && quarantined) throw Error('Unavailable source in affected document');
      }
      if (found)
        result.inbound.push({
          noteId: other.id,
          path: other.path,
          hash: sha256(doc.content),
          modifiedAt: doc.modifiedAt,
          native,
        });
    } catch {
      result.issues.push({ code: 'INBOUND_SCAN_INCOMPLETE', path: other.path });
    }
  }
  return result;
}
