import { afterEach, expect, it } from 'vitest';
import { mkdir, writeFile, rename, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { currentPrincipalPolicy } from '../packages/core/agent/config.js';
import { requireScope } from '../packages/core/agent/auth.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../shared/mcp-frame.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await pluginRuntimeFixture();
  closes.push(f.close);
  const principal = f.principal as Principal;
  principal.scopes.push(
    'knowledge:archive',
    'knowledge:organize',
    'knowledge:share',
    'knowledge:manage',
  );
  principal.knowledgeAll = true;
  const transfers = createMcpTransferStore(f.config, f.db);
  const port = createKnowledgeToolPort({
    config: f.config,
    db: f.db,
    runtime: f.platform.get(),
    transfers,
    toDooAccess: () => ({ listIds: [], domains: [] }),
    authorize(scopes) {
      const p = currentPrincipalPolicy(f.config, f.db, principal)!;
      for (const scope of scopes) requireScope(p, scope);
      return p;
    },
  });
  let sequence = 0;
  const k = f.platform.get().knowledge;
  const create = (name = 'source.md', content = '# Reviewed', directory = '00-Inbox') =>
    k.core.create(principal, directory, name, content, 'create-' + sequence++);
  const call = (name: string, a: any = {}) => port.call(name, a);
  const upload = async (note: any, name: string, mime: string, bytes: Buffer) => {
    const session: any = await call('begin_note_asset_upload', {
      noteId: note.id,
      expectedModifiedAt: note.modifiedAt,
      name,
      mime,
      totalBytes: bytes.length,
      requestId: 'upload-' + sequence++,
    });
    for (let offset = 0; offset < bytes.length; offset += 8192)
      transfers.append(principal, {
        transferId: session.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 8192).toString('base64'),
      });
    return session;
  };
  return { ...f, principal, k, call, create, upload, transfers };
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it.each(['share', 'asset', 'diagram'])(
  'R1.1 compares the live source at %s commit after awaited metadata',
  async (kind) => {
    const f = await fixture(),
      n = f.create();
    const asset =
      kind === 'asset'
        ? await f.upload(n, 'file.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nsource'))
        : undefined;
    const source =
      kind === 'diagram' ? await f.upload(n, 'source.svg', 'image/svg+xml', svg) : undefined;
    const preview =
      kind === 'diagram' ? await f.upload(n, 'preview.png', 'image/png', png) : undefined;
    const info = f.k.info;
    let changed = false;
    f.k.info = async (p, id) => {
      const old = await info(p, id);
      if (!changed) {
        changed = true;
        f.k.core.update(f.principal, n.id, '# Changed private source', n.modifiedAt, 'race-update');
      }
      return old;
    };
    const invoke =
      kind === 'share'
        ? f.call('create_note_share', {
            noteId: n.id,
            expectedModifiedAt: n.modifiedAt,
            permission: 'view',
            requestId: 'share-race',
          })
        : kind === 'asset'
          ? f.call('complete_note_asset_upload', {
              transferId: asset.transferId,
              requestId: 'asset-race',
            })
          : f.call('prepare_note_diagram', {
              noteId: n.id,
              expectedModifiedAt: n.modifiedAt,
              kind: 'svg',
              sourceHash: hash(svg),
              sourceTransferId: source.transferId,
              previewTransferId: preview.transferId,
              requestId: 'diagram-race',
            });
    await expect(invoke).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(f.db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id)).toBeUndefined();
    expect((f.db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(0);
  },
);

