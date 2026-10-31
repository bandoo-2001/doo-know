import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import {
  diagramRendererVersions,
  diagramPlainTitle,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import { parseMindmapOutline } from '../../../shared/mindmap-outline.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { diagramCreationService, DIAGRAM_CREATION_LEASE_MS } from './diagram-creation.js';
import { readPrimaryDiagramState } from './primary-diagram-state.js';
import { validateDiagramSource, validatePng, DIAGRAM_SOURCE_MIMES } from './diagram-artifacts.js';
import { sha256, beginOperation, completeOperation, existingResult } from './operations.js';
import { assertWritable } from './write-lease.js';
import { fail } from './errors.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('creation'), intentId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('document'),
      noteId: z.string().min(1),
      expectedDocumentHash: hash,
      expectedSourceHash: hash,
    })
    .strict(),
]);
const inputSchema = z
  .object({
    target: targetSchema,
    type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
    source: z.string(),
    sourceHash: hash,
    title: z.string().min(1).max(2000),
    renderer: z.string().min(1).max(160),
    config: z.record(z.string(), z.unknown()),
    pngBase64: z.string(),
    requestId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
const maxPng = 10 * 1024 * 1024;

/** Immutable primary preparation. No source-only update or unpublished file is activated here. */
export function primaryDiagramService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  principal: Principal,
) {
  const creations = diagramCreationService(config, db, principal);
  function target(input: Input) {
    if (isSharePrincipal(principal)) fail(403, 'SHARE_EDIT_UNSUPPORTED');
    if (input.target.kind === 'creation') {
      const intent = creations.get(input.target.intentId);
      if (!['reserved', 'prepared', 'published'].includes(intent.status))
        fail(409, 'CREATION_INTENT_UNAVAILABLE');
      if (intent.documentType !== input.type) fail(400, 'DIAGRAM_TYPE_MISMATCH');
      return {
        noteId: intent.noteId,
        path: intent.relativePath,
        creationIntentId: intent.id,
        documentHash: null,
        baselineSourceHash: null,
        status: intent.status,
        expiresAt: intent.expiresAt,
      };
    }
    const row = notes.row(input.target.noteId);
    authorizePath(principal, row.path, 'knowledge:write');
    const state = readPrimaryDiagramState(notes, assets, principal, row.id);
    if (state.documentHash !== input.target.expectedDocumentHash) fail(409, 'VERSION_CONFLICT');
    if (state.sourceHash !== input.target.expectedSourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
    if (state.parsed.type !== input.type) fail(400, 'DIAGRAM_TYPE_MISMATCH');
    return {
      noteId: row.id,
      path: row.path,
      creationIntentId: undefined,
      documentHash: state.documentHash,
      baselineSourceHash: state.sourceHash,
      status: 'published' as const,
      expiresAt: Date.now() + DIAGRAM_CREATION_LEASE_MS,
    };
  }
  function verifyArtifacts(result: PreparedDiagramPrimary) {
    try {
      if (
        sha256(assets.file(result.preview.relativePath).bytes) !== result.previewHash ||
        (result.source &&
          sha256(assets.file(result.source.relativePath).bytes) !== result.sourceHash)
      )
        throw Error();
    } catch {
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT', '已准备的图形附件发生变化，请核对原始文件');
    }
    return result;
  }
  function prepare(value: unknown): PreparedDiagramPrimary {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) fail(400, 'INVALID_INPUT', '主图准备请求格式不正确');
    const input = parsed.data;
    // Authorize before decoding large payloads; repeat the fixed baseline check under the short lock.
    target(input);
    if (input.renderer !== diagramRendererVersions[input.type])
      fail(400, 'UNSUPPORTED_DIAGRAM_RENDERER');
    if (sha256(input.source) !== input.sourceHash) fail(400, 'DIAGRAM_SOURCE_HASH_MISMATCH');
    try {
      diagramPlainTitle(input.title);
      if (input.type === 'whiteboard')
        validateDiagramSource('excalidraw', Buffer.from(input.source, 'utf8'));
      else if (input.type === 'flowchart') {
        if (!input.source.endsWith('\n')) fail(400, 'DIAGRAM_SOURCE_NOT_CANONICAL');
        validateDiagramSource('mermaid', Buffer.from(input.source, 'utf8'));
      } else {
        if (
          input.source &&
          (!input.source.endsWith('\n') || /(?:\r?\n)[ \t]*(?:\r?\n)$/.test(input.source))
        )
          fail(400, 'DIAGRAM_SOURCE_NOT_CANONICAL');
        parseMindmapOutline(diagramPlainTitle(input.title) + '\n\n' + input.source);
      }
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) throw error;
      fail(400, 'INVALID_DIAGRAM_SOURCE', (error as Error).message);
    }
    if (input.pngBase64.length > Math.ceil(maxPng / 3) * 4) fail(413, 'DIAGRAM_PREVIEW_TOO_LARGE');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pngBase64))
      fail(400, 'INVALID_DIAGRAM_PNG');
    const png = Buffer.from(input.pngBase64, 'base64');
    if (png.toString('base64') !== input.pngBase64) fail(400, 'INVALID_DIAGRAM_PNG');
    validatePng(png);
    let renderHash: string;
    try {
      renderHash = sha256(serializeDiagramRenderInput(input));
    } catch {
      return fail(400, 'INVALID_DIAGRAM_RENDER_CONFIG');
    }
    const previewHash = sha256(png);
    return workspaceWriteSync(db, { kind: 'diagram-primary.prepare' }, () => {
      const destination = target(input);
      assertWritable(db, destination.creationIntentId ? undefined : destination.noteId);
      const params = {
        target: input.target,
        type: input.type,
        sourceHash: input.sourceHash,
        title: input.title,
        renderer: input.renderer,
        config: input.config,
        renderHash,
        previewHash,
      };
      const { operation } = db
        .transaction(() =>
          beginOperation(db, principal, 'diagram-primary.prepare', input.requestId, params),
        )
        .immediate();
      if (operation.status !== 'prepared') {
        const result = existingResult(operation) as PreparedDiagramPrimary;
        const row = db
          .prepare('SELECT expires_at FROM diagram_prepared_primaries WHERE id=?')
          .get(result.id) as { expires_at: number } | undefined;
        if (!row || row.expires_at <= Date.now()) fail(409, 'DIAGRAM_PREPARATION_EXPIRED');
        return verifyArtifacts(result);
      }
      if (destination.creationIntentId && destination.status === 'published')
        fail(409, 'CREATION_ALREADY_PUBLISHED');
      const upload = (name: string, mime: string, bytes: Buffer, suffix: string) =>
        destination.creationIntentId
          ? assets.uploadForDiagramCreation(
              principal,
              destination.creationIntentId,
              name,
              mime,
              bytes,
              'diagram-' + operation.id + '-' + suffix,
            )
          : assets.upload(
              destination.noteId,
              name,
              mime,
              bytes,
              'diagram-' + operation.id + '-' + suffix,
            );
      const source =
        input.type === 'whiteboard'
          ? upload(
              'diagram.excalidraw',
              DIAGRAM_SOURCE_MIMES['.excalidraw'],
              Buffer.from(input.source, 'utf8'),
              'source',
            )
          : undefined;
      const preview = upload('diagram.png', 'image/png', png, 'preview');
      const result: PreparedDiagramPrimary = {
        id: operation.id,
        noteId: destination.noteId,
        ...(destination.creationIntentId ? { creationIntentId: destination.creationIntentId } : {}),
        type: input.type,
        documentHash: destination.documentHash,
        baselineSourceHash: destination.baselineSourceHash,
        sourceHash: input.sourceHash,
        renderHash,
        previewHash,
        title: input.title,
        renderer: input.renderer,
        config: input.config,
        preview,
        ...(source ? { source } : {}),
        expiresAt: Math.min(destination.expiresAt, Date.now() + DIAGRAM_CREATION_LEASE_MS),
      };
      db.transaction(() => {
        db.prepare(
          'INSERT INTO diagram_prepared_primaries(id,note_id,creation_intent_id,principal,client_id,document_hash,baseline_source_hash,source_hash,render_hash,preview_hash,result,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          result.id,
          result.noteId,
          result.creationIntentId ?? null,
          principal.id,
          principal.clientId,
          result.documentHash,
          result.baselineSourceHash,
          result.sourceHash,
          result.renderHash,
          result.previewHash,
          JSON.stringify(result),
          Date.now(),
          result.expiresAt,
        );
        if (result.creationIntentId)
          db.prepare(
            "UPDATE diagram_creation_intents SET status='prepared' WHERE id=? AND status='reserved'",
          ).run(result.creationIntentId);
        completeOperation(db, operation.id, result);
      }).immediate();
      return result;
    });
  }
  return { prepare };
}
