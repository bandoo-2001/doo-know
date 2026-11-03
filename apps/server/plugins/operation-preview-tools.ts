import { assertRoot } from '../../../packages/core/indexing/reconcile.js';
import type { McpDomainContext } from './mcp-domain-context.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { McpTransferBinding } from '../../../shared/mcp-domain-tools.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import { diagramOperationPreviewRegistry } from '../../../packages/core/knowledge/diagram-operation-previews.js';
import { diagramOperationPreviewNeeds } from '../../../packages/core/knowledge/diagram-operation-preview-pages.js';
import { portablePreviewRegistry } from '../../../packages/core/portable-delivery/previews.js';
import { operationPreviewToolDefinitions } from '../../../shared/mcp-operation-preview-tools.js';
import { mcpMaximumFrameBytes, mcpResultFrameSize } from '../../../shared/mcp-frame.js';
import { sha256 } from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export const operationPreviewToolNames = new Set(
  operationPreviewToolDefinitions.map((d) => d.name),
);
const purposes = new Set(['operation-preview-upload', 'portable-preview-upload']);
/** Opaque transport over the two distinct core registries. No owner principal or caller-supplied source. */
export function createOperationPreviewToolPort(
  context: McpDomainContext,
  paginate: (
    p: Principal,
    kind: string,
    rows: any[],
    args: any,
    extra?: Record<string, unknown>,
  ) => any,
) {
  const { config, db, runtime, transfers } = context,
    portable = portablePreviewRegistry(config, db);
  const principal = (generic: boolean, options?: ServiceCallOptions) => {
    const p = context.authorize(
      ['knowledge:read', ...(generic ? ['knowledge:write'] : [])],
      options,
    );
    assertRoot(config, db);
    return p;
  };
  const generic = (p: Principal) => diagramOperationPreviewRegistry(config, db, p, runtime.assets);
  function bounded<T extends Record<string, unknown>>(result: T): T {
    if (mcpResultFrameSize({ data: result }) > mcpMaximumFrameBytes)
      fail(413, 'RESPONSE_TOO_LARGE');
    return result;
  }
  function binding(
    family: 'operation' | 'portable',
    previewId: string,
    sourceHash: string,
    direction?: string,
  ): McpTransferBinding {
    return {
      domain: 'knowledge',
      kind: family + '-preview-upload',
      id: previewId,
      revision: sourceHash,
      metadata: { role: 'preview', ...(direction ? { direction } : {}) },
    };
  }
  function metadata(p: Principal, family: 'operation' | 'portable', id: string) {
    return family === 'operation' ? generic(p).metadata(id) : portable.describe(p, id);
  }
  function authorizeTransfer(b: McpTransferBinding, write: boolean, options?: ServiceCallOptions) {
    if (
      b.domain !== 'knowledge' ||
      !purposes.has(b.kind) ||
      !write ||
      b.metadata?.role !== 'preview'
    )
      fail(403, 'FORBIDDEN');
    const family = b.kind === 'operation-preview-upload' ? 'operation' : 'portable',
      p = principal(family === 'operation', options),
      current = metadata(p, family, b.id);
    if (current.sourceHash !== b.revision) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    if (
      family === 'portable' &&
      ('direction' in current ? current.direction : undefined) !== b.metadata.direction
    )
      fail(403, 'FORBIDDEN');
    return p;
  }
  function source(p: Principal, family: 'operation' | 'portable', a: any) {
    const preview = metadata(p, family, a.previewId);
    let maximum = Math.min(a.maxBytes, 16384);
    while (maximum >= 1) {
      const chunk =
        family === 'operation'
          ? generic(p).readSource(a.previewId, { offset: a.offset, maxBytes: maximum })
          : portable.readSource(p, a.previewId, { offset: a.offset, maxBytes: maximum });
      const result = { preview, source: chunk };
      if (mcpResultFrameSize({ data: result }) <= mcpMaximumFrameBytes) return result;
      maximum = Math.floor(maximum / 2);
    }
    return fail(413, 'RESPONSE_TOO_LARGE');
  }
  async function call(name: string, a: any, options?: ServiceCallOptions) {
    if (name === 'cancel_portable_preview')
      return portable.cancel(context.authorize([], options), a.previewId);
    if (name === 'resume_organization_operation') {
      const scopes = ['knowledge:read', 'knowledge:write', 'knowledge:organize'];
      const fresh = () => {
        const p = context.authorize(scopes, options);
        assertRoot(config, db);
        return p;
      };
      const reply = await runtime.knowledge.organization.resume(
        fresh(),
        { operationId: a.operationId },
        fresh,
      );
      const { operationId, requestId, kind, status } = reply.operation;
      return bounded({ kind: 'accepted', operation: { operationId, requestId, kind, status } });
    }
    const isOperation = name.includes('operation_diagram'),
      family = isOperation ? 'operation' : 'portable';
    let p = principal(isOperation, options);
    if (name === 'list_operation_diagram_previews') {
      let limit = a.limit;
      while (limit >= 1) {
        const page = diagramOperationPreviewNeeds(config, db, p, { ...a, limit });
        for (const need of page.documents)
          generic(principal(true, options)).metadata(need.snapshotId);
        if (mcpResultFrameSize({ data: page }) <= mcpMaximumFrameBytes) return page;
        limit--;
      }
      return fail(413, 'RESPONSE_TOO_LARGE');
    }
    if (name === 'list_portable_previews') {
      const items = portable.list(p, { requestId: a.requestId, direction: a.direction });
      for (const item of items) portable.describe(principal(false, options), item.previewId);
      return paginate(
        principal(false, options),
        name + ':' + a.direction + ':' + a.requestId,
        items,
        a,
        { requestId: a.requestId, direction: a.direction, totalCount: items.length },
      );
    }
    if (name === 'get_operation_diagram_preview' || name === 'get_portable_preview')
      return bounded(source(p, family, a));
    const current = metadata(p, family, a.previewId);
    if (a.sourceHash !== current.sourceHash) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
    const expected = binding(
      family,
      a.previewId,
      current.sourceHash,
      'direction' in current ? current.direction : undefined,
    );
    if (
      name === 'begin_operation_diagram_preview_upload' ||
      name === 'begin_portable_preview_upload'
    ) {
      authorizeTransfer(expected, true, options);
      return transfers.beginUpload(p, {
        requestId: a.requestId,
        binding: expected,
        name: 'preview.png',
        mime: 'image/png',
        totalBytes: a.totalBytes,
        sha256: a.sha256,
      });
    }
    if (name === 'prepare_operation_diagram_preview' || name === 'prepare_portable_preview') {
      const info = transfers.info(p, a.transferId);
      // Authorize the owned handle first, then require the exact family, role, baseline and direction.
      p = authorizeTransfer(info.binding, true, options);
      const claim = family + '-preview-' + sha256(a.requestId),
        upload = transfers.readUpload(p, a.transferId, expected, claim);
      if (upload.mime !== 'image/png' || upload.bytes.length > 10 * 1024 * 1024)
        fail(400, 'INVALID_DIAGRAM_PNG');
      p = principal(isOperation, options);
      let result: Record<string, unknown>;
      if (family === 'operation') {
        const prepared = generic(p).prepare(a.previewId, {
          sourceHash: a.sourceHash,
          pngBase64: upload.bytes.toString('base64'),
          requestId: a.requestId,
        });
        result = {
          preview: generic(principal(true, options)).metadata(a.previewId),
          preparedId: prepared.id,
          sourceHash: prepared.sourceHash,
          renderHash: prepared.renderHash,
          previewHash: prepared.previewHash,
          expiresAt: prepared.expiresAt,
        };
      } else {
        const preview = portable.prepare(p, {
          previewId: a.previewId,
          sourceHash: a.sourceHash,
          pngBase64: upload.bytes.toString('base64'),
          requestId: a.requestId,
        });
        result = { preview, previewHash: upload.sha256, ready: true };
        portable.describe(principal(false, options), a.previewId);
      }
      bounded(result);
      // Keep transfer receipts small even when optional renderer metadata is large.
      transfers.complete(p, a.transferId, claim, {
        previewId: a.previewId,
        sourceHash: a.sourceHash,
        previewHash: upload.sha256,
        ...(result.preparedId ? { preparedId: result.preparedId } : {}),
      });
      return result;
    }
    return fail(404, 'UNKNOWN_TOOL');
  }
  return {
    call,
    authorizeTransfer,
    handlesTransfer: (b: McpTransferBinding) => b.domain === 'knowledge' && purposes.has(b.kind),
  };
}