it('R1.2 denies conflict metadata when full-library authority is narrowed during Git lookup', async () => {
  const f = await fixture(),
    n = f.create('conflict.md'),
    other = f.create('unrelated.md');
  f.k.core.update(f.principal, n.id, '# Changed', n.modifiedAt, 'conflict-update');
  const op = f.db
    .prepare("SELECT id FROM operations WHERE request_id='conflict-update'")
    .get() as any;
  f.db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(op.id);
  f.db.prepare("UPDATE operations SET status='needs_reconciliation' WHERE id=?").run(op.id);
  const pending = f.call('list_knowledge_conflicts', { kind: 'files' });
  f.principal.knowledgeAll = false;
  f.principal.allowedPrefixes = ['00-Inbox/unrelated.md'];
  await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('R1.3 rejects second and cross-purpose finalizations before creating assets, with atomic diagram claims', async () => {
  const f = await fixture(),
    n = f.create();
  const s = await f.upload(n, 'source.svg', 'image/svg+xml', svg),
    p = await f.upload(n, 'preview.png', 'image/png', png);
  const first = await f.call('complete_note_asset_upload', {
    transferId: p.transferId,
    requestId: 'finished',
  });
  await expect(
    f.call('complete_note_asset_upload', { transferId: p.transferId, requestId: 'different' }),
  ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
  const args = {
    noteId: n.id,
    expectedModifiedAt: n.modifiedAt,
    kind: 'svg',
    sourceHash: hash(svg),
    sourceTransferId: s.transferId,
    previewTransferId: p.transferId,
    requestId: 'finished',
  };
  await expect(f.call('prepare_note_diagram', args)).rejects.toMatchObject({
    code: 'MCP_TRANSFER_CONFLICT',
  });
  expect((f.db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(1);
  expect(
    f.db
      .prepare(
        "SELECT id FROM operations WHERE kind='knowledge.asset-upload' AND request_id='different'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    f.db.prepare('SELECT complete_request FROM mcp_transfers WHERE id=?').get(s.transferId),
  ).toEqual({ complete_request: null });
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(p.transferId);
  expect(
    await f.call('complete_note_asset_upload', { transferId: p.transferId, requestId: 'finished' }),
  ).toEqual(first);
});

it('R1.4 exports over 64 MiB through bounded caller snapshots without raising their quota', async () => {
  const f = await fixture();
  f.platform.get().notes.createFolder('', 'Other');
  const ordinary = f.create('ordinary.md', '# Ordinary retained snapshot', 'Other');
  let snapshot = await f.k.snapshots.available(f.principal, ordinary.id, {});
  if ('operation' in snapshot) {
    await f.k.snapshots.drain();
    snapshot = await f.k.snapshots.available(f.principal, ordinary.id, {});
  }
  if ('operation' in snapshot) throw Error('snapshot did not finish');
  const retainedId = snapshot.id;
  const content = '# Large\n' + ('x'.repeat(32750) + '\n').repeat(320);
  for (let i = 0; i < 7; i++)
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox', `large-${i}.md`), content);
  f.platform.get().notes.scan();
  let job: any = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: f.k.organization.context(f.principal).structureRevision,
    requestId: 'large-export',
  });
  for (let i = 0; job.state === 'waiting' && i < 12; i++) {
    await f.k.snapshots.drain();
    job = await f.call('continue_knowledge_bundle_job', {
      jobId: job.jobId,
      expectedRevision: job.revision,
      requestId: 'export-next-' + i,
    });
  }
  expect(job).toMatchObject({ state: 'succeeded', total: 7, completed: 7 });
  expect(
    (
      f.db
        .prepare('SELECT coalesce(sum(size_bytes),0) n FROM read_snapshots WHERE principal=?')
        .get(f.principal.id) as any
    ).n,
  ).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(f.db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(retainedId)).toEqual({
    id: retainedId,
  });
  expect(await f.k.snapshots.check(f.principal, ordinary.id, retainedId)).toMatchObject({
    id: retainedId,
  });
}, 60000);

it('R1.5 represents and recovers a valid composed document path longer than 1200 characters', async () => {
  const f = await fixture(),
    directory =
      '00-Inbox/' + Array.from({ length: 8 }, (_, i) => String(i) + 'a'.repeat(140)).join('/'),
    name = 'b'.repeat(176) + '.md';
  await mkdir(join(f.config.knowledgeRoot, directory), { recursive: true });
  const bytes = Buffer.from('# Long path');
  const session: any = await f.call('begin_note_document_upload', {
    directory,
    name,
    mime: 'text/markdown',
    totalBytes: bytes.length,
    requestId: 'long-begin',
  });
  f.transfers.append(f.principal, {
    transferId: session.transferId,
    offset: 0,
    base64: bytes.toString('base64'),
  });
  const result: any = await f.call('complete_note_document_upload', {
    transferId: session.transferId,
    requestId: 'long-complete',
  });
  expect(result.relativePath).toBe(directory + '/' + name);
  expect(await f.call('get_knowledge_operation', { requestId: 'long-complete' })).toMatchObject({
    status: 'succeeded',
    result,
  });
  const tooLongDirectory = Array.from({ length: 14 }, (_, i) => String(i) + 'x'.repeat(140)).join(
    '/',
  );
  await expect(
    f.call('begin_note_document_upload', {
      directory: tooLongDirectory,
      name,
      mime: 'text/markdown',
      totalBytes: bytes.length,
      requestId: 'overlong-begin',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  expect(
    (
      f.db
        .prepare("SELECT count(*) n FROM mcp_transfers WHERE request_id='overlong-begin'")
        .get() as any
    ).n,
  ).toBe(0);
});

it('R1.6 invalidates in-flight collection totals and cursor when another resource is revoked', async () => {
  const f = await fixture(),
    a = f.create('a.md'),
    b = f.create('b.md');
  await f.call('set_note_favorite', { noteId: a.id, favorite: true, requestId: 'favorite-a' });
  await f.call('set_note_favorite', { noteId: b.id, favorite: true, requestId: 'favorite-b' });
  const first: any = await f.call('list_note_collection', { kind: 'favorites', limit: 1 });
  const pending = f.call('list_note_collection', { kind: 'favorites', limit: 1 });
  f.principal.knowledgeAll = false;
  f.principal.allowedPrefixes = [first.items[0].path];
  await expect(pending).rejects.toMatchObject({ code: 'COLLECTION_CHANGED' });
  expect(await f.call('get_note_collection_status', { kind: 'favorites' })).toMatchObject({
    total: 1,
  });
});

it('R1.7 fits quoted path trash and collection pages into complete frames without losing continuation', async () => {
  const f = await fixture();
  let directory = '00-Inbox';
  for (let i = 0; i < 5; i++) {
    const name = '"'.repeat(165) + String(i);
    f.platform.get().notes.createFolder(directory, name);
    directory += '/' + name;
  }
  const notes = [];
  for (let i = 0; i < 20; i++) {
    const n = f.create('"'.repeat(160) + i + '.md', '# Title', directory);
    notes.push(n);
    await f.call('set_note_favorite', {
      noteId: n.id,
      favorite: true,
      requestId: 'quote-favorite-' + i,
    });
  }
  let page: any = await f.call('list_note_collection', { kind: 'favorites', limit: 30 });
  expect(mcpResultFrameSize({ data: page })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
  expect(page.nextCursor).toBeTruthy();
  for (let i = 0; i < notes.length; i++)
    f.k.core.archive(f.principal, notes[i].id, notes[i].modifiedAt, 'quote-archive-' + i);
  let count = 0,
    cursor: string | undefined;
  do {
    page = await f.call('list_archived_notes', { limit: 30, ...(cursor ? { cursor } : {}) });
    expect(mcpResultFrameSize({ data: page })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
    count += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  expect(count).toBe(20);
  const bytes = Buffer.from(
    JSON.stringify({
      entries: notes.map((n) => ({
        path: n.relativePath.split('/').at(-1),
        encoding: 'utf8',
        content: '# Imported',
      })),
      folderPath: directory,
      collision: 'rename',
    }),
  );
  const upload: any = await f.call('begin_knowledge_bundle_upload', {
    name: 'quote-bundle.json',
    mime: 'application/json',
    totalBytes: bytes.length,
    requestId: 'quote-bundle',
  });
  for (let offset = 0; offset < bytes.length; offset += 8192)
    f.transfers.append(f.principal, {
      transferId: upload.transferId,
      offset,
      base64: bytes.subarray(offset, offset + 8192).toString('base64'),
    });
  const preview: any = await f.call('preview_knowledge_bundle_import', {
    transferId: upload.transferId,
    limit: 30,
  });
  expect(mcpResultFrameSize({ data: preview })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
  expect(preview.nextCursor).toBeTruthy();
  const job: any = await f.call('apply_knowledge_bundle_import', {
    transferId: upload.transferId,
    expectedPreviewHash: preview.previewHash,
    requestId: 'quote-bundle-apply',
  });
  const status: any = await f.call('get_knowledge_bundle_job', { jobId: job.jobId, limit: 30 });
  expect(mcpResultFrameSize({ data: status })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
  expect(status.nextCursor).toBeTruthy();
});

it('binds document finalization before mutation and replays the durable receipt after expiry', async () => {
  const f = await fixture(),
    bytes = Buffer.from('# Document'),
    n = f.create('doc.md');
  const session: any = await f.call('begin_note_document_upload', {
    noteId: n.id,
    expectedModifiedAt: n.modifiedAt,
    name: 'doc.md',
    mime: 'text/markdown',
    totalBytes: bytes.length,
    requestId: 'doc-begin',
  });
  f.transfers.append(f.principal, {
    transferId: session.transferId,
    offset: 0,
    base64: bytes.toString('base64'),
  });
  const result = await f.call('complete_note_document_upload', {
    transferId: session.transferId,
    requestId: 'doc-complete',
  });
  await expect(
    f.call('complete_note_document_upload', {
      transferId: session.transferId,
      requestId: 'doc-other',
    }),
  ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
  expect(
    f.db
      .prepare(
        "SELECT id FROM operations WHERE kind='knowledge.document-upload' AND request_id='doc-other'",
      )
      .get(),
  ).toBeUndefined();
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(session.transferId);
  expect(
    await f.call('complete_note_document_upload', {
      transferId: session.transferId,
      requestId: 'doc-complete',
    }),
  ).toEqual(result);
});

it('requires write authority to grant or preserve public editing while allowing view shares', async () => {
  const f = await fixture(),
    n = f.create();
  f.principal.scopes = f.principal.scopes.filter((s) => s !== 'knowledge:write');
  await expect(
    f.call('create_note_share', {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      permission: 'edit',
      requestId: 'edit-denied',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(
    await f.call('create_note_share', {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      permission: 'view',
      requestId: 'view-allowed',
    }),
  ).toMatchObject({ permission: 'view' });
  f.principal.scopes.push('knowledge:write');
  const status: any = await f.call('get_note_share', { noteId: n.id });
  const edit: any = await f.call('create_note_share', {
    noteId: n.id,
    expectedModifiedAt: n.modifiedAt,
    permission: 'edit',
    expectedToken: status.token,
    requestId: 'edit-allowed',
  });
  f.principal.scopes = f.principal.scopes.filter((s) => s !== 'knowledge:write');
  await expect(
    f.call('rotate_note_share', {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      expectedToken: edit.token,
      requestId: 'edit-rotation-denied',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.call('create_note_share', {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      expectedToken: edit.token,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      requestId: 'edit-expiry-denied',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('restarts a failed export with fresh authorized staging after its source changed during capture', async () => {
  const f = await fixture(),
    n = f.create('changed.md');
  f.create('other.md');
  const release = f.k.snapshots.releaseExport;
  let changed = false;
  f.k.snapshots.releaseExport = async (...args) => {
    await release(...args);
    if (!changed) {
      changed = true;
      f.k.core.update(f.principal, n.id, '# Later source', n.modifiedAt, 'export-source-race');
    }
  };
  const first: any = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: f.k.organization.context(f.principal).structureRevision,
    requestId: 'retry-export',
  });
  expect(first).toMatchObject({ state: 'failed', error: 'STALE_CURSOR' });
  f.k.snapshots.releaseExport = release;
  const retry: any = await f.call('continue_knowledge_bundle_job', {
    jobId: first.jobId,
    expectedRevision: first.revision,
    requestId: 'retry-export-current',
  });
  expect(retry).toMatchObject({ state: 'succeeded', completed: 2 });
});

it('rejects a replaced staging ancestor before creating files through that link', async () => {
  const f = await fixture();
  f.create('safe.md');
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await rename(join(f.config.dataRoot, 'mcp'), join(f.config.dataRoot, 'mcp-original'));
  await symlink(outside, join(f.config.dataRoot, 'mcp'), 'dir');
  const job: any = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: f.k.organization.context(f.principal).structureRevision,
    requestId: 'ancestor-export',
  });
  expect(job).toMatchObject({ state: 'failed', error: 'MCP_TRANSFER_UNAVAILABLE' });
  expect(await readdir(outside)).toEqual([]);
});
