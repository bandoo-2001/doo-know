import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { DiagramResource } from '../../../shared/diagram-resource.js';
import { diagramResourceSchema } from '../../../shared/diagram-resource.js';
import { isWhiteboard, parseWhiteboard } from '../../../shared/whiteboard.js';
import { diagramRendererVersions } from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath, requireScope } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { localReference } from '../render.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { readBoundDiagramAssetSnapshot } from './diagram-resource-files.js';
import { validatePng } from './diagram-artifacts.js';
import { beginOperation, completeOperation, sha256 } from './operations.js';
import { fail } from './errors.js';
import type { DiagramResolveOptions } from './diagram-resource-resolver.js';

type Manifest = {
  documentHash: string;
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  renderHash: string;
  preview: { path: string; hash: string };
};
export function resolveLegacyDiagram(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  id: string,
  options: DiagramResolveOptions = {},
): DiagramResource {
  if (isSharePrincipal(p)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
  const row = notes.row(id);
  authorizePath(p, row.path);
  if (!isWhiteboard(row.path)) fail(422, 'INVALID_DIAGRAM_DOCUMENT');
  const note = notes.getNoteSnapshot(id).note,
    source = note.content,
    scene = parseWhiteboard(source),
    hash = sha256(source),
    issues: { code: string }[] = [];
  const record = db
    .prepare(
      'SELECT manifest FROM legacy_diagram_previews WHERE note_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
    )
    .get(id) as { manifest: string } | undefined;
  let manifest: Manifest | undefined, preview: DiagramResource['preview'];
  if (record) {
    manifest = JSON.parse(record.manifest);
    let state: 'ready' | 'stale' | 'missing' = 'stale';
    try {
      const path = localReference(note.relativePath, manifest!.preview.path);
      if (!path) throw Error();
      const bytes = readBoundDiagramAssetSnapshot(config, path, 'preview').bytes;
      validatePng(bytes);
      const expected = sha256(
        serializeDiagramRenderInput({
          type: 'whiteboard',
          sourceHash: hash,
          title: note.title,
          renderer: manifest!.renderer,
          config: manifest!.config,
        }),
      );
      if (
        sha256(bytes) === manifest!.preview.hash &&
        manifest!.documentHash === hash &&
        expected === manifest!.renderHash
      )
        state = 'ready';
    } catch {
      state = 'missing';
    }
    preview = {
      path: manifest!.preview.path,
      hash: manifest!.preview.hash,
      renderHash: manifest!.renderHash,
      state,
    };
    if (state !== 'ready')
      issues.push({
        code: state === 'missing' ? 'DIAGRAM_PREVIEW_MISSING' : 'DIAGRAM_PREVIEW_STALE',
      });
  } else issues.push({ code: 'DIAGRAM_PREVIEW_MISSING' });
  let writable = true;
  try {
    requireScope(p, 'knowledge:write');
  } catch {
    writable = false;
  }
  if (![1, 2].includes(scene.version)) {
    writable = false;
    issues.push({ code: 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED' });
  }
  const max = options.maxInlineBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 0 || max > 8 * 1024 * 1024)
    fail(400, 'INVALID_SOURCE_READ_BUDGET');
  const nativeSource: DiagramResource['source'] = { format: 'excalidraw', hash };
  if (Buffer.byteLength(source) <= max) nativeSource.content = source;
  else if (options.sourceHandle)
    nativeSource.readHandle = options.sourceHandle({
      noteId: id,
      documentHash: hash,
      modifiedAt: note.modifiedAt,
      sourceHash: hash,
      format: 'excalidraw',
      title: note.title,
      sourcePath: row.path,
      content: source,
    });
  else fail(413, 'DIAGRAM_SOURCE_HANDLE_REQUIRED');
  return diagramResourceSchema.parse({
    version: 1,
    noteId: id,
    documentType: 'whiteboard',
    role: 'primary',
    documentHash: hash,
    title: note.title,
    source: nativeSource,
    render: {
      renderer: manifest?.renderer ?? diagramRendererVersions.whiteboard,
      config: manifest?.config ?? {},
    },
    ...(preview ? { preview } : {}),
    capabilities: { canEdit: writable, canDownloadSource: true },
    ...(issues.length ? { issues } : {}),
  });
}
const inputSchema = z
  .object({
    expectedDocumentHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    pngBase64: z.string().max(14 * 1024 * 1024),
    renderer: z.literal(diagramRendererVersions.whiteboard),
    config: z.record(z.string(), z.unknown()),
    requestId: z.string().min(1).max(128),
  })
  .strict();
export function legacyDiagramPreviewService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  p: Principal,
) {
  return {
    prepare(id: string, value: unknown) {
      return workspaceWriteSync(db, { kind: 'diagram.legacy-preview' }, () => {
        if (isSharePrincipal(p)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
        requireScope(p, 'knowledge:write');
        const parsed = inputSchema.safeParse(value);
        if (!parsed.success) fail(400, 'INVALID_INPUT');
        const input = parsed.data;
        const resource = resolveLegacyDiagram(config, db, notes, p, id);
        if (
          resource.documentHash !== input.expectedDocumentHash ||
          resource.source.hash !== input.expectedSourceHash
        )
          fail(409, 'DIAGRAM_SOURCE_CONFLICT');
        if (!resource.capabilities.canEdit) fail(409, 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED');
        const bytes = Buffer.from(input.pngBase64, 'base64');
        validatePng(bytes);
        const renderHash = sha256(
            serializeDiagramRenderInput({
              type: 'whiteboard',
              sourceHash: resource.source.hash,
              title: resource.title!,
              renderer: input.renderer,
              config: input.config,
            }),
          ),
          previewHash = sha256(bytes);
        const fixed = db
          .prepare(
            'SELECT manifest FROM legacy_diagram_previews WHERE note_id=? AND document_hash=? AND render_hash=?',
          )
          .get(id, resource.documentHash, renderHash) as { manifest: string } | undefined;
        if (fixed && (JSON.parse(fixed.manifest) as Manifest).preview.hash !== previewHash)
          fail(409, 'DIAGRAM_PREVIEW_CONFLICT');
        const { operation } = beginOperation(db, p, 'diagram.legacy-preview', input.requestId, {
          id,
          documentHash: resource.documentHash,
          sourceHash: resource.source.hash,
          title: resource.title,
          renderHash,
          previewHash,
        });
        const uploaded = assets.upload(
          id,
          'preview.png',
          'image/png',
          bytes,
          'diagram-legacy-' + operation.id,
        );
        const current = resolveLegacyDiagram(config, db, notes, p, id);
        if (current.documentHash !== resource.documentHash || current.title !== resource.title)
          fail(409, 'DIAGRAM_SOURCE_CONFLICT');
        const manifest: Manifest = {
          documentHash: resource.documentHash,
          title: resource.title!,
          renderer: input.renderer,
          config: input.config,
          renderHash,
          preview: { path: uploaded.markdownPath, hash: previewHash },
        };
        db.prepare(
          'INSERT INTO legacy_diagram_previews(note_id,document_hash,render_hash,manifest,created_at) VALUES(?,?,?,?,?) ON CONFLICT(note_id,document_hash,render_hash) DO UPDATE SET manifest=excluded.manifest,created_at=excluded.created_at',
        ).run(id, resource.documentHash, renderHash, JSON.stringify(manifest), Date.now());
        completeOperation(db, operation.id, {
          documentHash: resource.documentHash,
          sourceHash: resource.source.hash,
          renderHash,
          previewHash,
        });
        return resolveLegacyDiagram(config, db, notes, p, id);
      });
    },
  };
}
