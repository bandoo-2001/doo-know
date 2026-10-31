import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews.js';
import { portablePreviewRegistry } from '../packages/core/portable-delivery/previews.js';
import { sha256, beginOperation } from '../packages/core/knowledge/operations.js';
import { diagramRendererVersions } from '../shared/diagram-primary.js';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation.js';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams.js';
import { renderPreparedDiagramDocument } from '../shared/diagram-primary.js';
import { directoryByPath } from '../packages/core/organization/catalog.js';
import { emptyWhiteboard } from '../shared/whiteboard.js';
import { requireScope } from '../packages/core/agent/auth.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import { mcpResultFrameSize } from '../shared/mcp-frame.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { BridgeError, annotateError, errorBody } from '../plugins/mcp/server/errors.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
async function fixture() {
  const f = await pluginRuntimeFixture();
  cleanup.push(f.close);
  let caller: Principal = f.principal;
  const runtime = f.platform.get(),
    transfers = createMcpTransferStore(f.config, f.db);
  const port = createKnowledgeToolPort({
    config: f.config,
    db: f.db,
    runtime,
    transfers,
    authorize(scopes) {
      for (const scope of scopes) requireScope(caller, scope);
      return caller;
    },
    toDooAccess: () => ({ listIds: [], domains: [] }),
  });
  const call = async (name: string, args: any) => {
    const result: any = await port.call(name, args);
    expect(mcpResultFrameSize({ data: result })).toBeLessThanOrEqual(65536);
    return result;
  };
  const create = (name: string, content = '# Baseline') =>
    runtime.knowledge.core.create(f.principal, '00-Inbox', name, content, randomUUID());
  const registry = (p = caller) =>
      diagramOperationPreviewRegistry(f.config, f.db, p, runtime.assets),
    portable = portablePreviewRegistry(f.config, f.db);
  function fixed(source = JSON.stringify(emptyWhiteboard()), context?: unknown) {
    const note = create('native-' + randomUUID() + '.md');
    const snapshot = registry().fix({
      noteId: note.id,
      role: 'primary',
      documentPath: note.relativePath,
      documentHash: note.contentHash,
      documentModifiedAt: note.modifiedAt,
      sourceHash: sha256(source),
      finalSource: source,
      type: 'whiteboard',
      title: 'Native title',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      moves: [],
      context,
    });
    return { note, snapshot };
  }
  const upload = (info: any, bytes = png) => {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      port.authorizeTransfer(info.binding, true);
      transfers.append(caller, {
        transferId: info.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 16384).toString('base64'),
      });
    }
  };
  const privateFix = (
    note: any,
    direction: 'export' | 'import' = 'export',
    requestId = 'portable-fixed',
    source = JSON.stringify(emptyWhiteboard()),
    p = caller,
  ) =>
    portable.fix(p, {
      direction,
      requestId,
      contextHash: sha256(requestId),
      document: note.relativePath,
      role: 'primary',
      source,
      type: 'whiteboard',
      title: 'Private',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      permissions: [direction === 'export' ? note.relativePath : '00-Inbox/imported/private.md'],
      proofs:
        direction === 'export'
          ? [{ noteId: note.id, path: note.relativePath, hash: note.contentHash }]
          : [],
    });
  return {
    ...f,
    runtime,
    port,
    transfers,
    call,
    create,
    registry,
    portable,
    fixed,
    upload,
    privateFix,
    setCaller(p: Principal) {
      caller = p;
    },
    caller: () => caller,
  };
}
it('keeps complete portable preview counts across SDK error annotations without source, paths or unbounded metadata', () => {
  const refs = Array.from({ length: 41 }, () => ({
    previewId: randomUUID(),
    sourceHash: sha256('source'),
    renderHash: sha256('render'),
    role: 'primary',
    type: 'whiteboard',
    direction: 'export',
    source: 'SECRET_SOURCE',
    document: '/srv/secrets',
    config: { token: 'SECRET_TOKEN' },
  }));
  const original = new BridgeError('DIAGRAM_PREVIEW_REQUIRED', 409);
  original.details = { portablePreviews: refs, totalCount: 41 } as any;
  const result: any = errorBody(
    annotateError(original, 'export_portable_documents', { requestId: 'same' }),
  );
  expect(result.error.details).toMatchObject({ totalCount: 41, direction: 'export' });
  expect(result.error.details.portablePreviews).toHaveLength(20);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|\/srv\/secrets/);
  expect(mcpResultFrameSize(result)).toBeLessThanOrEqual(65536);
});
it('reads an 8 MiB fixed source only in bounded exact byte chunks and prepares an actor-bound PNG', async () => {
  const f = await fixture(),
    source = JSON.stringify({ ...emptyWhiteboard(), unknown: 'x'.repeat(8 * 1024 * 1024 - 2000) }),
    { snapshot } = f.fixed(source);
  const first = await f.call('get_operation_diagram_preview', {
    previewId: snapshot.id,
    maxBytes: 16384,
  });
  expect(first.preview.sourceSizeBytes).toBe(Buffer.byteLength(source));
  expect(Buffer.from(first.source.content, 'base64')).toEqual(
    Buffer.from(source).subarray(0, 16384),
  );
  expect(first.preview).not.toHaveProperty('source');
  const tail = await f.call('get_operation_diagram_preview', {
    previewId: snapshot.id,
    offset: Buffer.byteLength(source) - 19,
    maxBytes: 16384,
  });
  expect(Buffer.from(tail.source.content, 'base64')).toEqual(Buffer.from(source).subarray(-19));
  expect(tail.source.eof).toBe(true);
  await expect(
    f.call('get_operation_diagram_preview', { previewId: snapshot.id, maxBytes: 32768 }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const input = {
    previewId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    totalBytes: png.length,
    sha256: sha256(png),
    requestId: 'generic-png',
  };
  const upload = await f.call('begin_operation_diagram_preview_upload', input);
  f.upload(upload);
  const prepared = await f.call('prepare_operation_diagram_preview', {
    previewId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    transferId: upload.transferId,
    requestId: 'generic-prepare',
  });
  expect(prepared.previewHash).toBe(sha256(png));
  expect(f.registry().prepared(snapshot.id)?.id).toBe(prepared.preparedId);
}, 30000);
it('pages every pending generic need and rejects stale baselines, revoked grants, foreign actors and wrong-purpose PNGs', async () => {
  const f = await fixture(),
    { note, snapshot } = f.fixed(),
    documents = Array.from({ length: 41 }, (_, n) => {
      const s = f.registry().fix({ ...snapshot.input, context: { n } });
      return {
        noteId: note.id,
        role: 'primary',
        documentHash: note.contentHash,
        sourceHash: s.sourceHash,
        renderHash: s.renderHash,
        snapshotId: s.id,
      };
    });
  const { operation } = beginOperation(f.db, f.principal, 'move', 'native-paged', {});
  f.db.prepare("UPDATE operations SET status='awaiting_preview',error=? WHERE id=?").run(
    JSON.stringify({
      code: 'DIAGRAM_PREVIEW_REQUIRED',
      details: { planId: documents[0].snapshotId, documents },
    }),
    operation.id,
  );
  let cursor: string | undefined,
    found: string[] = [];
  do {
    const page = await f.call('list_operation_diagram_previews', {
      operationId: operation.id,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.documents.map((d: any) => d.snapshotId));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual(documents.map((d) => d.snapshotId));
  const first = await f.call('list_operation_diagram_previews', {
    operationId: operation.id,
    limit: 1,
  });
  f.setCaller({ ...f.principal, clientId: 'foreign' });
  await expect(
    f.call('get_operation_diagram_preview', { previewId: snapshot.id }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  f.setCaller({ ...f.principal, allowedPrefixes: [] });
  await expect(
    f.call('get_operation_diagram_preview', { previewId: snapshot.id }),
  ).rejects.toThrow();
  await expect(
    f.call('list_operation_diagram_previews', {
      operationId: operation.id,
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow();
  f.setCaller(f.principal);
  const wrong = f.transfers.beginUpload(f.principal, {
    requestId: 'wrong-preview',
    binding: { domain: 'knowledge', kind: 'asset-upload', id: note.id },
    name: 'preview.png',
    mime: 'image/png',
    totalBytes: png.length,
    sha256: sha256(png),
  });
  f.transfers.append(f.principal, {
    transferId: wrong.transferId,
    offset: 0,
    base64: png.toString('base64'),
  });
  await expect(
    f.call('prepare_operation_diagram_preview', {
      previewId: snapshot.id,
      sourceHash: snapshot.sourceHash,
      transferId: wrong.transferId,
      requestId: 'wrong-role',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const bad = Buffer.from('not a PNG'),
    invalid = await f.call('begin_operation_diagram_preview_upload', {
      previewId: snapshot.id,
      sourceHash: snapshot.sourceHash,
      totalBytes: bad.length,
      sha256: sha256(bad),
      requestId: 'bad-structure',
    });
  f.upload(invalid, bad);
  await expect(
    f.call('prepare_operation_diagram_preview', {
      previewId: snapshot.id,
      sourceHash: snapshot.sourceHash,
      transferId: invalid.transferId,
      requestId: 'bad-png',
    }),
  ).rejects.toThrow();
  expect(f.registry().prepared(snapshot.id)).toBeUndefined();
  const upload = await f.call('begin_operation_diagram_preview_upload', {
    previewId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    totalBytes: png.length,
    sha256: sha256(png),
    requestId: 'stale-png',
  });
  f.upload(upload);
  await writeFile(join(f.config.knowledgeRoot, note.relativePath), '# Changed');
  await expect(
    f.call('prepare_operation_diagram_preview', {
      previewId: snapshot.id,
      sourceHash: snapshot.sourceHash,
      transferId: upload.transferId,
      requestId: 'stale-prepare',
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(() => f.port.authorizeTransfer(upload.binding, true)).toThrow();
  await expect(
    f.call('get_operation_diagram_preview', { previewId: snapshot.id }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});
it('supports private read-only export preparation without knowledge assets and requires fresh import write authority', async () => {
  const f = await fixture(),
    note = f.create('private.md');
  const readonly = { ...f.principal, scopes: ['knowledge:read'] };
  f.setCaller(readonly);
  const need = f.privateFix(note),
    initialAssets = (f.db.prepare('SELECT count(*) n FROM assets').get() as any).n;
  const read = await f.call('get_portable_preview', { previewId: need.previewId, maxBytes: 16384 });
  expect(read.preview.direction).toBe('export');
  expect(Buffer.from(read.source.content, 'base64').toString()).toBe(
    JSON.stringify(emptyWhiteboard()),
  );
  const upload = await f.call('begin_portable_preview_upload', {
    previewId: need.previewId,
    sourceHash: need.sourceHash,
    totalBytes: png.length,
    sha256: sha256(png),
    requestId: 'private-png',
  });
  f.upload(upload);
  const result = await f.call('prepare_portable_preview', {
    previewId: need.previewId,
    sourceHash: need.sourceHash,
    transferId: upload.transferId,
    requestId: 'private-prepare',
  });
  expect(result.ready).toBe(true);
  expect((f.db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(initialAssets);
  expect(f.portable.prepared(readonly, need.previewId)?.previewHash).toBe(sha256(png));
  f.setCaller(f.principal);
  const generic = f.fixed();
  await expect(
    f.call('prepare_operation_diagram_preview', {
      previewId: generic.snapshot.id,
      sourceHash: generic.snapshot.sourceHash,
      transferId: upload.transferId,
      requestId: 'cross-family',
    }),
  ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
  const incoming = f.privateFix(note, 'import', 'incoming');
  f.setCaller(readonly);
  await expect(
    f.call('get_portable_preview', { previewId: incoming.previewId }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  f.setCaller({ ...readonly, allowedPrefixes: [] });
  expect(() => f.port.authorizeTransfer(upload.binding, true)).toThrow();
  const before = (
    f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any
  ).n;
  expect(await f.call('cancel_portable_preview', { previewId: need.previewId })).toMatchObject({
    cancelled: true,
  });
  expect(
    (f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any).n,
  ).toBeLessThan(before);
  f.setCaller({ ...f.principal, id: 'foreign' });
  await expect(f.call('get_portable_preview', { previewId: need.previewId })).rejects.toMatchObject(
    { code: 'PORTABLE_PREVIEW_NOT_FOUND' },
  );
});
it('pages every private preview ID for the original request and binds cursors to current permissions', async () => {
  const f = await fixture(),
    note = f.create('many-previews.md'),
    readonly = { ...f.principal, scopes: ['knowledge:read'] };
  f.setCaller(readonly);
  const expected = Array.from(
    { length: 41 },
    (_, n) =>
      f.privateFix(
        note,
        'export',
        'all-private',
        JSON.stringify({ ...emptyWhiteboard(), group: n }),
        readonly,
      ).previewId,
  );
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.call('list_portable_previews', {
      requestId: 'all-private',
      direction: 'export',
      limit: 20,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.totalCount).toBe(41);
    found.push(...page.items.map((i: any) => i.previewId));
    cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(found)).toEqual(new Set(expected));
  const first = await f.call('list_portable_previews', {
    requestId: 'all-private',
    direction: 'export',
    limit: 1,
  });
  f.setCaller({ ...readonly, allowedPrefixes: [] });
  await expect(
    f.call('list_portable_previews', {
      requestId: 'all-private',
      direction: 'export',
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow();
});
it('uses the actual SDK transport for generic and private preview chunk/upload/prepare workflows', async () => {
  const f = await fixture(),
    { snapshot } = f.fixed(),
    note = f.create('sdk-private.md'),
    need = f.privateFix(note);
  const services = {
    ...f.services,
    knowledgeTools: f.port,
    transfers: {
      async call(name: string, a: any) {
        const p = f.caller(),
          info = f.transfers.info(p, a.transferId);
        f.port.authorizeTransfer(info.binding, info.direction === 'upload');
        if (name === 'append_mcp_upload') return f.transfers.append(p, a);
        return f.transfers.info(p, a.transferId);
      },
    },
  };
  const operations = createOperations(
    { objectIdSecret: 'preview-sdk-object-secret-at-least-32-characters' },
    hostClient(
      () => services,
      () => ({}),
    ),
  );
  const server = new McpServer({ name: 'previews-sdk', version: '1.0.0' });
  registerOperations(server, operations, f.principal, {});
  const client = new Client({ name: 'preview-client', version: '1.0.0' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const invoke = async (name: string, args: any) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '\0'.repeat(128), result: response })),
    ).toBeLessThanOrEqual(65536);
    return (response.structuredContent as any).data;
  };
  for (const [family, id, hash] of [
    ['operation_diagram', snapshot.id, snapshot.sourceHash],
    ['portable', need.previewId, need.sourceHash],
  ]) {
    const read = await invoke('get_' + family + '_preview', { previewId: id, maxBytes: 16384 });
    expect(read.source.sourceHash).toBe(hash);
    const upload = await invoke('begin_' + family + '_preview_upload', {
      previewId: id,
      sourceHash: hash,
      totalBytes: png.length,
      sha256: sha256(png),
      requestId: 'sdk-' + family + '-png',
    });
    await invoke('append_mcp_upload', {
      transferId: upload.transferId,
      offset: 0,
      base64: png.toString('base64'),
    });
    const prepared = await invoke('prepare_' + family + '_preview', {
      previewId: id,
      sourceHash: hash,
      transferId: upload.transferId,
      requestId: 'sdk-' + family + '-prepare',
    });
    expect(prepared.previewHash).toBe(sha256(png));
  }
});

it('prepares every fixed native need and resumes the original organization operation through the MCP port', async () => {
  const f = await fixture();
  f.principal.scopes.push('knowledge:organize');
  const target = f.create('target.md', '# Target'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'linker', type: 'rectangle', link: '../target.md' }],
    });
  const primary = primaryDiagramService(
    f.config,
    f.db,
    f.runtime.notes,
    f.runtime.assets,
    f.principal,
  );
  const intent = diagramCreationService(f.config, f.db, f.principal).reserve({
    path: '00-Inbox/board.md',
    type: 'whiteboard',
    requestId: 'org-board-intent',
  });
  const prepared = primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'whiteboard',
    source,
    sourceHash: sha256(source),
    title: 'Board',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: 'org-board-prepare',
  });
  primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: 'Board', source }),
    requestId: 'org-board-commit',
  });
  const org = f.runtime.knowledge.organization,
    context = org.context(f.principal);
  const reply = await org.submit(f.principal, {
    ...context,
    requestId: 'org-native-move',
    expectedStructureRevision: context.structureRevision,
    actions: [
      {
        type: 'move_note',
        noteId: target.id,
        toDirectoryId: directoryByPath(f.db, '00-Inbox')!.id,
        fileName: 'renamed.md',
        expectedModifiedAt: target.modifiedAt,
        expectedContentHash: target.contentHash,
      },
    ],
  });
  await org.drain();
  expect(org.operation(f.principal, { operationId: reply.operation.operationId }).status).toBe(
    'awaiting_preview',
  );
  const needs = await f.call('list_operation_diagram_previews', {
    operationId: reply.operation.operationId,
  });
  for (const need of needs.documents) {
    const read = await f.call('get_operation_diagram_preview', { previewId: need.snapshotId });
    expect(Buffer.from(read.source.content, 'base64').toString()).toContain('renamed.md');
    const upload = await f.call('begin_operation_diagram_preview_upload', {
      previewId: need.snapshotId,
      sourceHash: need.sourceHash,
      totalBytes: png.length,
      sha256: sha256(png),
      requestId: 'org-png-' + need.snapshotId,
    });
    f.upload(upload);
    await f.call('prepare_operation_diagram_preview', {
      previewId: need.snapshotId,
      sourceHash: need.sourceHash,
      transferId: upload.transferId,
      requestId: 'org-prepare-' + need.snapshotId,
    });
  }
  const resumed = await f.call('resume_organization_operation', {
    operationId: reply.operation.operationId,
  });
  expect(resumed.kind).toBe('accepted');
  await org.drain();
  expect(org.operation(f.principal, { operationId: reply.operation.operationId }).status).toBe(
    'succeeded',
  );
  expect(f.runtime.notes.row(target.id).path).toBe('00-Inbox/renamed.md');
});

it('rejects source reads and pending PNG transfers when the active workspace binding changes', async () => {
  const f = await fixture(),
    { snapshot } = f.fixed(),
    note = f.create('workspace.md'),
    need = f.privateFix(note);
  const upload = await f.call('begin_operation_diagram_preview_upload', {
    previewId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    totalBytes: png.length,
    sha256: sha256(png),
    requestId: 'workspace-upload',
  });
  const prior = (
    f.db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
  ).value;
  f.db.prepare("UPDATE index_meta SET value='other-workspace' WHERE key='root_identity'").run();
  await expect(
    f.call('get_operation_diagram_preview', { previewId: snapshot.id }),
  ).rejects.toThrow();
  await expect(f.call('get_portable_preview', { previewId: need.previewId })).rejects.toThrow();
  expect(() => f.port.authorizeTransfer(upload.binding, true)).toThrow();
  f.db.prepare("UPDATE index_meta SET value=? WHERE key='root_identity'").run(prior);
});
