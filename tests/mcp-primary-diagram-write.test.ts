import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { knowledgeToolByName } from '../shared/mcp-knowledge-tools';
import { requireScope } from '../packages/core/agent/auth';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../shared/mcp-frame';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const f = await pluginRuntimeFixture();
  cleanup.push(f.close);
  const runtime = f.platform.get(),
    transfers = createMcpTransferStore(f.config, f.db);
  let principal = f.principal;
  const port = createKnowledgeToolPort({
    config: f.config,
    db: f.db,
    runtime,
    transfers,
    authorize(scopes) {
      for (const scope of scopes) requireScope(principal, scope);
      return principal;
    },
    toDooAccess: () => ({ listIds: [], domains: [] }),
  });
  const call = async (name: string, input: unknown): Promise<any> => {
    const value = await port.call(name, input);
    expect(mcpResultFrameSize({ data: value })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
    expect(knowledgeToolByName.get(name)!.output.safeParse(value).success).toBe(true);
    return value;
  };
  function append(info: any, bytes: Buffer) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      port.authorizeTransfer(info.binding, true);
      const value = transfers.append(principal, {
        transferId: info.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 16384).toString('base64'),
      });
      expect(mcpResultFrameSize({ data: value })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
    }
  }
  async function reserve(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
    const args = { path: `00-Inbox/${randomUUID()}.md`, type, requestId: randomUUID() };
    const intent = await call('reserve_diagram_document', args);
    expect(await call('reserve_diagram_document', args)).toEqual(intent);
    expect(existsSync(join(f.config.knowledgeRoot, args.path))).toBe(false);
    expect(
      f.db.prepare('SELECT id FROM notes WHERE active=1 AND id=?').get(intent.noteId),
    ).toBeUndefined();
    return { intent, target: { kind: 'creation', intentId: intent.id }, type };
  }
  async function upload(target: any, type: string, source: string) {
    const args = {
      target,
      type,
      sourceBytes: Buffer.byteLength(source),
      previewBytes: png.length,
      sourceSha256: sha(source),
      previewSha256: sha(png),
      requestId: randomUUID(),
    };
    const handles = await call('begin_primary_diagram_upload', args);
    expect(await call('begin_primary_diagram_upload', args)).toEqual(handles);
    append(handles.source, Buffer.from(source));
    append(handles.preview, png);
    return handles;
  }
  async function prepare(
    type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard',
    extraConfig = {},
    sourceOverride?: string,
  ) {
    const reserved = await reserve(type),
      source =
        sourceOverride ??
        (type === 'whiteboard'
          ? JSON.stringify(emptyWhiteboard())
          : type === 'mindmap'
            ? '- child\n'
            : 'flowchart TD\n  A --> B\n');
    const handles = await upload(reserved.target, type, source);
    const args = {
      target: reserved.target,
      type,
      title: '主图',
      renderer: diagramRendererVersions[type],
      config: extraConfig,
      sourceTransferId: handles.source.transferId,
      previewTransferId: handles.preview.transferId,
      sourceHash: sha(source),
      requestId: randomUUID(),
    };
    const prepared = await call('prepare_primary_diagram', args);
    expect(await call('prepare_primary_diagram', args)).toEqual(prepared);
    expect(prepared).not.toHaveProperty('config');
    const markdown = renderPreparedDiagramDocument({
      prepared: { ...prepared, title: args.title, renderer: args.renderer, config: args.config },
      title: args.title,
      source,
      description: '说明\n',
    });
    const main = await call('begin_primary_diagram_document_upload', {
      preparedId: prepared.id,
      totalBytes: Buffer.byteLength(markdown),
      sha256: sha(markdown),
      requestId: randomUUID(),
    });
    append(main, Buffer.from(markdown));
    return { ...reserved, source, handles, args, prepared, markdown, main };
  }
  return {
    ...f,
    runtime,
    transfers,
    port,
    call,
    append,
    reserve,
    upload,
    prepare,
    setPrincipal: (p: typeof principal) => {
      principal = p;
    },
  };
}
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'publishes complete %s Markdown through opaque uploads and bounded receipts',
  async (type) => {
    const f = await fixture(),
      p = await f.prepare(type),
      args = {
        preparedId: p.prepared.id,
        documentTransferId: p.main.transferId,
        requestId: randomUUID(),
      };
    f.runtime.notes.scan();
    expect(
      f.db.prepare('SELECT id FROM notes WHERE active=1 AND id=?').get(p.intent.noteId),
    ).toBeUndefined();
    expect(
      f.db.prepare('SELECT note_id FROM document_state WHERE note_id=?').get(p.intent.noteId),
    ).toBeUndefined();
    const result = await f.call('commit_primary_diagram', args);
    expect(result).toMatchObject({
      id: p.intent.noteId,
      documentType: type,
      contentHash: sha(p.markdown),
      sizeBytes: Buffer.byteLength(p.markdown),
    });
    expect(result).not.toHaveProperty('content');
    expect(f.runtime.notes.getNote(result.id).content).toBe(p.markdown);
    expect(await f.call('commit_primary_diagram', args)).toEqual(result);
    expect((await f.call('get_diagram_creation_intent', { intentId: p.intent.id })).status).toBe(
      'published',
    );
    expect(f.db.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({
      n: type === 'whiteboard' ? 2 : 1,
    });
    const operation = await f.call('get_knowledge_operation', { requestId: args.requestId });
    expect(operation.result).toEqual(result);
    expect(operation.kind).toBe('knowledge.primary-commit');
  },
);
it('keeps large caller render configuration out of prepared and operation replies', async () => {
  const f = await fixture(),
    p = await f.prepare('whiteboard', { label: '大'.repeat(16000) });
  expect(JSON.stringify(p.prepared).length).toBeLessThan(10000);
  expect((await f.call('get_knowledge_operation', { requestId: p.args.requestId })).result).toEqual(
    p.prepared,
  );
});
it('rejects exchanged target and role handles, source digest changes and reused request parameters', async () => {
  const f = await fixture(),
    one = await f.prepare(),
    two = await f.reserve(),
    twoHandles = await f.upload(two.target, two.type, one.source);
  const invoke = (changes: any) =>
    f.call('prepare_primary_diagram', { ...one.args, requestId: randomUUID(), ...changes });
  await expect(invoke({ sourceTransferId: twoHandles.source.transferId })).rejects.toMatchObject({
    code: 'MCP_TRANSFER_CONFLICT',
  });
  await expect(invoke({ sourceTransferId: one.handles.preview.transferId })).rejects.toMatchObject({
    code: 'MCP_TRANSFER_CONFLICT',
  });
  await expect(invoke({ sourceHash: sha('different') })).rejects.toMatchObject({
    code: 'DIAGRAM_SOURCE_HASH_MISMATCH',
  });
  await expect(
    f.call('prepare_primary_diagram', { ...one.args, title: 'different' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    f.call('commit_primary_diagram', {
      preparedId: one.prepared.id,
      documentTransferId: twoHandles.source.transferId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
});
it('rejects digest mismatch before material is accepted', async () => {
  const f = await fixture(),
    r = await f.reserve(),
    h = await f.call('begin_primary_diagram_upload', {
      target: r.target,
      type: r.type,
      sourceBytes: 2,
      previewBytes: png.length,
      sourceSha256: sha('{}'),
      requestId: randomUUID(),
    });
  expect(() => f.append(h.source, Buffer.from('[]'))).toThrowError(
    expect.objectContaining({ code: 'MCP_TRANSFER_HASH_MISMATCH' }),
  );
});
it('reauthorizes each upload chunk and each operation query against current target access and owner', async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.setPrincipal({ ...f.principal, allowedPrefixes: ['other'] });
  expect(() => f.port.authorizeTransfer(p.main.binding, true)).toThrowError(
    expect.objectContaining({ statusCode: 403 }),
  );
  await expect(
    f.call('commit_primary_diagram', {
      preparedId: p.prepared.id,
      documentTransferId: p.main.transferId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    f.call('get_knowledge_operation', { requestId: p.args.requestId }),
  ).rejects.toMatchObject({ statusCode: 403 });
  f.setPrincipal({ ...f.principal, clientId: 'other' });
  await expect(
    f.call('get_diagram_creation_intent', { intentId: p.intent.id }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it('expires uncommitted preparation and creation uploads but preserves cancellation semantics', async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0 WHERE id=?').run(p.prepared.id);
  expect(() => f.port.authorizeTransfer(p.main.binding, true)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_PREPARATION_EXPIRED' }),
  );
  await expect(
    f.call('begin_primary_diagram_document_upload', {
      preparedId: p.prepared.id,
      totalBytes: 1,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREPARATION_EXPIRED' });
  await expect(
    f.call('commit_primary_diagram', {
      preparedId: p.prepared.id,
      documentTransferId: p.main.transferId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREPARATION_EXPIRED' });
  const r = await f.reserve();
  expect((await f.call('cancel_diagram_creation_intent', { intentId: r.intent.id })).status).toBe(
    'cancelled',
  );
  await expect(f.upload(r.target, r.type, p.source)).rejects.toMatchObject({
    code: 'CREATION_INTENT_UNAVAILABLE',
  });
});
it.each(['knowledge.primary-commit', 'diagram-primary.commit'])(
  'recovers %s unknown-success without expired transfer bytes or preparations',
  async (kind) => {
    const f = await fixture(),
      p = await f.prepare(),
      args = {
        preparedId: p.prepared.id,
        documentTransferId: p.main.transferId,
        requestId: randomUUID(),
      };
    f.db.exec(
      `CREATE TRIGGER simulate_lost_receipt BEFORE UPDATE OF status ON operations WHEN NEW.kind='${kind}' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'lost receipt'); END`,
    );
    await expect(f.call('commit_primary_diagram', args)).rejects.toThrow('lost receipt');
    expect(f.runtime.notes.getNote(p.intent.noteId).content).toBe(p.markdown);
    f.db.exec('DROP TRIGGER simulate_lost_receipt');
    f.db.prepare('UPDATE mcp_transfers SET expires_at=0').run();
    f.transfers.cleanup();
    f.db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0').run();
    const result = await f.call('commit_primary_diagram', args);
    expect(result).toMatchObject({ id: p.intent.noteId, contentHash: sha(p.markdown) });
    expect(await f.call('commit_primary_diagram', args)).toEqual(result);
    expect(f.db.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 2 });
    await expect(
      f.call('commit_primary_diagram', { ...args, documentTransferId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await f.call('get_knowledge_operation', { requestId: args.requestId })).result).toEqual(
      result,
    );
  },
);
it('binds main-upload chunk authorization to both current document baselines', async () => {
  const f = await fixture(),
    p = await f.prepare(),
    commitArgs = {
      preparedId: p.prepared.id,
      documentTransferId: p.main.transferId,
      requestId: randomUUID(),
    },
    first = await f.call('commit_primary_diagram', commitArgs);
  const target = {
      kind: 'document',
      noteId: p.intent.noteId,
      expectedDocumentHash: sha(p.markdown),
      expectedSourceHash: sha(p.source),
    },
    handles = await f.upload(target, p.type, p.source);
  const prepared = await f.call('prepare_primary_diagram', {
    ...p.args,
    target,
    sourceTransferId: handles.source.transferId,
    previewTransferId: handles.preview.transferId,
    requestId: randomUUID(),
  });
  const main = await f.call('begin_primary_diagram_document_upload', {
    preparedId: prepared.id,
    totalBytes: Buffer.byteLength(p.markdown),
    requestId: randomUUID(),
  });
  f.runtime.knowledge.core.update(
    f.principal,
    p.intent.noteId,
    p.markdown + 'changed\n',
    first.modifiedAt,
    randomUUID(),
  );
  expect(() => f.port.authorizeTransfer(main.binding, true)).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
  expect(() => f.port.authorizeTransfer(handles.source.binding, true)).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
  expect(await f.call('commit_primary_diagram', commitArgs)).toEqual(first);
});
it('preserves exact UTF-8 BOM bytes in the complete main file', async () => {
  const f = await fixture(),
    p = await f.prepare(),
    markdown = '\ufeff' + p.markdown;
  const main = await f.call('begin_primary_diagram_document_upload', {
    preparedId: p.prepared.id,
    totalBytes: Buffer.byteLength(markdown),
    sha256: sha(markdown),
    requestId: randomUUID(),
  });
  f.append(main, Buffer.from(markdown));
  const result = await f.call('commit_primary_diagram', {
    preparedId: p.prepared.id,
    documentTransferId: main.transferId,
    requestId: randomUUID(),
  });
  expect(result.contentHash).toBe(sha(markdown));
  expect(f.runtime.notes.getNote(result.id).content).toBe(markdown);
});
it('requires live access even for a committed replay and after upload expiry', async () => {
  const f = await fixture(),
    p = await f.prepare(),
    args = {
      preparedId: p.prepared.id,
      documentTransferId: p.main.transferId,
      requestId: randomUUID(),
    },
    result = await f.call('commit_primary_diagram', args);
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0').run();
  f.transfers.cleanup();
  f.db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0').run();
  expect(await f.call('commit_primary_diagram', args)).toEqual(result);
  f.setPrincipal({ ...f.principal, allowedPrefixes: ['other'] });
  await expect(f.call('commit_primary_diagram', args)).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    f.call('get_knowledge_operation', { requestId: args.requestId }),
  ).rejects.toMatchObject({ statusCode: 403 });
});
it('does not recover an unknown attempt that never wrote the document', async () => {
  const f = await fixture(),
    p = await f.prepare(),
    args = {
      preparedId: p.prepared.id,
      documentTransferId: p.handles.source.transferId,
      requestId: randomUUID(),
    };
  await expect(f.call('commit_primary_diagram', args)).rejects.toMatchObject({
    code: 'MCP_TRANSFER_CONFLICT',
  });
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0').run();
  f.transfers.cleanup();
  f.db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0').run();
  await expect(f.call('commit_primary_diagram', args)).rejects.toMatchObject({
    code: 'DIAGRAM_PREPARATION_EXPIRED',
  });
  expect(
    f.db.prepare('SELECT id FROM notes WHERE active=1 AND id=?').get(p.intent.noteId),
  ).toBeUndefined();
});
it('publishes a version-checked existing primary and keeps the original receipt stable', async () => {
  const f = await fixture(),
    p = await f.prepare('flowchart'),
    firstArgs = {
      preparedId: p.prepared.id,
      documentTransferId: p.main.transferId,
      requestId: randomUUID(),
    },
    first = await f.call('commit_primary_diagram', firstArgs);
  const source = 'flowchart TD\n  A --> C\n',
    target = {
      kind: 'document',
      noteId: p.intent.noteId,
      expectedDocumentHash: first.contentHash,
      expectedSourceHash: sha(p.source),
    },
    handles = await f.upload(target, p.type, source);
  const prepared = await f.call('prepare_primary_diagram', {
    ...p.args,
    target,
    sourceHash: sha(source),
    sourceTransferId: handles.source.transferId,
    previewTransferId: handles.preview.transferId,
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({
    prepared: {
      ...prepared,
      title: p.args.title,
      renderer: p.args.renderer,
      config: p.args.config,
    },
    title: p.args.title,
    source,
  });
  const main = await f.call('begin_primary_diagram_document_upload', {
    preparedId: prepared.id,
    totalBytes: Buffer.byteLength(markdown),
    requestId: randomUUID(),
  });
  f.append(main, Buffer.from(markdown));
  const result = await f.call('commit_primary_diagram', {
    preparedId: prepared.id,
    documentTransferId: main.transferId,
    requestId: randomUUID(),
  });
  expect(result).toMatchObject({ id: first.id, contentHash: sha(markdown) });
  expect(result.modifiedAt).not.toBe(first.modifiedAt);
  expect(await f.call('commit_primary_diagram', firstArgs)).toEqual(first);
  expect(f.db.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
});
it('allows owner status and receipt reads with current read-only access while uploads still require write', async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.setPrincipal({ ...f.principal, scopes: ['knowledge:read'] });
  expect((await f.call('get_diagram_creation_intent', { intentId: p.intent.id })).id).toBe(
    p.intent.id,
  );
  expect((await f.call('get_knowledge_operation', { requestId: p.args.requestId })).result).toEqual(
    p.prepared,
  );
  expect(() => f.port.authorizeTransfer(p.main.binding, true)).toThrowError(
    expect.objectContaining({ statusCode: 403 }),
  );
});
it('keeps completed upload progress readable after publication changes the target version', async () => {
  const f = await fixture(),
    p = await f.prepare();
  await f.call('commit_primary_diagram', {
    preparedId: p.prepared.id,
    documentTransferId: p.main.transferId,
    requestId: randomUUID(),
  });
  const info = f.transfers.info(f.principal, p.main.transferId);
  expect(info.state).toBe('completed');
  expect(() => f.port.authorizeTransfer(info.binding, true, undefined, info.state)).not.toThrow();
});
it('streams source and complete Markdown larger than an MCP frame without storing正文 in operation receipts', async () => {
  const f = await fixture(),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'text', type: 'text', text: '大'.repeat(50000) }],
    }),
    p = await f.prepare('whiteboard', {}, source);
  expect(Buffer.byteLength(source)).toBeGreaterThan(mcpMaximumFrameBytes);
  expect(Buffer.byteLength(p.markdown)).toBeGreaterThan(mcpMaximumFrameBytes);
  const result = await f.call('commit_primary_diagram', {
    preparedId: p.prepared.id,
    documentTransferId: p.main.transferId,
    requestId: randomUUID(),
  });
  expect(f.runtime.notes.getNote(result.id).content).toBe(p.markdown);
  for (const row of f.db
    .prepare(
      "SELECT result FROM operations WHERE kind IN ('knowledge.primary-commit','diagram-primary.commit')",
    )
    .all() as { result: string }[]) {
    expect(JSON.parse(row.result)).not.toHaveProperty('content');
    expect(Buffer.byteLength(row.result)).toBeLessThan(16000);
  }
});
it('rejects expired creation intents on later source upload chunks', async () => {
  const f = await fixture(),
    r = await f.reserve(),
    handles = await f.upload(r.target, r.type, JSON.stringify(emptyWhiteboard()));
  f.db.prepare('UPDATE diagram_creation_intents SET expires_at=0 WHERE id=?').run(r.intent.id);
  expect(() => f.port.authorizeTransfer(handles.source.binding, true)).toThrowError(
    expect.objectContaining({ code: 'CREATION_INTENT_UNAVAILABLE' }),
  );
  expect((await f.call('get_diagram_creation_intent', { intentId: r.intent.id })).status).toBe(
    'expired',
  );
});

function movePublishedFixtureDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  intent: { noteId: string; relativePath: string },
) {
  // Represent an independently authorized admin/external move. Product graph movement is Task6.
  const path = `private/${intent.noteId}.md`;
  mkdirSync(join(f.config.knowledgeRoot, 'private'), { recursive: true });
  renameSync(join(f.config.knowledgeRoot, intent.relativePath), join(f.config.knowledgeRoot, path));
  f.db.prepare('UPDATE notes SET path=? WHERE id=? AND active=1').run(path, intent.noteId);
  // Historical receipts also survive later ordinary-description edits; they must not reapply old CAS baselines.
  appendFileSync(join(f.config.knowledgeRoot, path), '\n外部管理员补充说明\n');
  return path;
}

it('checks the current published path for status, historical replay and completed progress after an external move', async () => {
  const f = await fixture(),
    p = await f.prepare();
  const args = {
    preparedId: p.prepared.id,
    documentTransferId: p.main.transferId,
    requestId: randomUUID(),
  };
  const receipt = await f.call('commit_primary_diagram', args);
  const completed = [p.handles.source, p.handles.preview, p.main].map((handle) =>
    f.transfers.info(f.principal, handle.transferId),
  );
  movePublishedFixtureDocument(f, p.intent);

  f.setPrincipal({ ...f.principal, scopes: ['knowledge:read'] });
  await expect(
    f.call('get_diagram_creation_intent', { intentId: p.intent.id }),
  ).rejects.toMatchObject({ statusCode: 403 });
  for (const requestId of [p.args.requestId, args.requestId])
    await expect(f.call('get_knowledge_operation', { requestId })).rejects.toMatchObject({
      statusCode: 403,
    });

  f.setPrincipal(f.principal);
  await expect(f.call('commit_primary_diagram', args)).rejects.toMatchObject({ statusCode: 403 });
  await expect(f.call('prepare_primary_diagram', p.args)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(
    f.call('cancel_diagram_creation_intent', { intentId: p.intent.id }),
  ).rejects.toMatchObject({ statusCode: 403 });
  for (const info of completed) {
    expect(info.state).toBe('completed');
    expect(() => f.port.authorizeTransfer(info.binding, true, undefined, info.state)).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  }

  f.setPrincipal({ ...f.principal, scopes: ['knowledge:read'], allowedPrefixes: ['private'] });
  expect(await f.call('get_diagram_creation_intent', { intentId: p.intent.id })).toMatchObject({
    status: 'published',
    relativePath: p.intent.relativePath,
  });
  expect((await f.call('get_knowledge_operation', { requestId: p.args.requestId })).result).toEqual(
    p.prepared,
  );
  expect((await f.call('get_knowledge_operation', { requestId: args.requestId })).result).toEqual(
    receipt,
  );

  f.setPrincipal({ ...f.principal, allowedPrefixes: ['private'] });
  expect(await f.call('commit_primary_diagram', args)).toEqual(receipt);
  expect(await f.call('prepare_primary_diagram', p.args)).toEqual(p.prepared);
  for (const info of completed)
    expect(() => f.port.authorizeTransfer(info.binding, true, undefined, info.state)).not.toThrow();
  await expect(
    f.call('cancel_diagram_creation_intent', { intentId: p.intent.id }),
  ).rejects.toMatchObject({ code: 'CREATION_ALREADY_PUBLISHED' });
  await expect(
    f.call('begin_primary_diagram_upload', {
      target: p.target,
      type: p.type,
      sourceBytes: Buffer.byteLength(p.source),
      previewBytes: png.length,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'CREATION_ALREADY_PUBLISHED' });
  await expect(
    f.call('begin_primary_diagram_document_upload', {
      preparedId: p.prepared.id,
      totalBytes: 1,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'CREATION_INTENT_UNAVAILABLE' });
});

it.each(['knowledge.primary-commit', 'diagram-primary.commit'])(
  'checks the current published path before recovering moved %s unknown-success',
  async (kind) => {
    const f = await fixture(),
      p = await f.prepare(),
      args = {
        preparedId: p.prepared.id,
        documentTransferId: p.main.transferId,
        requestId: randomUUID(),
      };
    f.db.exec(
      `CREATE TRIGGER simulate_moved_lost_receipt BEFORE UPDATE OF status ON operations WHEN NEW.kind='${kind}' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'lost receipt'); END`,
    );
    await expect(f.call('commit_primary_diagram', args)).rejects.toThrow('lost receipt');
    f.db.exec('DROP TRIGGER simulate_moved_lost_receipt');
    const modifiedAt = f.runtime.notes.getNote(p.intent.noteId).modifiedAt;
    movePublishedFixtureDocument(f, p.intent);
    f.db.prepare('UPDATE mcp_transfers SET expires_at=0').run();
    f.transfers.cleanup();
    f.db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0').run();

    f.setPrincipal({ ...f.principal, scopes: ['knowledge:read'] });
    await expect(
      f.call('get_diagram_creation_intent', { intentId: p.intent.id }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.call('get_knowledge_operation', { requestId: args.requestId }),
    ).rejects.toMatchObject({ statusCode: 403 });
    f.setPrincipal(f.principal);
    await expect(f.call('commit_primary_diagram', args)).rejects.toMatchObject({ statusCode: 403 });

    f.setPrincipal({ ...f.principal, allowedPrefixes: ['private'], scopes: ['knowledge:read'] });
    expect((await f.call('get_knowledge_operation', { requestId: args.requestId })).status).toBe(
      'prepared',
    );
    expect((await f.call('get_diagram_creation_intent', { intentId: p.intent.id })).status).toBe(
      'published',
    );
    f.setPrincipal({ ...f.principal, allowedPrefixes: ['private'] });
    const receipt = await f.call('commit_primary_diagram', args);
    expect(receipt).toMatchObject({
      id: p.intent.noteId,
      relativePath: p.intent.relativePath,
      modifiedAt,
      contentHash: sha(p.markdown),
    });
    expect((await f.call('get_knowledge_operation', { requestId: args.requestId })).result).toEqual(
      receipt,
    );
    expect(await f.call('commit_primary_diagram', args)).toEqual(receipt);
    expect(f.db.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 2 });
  },
);
