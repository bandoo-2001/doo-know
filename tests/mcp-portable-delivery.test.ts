import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, utimes, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { requireScope } from '../packages/core/agent/auth.js';
import { sha256 } from '../packages/core/knowledge/operations.js';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../shared/mcp-frame.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation.js';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams.js';
import {
  renderPreparedDiagramDocument,
  diagramRendererVersions,
} from '../shared/diagram-primary.js';
import { emptyWhiteboard } from '../shared/whiteboard.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
  let authorizeHook: (() => void) | undefined;
  const runtime = f.platform.get(),
    transfers = createMcpTransferStore(f.config, f.db);
  const port = createKnowledgeToolPort({
    config: f.config,
    db: f.db,
    runtime,
    transfers,
    authorize(scopes) {
      authorizeHook?.();
      for (const scope of scopes) requireScope(caller, scope);
      return caller;
    },
    toDooAccess: () => ({ listIds: [], domains: [] }),
  });
  const call = async (name: string, args: any) => {
    const result: any = await port.call(name, args);
    expect(mcpResultFrameSize({ data: result })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
    return result;
  };
  const read = (id: string, offset = 0) => {
    const info = transfers.info(caller, id);
    port.authorizeTransfer(info.binding, false);
    return transfers.read(caller, { transferId: id, offset });
  };
  const upload = (info: any, bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      port.authorizeTransfer(info.binding, true);
      transfers.append(caller, {
        transferId: info.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 16384).toString('base64'),
      });
    }
  };
  const create = (name: string, content: string) =>
    runtime.knowledge.core.create(f.principal, '00-Inbox', name, content, randomUUID());
  return {
    ...f,
    runtime,
    transfers,
    port,
    call,
    read,
    upload,
    create,
    onAuthorize: (hook?: () => void) => {
      authorizeHook = hook;
    },
    setCaller: (p: Principal) => {
      caller = p;
    },
  };
}
it('delivers exact Markdown BOM bytes and idempotent unknown export results through the real store', async () => {
  const f = await fixture(),
    source = '\ufeff# 原样\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n';
  const note = f.create('plain.md', source);
  const args = { selection: { kind: 'single', noteId: note.id }, requestId: 'plain-export' };
  const first = await f.call('export_portable_documents', args),
    second = await f.call('export_portable_documents', args);
  expect(first.kind).toBe('markdown');
  expect(second).toEqual(first);
  const chunk = f.read(first.download.transferId);
  expect(Buffer.from(chunk.base64, 'base64')).toEqual(Buffer.from(source));
  expect(JSON.stringify(first)).not.toContain(f.config.dataRoot);
  f.setCaller({ ...f.principal, clientId: 'foreign' });
  expect(() => f.read(first.download.transferId)).toThrow();
});
it('rechecks document grants and same-byte attachment mtime on every later chunk', async () => {
  const f = await fixture();
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/picture.png'), png);
  const linked = f.create('linked.md', '# Dependency'),
    note = f.create('image.md', '![x](picture.png)\n[linked](linked.md)');
  const exported = await f.call('export_portable_documents', {
    selection: { kind: 'single', noteId: note.id },
    requestId: 'deps',
  });
  expect(exported.kind).toBe('archive');
  f.read(exported.download.transferId);
  f.setCaller({
    ...f.principal,
    allowedPrefixes: [],
    knowledgeResourcePaths: [{ kind: 'note', id: note.id, path: '00-Inbox/image.md' }],
  });
  expect(() => f.read(exported.download.transferId)).toThrow();
  f.setCaller(f.principal);
  await utimes(
    join(f.config.knowledgeRoot, '00-Inbox/picture.png'),
    new Date(),
    new Date(Date.now() + 3000),
  );
  expect(() => f.read(exported.download.transferId)).toThrow();
  expect(linked.id).toBeTruthy();
});
it('imports all three primary types with new UUIDs, bounded summaries, and recoverable unknown commit result', async () => {
  const f = await fixture(),
    primary = primaryDiagramService(f.config, f.db, f.runtime.notes, f.runtime.assets, f.principal);
  const originals = ['whiteboard', 'mindmap', 'flowchart'].map((type: any) => {
    const intent = diagramCreationService(f.config, f.db, f.principal).reserve({
      path: '00-Inbox/' + type + '.md',
      type,
      requestId: randomUUID(),
    });
    const source =
      type === 'whiteboard'
        ? JSON.stringify(emptyWhiteboard())
        : type === 'mindmap'
          ? '- Root\n  - Child\n'
          : 'flowchart LR\n A --> B\n';
    const prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type,
      source,
      sourceHash: sha256(source),
      title: type,
      renderer: diagramRendererVersions[type as keyof typeof diagramRendererVersions],
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    });
    const markdown = renderPreparedDiagramDocument({
      prepared,
      source,
      title: type,
      description: 'prose\n',
    });
    return primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  });
  const exported = await f.call('export_portable_documents', {
    selection: { kind: 'multiple', noteIds: originals.map((n) => n.id) },
    requestId: 'graphs',
  });
  const bytes = await readFile(
    join(f.config.dataRoot, 'mcp/transfers', exported.download.transferId, 'payload.bin'),
  );
  const session = await f.call('begin_portable_import_upload', {
    folderPath: '00-Inbox/copied',
    name: exported.fileName,
    mime: exported.mime,
    totalBytes: bytes.length,
    sha256: sha256(bytes),
    requestId: 'graphs-upload',
  });
  f.upload(session, bytes);
  const complete = vi.spyOn(f.transfers, 'complete');
  complete.mockImplementationOnce(() => {
    throw Error('transport result lost');
  });
  const args = {
    transferId: session.transferId,
    folderPath: '00-Inbox/copied',
    requestId: 'graphs-import',
  };
  await expect(f.call('import_portable_archive', args)).rejects.toThrow('transport result lost');
  const progress = await f.call('get_portable_import_result', { requestId: 'graphs-import' });
  expect(progress.import).toMatchObject({ state: 'succeeded', notesImported: 3 });
  const retried = await f.call('import_portable_archive', args);
  expect(retried.notesImported).toBe(3);
  expect(retried).not.toHaveProperty('notes');
  expect(progress.items.every((item: any) => !originals.some((n) => n.id === item.noteId))).toBe(
    true,
  );
  expect(
    f.db
      .prepare("SELECT count(*) n FROM notes WHERE active=1 AND path LIKE '00-Inbox/copied/%'")
      .get(),
  ).toMatchObject({ n: 3 });
  await expect(
    f.call('import_portable_archive', { ...args, folderPath: '00-Inbox/wrong' }),
  ).rejects.toThrow();
  // A current-looking PNG without a retained or live preparation tuple is not export authority.
  f.db.prepare('DELETE FROM diagram_document_versions WHERE note_id=?').run(originals[0].id);
  f.db
    .prepare('UPDATE diagram_prepared_primaries SET expires_at=0 WHERE note_id=?')
    .run(originals[0].id);
  f.setCaller({
    ...f.principal,
    knowledgeAll: true,
    scopes: [...f.principal.scopes, 'knowledge:manage'],
  });
  const legacy = await f.call('export_knowledge_bundle', {
    folderPath: '00-Inbox',
    expectedStructureRevision: f.runtime.knowledge.organization.context(f.principal)
      .structureRevision,
    requestId: 'legacy-unverified-primary',
  });
  expect(legacy).toMatchObject({ state: 'failed', error: 'DIAGRAM_PREVIEW_REQUIRED' });
  f.setCaller({ ...f.principal, id: 'foreign' });
  await expect(
    f.call('get_portable_import_result', { requestId: 'graphs-import' }),
  ).rejects.toMatchObject({ code: 'PORTABLE_IMPORT_NOT_FOUND' });
});
it('streams a real archive over the old 20 MiB/200-file boundary and pages a thousand imported identities', async () => {
  const f = await fixture();
  // A real, incompressible PCM media attachment crosses the historical transport cap.
  const dataBytes = 21 * 1024 * 1024,
    header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  await mkdir(join(f.config.knowledgeRoot, '00-Inbox/_doo-assets'), { recursive: true });
  const media = await open(join(f.config.knowledgeRoot, '00-Inbox/_doo-assets/large.wav'), 'wx');
  try {
    await media.write(header);
    for (let offset = 0; offset < dataBytes; offset += 65536)
      await media.write(randomBytes(Math.min(65536, dataBytes - offset)));
  } finally {
    await media.close();
  }
  for (let i = 0; i < 1000; i++)
    await writeFile(
      join(f.config.knowledgeRoot, '00-Inbox/n' + i + '.md'),
      '# Small ' + i + (i === 0 ? '\n[Audio](_doo-assets/large.wav)\n' : ''),
    );
  f.runtime.notes.scan();
  expect(f.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toMatchObject({
    n: 1000,
  });
  const exported = await f.call('export_portable_documents', {
    selection: { kind: 'directory', path: '00-Inbox' },
    requestId: 'large-export',
  });
  expect(exported.sizeBytes).toBeGreaterThan(20 * 1024 * 1024);
  const session = await f.call('begin_portable_import_upload', {
    folderPath: '00-Inbox/large',
    name: exported.fileName,
    mime: exported.mime,
    totalBytes: exported.sizeBytes,
    sha256: exported.sha256,
    requestId: 'large-upload',
  });
  const path = join(
    f.config.dataRoot,
    'mcp/transfers',
    exported.download.transferId,
    'payload.bin',
  );
  const { createReadStream } = await import('node:fs');
  let offset = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 16384 })) {
    f.transfers.append(f.principal, {
      transferId: session.transferId,
      offset,
      base64: chunk.toString('base64'),
    });
    offset += chunk.length;
  }
  const imported = await f.call('import_portable_archive', {
    transferId: session.transferId,
    folderPath: '00-Inbox/large',
    requestId: 'large-import',
  });
  expect(imported.notesImported).toBe(1000);
  let cursor: string | undefined,
    count = 0;
  do {
    const page = await f.call('get_portable_import_result', {
      importId: imported.importId,
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.items.length).toBeLessThanOrEqual(30);
    count += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  expect(count).toBe(1000);
}, 300000);
it('streams media beyond the old asset/document bounds and rejects cross-role handles', async () => {
  const f = await fixture(),
    note = f.create('audio.md', '# Audio');
  const dataBytes = 21 * 1024 * 1024,
    header = Buffer.alloc(44),
    zeros = Buffer.alloc(16384);
  header.write('RIFF');
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const session = await f.call('begin_note_asset_upload', {
    noteId: note.id,
    expectedModifiedAt: note.modifiedAt,
    name: 'large.wav',
    mime: 'audio/wav',
    totalBytes: 44 + dataBytes,
    requestId: 'media-upload',
  });
  f.upload(session, header);
  for (let offset = 44; offset < 44 + dataBytes; offset += zeros.length)
    f.transfers.append(f.principal, {
      transferId: session.transferId,
      offset,
      base64: zeros.subarray(0, Math.min(zeros.length, 44 + dataBytes - offset)).toString('base64'),
    });
  await expect(
    f.call('import_portable_archive', {
      transferId: session.transferId,
      folderPath: '00-Inbox',
      requestId: 'wrong-media-role',
    }),
  ).rejects.toThrow();
  const saved = await f.call('complete_note_asset_upload', {
    transferId: session.transferId,
    requestId: 'media-complete',
  });
  const download = await f.call('download_note_asset', {
    noteId: note.id,
    assetId: saved.id,
    requestId: 'media-download',
  });
  expect(download.totalBytes).toBe(44 + dataBytes);
  expect(f.read(download.transferId).nextOffset).toBe(8192);
  const descriptor = f.runtime.assets.inspectById(saved.id);
  await utimes(descriptor.absolutePath, new Date(), new Date(Date.now() + 5000));
  expect(() => f.read(download.transferId)).toThrow();
}, 30000);

