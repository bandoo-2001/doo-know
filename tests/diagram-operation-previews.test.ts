import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { assetService } from '../packages/core/assets';
import { sha256 } from '../packages/core/knowledge/operations';
import { diagramRendererVersions } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
function fixture() {
  const f = organizationFixture();
  cleanup.push(f.close);
  const created = f.create('00-Inbox/native.md', '# Native');
  const note = {
    id: created.noteId,
    relativePath: '00-Inbox/native.md',
    content: '# Native',
    modifiedAt: created.expectedModifiedAt,
  };
  const source = JSON.stringify(emptyWhiteboard());
  const registry = diagramOperationPreviewRegistry(
    f.config,
    f.db,
    f.p,
    assetService(f.config, f.db, f.notes),
  );
  const snapshot = registry.fix({
    noteId: note.id,
    role: 'primary',
    documentPath: note.relativePath,
    documentHash: sha256(note.content),
    documentModifiedAt: note.modifiedAt,
    sourceHash: sha256(source),
    finalSource: source,
    type: 'whiteboard',
    title: 'Native',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    moves: [],
  });
  return { ...f, note, registry, snapshot };
}
it('pins exact final bytes and persists a source and render bound lease across registry instances', () => {
  const f = fixture();
  expect(f.registry.fix(f.snapshot.input).id).toBe(f.snapshot.id);
  expect(f.registry.prepared(f.snapshot.id)).toBeUndefined();
  const prepared = f.registry.prepare(f.snapshot.id, {
    sourceHash: f.snapshot.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  expect(prepared.sourceHash).toBe(f.snapshot.sourceHash);
  expect(prepared.renderHash).toBe(f.snapshot.renderHash);
  const reopened = diagramOperationPreviewRegistry(
    f.config,
    f.db,
    f.p,
    assetService(f.config, f.db, f.notes),
  );
  expect(reopened.prepared(f.snapshot.id)?.id).toBe(prepared.id);
});
it('rejects substituted snapshots and changed baselines before accepting browser PNG', () => {
  const f = fixture();
  expect(() =>
    f.registry.prepare(f.snapshot.id, {
      sourceHash: '0'.repeat(64),
      pngBase64: png,
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREPARATION_MISMATCH' }));
  writeFileSync(join(f.config.knowledgeRoot, f.note.relativePath), '# Changed');
  expect(() =>
    f.registry.prepare(f.snapshot.id, {
      sourceHash: f.snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
});
it('keeps fixed source private to the preparing principal and rechecks current scope', () => {
  const f = fixture();
  const other = diagramOperationPreviewRegistry(
    f.config,
    f.db,
    { ...f.p, id: 'other' },
    assetService(f.config, f.db, f.notes),
  );
  expect(() => other.get(f.snapshot.id)).toThrowError(
    expect.objectContaining({ code: 'NOT_FOUND' }),
  );
  const revoked = diagramOperationPreviewRegistry(
    f.config,
    f.db,
    { ...f.p, allowedPrefixes: ['Topic'], knowledgeAll: false },
    assetService(f.config, f.db, f.notes),
  );
  expect(() => revoked.get(f.snapshot.id)).toThrow();
});
it('pages all preparation needs with bounded replies and actor-bound invalidating cursors', async () => {
  const f = fixture();
  const { beginOperation } = await import('../packages/core/knowledge/operations');
  const { diagramOperationPreviewNeeds } =
    await import('../packages/core/knowledge/diagram-operation-preview-pages');
  const documents = Array.from({ length: 41 }, (_, i) => {
    const fixed = f.registry.fix({ ...f.snapshot.input, context: { group: i } });
    return {
      noteId: f.note.id,
      role: 'primary',
      documentHash: f.snapshot.input.documentHash,
      sourceHash: fixed.sourceHash,
      renderHash: fixed.renderHash,
      snapshotId: fixed.id,
    };
  });
  const { operation } = beginOperation(f.db, f.p, 'move', randomUUID(), {});
  f.db.prepare("UPDATE operations SET status='awaiting_preview',error=? WHERE id=?").run(
    JSON.stringify({
      code: 'DIAGRAM_PREVIEW_REQUIRED',
      details: { planId: documents[0].snapshotId, documents },
    }),
    operation.id,
  );
  const first = diagramOperationPreviewNeeds(f.config, f.db, f.p, { operationId: operation.id });
  expect(first.documents).toHaveLength(20);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(16000);
  const second = diagramOperationPreviewNeeds(f.config, f.db, f.p, {
    operationId: operation.id,
    cursor: first.nextCursor,
  });
  const third = diagramOperationPreviewNeeds(f.config, f.db, f.p, {
    operationId: operation.id,
    cursor: second.nextCursor,
  });
  expect(
    [...first.documents, ...second.documents, ...third.documents].map((d) => d.snapshotId),
  ).toEqual(documents.map((d) => d.snapshotId));
  expect(third.nextCursor).toBeUndefined();
  expect(() =>
    diagramOperationPreviewNeeds(
      f.config,
      f.db,
      { ...f.p, id: 'foreign' },
      { operationId: operation.id },
    ),
  ).toThrowError(expect.objectContaining({ code: 'OPERATION_NOT_FOUND' }));
  expect(() =>
    diagramOperationPreviewNeeds(
      f.config,
      f.db,
      { ...f.p, knowledgeAll: false, allowedPrefixes: ['Topic'] },
      { operationId: operation.id },
    ),
  ).toThrowError(expect.objectContaining({ statusCode: 403 }));
  f.db.prepare('UPDATE operations SET error=? WHERE id=?').run(
    JSON.stringify({
      details: { planId: documents[0].snapshotId, documents: [...documents].reverse() },
    }),
    operation.id,
  );
  expect(() =>
    diagramOperationPreviewNeeds(f.config, f.db, f.p, {
      operationId: operation.id,
      cursor: first.nextCursor,
    }),
  ).toThrowError(expect.objectContaining({ code: 'CURSOR_INVALIDATED' }));
});
it('serves exact source bytes through bounded ranges and rechecks the baseline for every chunk', () => {
  const f = fixture();
  const metadata = f.registry.metadata(f.snapshot.id);
  expect(metadata.sourceSizeBytes).toBe(Buffer.byteLength(f.snapshot.source));
  const chunks: Buffer[] = [];
  let offset = 0;
  do {
    const chunk = f.registry.readSource(f.snapshot.id, { offset, maxBytes: 17 });
    expect(chunk.content.length).toBeLessThanOrEqual(24);
    chunks.push(Buffer.from(chunk.content, 'base64'));
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  } while (true);
  expect(Buffer.concat(chunks).toString()).toBe(f.snapshot.source);
  writeFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'Changed');
  expect(() => f.registry.readSource(f.snapshot.id, { offset: 0 })).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
});
it('does not reuse a fixed source lease after an authorized workspace root rebind with identical document bytes', async () => {
  const f = fixture();
  const { renameSync, cpSync, lstatSync, realpathSync } = await import('node:fs');
  const old = join(f.root, 'old-knowledge');
  renameSync(f.config.knowledgeRoot, old);
  cpSync(old, f.config.knowledgeRoot, { recursive: true, preserveTimestamps: true });
  const s = lstatSync(f.config.knowledgeRoot, { bigint: true });
  f.db.prepare("UPDATE index_meta SET value=? WHERE key='root_identity'").run(
    JSON.stringify({
      path: realpathSync(f.config.knowledgeRoot),
      dev: String(s.dev),
      ino: String(s.ino),
    }),
  );
  expect(() => f.registry.metadata(f.snapshot.id)).toThrowError(
    expect.objectContaining({ code: 'LIBRARY_BINDING_CHANGED' }),
  );
});
it('retains an explicit expired outcome when a fresh snapshot replaces an expired fingerprint', () => {
  const f = fixture();
  f.db
    .prepare('UPDATE diagram_operation_previews SET expires_at=? WHERE id=?')
    .run(Date.now() - 1, f.snapshot.id);
  const fresh = f.registry.fix(f.snapshot.input);
  expect(fresh.id).not.toBe(f.snapshot.id);
  expect(() => f.registry.get(f.snapshot.id)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_PREPARATION_EXPIRED' }),
  );
});
