import { afterEach, expect, it } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { requireScope } from '../packages/core/agent/auth.js';
import { currentPrincipalPolicy } from '../packages/core/agent/config.js';
import { projectPermissionPrincipal } from '../packages/core/auth/permissions.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import { directoryByPath } from '../packages/core/organization/catalog.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { createHash } from 'node:crypto';
import { emptyWhiteboard } from '../shared/whiteboard.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await pluginRuntimeFixture();
  cleanups.push(f.close);
  f.principal.scopes.push('knowledge:archive', 'knowledge:organize', 'knowledge:share');
  let caller: Principal = f.principal;
  const transfers = createMcpTransferStore(f.config, f.db);
  const module = await import('../apps/server/plugins/knowledge-tools.js').catch(() => undefined);
  expect(module, 'caller-aware knowledge domain adapter is available').toBeDefined();
  const port = module!.createKnowledgeToolPort({
    config: f.config,
    db: f.db,
    runtime: f.platform.get(),
    authorize(scopes: string[]) {
      const p = currentPrincipalPolicy(f.config, f.db, caller)!;
      for (const scope of scopes) requireScope(p, scope);
      return p;
    },
    toDooAccess: () => ({ listIds: [], domains: [] }),
    transfers,
  });
  const call = (name: string, input: any = {}) => port.call(name, input);
  let created = 0;
  const create = (fileName: string, content = '# Original') =>
    f.platform
      .get()
      .knowledge.core.create(
        f.principal,
        '00-Inbox',
        fileName,
        content,
        fileName.replaceAll('.', '-') + '-create-' + created++,
      );
  const upload = (session: any, bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length; offset += 8192)
      transfers.append(f.principal, {
        transferId: session.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 8192).toString('base64'),
      });
  };
  return {
    ...f,
    call,
    create,
    port,
    transfers,
    upload,
    setCaller(p: Principal) {
      caller = p;
    },
  };
}

