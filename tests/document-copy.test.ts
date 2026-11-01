import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { organizationFixture } from './support/organization-fixture';
import { assetService } from '../packages/core/assets';
import { documentCopyService } from '../packages/core/knowledge/document-copy';
import { mutationCore } from '../packages/core/knowledge/core';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
it('copies a document under a fresh identity while preserving its referenced shared attachments and retry receipt', () => {
  const f = organizationFixture();
  cleanup.push(f.close);
  const original = f.create('00-Inbox/original.md', '# Original\n\n[Related](related.md)');
  const service = documentCopyService(
    f.config,
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  );
  const input = {
    folderPath: 'Topic',
    fileName: 'copied.md',
    expectedModifiedAt: original.expectedModifiedAt,
    expectedContentHash: original.expectedContentHash,
    requestId: randomUUID(),
  };
  const copied = service.copy(original.noteId, input);
  expect(copied.id).not.toBe(original.noteId);
  expect(f.notes.getNote(copied.id).content).toContain('../00-Inbox/related.md');
  expect(f.notes.row(original.noteId).path).toBe('00-Inbox/original.md');
  expect(service.copy(original.noteId, input)).toEqual(copied);
  expect(() => service.copy(original.noteId, { ...input, fileName: 'other.md' })).toThrowError(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
  );
});
it('copies a published primary with a new UUID and verified shared immutable pair, then allows its own later mutation', async () => {
  const f = organizationFixture();
  cleanup.push(f.close);
  const { diagramCreationService } = await import('../packages/core/knowledge/diagram-creation');
  const { primaryDiagramService } = await import('../packages/core/knowledge/primary-diagrams');
  const { diagramRendererVersions, renderPreparedDiagramDocument } =
    await import('../shared/diagram-primary');
  const { sha256 } = await import('../packages/core/knowledge/operations');
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p);
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: '00-Inbox/flow.md',
    type: 'flowchart',
    requestId: randomUUID(),
  });
  const source = 'flowchart TD\n A-->B\n',
    png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
  const prepared = primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'flowchart',
    source,
    sourceHash: sha256(source),
    title: 'Flow',
    renderer: diagramRendererVersions.flowchart,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  const original = primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: 'Flow', source }),
    requestId: randomUUID(),
  });
  const service = documentCopyService(f.config, f.db, f.notes, assets, f.p);
  const copied = service.copy(original.id, {
    folderPath: 'Topic',
    fileName: 'copied.md',
    expectedModifiedAt: original.modifiedAt,
    expectedContentHash: sha256(original.content),
    requestId: randomUUID(),
  });
  expect(copied.id).not.toBe(original.id);
  expect(f.notes.getNote(copied.id).content).toContain('../00-Inbox/assets/');
  const resolved = primary.resolve(copied.id);
  expect(resolved.source.hash).toBe(prepared.sourceHash);
  expect(resolved.preview?.state).toBe('ready');
  const updated = primary.prepare({
    target: {
      kind: 'document',
      noteId: copied.id,
      expectedDocumentHash: resolved.documentHash,
      expectedSourceHash: resolved.source.hash,
    },
    type: 'flowchart',
    source: 'flowchart TD\n A-->C\n',
    sourceHash: sha256('flowchart TD\n A-->C\n'),
    title: 'Flow',
    renderer: diagramRendererVersions.flowchart,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  expect(updated.preview.relativePath).not.toBe(prepared.preview.relativePath);
  expect(primary.resolve(original.id).source.hash).toBe(prepared.sourceHash);
});
it('converts an old JSON copy to a new Markdown primary only after rendering its final asset-anchored source', async () => {
  const f = organizationFixture();
  cleanup.push(f.close);
  const { emptyWhiteboard } = await import('../shared/whiteboard');
  const { diagramOperationPreviewRegistry } =
    await import('../packages/core/knowledge/diagram-operation-previews');
  const original = f.create(
    '00-Inbox/legacy.excalidraw',
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../Topic/target.md' }],
    }),
  );
  const assets = assetService(f.config, f.db, f.notes),
    service = documentCopyService(f.config, f.db, f.notes, assets, f.p),
    registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets);
  const input = {
    folderPath: 'Topic',
    fileName: 'copy.md',
    expectedModifiedAt: original.expectedModifiedAt,
    expectedContentHash: original.expectedContentHash,
    requestId: randomUUID(),
  };
  let required: any;
  try {
    service.copy(original.noteId, input);
  } catch (error) {
    required = (error as any).details;
  }
  expect(required.documents).toHaveLength(1);
  expect(
    f.db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get('Topic/copy.md'),
  ).toBeUndefined();
  const snapshot = registry.get(required.documents[0].snapshotId);
  expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/target.md');
  registry.prepare(snapshot.id, {
    sourceHash: snapshot.sourceHash,
    pngBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    requestId: randomUUID(),
  });
  const copied = service.copy(original.noteId, input);
  expect(copied.id).not.toBe(original.noteId);
  expect(f.notes.getNote(copied.id).documentType).toBe('whiteboard');
  expect(f.notes.row(original.noteId).path).toBe('00-Inbox/legacy.excalidraw');
});
it('copies a relocated inline primary only after final-source PNG preparation, using the same request and a fresh UUID', async () => {
  const f = organizationFixture();
  cleanup.push(f.close);
  const { diagramCreationService } = await import('../packages/core/knowledge/diagram-creation'),
    { primaryDiagramService } = await import('../packages/core/knowledge/primary-diagrams'),
    { diagramOperationPreviewRegistry } =
      await import('../packages/core/knowledge/diagram-operation-previews'),
    { diagramRendererVersions, renderPreparedDiagramDocument } =
      await import('../shared/diagram-primary'),
    { sha256 } = await import('../packages/core/knowledge/operations');
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p),
    intent = diagramCreationService(f.config, f.db, f.p).reserve({
      path: '00-Inbox/mind.md',
      type: 'mindmap',
      requestId: randomUUID(),
    }),
    source = '- [[../Topic/target.md]]\n',
    png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
  const old = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'mindmap',
      source,
      sourceHash: sha256(source),
      title: 'Mind',
      renderer: diagramRendererVersions.mindmap,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    }),
    original = primary.commit({
      preparedId: old.id,
      markdown: renderPreparedDiagramDocument({ prepared: old, title: 'Mind', source }),
      requestId: randomUUID(),
    }),
    service = documentCopyService(f.config, f.db, f.notes, assets, f.p),
    input = {
      folderPath: 'Topic',
      fileName: 'mindcopy.md',
      expectedModifiedAt: original.modifiedAt,
      expectedContentHash: sha256(original.content),
      requestId: randomUUID(),
    };
  let details: any;
  try {
    service.copy(original.id, input);
  } catch (error) {
    expect(error).toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
    details = (error as any).details;
  }
  expect(details.documents).toHaveLength(1);
  expect(
    f.db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get('Topic/mindcopy.md'),
  ).toBeUndefined();
  const registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets),
    fixed = registry.get(details.documents[0].snapshotId);
  expect(fixed.source).toBe('- [[target.md]]\n');
  const prepared = registry.prepare(fixed.id, {
    sourceHash: fixed.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  const copied = service.copy(original.id, input);
  expect(copied.id).not.toBe(original.id);
  expect(primary.resolve(copied.id).source.hash).toBe(fixed.sourceHash);
  expect(primary.resolve(copied.id).preview?.state).toBe('ready');
  expect(prepared.preview.relativePath).not.toBe(old.preview.relativePath);
  expect(primary.resolve(original.id).source.hash).toBe(old.sourceHash);
  expect(service.copy(original.id, input)).toEqual(copied);
});