it('stops subsequent import publications after revocation and resumes the original partial receipt', async () => {
  const f = await fixture(),
    a = f.create('a.md', '# A'),
    b = f.create('b.md', '# B');
  const exported = await f.call('export_portable_documents', {
    selection: { kind: 'multiple', noteIds: [a.id, b.id] },
    requestId: 'revoke-export',
  });
  const bytes = Buffer.from(f.read(exported.download.transferId).base64, 'base64');
  const upload = await f.call('begin_portable_import_upload', {
    folderPath: '00-Inbox/revoked',
    name: exported.fileName,
    mime: exported.mime,
    totalBytes: bytes.length,
    sha256: sha256(bytes),
    requestId: 'revoke-upload',
  });
  f.upload(upload, bytes);
  f.onAuthorize(() => {
    if (
      !f.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_import_jobs'")
        .get()
    )
      return;
    const current = f.db
      .prepare("SELECT result FROM portable_import_jobs WHERE request_id='revoke-import'")
      .get() as { result: string } | undefined;
    if (current && JSON.parse(current.result).notes.length >= 1)
      f.setCaller({ ...f.principal, scopes: ['knowledge:read'] });
  });
  const args = {
    transferId: upload.transferId,
    folderPath: '00-Inbox/revoked',
    requestId: 'revoke-import',
  };
  await expect(f.call('import_portable_archive', args)).rejects.toThrow();
  expect(
    f.db
      .prepare("SELECT count(*) n FROM notes WHERE active=1 AND path LIKE '00-Inbox/revoked/%'")
      .get(),
  ).toMatchObject({ n: 1 });
  f.onAuthorize();
  f.setCaller(f.principal);
  const partial = await f.call('get_portable_import_result', { requestId: 'revoke-import' });
  expect(partial.import.notesImported).toBe(1);
  const completed = await f.call('import_portable_archive', args);
  expect(completed.notesImported).toBe(2);
  const final = await f.call('get_portable_import_result', { requestId: 'revoke-import' });
  expect(final.items[0].noteId).toBe(partial.items[0].noteId);
});

