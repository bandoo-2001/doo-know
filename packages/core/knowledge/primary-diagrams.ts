import { DOO_ASSETS_DIRECTORY, isDooAssetPath } from '../../../shared/storage-paths.js';
import { posix } from 'node:path';
import {
  diagramPreparationSchema as inputSchema,
  type DiagramPreparationInput,
} from '../../../shared/diagram-document-contracts.js';
import { resolvePrimaryDiagram, type DiagramResolveOptions } from './diagram-resource-resolver.js';
import { localReference } from '../render.js';
import { mutationCore } from './core.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import type { NoteDocument } from '../../../shared/contracts.js';
import type { OperationRow } from './operations.js';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import {
  diagramRendererVersions,
  renderPreparedDiagramDocument,
  diagramPlainTitle,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import { parseMindmapOutline } from '../../../shared/mindmap-outline.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath, canAccessPath, requireScope } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { diagramCreationService, DIAGRAM_CREATION_LEASE_MS } from './diagram-creation.js';
import { readPrimaryDiagramState } from './primary-diagram-state.js';
import { validateDiagramSource, validatePng, DIAGRAM_SOURCE_MIMES } from './diagram-artifacts.js';
import { sha256, beginOperation, completeOperation, existingResult } from './operations.js';
import { assertWritable } from './write-lease.js';
import { fail } from './errors.js';

type Input = DiagramPreparationInput;
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
  function target(input: Pick<Input, 'target' | 'type'>) {
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
    const state = readPrimaryDiagramState(db, notes, assets, principal, row.id);
    if (state.note.publication)
      fail(409, 'OPERATION_OUTCOME_UNKNOWN', '请先核对尚未完成的图形保存', true);
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
  function prepare(
    value: unknown,
    imported?: { sourcePath?: string; previewPath: string },
  ): PreparedDiagramPrimary {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) fail(400, 'INVALID_INPUT', '主图准备请求格式不正确');
    const input = parsed.data;
    // Authorize before decoding large payloads; repeat the fixed baseline check under the short lock.
    const initialTarget = target(input);
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
    // Validate the exact main-file source range before writing any immutable resource.
    // Placeholder destinations affect neither source bytes nor the render fingerprint.
    const probe = {
      id: 'preflight',
      relativePath: DOO_ASSETS_DIRECTORY + '/preview.png',
      markdownPath: DOO_ASSETS_DIRECTORY + '/preview.png',
      mime: 'image/png',
    };
    try {
      renderPreparedDiagramDocument({
        prepared: {
          id: 'preflight',
          noteId: initialTarget.noteId,
          type: input.type,
          documentHash: initialTarget.documentHash,
          baselineSourceHash: initialTarget.baselineSourceHash,
          sourceHash: input.sourceHash,
          renderHash,
          previewHash,
          title: input.title,
          renderer: input.renderer,
          config: input.config,
          preview: probe,
          ...(input.type === 'whiteboard'
            ? {
                source: {
                  ...probe,
                  relativePath: DOO_ASSETS_DIRECTORY + '/source.excalidraw',
                  markdownPath: DOO_ASSETS_DIRECTORY + '/source.excalidraw',
                  mime: DIAGRAM_SOURCE_MIMES['.excalidraw'],
                },
              }
            : {}),
          expiresAt: 0,
        },
        title: input.title,
        source: input.source,
      });
    } catch (error) {
      fail(400, 'DIAGRAM_SOURCE_NOT_CANONICAL', (error as Error).message);
    }

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
        ...(imported ? { imported } : {}),
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
      const importedAsset = (path: string, hash: string, mime: string) => {
        requireScope(principal, 'knowledge:write');
        if (!canAccessPath(principal, path)) fail(403, 'FORBIDDEN');
        const file = assets.file(path);
        if (sha256(file.sourceBytes || file.bytes) !== hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        const asset = assets.register(path);
        return {
          id: asset.id,
          relativePath: path,
          markdownPath: posix.relative(posix.dirname(destination.path), path),
          mime,
        };
      };
      const upload = (name: string, mime: string, bytes: Buffer, suffix: string) =>
        imported
          ? importedAsset(
              suffix === 'source' ? imported.sourcePath! : imported.previewPath,
              sha256(bytes),
              mime,
            )
          : destination.creationIntentId
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
  function commit(value: {
    preparedId: string;
    markdown: string;
    requestId: string;
  }): NoteDocument {
    if (isSharePrincipal(principal)) fail(403, 'SHARE_EDIT_UNSUPPORTED');
    if (
      !value ||
      typeof value.preparedId !== 'string' ||
      typeof value.markdown !== 'string' ||
      typeof value.requestId !== 'string'
    )
      fail(400, 'INVALID_INPUT');
    return workspaceWriteSync(db, { kind: 'diagram-primary.commit' }, () => {
      const row = db
        .prepare(
          'SELECT result,expires_at,principal,client_id FROM diagram_prepared_primaries WHERE id=?',
        )
        .get(value.preparedId) as
        | { result: string; expires_at: number; principal: string; client_id: string }
        | undefined;
      if (!row) fail(404, 'NOT_FOUND');
      if (row.principal !== principal.id || row.client_id !== principal.clientId)
        fail(403, 'FORBIDDEN');
      const prepared = JSON.parse(row.result) as PreparedDiagramPrimary;
      const prior = db
        .prepare(
          "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='diagram-primary.commit' AND request_id=?",
        )
        .get(principal.id, principal.clientId, value.requestId) as OperationRow | undefined;
      if (prior?.status === 'succeeded') {
        // Validate the original request before exposing the current identity. A consumed
        // receipt never rewrites the file or returns stale Markdown in a new path context.
        beginOperation(db, principal, 'diagram-primary.commit', value.requestId, {
          preparedId: value.preparedId,
          markdown: value.markdown,
        });
        const recorded = existingResult(prior),
          current = notes.row(recorded.id);
        authorizePath(principal, current.path, 'knowledge:write');
        authorizePath(principal, current.path, 'knowledge:read');
        const result = notes.getNote(current.id);
        if (!Object.hasOwn(recorded, 'shared')) delete result.shared;
        return result;
      }
      if (prepared.creationIntentId) creations.get(prepared.creationIntentId);
      else authorizePath(principal, notes.row(prepared.noteId).path, 'knowledge:write');
      const { operation } = db
        .transaction(() =>
          beginOperation(db, principal, 'diagram-primary.commit', value.requestId, {
            preparedId: value.preparedId,
            markdown: value.markdown,
          }),
        )
        .immediate();
      if (operation.status !== 'prepared')
        return { ...existingResult(operation), content: value.markdown } as NoteDocument;
      const candidate = parseDiagramDocument(value.markdown);
      const targetPath = prepared.creationIntentId
        ? creations.get(prepared.creationIntentId).relativePath
        : notes.row(prepared.noteId).path;
      if (candidate.status !== 'diagram') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
      if (
        candidate.type !== prepared.type ||
        candidate.primary.binding.sourceHash !== prepared.sourceHash ||
        candidate.primary.binding.renderHash !== prepared.renderHash ||
        candidate.primary.binding.previewHash !== prepared.previewHash ||
        localReference(targetPath, candidate.primary.previewPath) !==
          prepared.preview.relativePath ||
        (candidate.primary.source.format === 'excalidraw'
          ? localReference(targetPath, candidate.primary.source.path)
          : undefined) !== prepared.source?.relativePath
      )
        fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
      const innerRequestId = 'primary-' + operation.id,
        kind = prepared.creationIntentId ? 'create' : 'update';
      const inner = db
        .prepare(
          'SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=?',
        )
        .get(principal.id, principal.clientId, kind, innerRequestId) as OperationRow | undefined;
      let receipt: any;
      if (inner?.status === 'succeeded') receipt = existingResult(inner);
      else {
        if (row.expires_at <= Date.now()) fail(409, 'DIAGRAM_PREPARATION_EXPIRED');
        const core = mutationCore(config, db);
        if (prepared.creationIntentId)
          receipt = core.createDiagram(
            principal,
            prepared.creationIntentId,
            value.markdown,
            innerRequestId,
          );
        else {
          const current = readPrimaryDiagramState(db, notes, assets, principal, prepared.noteId);
          if (current.documentHash !== prepared.documentHash) fail(409, 'VERSION_CONFLICT');
          if (current.sourceHash !== prepared.baselineSourceHash)
            fail(409, 'DIAGRAM_SOURCE_CONFLICT');
          receipt = core.update(
            principal,
            prepared.noteId,
            value.markdown,
            current.note.modifiedAt,
            innerRequestId,
          );
        }
      }
      const parsed = parseDiagramDocument(value.markdown);
      if (parsed.status !== 'diagram') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
      const result: NoteDocument = {
        id: receipt.id,
        relativePath: receipt.relativePath,
        documentType: parsed.type,
        title: parsed.title,
        content: value.markdown,
        modifiedAt: receipt.modifiedAt,
        updatedAt: new Date(Number(BigInt(receipt.modifiedAt) / 1000000n)).toISOString(),
      };
      const { content: _content, ...metadata } = result;
      completeOperation(db, operation.id, metadata);
      return result;
    });
  }
  function getPreparation(
    id: string,
    options: { fresh?: boolean; scope?: 'knowledge:read' | 'knowledge:write' } = {},
  ) {
    const row = db
      .prepare(
        'SELECT result,principal,client_id,expires_at FROM diagram_prepared_primaries WHERE id=?',
      )
      .get(id) as
      | { result: string; principal: string; client_id: string; expires_at: number }
      | undefined;
    if (!row || row.principal !== principal.id || row.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    const prepared = JSON.parse(row.result) as PreparedDiagramPrimary;
    const scope = options.scope ?? 'knowledge:write';
    if (prepared.creationIntentId) creations.get(prepared.creationIntentId, { scope });
    else authorizePath(principal, notes.row(prepared.noteId).path, scope);
    if (options.fresh && row.expires_at <= Date.now()) fail(409, 'DIAGRAM_PREPARATION_EXPIRED');
    return prepared;
  }
  /** Recover only this actor's committed preparation metadata, never uploaded content.
   * The caller supplies its durable upload digest/size binding before attempting commit. */
  function getCommitMetadata(input: {
    preparedId: string;
    requestId: string;
    contentHash: string;
    sizeBytes: number;
    paramsHash: string;
  }) {
    const prepared = getPreparation(input.preparedId);
    const operation = db
      .prepare(
        "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='diagram-primary.commit' AND request_id=?",
      )
      .get(principal.id, principal.clientId, input.requestId) as OperationRow | undefined;
    if (!operation) return undefined;
    if (operation.params_hash !== input.paramsHash) fail(409, 'IDEMPOTENCY_CONFLICT');
    const inner = db
      .prepare(
        'SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=?',
      )
      .get(
        principal.id,
        principal.clientId,
        prepared.creationIntentId ? 'create' : 'update',
        'primary-' + operation.id,
      ) as OperationRow | undefined;
    if (inner?.status !== 'succeeded') return undefined;
    const receipt = existingResult(inner);
    if (
      receipt.id !== prepared.noteId ||
      receipt.contentHash !== input.contentHash ||
      receipt.sizeBytes !== input.sizeBytes
    )
      fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    const metadata = {
      id: receipt.id,
      relativePath: receipt.relativePath,
      documentType: prepared.type,
      title: prepared.title,
      modifiedAt: receipt.modifiedAt,
      updatedAt: new Date(Number(BigInt(receipt.modifiedAt) / 1000000n)).toISOString(),
    };
    if (operation.status === 'succeeded') {
      const recorded = existingResult(operation);
      if (
        recorded.id !== metadata.id ||
        recorded.modifiedAt !== metadata.modifiedAt ||
        recorded.documentType !== metadata.documentType
      )
        fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    } else {
      if (operation.status !== 'prepared') existingResult(operation);
      completeOperation(db, operation.id, metadata);
    }
    return {
      ...metadata,
      contentHash: receipt.contentHash,
      sizeBytes: receipt.sizeBytes,
      indexState: receipt.indexState,
    };
  }
  return {
    getCommitMetadata,
    validateTarget: target,
    getPreparation,
    prepare: (value: unknown) => prepare(value),
    prepareImported: (value: unknown, paths: { sourcePath?: string; previewPath: string }) =>
      prepare(value, paths),
    commit,
    resolve: (noteId: string, options?: DiagramResolveOptions) =>
      resolvePrimaryDiagram(config, db, notes, principal, noteId, options),
  };
}
