import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { noteIdAtPath } from './note-path-aliases.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppConfig } from '../../../shared/contracts.js';
import { diagramResourceSchema, type DiagramResource } from '../../../shared/diagram-resource.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import {
  diagramRendererVersions,
  primaryRenderDescriptor,
} from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { authorizePath, canAccessPath, requireScope } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { localReference } from '../render.js';
import { hasDiagramResourceProof } from './diagram-publications.js';
import { readBoundDiagramAssetSnapshot } from './diagram-resource-files.js';
import { validateDiagramSource, validatePng } from './diagram-artifacts.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { isWhiteboard, whiteboardId, whiteboardReference } from '../../../shared/whiteboard.js';
import { resolveLegacyDiagram } from './legacy-diagram-previews.js';

export type DiagramSourceSnapshot = {
  noteId: string;
  documentHash: string;
  modifiedAt: string;
  sourceHash: string;
  format: DiagramResource['source']['format'];
  title: string;
  content: string;
  sourcePath?: string;
};
export type DiagramResolveOptions = {
  maxInlineBytes?: number;
  sourceHandle?: (snapshot: DiagramSourceSnapshot) => string;
};
/** Private resource resolution: published Markdown and editable source stay separate wire objects. */
export function resolvePrimaryDiagram(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  principal: Principal,
  noteId: string,
  options: DiagramResolveOptions = {},
): DiagramResource {
  if (isSharePrincipal(principal)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
  const row = notes.row(noteId);
  authorizePath(principal, row.path);
  if (isWhiteboard(row.path))
    return resolveLegacyDiagram(config, db, notes, principal, noteId, options);
  const { note } = notes.getNoteSnapshot(noteId),
    parsed = parseDiagramDocument(note.content);
  if (parsed.status !== 'diagram')
    fail(422, 'INVALID_DIAGRAM_DOCUMENT', '请使用 Markdown 源码恢复图形文档');
  const declared = parsed.primary.source,
    binding = parsed.primary.binding,
    descriptor = primaryRenderDescriptor(parsed),
    documentHash = sha256(note.content),
    issues: { code: string }[] = [];
  const format = declared.format;
  let content: string | undefined,
    sourcePath: string | undefined,
    sourceHash = binding.sourceHash;
  try {
    if (format === 'excalidraw') {
      sourcePath = localReference(note.relativePath, declared.path);
      if (!sourcePath || !isCompatibleAssetPath(sourcePath)) throw Error();
      if (
        !canAccessPath(principal, sourcePath) &&
        !hasDiagramResourceProof(db, noteId, sourcePath, binding.sourceHash, 'source')
      )
        throw Error();
      const snapshot = readBoundDiagramAssetSnapshot(config, sourcePath, 'source');
      validateDiagramSource('excalidraw', snapshot.bytes);
      content = snapshot.bytes.toString('utf8');
      sourceHash = sha256(snapshot.bytes);
      if (!canAccessPath(principal, sourcePath) && sourceHash !== binding.sourceHash) {
        content = undefined;
        sourceHash = binding.sourceHash;
        throw Error();
      }
    } else content = declared.content;
    if (content !== undefined) sourceHash = sha256(content);
  } catch {
    content = undefined;
    issues.push({ code: 'DIAGRAM_SOURCE_UNAVAILABLE' });
  }
  const sourceAvailable = content !== undefined;
  if (sourceAvailable && sourceHash !== binding.sourceHash)
    issues.push({ code: 'DIAGRAM_SOURCE_CONFLICT' });
  let expectedRender: string | undefined;
  try {
    expectedRender = sha256(
      serializeDiagramRenderInput({
        type: parsed.type,
        sourceHash,
        title: parsed.title,
        renderer: descriptor.renderer,
        config: descriptor.config,
      }),
    );
  } catch {
    issues.push({ code: 'INVALID_DIAGRAM_RENDER_CONFIG' });
  }
  const supported = descriptor.renderer === diagramRendererVersions[parsed.type];
  if (!supported) issues.push({ code: 'DIAGRAM_RENDERER_UNSUPPORTED' });
  let previewState: 'ready' | 'stale' | 'missing' = 'stale';
  try {
    const path = localReference(note.relativePath, parsed.primary.previewPath);
    if (!path || !isCompatibleAssetPath(path)) throw Error();
    // The PNG itself is explicitly included in the readable main document; this never grants native source access.
    const snapshot = readBoundDiagramAssetSnapshot(config, path, 'preview');
    validatePng(snapshot.bytes);
    if (sha256(snapshot.bytes) !== binding.previewHash)
      issues.push({ code: 'DIAGRAM_PREVIEW_STALE' });
    else if (
      sourceAvailable &&
      sourceHash === binding.sourceHash &&
      expectedRender === binding.renderHash
    )
      previewState = 'ready';
    else issues.push({ code: 'DIAGRAM_PREVIEW_STALE' });
  } catch {
    previewState = 'missing';
    issues.push({ code: 'DIAGRAM_PREVIEW_MISSING' });
  }
  let writable = false;
  try {
    requireScope(principal, 'knowledge:write');
    writable = true;
  } catch {
    /* Read grants still allow an authorized native download. */
  }
  if (sourceAvailable && format === 'excalidraw') {
    const version = JSON.parse(content!).version;
    if (version !== 1 && version !== 2) {
      writable = false;
      issues.push({ code: 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED' });
    }
  }
  const source: DiagramResource['source'] = { format, hash: sourceHash };
  if (sourceAvailable) {
    const max = options.maxInlineBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 0 || max > 8 * 1024 * 1024)
      fail(400, 'INVALID_SOURCE_READ_BUDGET');
    if (Buffer.byteLength(content!) <= max) source.content = content!;
    else if (options.sourceHandle)
      source.readHandle = options.sourceHandle({
        noteId,
        documentHash,
        modifiedAt: note.modifiedAt,
        sourceHash,
        format,
        title: parsed.title,
        sourcePath,
        content: content!,
      });
    else fail(413, 'DIAGRAM_SOURCE_HANDLE_REQUIRED', '请使用有界原件读取句柄');
    if (format === 'excalidraw') source.path = declared.path;
  }
  return diagramResourceSchema.parse({
    version: 1,
    noteId,
    documentType: parsed.type,
    title: parsed.title,
    role: 'primary',
    documentHash,
    source,
    render: descriptor,
    preview: {
      path: parsed.primary.previewPath,
      hash: binding.previewHash,
      renderHash: binding.renderHash,
      state: previewState,
    },
    capabilities: {
      canEdit:
        writable &&
        supported &&
        sourceAvailable &&
        sourceHash === binding.sourceHash &&
        !note.publication,
      canDownloadSource: sourceAvailable,
    },
    ...(note.publication ? { publication: note.publication } : {}),
    ...(issues.length ? { issues } : {}),
  });
}

/** Resolve document identity first; never interpret a Markdown main file as scene JSON. */
export function resolveWhiteboardResource(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  principal: Principal,
  parentPath: string,
  reference: string,
  options: DiagramResolveOptions = {},
): DiagramResource {
  const ref = whiteboardReference(reference),
    path = ref && !whiteboardId(ref) ? localReference(parentPath, ref) : undefined;
  const id =
    ref &&
    (whiteboardId(ref) ||
      (path && noteIdAtPath(db, path, principal)));
  if (!id) fail(404, 'WHITEBOARD_NOT_FOUND');
  const resource = resolvePrimaryDiagram(config, db, notes, principal, id, options);
  if (resource.documentType !== 'whiteboard') fail(404, 'WHITEBOARD_NOT_FOUND');
  return resource;
}