it('accepts the full 128-character import request ID without overflowing the private completion claim', async () => {
  const f = await fixture(),
    note = f.create('long-request.md', '# Full request length');
  const exported = await f.call('export_portable_documents', {
    selection: { kind: 'multiple', noteIds: [note.id] },
    requestId: 'long-request-export',
  });
  const bytes = Buffer.from(f.read(exported.download.transferId).base64, 'base64');
  const upload = await f.call('begin_portable_import_upload', {
    folderPath: '00-Inbox/long-request',
    name: exported.fileName,
    mime: exported.mime,
    totalBytes: bytes.length,
    sha256: sha256(bytes),
    requestId: 'long-request-upload',
  });
  f.upload(upload, bytes);
  const result = await f.call('import_portable_archive', {
    transferId: upload.transferId,
    folderPath: '00-Inbox/long-request',
    requestId: 'x'.repeat(128),
  });
  expect(result.notesImported).toBe(1);
});
it('rechecks current asset entitlement after a directory grant becomes a selected-note grant', async () => {
  const f = await fixture(),
    note = f.create('unrelated-media.md', '# Unrelated');
  const wav = Buffer.alloc(20044);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  async function* source() {
    yield wav;
  }
  // A runtime upload deliberately has no MCP actor-bound upload receipt and no saved reference.
  const asset = await f.runtime.assets.uploadStream(
    note.id,
    'private.wav',
    'audio/wav',
    source(),
    'private-runtime-upload',
  );
  const initial = await f.call('download_note_asset', {
    noteId: note.id,
    assetId: asset.id,
    requestId: 'directory-entitlement',
  });
  expect(f.read(initial.transferId).nextOffset).toBe(8192);
  f.setCaller({
    ...f.principal,
    allowedPrefixes: [],
    knowledgeResourcePaths: [{ kind: 'note', id: note.id, path: '00-Inbox/unrelated-media.md' }],
  });
  await expect(
    f.call('download_note_asset', {
      noteId: note.id,
      assetId: asset.id,
      requestId: 'selected-entitlement',
    }),
  ).rejects.toThrow();
  expect(() => f.read(initial.transferId, 8192)).toThrow();
  f.setCaller(f.principal);
  f.onAuthorize(() => {
    if (
      f.db
        .prepare(
          "SELECT 1 FROM mcp_transfers WHERE request_id='during-tighten' AND state='uploading'",
        )
        .get()
    )
      f.setCaller({
        ...f.principal,
        allowedPrefixes: [],
        knowledgeResourcePaths: [
          { kind: 'note', id: note.id, path: '00-Inbox/unrelated-media.md' },
        ],
      });
  });
  await expect(
    f.call('download_note_asset', {
      noteId: note.id,
      assetId: asset.id,
      requestId: 'during-tighten',
    }),
  ).rejects.toThrow();
  expect(
    f.db.prepare("SELECT 1 FROM mcp_transfers WHERE request_id='during-tighten'").get(),
  ).toBeUndefined();
});
it('keeps parser-proven media readable after tightening to the same selected note and invalidates changed references', async () => {
  const f = await fixture(),
    note = f.create('referenced-media.md', '# Audio');
  const wav = Buffer.alloc(20044);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  async function* source() {
    yield wav;
  }
  const asset = await f.runtime.assets.uploadStream(
    note.id,
    'referenced.wav',
    'audio/wav',
    source(),
    'referenced-runtime-upload',
  );
  const updated = f.runtime.knowledge.core.update(
    f.principal,
    note.id,
    '[Listen](' + asset.markdownPath + ')',
    note.modifiedAt,
    'reference-media',
  );
  const initial = await f.call('download_note_asset', {
    noteId: note.id,
    assetId: asset.id,
    requestId: 'referenced-directory',
  });
  expect(initial.binding.metadata.savedReferenceHash).toBeTruthy();
  f.setCaller({
    ...f.principal,
    allowedPrefixes: [],
    knowledgeResourcePaths: [{ kind: 'note', id: note.id, path: '00-Inbox/referenced-media.md' }],
  });
  expect(f.read(initial.transferId, 8192).nextOffset).toBe(16384);
  f.runtime.knowledge.core.update(
    f.principal,
    note.id,
    '# Reference removed',
    updated.modifiedAt,
    'remove-media-reference',
  );
  expect(() => f.read(initial.transferId, 16384)).toThrow();
});
