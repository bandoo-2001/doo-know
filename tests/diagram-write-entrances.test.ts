import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { createKnowledgeToolPort } from '../apps/server/plugins/knowledge-tools';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers';
import { requireScope } from '../packages/core/agent/auth';
import type { PatchEdit } from '../shared/knowledge-contracts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const f = await pluginRuntimeFixture();
  cleanups.push(f.close);
  const runtime = f.platform.get(),
    intent = diagramCreationService(f.config, f.db, f.principal).reserve({
      path: '00-Inbox/diagram.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'label', type: 'text', text: '图中文字' }],
    });
  const primary = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal);
  const prepared = primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'whiteboard',
    source,
    sourceHash: sha(source),
    title: '原图标题',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({
      prepared,
      title: prepared.title,
      source,
      description: '说明\n',
    }),
    note = primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  const transfers = createMcpTransferStore(f.config, f.db),
    port = createKnowledgeToolPort({
      config: f.config,
      db: f.db,
      runtime,
      transfers,
      authorize(scopes) {
        for (const scope of scopes) requireScope(f.principal, scope);
        return f.principal;
      },
      toDooAccess: () => ({ listIds: [], domains: [] }),
    });
  async function page() {
    let ready = await runtime.knowledge.snapshots.read(f.principal, note.id, {});
    if (ready.kind === 'accepted') {
      await runtime.knowledge.snapshots.drain();
      ready = await runtime.knowledge.snapshots.read(f.principal, note.id, {});
    }
    if (ready.kind !== 'ready') throw Error('snapshot not ready');
    return ready.data;
  }
  async function patch(edits: PatchEdit[]) {
    const current = await page(),
      accepted = await runtime.knowledge.files.submit(f.principal, note.id, {
        snapshotId: current.snapshotId,
        expectedContentHash: current.sourceHash,
        expectedModifiedAt: current.modifiedAt,
        edits,
        requestId: randomUUID(),
      });
    if (accepted.kind !== 'accepted') throw Error('expected accepted');
    await runtime.knowledge.files.drain();
    return runtime.knowledge.files.operation(f.principal, accepted.operation.operationId);
  }
  async function upload(content: string, requestId = randomUUID()) {
    const current = runtime.notes.getNote(note.id),
      bytes = Buffer.from(content),
      session: any = await port.call('begin_note_document_upload', {
        noteId: note.id,
        expectedModifiedAt: current.modifiedAt,
        name: 'diagram.md',
        mime: 'text/markdown',
        totalBytes: bytes.length,
        requestId: 'begin-' + requestId,
      });
    for (let offset = 0; offset < bytes.length; offset += 8192)
      transfers.append(f.principal, {
        transferId: session.transferId,
        offset,
        base64: bytes.subarray(offset, offset + 8192).toString('base64'),
      });
    return {
      session,
      args: { transferId: session.transferId, requestId: 'complete-' + requestId },
    };
  }
  return {
    ...f,
    transfers,
    runtime,
    note,
    prepared,
    markdown,
    primary,
    patch,
    page,
    upload,
    call: port.call,
  };
}
it('rejects a background primary title patch and persists the structured pending-preview list', async () => {
  const f = await fixture(),
    result = await f.patch([
      { type: 'replace_text', before: '# 原图标题', after: '# 没有新预览的标题' },
    ]);
  expect(result.status).toBe('failed');
  const status = await f.call('get_knowledge_operation', { operationId: result.operationId });
  expect(status).toMatchObject({
    error: { details: { documents: [expect.objectContaining({ noteId: f.note.id })] } },
  });
  expect(result.error).toMatchObject({
    code: 'DIAGRAM_PREVIEW_REQUIRED',
    details: { documents: [expect.objectContaining({ noteId: f.note.id, role: 'primary' })] },
  });
  expect(await readFile(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toBe(
    f.markdown,
  );
});
it('records a complete new version for a description-only background patch', async () => {
  const f = await fixture(),
    result = await f.patch([{ type: 'replace_text', before: '说明\n', after: '补充说明\n' }]);
  expect(result.status).toBe('succeeded');
  expect(
    f.db
      .prepare('SELECT count(*) AS count FROM diagram_document_versions WHERE note_id=?')
      .get(f.note.id),
  ).toEqual({ count: 2 });
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(
    f.markdown.replace('说明\n', '补充说明\n'),
  );
});
it('rejects a background historical source whose preview no longer matches its title', async () => {
  const f = await fixture(),
    revisionId = randomUUID(),
    file = revisionId + '.md';
  await writeFile(
    join(f.config.dataRoot, 'history', file),
    f.markdown.replace('# 原图标题', '# 未准备的历史标题'),
  ).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.config.dataRoot, 'history'), { recursive: true });
    await writeFile(
      join(f.config.dataRoot, 'history', file),
      f.markdown.replace('# 原图标题', '# 未准备的历史标题'),
    );
  });
  f.db
    .prepare('INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)')
    .run(revisionId, f.note.id, file, new Date().toISOString(), f.note.modifiedAt);
  // Supply the historical path proof so this fixture reaches the preview gate.
  // Unknown original paths have separate explicit-refusal coverage.
  f.db.prepare("UPDATE revisions SET document_type='whiteboard',payload_format='markdown',logical_path=?,content_hash=? WHERE id=?")
    .run(f.note.relativePath, sha(f.markdown.replace('# 原图标题', '# 未准备的历史标题')), revisionId);
  const accepted = await f.runtime.knowledge.files.restore(
    f.principal,
    f.note.id,
    revisionId,
    f.note.modifiedAt,
    randomUUID(),
  );
  if (accepted.kind !== 'accepted') throw Error('expected accepted');
  await f.runtime.knowledge.files.drain();
  const result = f.runtime.knowledge.files.operation(f.principal, accepted.operation.operationId);
  expect(result).toMatchObject({ status: 'failed', error: { code: 'DIAGRAM_PREVIEW_REQUIRED' } });
  expect(await readFile(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toBe(
    f.markdown,
  );
});
it('uses the same policy for actual MCP document upload completion and keeps the failure details on retry', async () => {
  const f = await fixture(),
    upload = await f.upload(f.markdown.replace('# 原图标题', '# 通过上传绕过预览'));
  for (let i = 0; i < 2; i++)
    await expect(f.call('complete_note_document_upload', upload.args)).rejects.toMatchObject({
      code: 'DIAGRAM_PREVIEW_REQUIRED',
      details: { documents: [expect.objectContaining({ noteId: f.note.id })] },
    });
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(f.markdown);
});
it('preserves a BOM in an uploaded Markdown snapshot while reusing an unchanged complete primary', async () => {
  const f = await fixture(),
    content = '\ufeff' + f.markdown + '附加说明\n',
    upload = await f.upload(content);
  await f.call('complete_note_document_upload', upload.args);
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(content);
  await f.page();
  let download: any = await f.call('download_note_document', {
    noteId: f.note.id,
    requestId: randomUUID(),
  });
  if (download.kind === 'accepted') {
    await f.runtime.knowledge.snapshots.drain();
    download = await f.call('download_note_document', {
      noteId: f.note.id,
      requestId: randomUUID(),
    });
  }
  expect(download.mime).toBe('text/markdown');
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < download.totalBytes) {
    const chunk = f.transfers.read(f.principal, { transferId: download.transferId, offset });
    chunks.push(Buffer.from(chunk.base64, 'base64'));
    offset = chunk.nextOffset;
  }
  expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
});
it('keeps source-only edits in ordinary embedded diagrams compatible', async () => {
  const f = await fixture(),
    note = f.runtime.knowledge.core.create(
      f.principal,
      '00-Inbox',
      'ordinary.md',
      '# 普通笔记\n\n```mermaid\nflowchart TD\n A-->B\n```\n',
      randomUUID(),
    );
  let ready = await f.runtime.knowledge.snapshots.read(f.principal, note.id, {});
  if (ready.kind === 'accepted') {
    await f.runtime.knowledge.snapshots.drain();
    ready = await f.runtime.knowledge.snapshots.read(f.principal, note.id, {});
  }
  if (ready.kind !== 'ready') throw Error('snapshot not ready');
  const accepted = await f.runtime.knowledge.files.submit(f.principal, note.id, {
    snapshotId: ready.data.snapshotId,
    expectedContentHash: ready.data.sourceHash,
    expectedModifiedAt: ready.data.modifiedAt,
    requestId: randomUUID(),
    edits: [{ type: 'replace_text', before: 'A-->B', after: 'A-->C' }],
  });
  if (accepted.kind !== 'accepted') throw Error('expected accepted');
  await f.runtime.knowledge.files.drain();
  expect(
    f.runtime.knowledge.files.operation(f.principal, accepted.operation.operationId).status,
  ).toBe('succeeded');
  expect(f.runtime.notes.getNote(note.id).content).toContain('A-->C');
});

