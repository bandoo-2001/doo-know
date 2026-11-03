import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { McpDomainContext } from './mcp-domain-context.js';
import type { McpTransferBinding, McpTransferInfo } from '../../../shared/mcp-domain-tools.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { DiagramPreparationInput } from '../../../shared/diagram-document-contracts.js';
import { primaryDiagramToolNames } from '../../../shared/mcp-primary-diagram-contracts.js';
import { primaryDiagramService } from '../../../packages/core/knowledge/primary-diagrams.js';
import { diagramCreationService } from '../../../packages/core/knowledge/diagram-creation.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  sha256,
} from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { authorizePath } from '../../../packages/core/agent/auth.js';
import { mcpMaximumFrameBytes, mcpResultFrameSize } from '../../../shared/mcp-frame.js';

type Target = DiagramPreparationInput['target'];
type Type = DiagramPreparationInput['type'];
const kinds = new Set([
  'primary-source-upload',
  'primary-preview-upload',
  'primary-document-upload',
]);
export { primaryDiagramToolNames };

/** Actor-bound opaque transport only: all format, publication and CAS rules live in core. */
export function createPrimaryDiagramToolPort(context: McpDomainContext) {
  const { config, db, runtime, transfers } = context;
  const service = (p: Principal) =>
    primaryDiagramService(config, db, runtime.notes, runtime.assets, p);
  const creations = (p: Principal) => diagramCreationService(config, db, p);
  function bounded<T extends Record<string, unknown>>(value: T): T {
    if (mcpResultFrameSize({ data: value }) > mcpMaximumFrameBytes) fail(413, 'RESPONSE_TOO_LARGE');
    return value;
  }
  function resourceBinding(
    target: Target,
    type: Type,
    role: 'source' | 'preview',
    uploadId: string,
  ): McpTransferBinding {
    return {
      domain: 'knowledge',
      kind: `primary-${role}-upload`,
      id: target.kind === 'creation' ? target.intentId : target.noteId,
      metadata: { target: JSON.stringify(target), type, uploadId },
    };
  }
  function mainBinding(preparedId: string): McpTransferBinding {
    return { domain: 'knowledge', kind: 'primary-document-upload', id: preparedId };
  }
  function validatePreparationTarget(p: Principal, preparedId: string) {
    const core = service(p),
      prepared = core.getPreparation(preparedId, { fresh: true });
    if (prepared.creationIntentId) {
      const status = creations(p).get(prepared.creationIntentId).status;
      if (!['reserved', 'prepared'].includes(status)) fail(409, 'CREATION_INTENT_UNAVAILABLE');
    } else
      core.validateTarget({
        type: prepared.type,
        target: {
          kind: 'document',
          noteId: prepared.noteId,
          expectedDocumentHash: prepared.documentHash!,
          expectedSourceHash: prepared.baselineSourceHash!,
        },
      });
    return prepared;
  }
  function authorizeTransfer(
    binding: McpTransferBinding,
    _write: boolean,
    options?: ServiceCallOptions,
    state?: McpTransferInfo['state'],
  ) {
    if (binding.domain !== 'knowledge' || !kinds.has(binding.kind)) fail(403, 'FORBIDDEN');
    const p = context.authorize(['knowledge:read', 'knowledge:write'], options);
    if (state === 'completed') {
      if (binding.kind === 'primary-document-upload') service(p).getPreparation(binding.id);
      else {
        let target: Target;
        try {
          target = JSON.parse(String(binding.metadata?.target));
        } catch {
          return fail(403, 'FORBIDDEN');
        }
        authorizeOperation(
          p,
          { target, type: binding.metadata?.type },
          { scope: 'knowledge:write', baseline: false },
        );
      }
    } else if (binding.kind === 'primary-document-upload') validatePreparationTarget(p, binding.id);
    else {
      let target: Target;
      try {
        target = JSON.parse(String(binding.metadata?.target));
      } catch {
        return fail(403, 'FORBIDDEN');
      }
      const type = binding.metadata?.type as Type;
      if (
        !['whiteboard', 'mindmap', 'flowchart'].includes(type) ||
        !target ||
        !['creation', 'document'].includes(target.kind) ||
        binding.id !== (target.kind === 'creation' ? target.intentId : target.noteId)
      )
        fail(403, 'FORBIDDEN');
      const state = service(p).validateTarget({ target, type });
      if (state.status === 'published' && target.kind === 'creation')
        fail(409, 'CREATION_ALREADY_PUBLISHED');
    }
    return p;
  }
  function remember(id: string, binding: Record<string, unknown>) {
    db.prepare(
      'INSERT OR REPLACE INTO mcp_knowledge_operation_bindings(operation_id,binding) VALUES(?,?)',
    ).run(id, JSON.stringify({ primary: binding }));
  }
  function readBinding(id: string): any {
    const row = db
      .prepare('SELECT binding FROM mcp_knowledge_operation_bindings WHERE operation_id=?')
      .get(id) as { binding: string } | undefined;
    return row && JSON.parse(row.binding).primary;
  }
  function authorizeOperation(
    p: Principal,
    binding: any,
    options: { scope?: 'knowledge:read' | 'knowledge:write'; baseline?: boolean } = {},
  ) {
    const scope = options.scope ?? 'knowledge:write';
    // Status/replay ownership checks survive publication/expiry; new material still needs fresh CAS checks.
    if (binding.preparedId) service(p).getPreparation(binding.preparedId, { scope });
    else if (binding.intentId) creations(p).get(binding.intentId, { scope });
    else if (binding.target) {
      if (scope === 'knowledge:read' || options.baseline === false) {
        if (binding.target.kind === 'creation')
          creations(p).get(binding.target.intentId, { scope });
        else if (binding.target.kind === 'document')
          authorizePath(p, runtime.notes.row(binding.target.noteId).path, scope);
        else fail(403, 'FORBIDDEN');
      } else service(p).validateTarget({ target: binding.target, type: binding.type });
    } else fail(403, 'FORBIDDEN');
  }
  function utf8(bytes: Buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail(400, 'INVALID_INPUT');
    }
  }
  function compact(
    prepared: ReturnType<ReturnType<typeof primaryDiagramService>['getPreparation']>,
  ) {
    const { title: _title, renderer: _renderer, config: _config, ...receipt } = prepared;
    return bounded(receipt);
  }
  function start(p: Principal, kind: string, a: any, binding: Record<string, unknown>) {
    const op = db
      .transaction(() => beginOperation(db, p, 'knowledge.' + kind, a.requestId, a))
      .immediate();
    if (!readBinding(op.operation.id)) remember(op.operation.id, binding);
    authorizeOperation(p, readBinding(op.operation.id));
    return op.operation;
  }
  async function call(
    name: string,
    a: any,
    options?: ServiceCallOptions,
  ): Promise<Record<string, unknown>> {
    const p = context.authorize(
      name === 'get_diagram_creation_intent'
        ? ['knowledge:read']
        : ['knowledge:read', 'knowledge:write'],
      options,
    );
    if (name === 'reserve_diagram_document') {
      const result = creations(p).reserve(a);
      // The core reservation receipt intentionally contains only its ID; expose a bounded intent DTO.
      remember(result.id, { intentId: result.id });
      return bounded(result);
    }
    if (name === 'get_diagram_creation_intent')
      return bounded(creations(p).get(a.intentId, { scope: 'knowledge:read' }));
    if (name === 'cancel_diagram_creation_intent') return bounded(creations(p).cancel(a.intentId));
    if (name === 'begin_primary_diagram_upload') {
      const state = service(p).validateTarget(a);
      if (a.target.kind === 'creation' && state.status === 'published')
        fail(409, 'CREATION_ALREADY_PUBLISHED');
      const uploadId = sha256(a.requestId);
      const source = transfers.beginUpload(p, {
        binding: resourceBinding(a.target, a.type, 'source', uploadId),
        name:
          a.type === 'whiteboard'
            ? 'diagram.excalidraw'
            : a.type === 'flowchart'
              ? 'diagram.mmd'
              : 'diagram.md',
        mime: a.type === 'whiteboard' ? 'application/vnd.excalidraw+json' : 'text/plain',
        totalBytes: a.sourceBytes,
        sha256: a.sourceSha256,
        requestId: 'primary-source-' + uploadId,
      });
      const preview = transfers.beginUpload(p, {
        binding: resourceBinding(a.target, a.type, 'preview', uploadId),
        name: 'diagram.png',
        mime: 'image/png',
        totalBytes: a.previewBytes,
        sha256: a.previewSha256,
        requestId: 'primary-preview-' + uploadId,
      });
      return bounded({ source, preview });
    }
    if (name === 'prepare_primary_diagram') {
      const core = service(p),
        op = start(p, 'primary-prepare', a, { target: a.target, type: a.type });
      if (op.status !== 'prepared') return bounded(existingResult(op));
      core.validateTarget(a);
      const sourceInfo = transfers.info(p, a.sourceTransferId),
        previewInfo = transfers.info(p, a.previewTransferId);
      const batch = String(sourceInfo.binding.metadata?.uploadId);
      const expectedSource = resourceBinding(a.target, a.type, 'source', batch),
        expectedPreview = resourceBinding(a.target, a.type, 'preview', batch);
      // Inspect before claiming so invalid payloads never consume a preparation attempt.
      const source = transfers.readUpload(p, a.sourceTransferId, expectedSource),
        preview = transfers.readUpload(p, a.previewTransferId, expectedPreview);
      if (source.bytes.length > 8 * 1024 * 1024 || preview.bytes.length > 10 * 1024 * 1024)
        fail(413, 'PAYLOAD_TOO_LARGE');
      if (source.sha256 !== a.sourceHash) fail(400, 'DIAGRAM_SOURCE_HASH_MISMATCH');
      authorizeTransfer(sourceInfo.binding, true, options);
      authorizeTransfer(previewInfo.binding, true, options);
      const claim = 'primary-prepare-' + sha256(a.requestId);
      db.transaction(() => {
        transfers.readUpload(p, a.sourceTransferId, expectedSource, claim);
        transfers.readUpload(p, a.previewTransferId, expectedPreview, claim);
      }).immediate();
      const prepared = core.prepare({
        target: a.target,
        type: a.type,
        title: a.title,
        renderer: a.renderer,
        config: a.config,
        source: utf8(source.bytes),
        sourceHash: a.sourceHash,
        pngBase64: preview.bytes.toString('base64'),
        requestId: 'mcp-' + op.id,
      });
      const result = compact(prepared);
      remember(op.id, { preparedId: prepared.id });
      completeOperation(db, op.id, result);
      const receipt = { preparedId: prepared.id };
      transfers.complete(p, a.sourceTransferId, claim, receipt);
      transfers.complete(p, a.previewTransferId, claim, receipt);
      return result;
    }
    if (name === 'begin_primary_diagram_document_upload') {
      validatePreparationTarget(p, a.preparedId);
      return bounded(
        transfers.beginUpload(p, {
          binding: mainBinding(a.preparedId),
          name: 'diagram.md',
          mime: 'text/markdown',
          totalBytes: a.totalBytes,
          sha256: a.sha256,
          requestId: 'primary-main-' + sha256(a.requestId),
        }),
      );
    }
    if (name === 'commit_primary_diagram') {
      const core = service(p),
        op = start(p, 'primary-commit', a, { preparedId: a.preparedId });
      if (op.status !== 'prepared') return bounded(existingResult(op));
      const binding = readBinding(op.id),
        coreRequestId = 'mcp-' + op.id;
      if (binding.contentHash !== undefined) {
        const recovered = core.getCommitMetadata({
          preparedId: a.preparedId,
          requestId: coreRequestId,
          contentHash: binding.contentHash,
          sizeBytes: binding.sizeBytes,
          paramsHash: binding.paramsHash,
        });
        if (recovered) {
          const result = bounded(recovered);
          completeOperation(db, op.id, result);
          return result;
        }
      }
      core.getPreparation(a.preparedId, { fresh: true });
      const expected = mainBinding(a.preparedId),
        info = transfers.info(p, a.documentTransferId);
      const upload = transfers.readUpload(
        p,
        a.documentTransferId,
        expected,
        'primary-commit-' + op.id,
      );
      authorizeTransfer(info.binding, true, options);
      if (upload.bytes.length > 20 * 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE');
      if (
        binding.contentHash !== undefined &&
        (binding.contentHash !== upload.sha256 || binding.sizeBytes !== upload.bytes.length)
      )
        fail(409, 'IDEMPOTENCY_CONFLICT');
      const markdown = utf8(upload.bytes),
        paramsHash = sha256(JSON.stringify({ markdown, preparedId: a.preparedId }));
      remember(op.id, {
        preparedId: a.preparedId,
        contentHash: upload.sha256,
        sizeBytes: upload.bytes.length,
        paramsHash,
      });
      core.commit({ preparedId: a.preparedId, markdown, requestId: coreRequestId });
      const metadata = core.getCommitMetadata({
        preparedId: a.preparedId,
        requestId: coreRequestId,
        contentHash: upload.sha256,
        sizeBytes: upload.bytes.length,
        paramsHash,
      });
      if (!metadata) fail(409, 'OPERATION_OUTCOME_UNKNOWN');
      const result = bounded(metadata);
      completeOperation(db, op.id, result);
      transfers.complete(p, a.documentTransferId, 'primary-commit-' + op.id, result);
      return result;
    }
    return fail(404, 'UNKNOWN_TOOL');
  }
  return {
    call,
    authorizeTransfer,
    authorizeOperation,
    handlesTransfer: (binding: McpTransferBinding) => kinds.has(binding.kind),
  };
}
