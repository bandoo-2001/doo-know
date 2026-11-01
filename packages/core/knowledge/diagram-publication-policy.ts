import { readBoundDiagramAsset } from './diagram-resource-files.js';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import {
  primaryRenderDescriptor,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import { whiteboardText } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import { canAccessPath } from '../agent/auth.js';
import { validateRelative } from '../files.js';
import { localReference } from '../render.js';
import { isSharePrincipal } from '../share-policy.js';
import { validateDiagramSource, validatePng } from './diagram-artifacts.js';
import { diagramCreationService } from './diagram-creation.js';
import { hasDiagramResourceProof, type DiagramVersionManifest } from './diagram-publications.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { captureNativeLinkProof } from './native-link-proof.js';

type Parsed = Extract<ReturnType<typeof parseDiagramDocument>, { status: 'diagram' }>;
function assetPath(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  noteId: string,
  path: string,
  relative: string,
  hash: string,
  role: 'source' | 'preview',
) {
  const target = localReference(path, relative);
  if (!target) fail(400, 'INVALID_DIAGRAM_RESOURCE');
  validateRelative(target, 'asset');
  if (!target.split('/').includes('assets')) fail(400, 'INVALID_DIAGRAM_RESOURCE');
  if (!canAccessPath(principal, target) && !hasDiagramResourceProof(db, noteId, target, hash, role))
    fail(403, 'FORBIDDEN');
  return target;
}
function sourceSnapshot(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  noteId: string,
  path: string,
  parsed: Parsed,
) {
  const source = parsed.primary.source;
  if (source.format !== 'excalidraw')
    return { content: source.content, hash: sha256(source.content), path: undefined };
  const sourcePath = assetPath(
    config,
    db,
    principal,
    noteId,
    path,
    source.path,
    parsed.primary.binding.sourceHash,
    'source',
  );
  try {
    const bytes = readBoundDiagramAsset(config, sourcePath, 'source');
    return { content: bytes.toString('utf8'), hash: sha256(bytes), path: sourcePath };
  } catch {
    return fail(409, 'DIAGRAM_SOURCE_CONFLICT', '图形源附件不可用或已变化');
  }
}
export function assertDiagramPublication(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  input: {
    operationId: string;
    noteId: string;
    path: string;
    markdown: string;
    currentMarkdown?: string;
    creationIntentId?: string;
  },
) {
  const parsed = parseDiagramDocument(input.markdown),
    before =
      input.currentMarkdown === undefined ? undefined : parseDiagramDocument(input.currentMarkdown);
  if (parsed.status === 'invalid') {
    if (parsed.unsupported && before?.status !== 'diagram' && !input.creationIntentId) return;
    fail(400, 'INVALID_DIAGRAM_DOCUMENT', parsed.reason);
  }
  if (before?.status === 'diagram' && (parsed.status !== 'diagram' || before.type !== parsed.type))
    fail(409, 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED');
  if (parsed.status !== 'diagram') {
    if (input.creationIntentId) fail(400, 'INVALID_DIAGRAM_DOCUMENT');
    return;
  }
  if (isSharePrincipal(principal)) fail(403, 'SHARE_EDIT_UNSUPPORTED');
  if (before && before.status !== 'diagram') fail(409, 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED');
  if (!before) {
    if (!input.creationIntentId) fail(409, 'DIAGRAM_CREATION_REQUIRED');
    const intent = diagramCreationService(config, db, principal).get(input.creationIntentId);
    if (
      !(
        ['reserved', 'prepared'].includes(intent.status) ||
        (intent.status === 'committing' && intent.commitOperationId === input.operationId)
      ) ||
      intent.noteId !== input.noteId ||
      intent.relativePath !== input.path ||
      intent.documentType !== parsed.type
    )
      fail(409, 'CREATION_INTENT_UNAVAILABLE');
  }
  const binding = parsed.primary.binding,
    descriptor = primaryRenderDescriptor(parsed),
    documentHash = sha256(input.markdown);
  let renderHash: string;
  try {
    renderHash = sha256(
      serializeDiagramRenderInput({
        type: parsed.type,
        sourceHash: binding.sourceHash,
        title: parsed.title,
        renderer: descriptor.renderer,
        config: descriptor.config,
      }),
    );
  } catch {
    return fail(400, 'INVALID_DIAGRAM_RENDER_CONFIG');
  }
  const needsPreview = (): never =>
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请准备与当前图形快照匹配的预览', false, {
      documents: [
        {
          noteId: input.noteId,
          role: 'primary',
          documentHash: before ? sha256(input.currentMarkdown!) : documentHash,
          sourceHash: binding.sourceHash,
          renderHash,
        },
      ],
    });
  if (renderHash !== binding.renderHash) needsPreview();
  const source = sourceSnapshot(config, db, principal, input.noteId, input.path, parsed);
  if (source.hash !== binding.sourceHash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  if (parsed.type === 'whiteboard') {
    validateDiagramSource('excalidraw', Buffer.from(source.content, 'utf8'));
    const text = whiteboardText(source.content),
      expected = text ? (text.endsWith('\n') ? text : text + '\n') : undefined;
    if (parsed.primary.summary !== expected)
      fail(409, 'DIAGRAM_SUMMARY_CONFLICT', '白板文字摘要与当前场景不一致');
  } else if (parsed.type === 'flowchart')
    validateDiagramSource('mermaid', Buffer.from(source.content, 'utf8'));
  const previewPath = assetPath(
    config,
    db,
    principal,
    input.noteId,
    input.path,
    parsed.primary.previewPath,
    binding.previewHash,
    'preview',
  );
  let preview: Buffer;
  try {
    preview = readBoundDiagramAsset(config, previewPath, 'preview');
    if (sha256(preview) !== binding.previewHash) throw Error();
    validatePng(preview);
  } catch {
    return fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  }
  const sameResources = (result: PreparedDiagramPrimary) =>
    result.preview.relativePath === previewPath &&
    (result.source?.relativePath ?? undefined) === source.path;
  const rows = db
    .prepare(
      'SELECT result,document_hash,baseline_source_hash,creation_intent_id FROM diagram_prepared_primaries WHERE note_id=? AND source_hash=? AND render_hash=? AND preview_hash=? AND expires_at>?',
    )
    .all(input.noteId, binding.sourceHash, binding.renderHash, binding.previewHash, Date.now()) as {
    result: string;
    document_hash: string | null;
    baseline_source_hash: string | null;
    creation_intent_id: string | null;
  }[];
  const currentSource =
    before?.status === 'diagram'
      ? sourceSnapshot(config, db, principal, input.noteId, input.path, before)
      : undefined;
  const matched = rows.find(
    (row) =>
      sameResources(JSON.parse(row.result)) &&
      row.document_hash === (before ? sha256(input.currentMarkdown!) : null) &&
      row.creation_intent_id === (input.creationIntentId ?? null),
  );
  if (matched && currentSource && matched.baseline_source_hash !== currentSource.hash)
    fail(409, 'DIAGRAM_SOURCE_CONFLICT');
  const retained = db
    .prepare(
      'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND source_hash=? AND render_hash=? AND preview_hash=?',
    )
    .all(input.noteId, binding.sourceHash, binding.renderHash, binding.previewHash) as {
    manifest: string;
  }[];
  const previouslyPublished =
    before &&
    retained.some((row) => {
      const manifest = JSON.parse(row.manifest) as DiagramVersionManifest;
      return (
        manifest.resources.some(
          (r) => r.role === 'preview' && r.path === previewPath && r.hash === binding.previewHash,
        ) &&
        (!source.path ||
          manifest.resources.some(
            (r) => r.role === 'source' && r.path === source.path && r.hash === binding.sourceHash,
          ))
      );
    });
  if (!matched && !previouslyPublished) needsPreview();
  if (
    !matched &&
    currentSource &&
    before?.status === 'diagram' &&
    currentSource.hash !== before.primary.binding.sourceHash
  )
    fail(409, 'DIAGRAM_SOURCE_CONFLICT');
  const manifest: DiagramVersionManifest = {
    type: parsed.type,
    sourceHash: binding.sourceHash,
    renderHash: binding.renderHash,
    previewHash: binding.previewHash,
    resources: [
      { role: 'preview', path: previewPath, hash: binding.previewHash },
      ...(source.path
        ? [{ role: 'source' as const, path: source.path, hash: binding.sourceHash }]
        : []),
    ],
    ...(source.path
      ? { nativeLinks: captureNativeLinkProof(source.path, source.hash, source.content) }
      : {}),
  };
  db.prepare(
    'INSERT INTO diagram_pending_publications(operation_id,note_id,path,document_hash,creation_intent_id,manifest) VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET manifest=excluded.manifest',
  ).run(
    input.operationId,
    input.noteId,
    input.path,
    documentHash,
    input.creationIntentId ?? null,
    JSON.stringify(manifest),
  );
  return manifest;
}
