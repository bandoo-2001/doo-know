import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { organizationService } from '../packages/core/organization/service';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { documentCopyService } from '../packages/core/knowledge/document-copy';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of close.splice(0).reverse()) await f();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
async function fixture(link?: string) {
  const f = organizationFixture(),
    org = organizationService(f.config, f.db, f.notes);
  close.push(async () => {
    await org.close();
    f.close();
  });
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p),
    registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets),
    intent = diagramCreationService(f.config, f.db, f.p).reserve({
      path: '00-Inbox/board.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: link ? [{ id: 'a', type: 'rectangle', link }] : [],
    });
  const prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source,
      sourceHash: sha256(source),
      title: 'Board',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    }),
    note = primary.commit({
      preparedId: prepared.id,
      markdown: renderPreparedDiagramDocument({ prepared, title: 'Board', source }),
      requestId: randomUUID(),
    }),
    copy = documentCopyService(f.config, f.db, f.notes, assets, f.p).copy(note.id, {
      folderPath: 'Topic',
      fileName: 'copy.md',
      expectedModifiedAt: note.modifiedAt,
      expectedContentHash: sha256(note.content),
      requestId: randomUUID(),
    });
  async function finish(id: string) {
    let op = org.operation(f.p, { operationId: id });
    if (op.status === 'awaiting_preview') {
      for (const need of op.previewRequired!.documents) {
        const fixed = registry.get(need.snapshotId);
        registry.prepare(fixed.id, {
          sourceHash: fixed.sourceHash,
          pngBase64: png,
          requestId: randomUUID(),
        });
      }
      await org.resume(f.p, { operationId: id });
      await org.drain();
      op = org.operation(f.p, { operationId: id });
    }
    return op;
  }
  async function move() {
    const context = org.context(f.p),
      folder = f.directory('00-Inbox');
    const result = await org.submit(f.p, {
      libraryId: context.libraryId,
      expectedStructureRevision: context.structureRevision,
      requestId: randomUUID(),
      actions: [
        {
          type: 'move_directory',
          directoryId: folder.id,
          toDirectoryId: f.directory('Topic').id,
          name: 'Moved',
          expectedSubtreeRevision: folder.subtreeRevision,
        },
      ],
    });
    await org.drain();
    return finish(result.operation.operationId);
  }
  return { ...f, org, primary, registry, prepared, note, copy, source, finish, move };
}
it('moves a published source folder with an outside copy while keeping fixed shared source/PNG identities readable', async () => {
  const f = await fixture();
  const before = f.primary.resolve(f.copy.id);
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  expect(f.notes.row(f.note.id).path).toBe('Topic/Moved/board.md');
  expect(f.primary.resolve(f.note.id).preview?.state).toBe('ready');
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
  expect(f.primary.resolve(f.copy.id).source.hash).toBe(before.source.hash);
  expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8')).toBe(
    f.source,
  );
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(f.prepared.source!.id)).toEqual({
    path: f.prepared.source!.relativePath,
  });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/board.md'))).toBe(false);
});
it('undoes a shared folder move by reusing only its verified retained resource directories', async () => {
  const f = await fixture();
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  const undo = await f.org.undo(f.p, { operationId: moved.operationId, requestId: randomUUID() });
  await f.org.drain();
  const result = await f.finish(undo.operation.operationId);
  expect(result.status).toBe('succeeded');
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
  expect(f.primary.resolve(f.note.id).preview?.state).toBe('ready');
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
});
it('prepares fresh current sources when a retained shared source keeps its base while internal targets move', async () => {
  const f = await fixture('../inside.md');
  f.create('00-Inbox/inside.md', '# Inside');
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  const primary = f.primary.resolve(f.note.id),
    copy = f.primary.resolve(f.copy.id);
  expect(primary.preview?.state).toBe('ready');
  expect(copy.preview?.state).toBe('ready');
  expect(JSON.parse(primary.source.content!).elements[0].link).toBe('../inside.md');
  expect(JSON.parse(copy.source.content!).elements[0].link).toBe('../Moved/inside.md');
  expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8')).toBe(
    f.source,
  );
});
it('refuses shared-directory undo when the retained original resource root contains a new user document', async () => {
  const f = await fixture();
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  f.create('00-Inbox/new-user.md', '# User');
  const undo = await f.org.undo(f.p, { operationId: moved.operationId, requestId: randomUUID() });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: undo.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'UNDO_CONFLICT' },
  });
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/new-user.md'), 'utf8')).toBe('# User');
  expect(f.notes.row(f.note.id).path).toBe('Topic/Moved/board.md');
});
it('keeps shared history resources usable through move and fixed-primary history restore, then exports a complete package', async () => {
  const f = await fixture();
  const current = f.notes.getNote(f.copy.id);
  f.notes.saveNote(
    current.id,
    current.content + '\nEdited description\n',
    current.modifiedAt,
    randomUUID(),
  );
  const revision = f.db
    .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid LIMIT 1')
    .get(f.copy.id) as { id: string };
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  const { diagramHistoryRestoreService } =
      await import('../packages/core/knowledge/diagram-history-restore'),
    { portableDeliveryService } = await import('../packages/core/portable-delivery/service');
  const history = diagramHistoryRestoreService(
      f.config,
      f.db,
      f.notes,
      assetService(f.config, f.db, f.notes),
      f.p,
    ),
    now = f.notes.getNote(f.copy.id),
    plan = history.plan(f.copy.id, revision.id, now.modifiedAt, randomUUID());
  history.prepare(plan.id, {
    sourceHash: plan.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  history.commit(plan.id, { requestId: randomUUID() });
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
  expect(f.notes.getNote(f.copy.id).content).not.toContain('Edited description');
  const portable = portableDeliveryService(f.config, f.db, f.notes);
  const out = await portable.create(f.p, {
    selection: { kind: 'single', noteId: f.copy.id },
    requestId: randomUUID(),
  });
  expect(out.kind).toBe('archive');
  const chunks: Buffer[] = [];
  for await (const chunk of await portable.download(f.p, out.id)) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).length).toBeGreaterThan(200);
});
it('keeps unpublished changed-scene preparations protected while the published shared copies remain readable', async () => {
  const f = await fixture();
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'draft', type: 'text', text: 'Unsaved draft' }],
  });
  const prepared = f.primary.prepare({
    target: {
      kind: 'document',
      noteId: f.note.id,
      expectedDocumentHash: sha256(f.note.content),
      expectedSourceHash: f.prepared.sourceHash,
    },
    type: 'whiteboard',
    source,
    sourceHash: sha256(source),
    title: 'Board',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  const moved = await f.move();
  expect(moved).toMatchObject({ status: 'failed', error: { code: 'DIAGRAM_RESOURCES_RETAINED' } });
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
  expect(f.primary.getPreparation(prepared.id, { fresh: true }).sourceHash).toBe(sha256(source));
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
});
it('undoes native shared resource relocation only after every final inverse source has a fixed preview', async () => {
  const f = await fixture('../inside.md');
  f.create('00-Inbox/inside.md', '# Inside');
  const moved = await f.move();
  expect(moved.status).toBe('succeeded');
  const undo = await f.org.undo(f.p, { operationId: moved.operationId, requestId: randomUUID() });
  await f.org.drain();
  const result = await f.finish(undo.operation.operationId);
  expect(result.status).toBe('succeeded');
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
  expect(f.primary.resolve(f.note.id).preview?.state).toBe('ready');
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
});
it('recovers a shared-resource folder move after the real metadata worker exit without losing retained proofs or identities', async () => {
  const f = await fixture(),
    context = f.org.context(f.p),
    directory = f.directory('00-Inbox'),
    requestId = randomUUID(),
    input = {
      requestId,
      libraryId: context.libraryId,
      expectedStructureRevision: context.structureRevision,
      actions: [
        {
          type: 'move_directory',
          directoryId: directory.id,
          toDirectoryId: f.directory('Topic').id,
          name: 'Moved',
          expectedSubtreeRevision: directory.subtreeRevision,
        },
      ],
    };
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'metadata',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  await f.org.recover();
  await f.org.drain();
  expect(f.org.operation(f.p, { requestId }).status).toBe('succeeded');
  expect(f.notes.row(f.note.id).path).toBe('Topic/Moved/board.md');
  expect(f.primary.resolve(f.note.id).preview?.state).toBe('ready');
  expect(f.primary.resolve(f.copy.id).preview?.state).toBe('ready');
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(f.prepared.source!.id)).toEqual({
    path: f.prepared.source!.relativePath,
  });
  const replay = await f.org.submit(f.p, input as any);
  expect(replay.operation.status).toBe('succeeded');
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE note_id=?').get(f.note.id),
  ).toEqual({ count: 1 });
});