it('refuses to restore a trashed primary with a missing retained preview before moving its main file back', async () => {
  const f = await fixture(),
    p = { ...f.principal, scopes: [...f.principal.scopes, 'knowledge:archive'] };
  f.runtime.knowledge.core.archive(p, f.note.id, f.note.modifiedAt, randomUUID());
  const { unlink } = await import('node:fs/promises');
  await unlink(join(f.config.knowledgeRoot, f.prepared.preview.relativePath));
  expect(() =>
    f.runtime.knowledge.core.restore(p, f.note.id, undefined, randomUUID()),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }));
  const { access } = await import('node:fs/promises');
  await expect(access(join(f.config.knowledgeRoot, f.note.relativePath))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});
it('restores a complete trashed primary using its retained resources and original identity', async () => {
  const f = await fixture(),
    p = { ...f.principal, scopes: [...f.principal.scopes, 'knowledge:archive'] };
  f.runtime.knowledge.core.archive(p, f.note.id, f.note.modifiedAt, randomUUID());
  const restored = f.runtime.knowledge.core.restore(p, f.note.id, undefined, randomUUID());
  expect(restored.id).toBe(f.note.id);
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(f.markdown);
});

it('applies the same preview policy through the small revision recovery service', async () => {
  const f = await fixture(),
    revisionId = randomUUID(),
    file = revisionId + '.md';
  await mkdir(join(f.config.dataRoot, 'history'), { recursive: true });
  await writeFile(
    join(f.config.dataRoot, 'history', file),
    f.markdown.replace('# 原图标题', '# 无预览的小文件历史'),
  );
  f.db
    .prepare('INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)')
    .run(revisionId, f.note.id, file, new Date().toISOString(), f.note.modifiedAt);
  // Supply the historical path proof so this fixture reaches the preview gate.
  // Unknown original paths have separate explicit-refusal coverage.
  f.db.prepare("UPDATE revisions SET document_type='whiteboard',payload_format='markdown',logical_path=?,content_hash=? WHERE id=?")
    .run(f.note.relativePath, sha(f.markdown.replace('# 原图标题', '# 无预览的小文件历史')), revisionId);
  expect(() =>
    f.runtime.recovery.restoreRevision(f.note.id, revisionId, f.note.modifiedAt, randomUUID()),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREVIEW_REQUIRED' }));
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(f.markdown);
});
it('restores a complete small revision without changing the original identity or Markdown bytes', async () => {
  const f = await fixture(),
    patch = await f.patch([{ type: 'replace_text', before: '说明\n', after: '修改过的说明\n' }]);
  expect(patch.status).toBe('succeeded');
  const revision = f.db
    .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
    .get(f.note.id) as { id: string };
  const current = f.runtime.notes.getNote(f.note.id);
  const restored = f.runtime.recovery.restoreRevision(
    f.note.id,
    revision.id,
    current.modifiedAt,
    randomUUID(),
  );
  expect(restored).toMatchObject({
    id: f.note.id,
    documentType: 'whiteboard',
    content: f.markdown,
  });
});

it('does not let bare-CR frontmatter bypass the background primary conversion guard', async () => {
  const f = await fixture(),
    original = '# 普通来源\n',
    note = f.runtime.knowledge.core.create(
      f.principal,
      '00-Inbox',
      'cr-boundary.md',
      original,
      randomUUID(),
    );
  const { readFile: readFixture } = await import('node:fs/promises');
  const target =
    '---\n---\r' +
    (await readFixture(
      new URL('./fixtures/diagram-documents/flowchart.md', import.meta.url),
      'utf8',
    ));
  let ready = await f.runtime.knowledge.snapshots.read(f.principal, note.id, {});
  if (ready.kind === 'accepted') {
    await f.runtime.knowledge.snapshots.drain();
    ready = await f.runtime.knowledge.snapshots.read(f.principal, note.id, {});
  }
  if (ready.kind !== 'ready') throw Error('snapshot not ready');
  const accepted = await f.runtime.knowledge.files.submit(f.principal, note.id, {
    snapshotId: ready.data.snapshotId,
    expectedContentHash: ready.data.sourceHash,
    expectedModifiedAt: ready.data.modifiedAt,
    requestId: randomUUID(),
    edits: [{ type: 'replace_text', before: original, after: target }],
  });
  if (accepted.kind !== 'accepted') throw Error('expected accepted');
  await f.runtime.knowledge.files.drain();
  expect(
    f.runtime.knowledge.files.operation(f.principal, accepted.operation.operationId),
  ).toMatchObject({ status: 'failed', error: { code: 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED' } });
  expect(f.runtime.notes.getNote(note.id).content).toBe(original);
});