it('reads a note-bound revision through snapshots and restores using a replayable file operation', async () => {
  const f = await fixture(),
    a = f.create('history.md'),
    b = f.create('unrelated.md');
  const k = f.platform.get().knowledge;
  const changed = k.core.update(f.principal, a.id, '# New', a.modifiedAt, 'history-update');
  const history: any = await f.call('list_note_revisions', { noteId: a.id, limit: 1 });
  expect(history.items).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain(f.config.dataRoot);
  const revisionId = history.items[0].id;
  await expect(f.call('read_note_revision', { noteId: b.id, revisionId })).rejects.toMatchObject({
    code: 'REVISION_NOT_FOUND',
  });
  let read: any = await f.call('read_note_revision', { noteId: a.id, revisionId });
  if (read.kind === 'accepted') {
    await k.snapshots.drain();
    read = await f.call('read_note_revision', { noteId: a.id, revisionId });
  }
  expect(read.data.content).toBe('# Original');
  const args = {
    noteId: a.id,
    revisionId,
    expectedModifiedAt: changed.modifiedAt,
    requestId: 'history-restore',
  };
  const receipt: any = await f.call('restore_note_revision', args);
  await k.files.drain();
  expect((await k.files.operation(f.principal, receipt.operation.operationId)).status).toBe(
    'succeeded',
  );
  expect(((await f.call('restore_note_revision', args)) as any).operation.operationId).toBe(
    receipt.operation.operationId,
  );
  expect(f.platform.get().notes.getNote(a.id).content).toBe('# Original');
  await expect(
    f
      .call('restore_note_revision', { ...args, requestId: 'stale-revision-restore' })
      .then(async (r: any) => {
        await k.files.drain();
        const op = k.files.operation(f.principal, r.operation.operationId);
        if (op.status !== 'succeeded') throw { code: op.error?.code };
      }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

it('imports bounded source documents and exports a multi-megabyte authorized snapshot through real opaque transfers', async () => {
  const f = await fixture(),
    content = Buffer.from('# Imported\n' + 'a\n'.repeat(50_000));
  const session: any = await f.call('begin_note_document_upload', {
    directory: '00-Inbox',
    name: 'imported.md',
    mime: 'text/markdown',
    totalBytes: content.length,
    requestId: 'doc-upload-begin',
  });
  f.upload(session, content);
  const args = { transferId: session.transferId, requestId: 'doc-upload-complete' };
  const saved: any = await f.call('complete_note_document_upload', args);
  expect(f.platform.get().notes.getNote(saved.id).content).toBe(content.toString());
  expect(await f.call('complete_note_document_upload', args)).toEqual(saved);
  const changed = Buffer.from('# Changed document\n');
  const updateUpload: any = await f.call('begin_note_document_upload', {
    noteId: saved.id,
    expectedModifiedAt: saved.modifiedAt,
    name: 'imported.md',
    mime: 'text/markdown',
    totalBytes: changed.length,
    requestId: 'doc-update-begin',
  });
  f.upload(updateUpload, changed);
  const updateArgs = { transferId: updateUpload.transferId, requestId: 'doc-update-complete' };
  const updated = await f.call('complete_note_document_upload', updateArgs);
  expect(f.platform.get().notes.getNote(saved.id).content).toBe(changed.toString());
  expect(await f.call('complete_note_document_upload', updateArgs)).toEqual(updated);
  expect(
    f.port.authorizeTransfer(f.transfers.info(f.principal, updateUpload.transferId).binding, false)
      .id,
  ).toBe(f.principal.id);
  await writeFile(
    join(f.config.knowledgeRoot, '00-Inbox/huge.md'),
    '# Huge\n' + 'abc\n'.repeat(550_000),
  );
  f.platform.get().notes.scan();
  const huge = f.db
    .prepare("SELECT id FROM notes WHERE path='00-Inbox/huge.md' AND active=1")
    .get() as { id: string };
  let download: any = await f.call('download_note_document', {
    noteId: huge.id,
    requestId: 'huge-download',
  });
  if (download.kind === 'accepted') {
    await f.platform.get().knowledge.snapshots.drain();
    download = await f.call('download_note_document', {
      noteId: huge.id,
      requestId: 'huge-download',
    });
  }
  expect(download.totalBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(JSON.stringify(download)).not.toContain(f.config.dataRoot);
  expect(
    Buffer.from(
      f.transfers.read(f.principal, { transferId: download.transferId, offset: 0 }).base64,
      'base64',
    ).toString(),
  ).toContain('# Huge');
  f.principal.allowedPrefixes = ['00-Inbox/imported.md'];
  expect(() => f.port.authorizeTransfer(download.binding, false)).toThrow();
});

it('previews collision-safe bulk imports, preserves attachments, pages receipts and exports the source bundle', async () => {
  const f = await fixture();
  f.principal.scopes.push('knowledge:manage');
  (f.principal as Principal).knowledgeAll = true;
  f.create('bundle.md', '# Existing');
  const entries = [
    { path: 'bundle.md', encoding: 'utf8', content: '# Bundle\n[PDF](assets/file.pdf)' },
    {
      path: 'assets/file.pdf',
      encoding: 'base64',
      content: Buffer.from('%PDF-1.7\nsource').toString('base64'),
    },
  ];
  const payload = Buffer.from(
    JSON.stringify({ entries, folderPath: '00-Inbox', collision: 'rename' }),
  );
  const session: any = await f.call('begin_knowledge_bundle_upload', {
    name: 'source.json',
    mime: 'application/json',
    totalBytes: payload.length,
    requestId: 'bundle-upload',
  });
  f.upload(session, payload);
  const preview: any = await f.call('preview_knowledge_bundle_import', {
    transferId: session.transferId,
    limit: 1,
  });
  expect(preview).toMatchObject({
    totalItems: 2,
    items: [{ targetPath: '00-Inbox/bundle (2).md', decision: 'rename' }],
  });
  const args = {
    transferId: session.transferId,
    expectedPreviewHash: preview.previewHash,
    requestId: 'bundle-import',
  };
  const job: any = await f.call('apply_knowledge_bundle_import', args);
  expect(job).toMatchObject({ state: 'succeeded', completed: 2, failed: 0 });
  expect(await f.call('apply_knowledge_bundle_import', args)).toEqual(job);
  expect(
    await f.call('preview_knowledge_bundle_import', {
      transferId: session.transferId,
      section: 'warnings',
    }),
  ).toMatchObject({ items: [], warningsTotal: 0 });
  expect(await f.call('get_knowledge_operation', { requestId: args.requestId })).toMatchObject({
    status: 'succeeded',
    result: { jobId: job.jobId },
  });
  const status: any = await f.call('get_knowledge_bundle_job', { jobId: job.jobId, limit: 1 });
  expect(status.items).toHaveLength(1);
  expect(status.nextCursor).toBeDefined();
  const imported = f.db
    .prepare("SELECT id FROM notes WHERE path='00-Inbox/bundle (2).md' AND active=1")
    .get() as { id: string };
  expect(f.platform.get().notes.getNote(imported.id).content).toContain('assets/file.pdf');
  const structure = f.platform.get().knowledge.organization.context(f.principal).structureRevision;
  let exported: any = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: structure,
    requestId: 'bundle-export',
  });
  if (exported.state === 'waiting') {
    await f.platform.get().knowledge.snapshots.drain();
    exported = await f.call('continue_knowledge_bundle_job', {
      jobId: exported.jobId,
      expectedRevision: exported.revision,
      requestId: 'bundle-export-continue',
    });
  }
  expect(exported).toMatchObject({
    state: 'succeeded',
    download: { direction: 'download', mime: 'application/gzip' },
  });
  const first = f.transfers.read(f.principal, {
    transferId: exported.download.transferId,
    offset: 0,
  });
  expect(Buffer.from(first.base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([31, 139]));
  expect(await f.call('list_knowledge_bundle_jobs', { limit: 1 })).toMatchObject({
    items: [{ kind: 'export' }],
    nextCursor: expect.any(String),
  });
});

it('binds attachment and diagram uploads to the note version and resolves whiteboards with independent target rights', async () => {
  const f = await fixture(),
    a = f.create('asset-note.md'),
    other = f.create('other-note.md');
  const pdf = Buffer.from('%PDF-1.7\nexample');
  const session: any = await f.call('begin_note_asset_upload', {
    noteId: a.id,
    expectedModifiedAt: a.modifiedAt,
    name: 'test.pdf',
    mime: 'application/pdf',
    totalBytes: pdf.length,
    requestId: 'asset-begin',
  });
  f.upload(session, pdf);
  const asset: any = await f.call('complete_note_asset_upload', {
    transferId: session.transferId,
    requestId: 'asset-complete',
  });
  expect(asset.mime).toBe('application/pdf');
  const policy = {
    version: 2 as const,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: f.platform.get().knowledge.organization.context(f.principal).libraryId,
        actions: ['read', 'write', 'archive'],
        resources: { mode: 'selected' as const, resources: [{ kind: 'note', id: other.id }] },
      },
    },
  };
  f.config.agent!.policies[0] = { ...f.principal, permissionPolicy: policy, policyVersion: 2 };
  f.setCaller(projectPermissionPrincipal(f.db, f.principal, policy));
  await writeFile(
    join(f.config.knowledgeRoot, '00-Inbox/assets/unrelated.pdf'),
    '%PDF-1.7\nprivate',
  );
  expect(await f.call('list_note_assets', { noteId: other.id })).toMatchObject({ items: [] });
  expect(
    f.db.prepare("SELECT id FROM assets WHERE path='00-Inbox/assets/unrelated.pdf'").get(),
  ).toBeUndefined();
  await expect(
    f.call('download_note_asset', {
      noteId: other.id,
      assetId: asset.id,
      requestId: 'leak-download',
    }),
  ).rejects.toThrow();
  f.config.agent!.policies[0] = f.principal;
  f.setCaller(f.principal);
  const board = f.platform
    .get()
    .knowledge.core.create(
      f.principal,
      '00-Inbox',
      'board.excalidraw',
      JSON.stringify(emptyWhiteboard()),
      'board-create',
    );
  expect(await f.call('resolve_note_whiteboard', { noteId: a.id, source: board.id })).toMatchObject(
    { id: board.id, documentType: 'whiteboard' },
  );
  f.principal.allowedPrefixes = ['00-Inbox/asset-note.md'];
  await expect(
    f.call('resolve_note_whiteboard', { noteId: a.id, source: board.id }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('rechecks resource revocation after awaiting the source version before sharing or preparing attachments', async () => {
  const f = await fixture(),
    a = f.create('revoked.md'),
    other = f.create('other.md'),
    k = f.platform.get().knowledge;
  const original = k.info;
  k.info = async (p, id) => {
    const info = await original(p, id);
    f.principal.allowedPrefixes = ['00-Inbox/other.md'];
    return info;
  };
  await expect(
    f.call('create_note_share', {
      noteId: a.id,
      expectedModifiedAt: a.modifiedAt,
      permission: 'view',
      requestId: 'revoked-share',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(a.id)).toBeUndefined();
});

it('prepares a replayable diagram group from same-note uploads and rejects stale note uploads', async () => {
  const f = await fixture(),
    a = f.create('diagram.md'),
    k = f.platform.get().knowledge;
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  );
  const start = async (name: string, mime: string, bytes: Buffer, requestId: string) => {
    const s: any = await f.call('begin_note_asset_upload', {
      noteId: a.id,
      expectedModifiedAt: a.modifiedAt,
      name,
      mime,
      totalBytes: bytes.length,
      requestId,
    });
    f.upload(s, bytes);
    return s;
  };
  const source = await start('drawing.svg', 'image/svg+xml', svg, 'diagram-source'),
    preview = await start('preview.png', 'image/png', png, 'diagram-preview');
  const args = {
    noteId: a.id,
    expectedModifiedAt: a.modifiedAt,
    kind: 'svg',
    sourceHash: createHash('sha256').update(svg).digest('hex'),
    sourceTransferId: source.transferId,
    previewTransferId: preview.transferId,
    requestId: 'diagram-prepare',
  };
  const result: any = await f.call('prepare_note_diagram', args);
  expect(result.source.mime).toBe('image/svg+xml');
  expect(result.preview.mime).toBe('image/png');
  expect(await f.call('prepare_note_diagram', args)).toEqual(result);
  f.principal.allowedPrefixes = ['00-Inbox/diagram.md'];
  const download: any = await f.call('download_note_asset', {
    noteId: a.id,
    assetId: result.source.id,
    requestId: 'selected-diagram-source',
  });
  expect(
    Buffer.from(
      f.transfers.read(f.principal, { transferId: download.transferId, offset: 0 }).base64,
      'base64',
    ),
  ).toEqual(svg);
  const stale = await start(
    'stale.pdf',
    'application/pdf',
    Buffer.from('%PDF-1.7\nstale'),
    'stale-upload',
  );
  k.core.update(f.principal, a.id, '# Later', a.modifiedAt, 'diagram-note-change');
  await expect(
    f.call('complete_note_asset_upload', {
      transferId: stale.transferId,
      requestId: 'stale-diagram-source',
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

it('cancels bulk imports between committed items and resumes without duplicating completed notes', async () => {
  const f = await fixture();
  f.principal.scopes.push('knowledge:manage');
  (f.principal as Principal).knowledgeAll = true;
  const entries = Array.from({ length: 12 }, (_, i) => ({
      path: `batch-${i}.md`,
      encoding: 'utf8',
      content: '# Batch ' + i,
    })),
    bytes = Buffer.from(JSON.stringify({ entries, folderPath: '00-Inbox', collision: 'rename' }));
  const upload: any = await f.call('begin_knowledge_bundle_upload', {
    name: 'batch.json',
    mime: 'application/json',
    totalBytes: bytes.length,
    requestId: 'cancel-begin',
  });
  f.upload(upload, bytes);
  const preview: any = await f.call('preview_knowledge_bundle_import', {
    transferId: upload.transferId,
  });
  const apply = f.call('apply_knowledge_bundle_import', {
    transferId: upload.transferId,
    expectedPreviewHash: preview.previewHash,
    requestId: 'cancel-apply',
  });
  await new Promise<void>((r) => setImmediate(r));
  const current: any = await f.call('get_knowledge_bundle_job', { requestId: 'cancel-apply' });
  await f.call('cancel_knowledge_bundle_job', {
    jobId: current.job.jobId,
    expectedRevision: current.job.revision,
    requestId: 'cancel-job',
  });
  const cancelled: any = await apply;
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.completed).toBeLessThan(12);
  const resumed: any = await f.call('continue_knowledge_bundle_job', {
    jobId: cancelled.jobId,
    expectedRevision: cancelled.revision,
    requestId: 'resume-job',
  });
  expect(resumed).toMatchObject({ state: 'succeeded', completed: 12 });
  expect(
    (
      f.db
        .prepare("SELECT count(*) n FROM notes WHERE active=1 AND path LIKE '00-Inbox/batch-%'")
        .get() as any
    ).n,
  ).toBe(12);
});

it('includes a whiteboard referenced by a large note in a scoped portable export', async () => {
  const f = await fixture();
  f.principal.scopes.push('knowledge:manage');
  (f.principal as Principal).knowledgeAll = true;
  f.platform.get().notes.createFolder('', 'Outside');
  const board = f.platform
    .get()
    .knowledge.core.create(
      f.principal,
      'Outside',
      'board.excalidraw',
      JSON.stringify(emptyWhiteboard()),
      'export-board-create',
    );
  await writeFile(
    join(f.config.knowledgeRoot, '00-Inbox/large.md'),
    'line\n'.repeat(230_000) + '\n```excalidraw\n' + board.id + '\n```\n',
  );
  f.platform.get().notes.scan();
  let job: any = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: f.platform.get().knowledge.organization.context(f.principal)
      .structureRevision,
    requestId: 'large-reference-export',
  });
  for (let i = 0; job.state === 'waiting' && i < 5; i++) {
    await f.platform.get().knowledge.snapshots.drain();
    job = await f.call('continue_knowledge_bundle_job', {
      jobId: job.jobId,
      expectedRevision: job.revision,
      requestId: 'large-export-continue-' + i,
    });
  }
  expect(job).toMatchObject({ state: 'succeeded', total: 2, completed: 2 });
});

it('restores only the selected archived identity without granting a replacement note at its old path', async () => {
  const f = await fixture(),
    a = f.create('selected.md');
  const k = f.platform.get().knowledge;
  const libraryId = k.organization.context(f.principal).libraryId;
  k.core.archive(f.principal, a.id, a.modifiedAt, 'selected-archive');
  const replacement = f.create('selected.md', '# Replacement');
  const policy = {
    version: 2 as const,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: libraryId,
        actions: ['read', 'write', 'archive'],
        resources: { mode: 'selected' as const, resources: [{ kind: 'note', id: a.id }] },
      },
    },
  };
  f.config.agent!.policies[0] = { ...f.principal, permissionPolicy: policy, policyVersion: 2 };
  f.setCaller(projectPermissionPrincipal(f.db, f.principal, policy));
  expect(await f.call('list_archived_notes')).toMatchObject({ items: [{ id: a.id }] });
  await expect(f.call('list_note_revisions', { noteId: replacement.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(
    f.call('restore_archived_note', { noteId: a.id, requestId: 'selected-conflict' }),
  ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
  const args = { noteId: a.id, fileName: 'restored.md', requestId: 'selected-restore' };
  const receipt = await f.call('restore_archived_note', args);
  expect(receipt).toMatchObject({ id: a.id, restored: true, relativePath: '00-Inbox/restored.md' });
  expect(await f.call('restore_archived_note', args)).toEqual(receipt);
  expect(f.platform.get().notes.getNote(replacement.id).content).toBe('# Replacement');
});

it('isolates shares behind explicit sharing permission and stable CAS receipts', async () => {
  const f = await fixture(),
    a = f.create('share.md');
  const args = {
    noteId: a.id,
    expectedModifiedAt: a.modifiedAt,
    requestId: 'share-create-1',
    permission: 'view',
  };
  const first: any = await f.call('create_note_share', args);
  expect(first).toMatchObject({ enabled: true, permission: 'view' });
  await expect(
    f.call('create_note_share', { ...args, permission: 'edit', requestId: 'share-unbound-update' }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const rotated: any = await f.call('rotate_note_share', {
    ...args,
    requestId: 'share-rotate-1',
    expectedToken: first.token,
  });
  expect(rotated.token).not.toBe(first.token);
  expect(await f.call('get_note_share', { noteId: a.id })).toEqual(rotated);
  expect(await f.call('create_note_share', args)).toEqual(first);
  expect(await f.call('get_knowledge_operation', { requestId: args.requestId })).toMatchObject({
    status: 'succeeded',
    result: first,
  });
  await expect(
    f.call('revoke_note_share', {
      noteId: a.id,
      expectedModifiedAt: a.modifiedAt,
      expectedToken: first.token,
      requestId: 'share-revoke-stale',
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const revoked = await f.call('revoke_note_share', {
    noteId: a.id,
    expectedModifiedAt: a.modifiedAt,
    expectedToken: rotated.token,
    requestId: 'share-revoke-current',
  });
  expect(revoked).toMatchObject({ enabled: false, state: 'revoked' });
  expect(
    await f.call('revoke_note_share', {
      noteId: a.id,
      expectedModifiedAt: a.modifiedAt,
      expectedToken: rotated.token,
      requestId: 'share-revoke-current',
    }),
  ).toEqual(revoked);
  f.principal.scopes = f.principal.scopes.filter((s) => s !== 'knowledge:share');
  await expect(f.call('get_note_share', { noteId: a.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

it('requires full library maintenance rights for settings and returns stable CAS receipts', async () => {
  const f = await fixture();
  f.principal.scopes.push('knowledge:manage');
  await expect(f.call('get_knowledge_organization_settings')).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  (f.principal as Principal).knowledgeAll = true;
  const old: any = await f.call('get_knowledge_organization_settings');
  const args = {
    retentionDays: 61,
    expectedRetentionDays: old.retentionDays,
    requestId: 'settings-retention-1',
  };
  expect(await f.call('update_knowledge_organization_settings', args)).toEqual({
    retentionDays: 61,
  });
  expect(await f.call('update_knowledge_organization_settings', args)).toEqual({
    retentionDays: 61,
  });
  expect(await f.call('list_knowledge_conflicts', { kind: 'files' })).toMatchObject({ items: [] });
  const n = f.create('conflict.md'),
    updated = f.platform
      .get()
      .knowledge.core.update(f.principal, n.id, '# Disk chosen', n.modifiedAt, 'conflicted-update');
  const intent = f.db
    .prepare("SELECT id FROM operations WHERE request_id='conflicted-update'")
    .get() as { id: string };
  f.db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(intent.id);
  f.db.prepare("UPDATE operations SET status='needs_reconciliation' WHERE id=?").run(intent.id);
  expect(await f.call('list_knowledge_conflicts', { kind: 'files' })).toMatchObject({
    items: [{ id: intent.id, resolvable: true }],
  });
  const resolve = {
    conflictId: intent.id,
    strategy: 'keep_disk',
    expectedModifiedAt: updated.modifiedAt,
    expectedContentHash: updated.contentHash,
    requestId: 'resolve-disk',
  };
  const resolved = await f.call('resolve_knowledge_conflict', resolve);
  expect(resolved).toMatchObject({ resolved: true, evidencePreserved: true });
  expect(await f.call('resolve_knowledge_conflict', resolve)).toEqual(resolved);
  expect(await f.call('get_knowledge_operation', { requestId: resolve.requestId })).toMatchObject({
    status: 'succeeded',
    result: resolved,
  });
  await expect(
    f.call('update_knowledge_organization_settings', { ...args, requestId: 'settings-stale' }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});

it('pages backlinks and favorites inside live permitted paths and replays favorite changes', async () => {
  const f = await fixture(),
    a = f.create('target.md'),
    b = f.create('mention.md', '[Target](target.md)');
  expect(await f.call('get_note_backlinks', { noteId: a.id })).toMatchObject({
    matches: [{ id: b.id }],
  });
  const args = { noteId: a.id, favorite: true, requestId: 'favorite-set-1' };
  expect(await f.call('set_note_favorite', args)).toEqual({ favorite: true });
  expect(await f.call('list_note_collection', { kind: 'favorites', limit: 1 })).toMatchObject({
    items: [{ id: a.id }],
    total: 1,
  });
  expect(await f.call('set_note_favorite', args)).toEqual({ favorite: true });
  f.principal.allowedPrefixes = ['00-Inbox/mention.md'];
  expect(await f.call('get_note_collection_status', { kind: 'favorites' })).toMatchObject({
    total: 0,
  });
  expect(await f.call('list_note_collection', { kind: 'favorites' })).toMatchObject({
    items: [],
    total: 0,
  });
});

it('archives and restores whole folders with caller-owned receipts and current subtree versions', async () => {
  const f = await fixture();
  f.platform.get().notes.createFolder('00-Inbox', 'Folder');
  const k = f.platform.get().knowledge;
  k.organization.context(f.principal);
  const dir = directoryByPath(f.db, '00-Inbox/Folder')!;
  const input = {
    directoryId: dir.id,
    expectedSubtreeRevision: dir.subtreeRevision,
    requestId: 'folder-archive-1',
  };
  const receipt: any = await f.call('archive_note_folder', input);
  expect(receipt.deleted).toBe(true);
  expect(await f.call('archive_note_folder', input)).toEqual(receipt);
  expect(await f.call('list_archived_folders')).toMatchObject({
    items: [{ id: receipt.id, relativePath: dir.path }],
  });
  const restored = await f.call('restore_archived_folder', {
    folderId: receipt.id,
    requestId: 'folder-restore-1',
  });
  expect(restored).toMatchObject({ id: receipt.id, deleted: false });
  expect(
    f.db
      .prepare("SELECT principal FROM operations WHERE kind='folder.archive' AND request_id=?")
      .get(input.requestId),
  ).toEqual({ principal: f.principal.id });
});

it('recovers a selected inactive directory without granting the replacement directory at its old path', async () => {
  const f = await fixture(),
    k = f.platform.get().knowledge;
  f.platform.get().notes.createFolder('00-Inbox', 'Selected');
  k.organization.context(f.principal);
  const directory = directoryByPath(f.db, '00-Inbox/Selected')!;
  const archived: any = await f.call('archive_note_folder', {
    directoryId: directory.id,
    expectedSubtreeRevision: directory.subtreeRevision,
    requestId: 'selected-folder-archive',
  });
  f.platform.get().notes.createFolder('00-Inbox', 'Selected');
  const replacement = k.core.create(
    f.principal,
    '00-Inbox/Selected',
    'private.md',
    '# Replacement',
    'replacement-folder-note',
  );
  k.organization.context(f.principal);
  const policy = {
    version: 2 as const,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: k.organization.context(f.principal).libraryId,
        actions: ['read', 'write', 'archive', 'organize'],
        resources: {
          mode: 'selected' as const,
          resources: [{ kind: 'directory', id: directory.id }],
        },
      },
    },
  };
  f.config.agent!.policies[0] = { ...f.principal, permissionPolicy: policy, policyVersion: 2 };
  f.setCaller(projectPermissionPrincipal(f.db, f.principal, policy));
  expect(await f.call('list_archived_folders')).toMatchObject({ items: [{ id: archived.id }] });
  await expect(f.call('list_note_revisions', { noteId: replacement.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(
    f.call('restore_archived_folder', {
      folderId: archived.id,
      requestId: 'selected-folder-collision',
    }),
  ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
  expect(
    await f.call('restore_archived_folder', {
      folderId: archived.id,
      name: 'Recovered',
      requestId: 'selected-folder-restore',
    }),
  ).toMatchObject({ relativePath: '00-Inbox/Recovered', deleted: false });
  expect(f.platform.get().notes.getNote(replacement.id).content).toBe('# Replacement');
});
