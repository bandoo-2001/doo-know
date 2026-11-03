import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { collectNativeLinkChanges } from '../packages/core/knowledge/native-link-plans';
import { organizationService } from '../packages/core/organization/service';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
function fixture(targetName = 'target.md') {
  const f = organizationFixture();
  const org = organizationService(f.config, f.db, f.notes);
  cleanup.push(async () => {
    await org.close();
    f.close();
  });
  const assets = assetService(f.config, f.db, f.notes);
  const primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p);
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: '00-Inbox/board.md',
    type: 'whiteboard',
    requestId: randomUUID(),
  });
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'a', type: 'rectangle', link: '../../Topic/' + targetName }],
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
  });
  const note = primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: 'Board', source }),
    requestId: randomUUID(),
  });
  const target = f.create('Topic/' + targetName, '# Target');
  const registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets);
  async function rename() {
    const context = org.context(f.p);
    const response = await org.submit(f.p, {
      ...context,
      requestId: randomUUID(),
      expectedStructureRevision: context.structureRevision,
      actions: [
        {
          type: 'move_note',
          ...target,
          toDirectoryId: f.directory('Topic').id,
          fileName: 'renamed.md',
        },
      ],
    });
    await org.drain();
    return org.operation(f.p, { operationId: response.operation.operationId });
  }
  return { ...f, org, registry, prepared, note, source, target, rename };
}
it('keeps target live until exact final native source has a new prepared preview, then commits dependencies together', async () => {
  const f = fixture();
  const pending = await f.rename();
  expect(pending.status).toBe('awaiting_preview');
  expect(pending.previewRequired?.documents).toHaveLength(1);
  const id = pending.previewRequired!.documents[0].snapshotId;
  const snapshot = f.registry.get(id);
  expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/renamed.md');
  const prepared = f.registry.prepare(id, {
    sourceHash: snapshot.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: pending.operationId }).status).toBe('succeeded');
  const body = readFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8');
  const parsed = parseDiagramDocument(body);
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram') return;
  expect(parsed.primary.binding.sourceHash).toBe(snapshot.sourceHash);
  expect(parsed.primary.binding.renderHash).toBe(prepared.renderHash);
  expect(f.notes.row(f.target.noteId).path).toBe('Topic/renamed.md');
  expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8')).toBe(
    f.source,
  );
});
it('requires a fresh final-source snapshot when undo changes native targets and restores the original target identity', async () => {
  const f = fixture();
  const pending = await f.rename();
  for (const need of pending.previewRequired!.documents) {
    const snapshot = f.registry.get(need.snapshotId);
    f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.drain();
  const undo = await f.org.undo(f.p, { operationId: pending.operationId, requestId: randomUUID() });
  await f.org.drain();
  const waiting = f.org.operation(f.p, { operationId: undo.operation.operationId });
  expect(waiting.status).toBe('awaiting_preview');
  for (const need of waiting.previewRequired!.documents) {
    const snapshot = f.registry.get(need.snapshotId);
    expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/target.md');
    f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  await f.org.resume(f.p, { operationId: waiting.operationId });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: waiting.operationId }).status).toBe('succeeded');
  expect(f.notes.row(f.target.noteId).path).toBe('Topic/target.md');
});
it('checks inventory again before resuming an immutable operation plan', async () => {
  const f = fixture();
  const pending = await f.rename();
  const snapshot = f.registry.get(pending.previewRequired!.documents[0].snapshotId);
  f.registry.prepare(snapshot.id, {
    sourceHash: snapshot.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  f.create('Topic/added-after-plan.md', '# Added');
  await expect(f.org.resume(f.p, { operationId: pending.operationId })).rejects.toMatchObject({
    code: 'STRUCTURE_VERSION_CONFLICT',
  });
  expect(f.notes.row(f.target.noteId).path).toBe('Topic/target.md');
});
it('prepares all current primary, ordinary native groups, and legacy JSON dependencies once before a single activation', async () => {
  const f = fixture();
  const { diagramArtifactService } = await import('../packages/core/knowledge/diagram-artifacts');
  const { serializeDiagramBinding } = await import('../shared/diagram-binding');
  const { renderPortableFigure } = await import('../shared/portable-figure');
  const { boundDiagramSources, normalizeDiagramCode } =
    await import('../shared/diagram-portability');
  const { localReference } = await import('../packages/core/render');
  const group = f.create('00-Inbox/group.md', '# Group');
  const artifacts = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(group.noteId, {
    kind: 'excalidraw',
    source: f.source,
    sourceHash: sha256(f.source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  const code = artifacts.source.markdownPath;
  const groupContent =
    '# Group\n\n' +
    renderPortableFigure({
      alt: 'EXCALIDRAW 预览',
      previewPath: artifacts.preview.markdownPath,
      source: { type: 'file', path: code },
    }) +
    '\n' +
    serializeDiagramBinding({
      kind: 'excalidraw',
      sourceHash: artifacts.sourceHash,
      codeHash: sha256(normalizeDiagramCode(code)),
    }) +
    '\n\n```excalidraw\n' +
    code +
    '\n```\n';
  f.notes.saveNote(group.noteId, groupContent, group.expectedModifiedAt, randomUUID());
  const legacy = f.create(
    '00-Inbox/legacy.excalidraw',
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../Topic/target.md' }],
    }),
  );
  const pending = await f.rename();
  expect(pending.previewRequired?.documents).toHaveLength(3);
  const ids = pending.previewRequired!.documents.map((d) => d.snapshotId);
  const legacyRender = pending.previewRequired!.documents.find(
    (d) => d.noteId === legacy.noteId,
  )!.renderHash;
  for (const id of ids) {
    const snapshot = f.registry.get(id);
    f.registry.prepare(id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: pending.operationId }).status).toBe('succeeded');
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM diagram_operation_previews').get()).toEqual({
    count: 3,
  });
  const currentGroup = f.notes.getNote(group.noteId);
  const native = boundDiagramSources(currentGroup.content)[0];
  expect(native.code.trim()).toBe(native.sourcePath);
  const sourcePath = localReference(currentGroup.relativePath, native.sourcePath)!;
  expect(
    JSON.parse(readFileSync(join(f.config.knowledgeRoot, sourcePath), 'utf8')).elements[0].link,
  ).toBe('../../Topic/renamed.md');
  expect(JSON.parse(f.notes.getNote(legacy.noteId).content).elements[0].link).toBe(
    '../Topic/renamed.md',
  );
  const record = f.db
    .prepare(
      'SELECT document_hash,manifest FROM legacy_diagram_previews WHERE note_id=? ORDER BY created_at DESC LIMIT 1',
    )
    .get(legacy.noteId) as any;
  expect(record.document_hash).toBe(sha256(f.notes.getNote(legacy.noteId).content));
  expect(JSON.parse(record.manifest).renderHash).toBe(legacyRender);
});
it('moves a source directory after final preview preparation and can undo that move with the same journal rules', async () => {
  const f = fixture();
  const folder = f.directory('00-Inbox'),
    context = f.org.context(f.p);
  const submitted = await f.org.submit(f.p, {
    requestId: randomUUID(),
    libraryId: context.libraryId,
    expectedStructureRevision: context.structureRevision,
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
  await f.org.drain();
  async function finish(id: string) {
    let operation = f.org.operation(f.p, { operationId: id });
    if (operation.status === 'awaiting_preview') {
      for (const need of operation.previewRequired!.documents) {
        const snapshot = f.registry.get(need.snapshotId);
        f.registry.prepare(snapshot.id, {
          sourceHash: snapshot.sourceHash,
          pngBase64: png,
          requestId: randomUUID(),
        });
      }
      await f.org.resume(f.p, { operationId: id });
      await f.org.drain();
      operation = f.org.operation(f.p, { operationId: id });
    }
    expect(operation.status).toBe('succeeded');
  }
  await finish(submitted.operation.operationId);
  expect(f.notes.row(f.note.id).path).toBe('Topic/Moved/board.md');
  const undo = await f.org.undo(f.p, {
    operationId: submitted.operation.operationId,
    requestId: randomUUID(),
  });
  await f.org.drain();
  await finish(undo.operation.operationId);
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
});
it('retries the same simple-move request after final native preparation and recovers a lost outer receipt', async () => {
  const f = fixture();
  const { mutationCore, webPrincipal } = await import('../packages/core/knowledge/core');
  const { diagramOperationPreviewRegistry } =
    await import('../packages/core/knowledge/diagram-operation-previews');
  const core = mutationCore(f.config, f.db),
    registry = diagramOperationPreviewRegistry(
      f.config,
      f.db,
      webPrincipal,
      assetService(f.config, f.db, f.notes),
    ),
    requestId = randomUUID();
  let details: any;
  try {
    core.move(
      webPrincipal,
      f.target.noteId,
      'Topic',
      'renamed.md',
      f.target.expectedModifiedAt,
      requestId,
    );
  } catch (error) {
    details = (error as any).details;
  }
  expect(details.documents).toHaveLength(1);
  for (const need of details.documents) {
    const fixed = registry.get(need.snapshotId);
    registry.prepare(fixed.id, {
      sourceHash: fixed.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  const moved = core.move(
    webPrincipal,
    f.target.noteId,
    'Topic',
    'renamed.md',
    f.target.expectedModifiedAt,
    requestId,
  );
  expect(moved.moved).toBe(true);
  expect(moved.id).toBe(f.target.noteId);
  f.db
    .prepare(
      "UPDATE operations SET status='prepared',result=NULL WHERE principal=? AND kind='move' AND request_id=?",
    )
    .run(webPrincipal.id, requestId);
  await core.recover();
  const recovered = core.move(
    webPrincipal,
    f.target.noteId,
    'Topic',
    'renamed.md',
    f.target.expectedModifiedAt,
    requestId,
  );
  expect(recovered).toEqual(moved);
});
it('does not silently replace a simple-move plan when another current document changes during preview preparation', async () => {
  const f = fixture();
  const { mutationCore, webPrincipal } = await import('../packages/core/knowledge/core');
  const { diagramOperationPreviewRegistry } =
    await import('../packages/core/knowledge/diagram-operation-previews');
  const core = mutationCore(f.config, f.db),
    registry = diagramOperationPreviewRegistry(
      f.config,
      f.db,
      webPrincipal,
      assetService(f.config, f.db, f.notes),
    ),
    requestId = randomUUID();
  let details: any;
  try {
    core.move(
      webPrincipal,
      f.target.noteId,
      'Topic',
      'renamed.md',
      f.target.expectedModifiedAt,
      requestId,
    );
  } catch (error) {
    details = (error as any).details;
  }
  for (const need of details.documents) {
    const fixed = registry.get(need.snapshotId);
    registry.prepare(fixed.id, {
      sourceHash: fixed.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  f.create('Topic/new-after-plan.md', '# New');
  expect(() =>
    core.move(
      webPrincipal,
      f.target.noteId,
      'Topic',
      'renamed.md',
      f.target.expectedModifiedAt,
      requestId,
    ),
  ).toThrowError(expect.objectContaining({ code: 'STRUCTURE_VERSION_CONFLICT' }));
});
for (const point of ['publish', 'source_removed', 'metadata'])
  it('recovers a native multi-document journal after a worker exits at ' + point, async () => {
    const f = fixture('a.md');
    const { collectNativeLinkChanges } =
      await import('../packages/core/knowledge/native-link-plans');
    const { spawnSync } = await import('node:child_process');
    const moves = [{ from: 'Topic/a.md', to: 'Topic/moved.md' }];
    const fixed = collectNativeLinkChanges(f.config, f.db, f.p, moves);
    expect(fixed.needs).toHaveLength(1);
    for (const need of fixed.needs) {
      const snapshot = f.registry.get(need.snapshotId);
      f.registry.prepare(snapshot.id, {
        sourceHash: snapshot.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    }
    const context = f.org.context(f.p),
      requestId = randomUUID(),
      input = {
        requestId,
        libraryId: context.libraryId,
        expectedStructureRevision: context.structureRevision,
        actions: [
          {
            type: 'move_note',
            ...f.target,
            toDirectoryId: f.directory('Topic').id,
            fileName: 'moved.md',
          },
        ],
      };
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/support/organization-crash-child.ts',
        JSON.stringify(f.config),
        JSON.stringify(input),
        point,
      ],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(91);
    await f.org.recover();
    await f.org.drain();
    expect(f.org.operation(f.p, { requestId }).status).toBe('succeeded');
    expect(f.notes.row(f.target.noteId).path).toBe('Topic/moved.md');
    const parsed = parseDiagramDocument(f.notes.getNote(f.note.id).content);
    expect(parsed.status).toBe('diagram');
    if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw') return;
    const { localReference } = await import('../packages/core/render');
    const sourcePath = localReference(f.note.relativePath, parsed.primary.source.path)!;
    expect(
      JSON.parse(readFileSync(join(f.config.knowledgeRoot, sourcePath), 'utf8')).elements[0].link,
    ).toBe('../../Topic/moved.md');
    expect(
      readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8'),
    ).toBe(f.source);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM notes WHERE active=1').get()).toEqual({
      count: 2,
    });
    const history = f.db
      .prepare('SELECT document_type,logical_path,content_hash FROM revisions WHERE note_id=?')
      .all(f.note.id);
    expect(history).toEqual([
      {
        document_type: 'whiteboard',
        logical_path: '00-Inbox/board.md',
        content_hash: sha256(f.note.content),
      },
    ]);
    await f.org.recover();
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE note_id=?').get(f.note.id),
    ).toEqual({ count: 1 });
  });
it('rebases an ordinary native reference fence with its linked source when its containing note moves across directories', async () => {
  const f = fixture();
  const { diagramArtifactService } = await import('../packages/core/knowledge/diagram-artifacts');
  const { serializeDiagramBinding } = await import('../shared/diagram-binding');
  const { renderPortableFigure } = await import('../shared/portable-figure');
  const { boundDiagramSources, normalizeDiagramCode } =
    await import('../shared/diagram-portability');
  const { mutationCore, webPrincipal } = await import('../packages/core/knowledge/core');
  const group = f.create('00-Inbox/moving-group.md', '# Group');
  const artifacts = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(group.noteId, {
    kind: 'excalidraw',
    source: f.source,
    sourceHash: sha256(f.source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  const code = artifacts.source.markdownPath;
  const content =
    '# Group\n\n' +
    renderPortableFigure({
      alt: 'EXCALIDRAW 预览',
      previewPath: artifacts.preview.markdownPath,
      source: { type: 'file', path: code },
    }) +
    '\n' +
    serializeDiagramBinding({
      kind: 'excalidraw',
      sourceHash: artifacts.sourceHash,
      codeHash: sha256(normalizeDiagramCode(code)),
    }) +
    '\n\n```excalidraw\n' +
    code +
    '\n```\n';
  const saved = f.notes.saveNote(group.noteId, content, group.expectedModifiedAt, randomUUID());
  const moved = mutationCore(f.config, f.db).move(
    webPrincipal,
    group.noteId,
    'Topic',
    'group.md',
    saved.modifiedAt,
    randomUUID(),
  );
  const current = boundDiagramSources(f.notes.getNote(moved.id).content)[0];
  expect(current.code.trim()).toBe(current.sourcePath);
  expect(current.binding.codeHash).toBe(sha256(normalizeDiagramCode(current.code)));
  expect(current.sourcePath).toContain('../00-Inbox/_doo-assets/');
});
it('records one original typed revision for each rewritten dependent main document and preserves it across receipt replay', async () => {
  const f = fixture();
  const pending = await f.rename();
  for (const need of pending.previewRequired!.documents) {
    const snapshot = f.registry.get(need.snapshotId);
    f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: pending.operationId }).status).toBe('succeeded');
  const revisions = f.db.prepare('SELECT * FROM revisions WHERE note_id=?').all(f.note.id) as any[];
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    document_type: 'whiteboard',
    payload_format: 'markdown',
    logical_path: '00-Inbox/board.md',
    content_hash: sha256(f.note.content),
  });
  expect(readFileSync(join(f.config.dataRoot, 'history', revisions[0].file), 'utf8')).toBe(
    f.note.content,
  );
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.recover();
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE note_id=?').get(f.note.id),
  ).toEqual({ count: 1 });
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE note_id=?').get(f.target.noteId),
  ).toEqual({ count: 0 });
});
it('prepares an authoritative mindmap outline changed by relative-link relocation before publishing a new PNG binding', async () => {
  const f = fixture(),
    assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p),
    intent = diagramCreationService(f.config, f.db, f.p).reserve({
      path: '00-Inbox/map.md',
      type: 'mindmap',
      requestId: randomUUID(),
    }),
    source = '- [[../Topic/target.md]]\n';
  const prepared = primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'mindmap',
    source,
    sourceHash: sha256(source),
    title: 'Map',
    renderer: diagramRendererVersions.mindmap,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  const map = primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: 'Map', source }),
    requestId: randomUUID(),
  });
  const pending = await f.rename();
  expect(pending.previewRequired?.documents).toHaveLength(2);
  const mapNeed = pending.previewRequired!.documents.find((d) => d.noteId === map.id)!;
  const fixed = f.registry.get(mapNeed.snapshotId);
  expect(fixed.source).toBe('- [[../Topic/renamed.md]]\n');
  expect(primary.resolve(map.id).source.hash).toBe(prepared.sourceHash);
  for (const need of pending.previewRequired!.documents) {
    const snapshot = f.registry.get(need.snapshotId);
    f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  await f.org.resume(f.p, { operationId: pending.operationId });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: pending.operationId }).status).toBe('succeeded');
  expect(primary.resolve(map.id).source.hash).toBe(fixed.sourceHash);
  expect(primary.resolve(map.id).preview?.state).toBe('ready');
  expect(primary.resolve(map.id).preview?.renderHash).toBe(fixed.renderHash);
});
it('rejects an inbound ordinary document changed between native enumeration and the fixed organization manifest', async () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const org = organizationService(f.config, f.db, f.notes);
  cleanup.push(() => org.close());
  const target = f.create('Topic/a.md', '# A');
  f.create('00-Inbox/incoming.md', '# Original\n[Link](../Topic/a.md)');
  const context = org.context(f.p),
    prepare = f.db.prepare.bind(f.db);
  let reads = 0;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT id,path FROM notes WHERE active=1 ORDER BY path') {
      const all = statement.all.bind(statement);
      statement.all = ((...args: any[]) => {
        reads++;
        if (reads === 2)
          writeFileSync(
            join(f.config.knowledgeRoot, '00-Inbox/incoming.md'),
            '# User edit\n[Link](../Topic/a.md)',
          );
        return all(...args);
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  const { prepareOrganization } = await import('../packages/core/organization/plan');
  try {
    expect(() =>
      prepareOrganization(
        f.config,
        f.db,
        f.p,
        {
          requestId: randomUUID(),
          libraryId: context.libraryId,
          expectedStructureRevision: context.structureRevision,
          actions: [
            {
              type: 'move_note',
              ...target,
              toDirectoryId: f.directory('Topic').id,
              fileName: 'renamed.md',
            },
          ],
        },
        randomUUID(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  } finally {
    f.db.prepare = prepare;
  }
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/incoming.md'), 'utf8')).toContain(
    '# User edit',
  );
});

it.each(['missing', 'changed'] as const)(
  'organizes an independent legacy dependency while an unrelated published primary source is %s',
  async (state) => {
    const f = fixture();
    // The existing primary points to Topic/target.md, which this operation leaves fixed.
    const original = readFileSync(join(f.config.knowledgeRoot, f.note.relativePath));
    const oldPreview = readFileSync(join(f.config.knowledgeRoot, f.prepared.preview.relativePath));
    const changedSource = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ link: '../../Topic/other.md' }],
    });
    if (state === 'missing')
      unlinkSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath));
    else
      writeFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), changedSource);
    const other = f.create('Topic/other.md', '# Other');
    const legacy = f.create(
      '00-Inbox/other.excalidraw',
      JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'other', type: 'rectangle', link: '../Topic/other.md' }],
      }),
    );
    const context = f.org.context(f.p);
    const submitted = await f.org.submit(f.p, {
      ...context,
      requestId: randomUUID(),
      expectedStructureRevision: context.structureRevision,
      actions: [
        {
          type: 'move_note',
          ...other,
          toDirectoryId: f.directory('Topic').id,
          fileName: 'other-renamed.md',
        },
      ],
    });
    await f.org.drain();
    const pending = f.org.operation(f.p, { operationId: submitted.operation.operationId });
    expect(pending.status, JSON.stringify(pending)).toBe('awaiting_preview');
    expect(pending.previewRequired?.documents.map((need) => need.noteId)).toEqual([legacy.noteId]);
    for (const need of pending.previewRequired!.documents) {
      const fixed = f.registry.get(need.snapshotId);
      f.registry.prepare(fixed.id, {
        sourceHash: fixed.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    }
    await f.org.resume(f.p, { operationId: pending.operationId });
    await f.org.drain();
    const completed = f.org.operation(f.p, { operationId: pending.operationId });
    expect(completed.status, JSON.stringify(completed)).toBe('succeeded');
    expect(f.notes.row(other.noteId).path).toBe('Topic/other-renamed.md');
    expect(JSON.parse(f.notes.getNote(legacy.noteId).content).elements[0].link).toBe(
      '../Topic/other-renamed.md',
    );
    const undo = await f.org.undo(f.p, {
      operationId: pending.operationId,
      requestId: randomUUID(),
    });
    await f.org.drain();
    const reverting = f.org.operation(f.p, { operationId: undo.operation.operationId });
    expect(reverting.status).toBe('awaiting_preview');
    expect(reverting.previewRequired?.documents.map((need) => need.noteId)).toEqual([
      legacy.noteId,
    ]);
    for (const need of reverting.previewRequired!.documents) {
      const fixed = f.registry.get(need.snapshotId);
      f.registry.prepare(fixed.id, {
        sourceHash: fixed.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    }
    await f.org.resume(f.p, { operationId: reverting.operationId });
    await f.org.drain();
    const undone = f.org.operation(f.p, { operationId: reverting.operationId });
    expect(undone.status, JSON.stringify(undone)).toBe('succeeded');
    expect(f.notes.row(other.noteId).path).toBe('Topic/other.md');
    expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath))).toEqual(original);
    expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.preview.relativePath))).toEqual(
      oldPreview,
    );
    if (state === 'changed')
      expect(
        readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8'),
      ).toBe(changedSource);
    else
      expect(existsSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath))).toBe(false);
    const quarantined = primaryDiagramService(
      f.config,
      f.db,
      f.notes,
      assetService(f.config, f.db, f.notes),
      f.p,
    ).resolve(f.note.id);
    expect(quarantined).toMatchObject({
      preview: { hash: f.prepared.previewHash, state: 'stale' },
      capabilities: { canEdit: false },
    });
  },
);
it.each(['target', 'main', 'source', 'unproven'] as const)(
  'rejects a missing primary source before activation when its %s context cannot be proved unaffected',
  (context) => {
    const f = fixture();
    unlinkSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath));
    if (context === 'unproven') {
      const versions = f.db
        .prepare('SELECT rowid,manifest FROM diagram_document_versions WHERE note_id=?')
        .all(f.note.id) as { rowid: number; manifest: string }[];
      for (const row of versions) {
        const manifest = JSON.parse(row.manifest);
        delete manifest.nativeLinks;
        f.db
          .prepare('UPDATE diagram_document_versions SET manifest=? WHERE rowid=?')
          .run(JSON.stringify(manifest), row.rowid);
      }
    }
    const moves =
      context === 'main'
        ? [{ from: f.note.relativePath, to: 'Topic/moved-board.md' }]
        : context === 'source'
          ? [{ from: f.prepared.source!.relativePath, to: 'Topic/assets/moved.excalidraw' }]
          : [
              {
                from: context === 'target' ? 'Topic/target.md' : 'Topic/other.md',
                to: 'Topic/renamed.md',
              },
            ];
    expect(() => collectNativeLinkChanges(f.config, f.db, f.p, moves)).toThrowError(
      expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }),
    );
    expect(f.notes.row(f.target.noteId).path).toBe('Topic/target.md');
    expect(f.notes.row(f.note.id).path).toBe(f.note.relativePath);
  },
);
it.each(['unrelated', 'native-inbound', 'unproven', 'markdown-inbound'] as const)(
  'preflights migration with a missing primary source only when its complete proof establishes %s context',
  async (context) => {
    const f = fixture(context === 'native-inbound' ? 'migrating.excalidraw' : 'target.md');
    const legacy = f.create('Topic/migrating.excalidraw', JSON.stringify(emptyWhiteboard()));
    if (context === 'markdown-inbound') {
      const before = f.notes.getNote(f.note.id);
      f.notes.saveNote(
        f.note.id,
        before.content + '\n[Migration](../Topic/migrating.excalidraw)\n',
        before.modifiedAt,
        randomUUID(),
      );
    }
    if (context === 'unproven') {
      const row = f.db
        .prepare('SELECT rowid,manifest FROM diagram_document_versions WHERE note_id=?')
        .get(f.note.id) as { rowid: number; manifest: string };
      const manifest = JSON.parse(row.manifest);
      delete manifest.nativeLinks;
      f.db
        .prepare('UPDATE diagram_document_versions SET manifest=? WHERE rowid=?')
        .run(JSON.stringify(manifest), row.rowid);
    }
    const original = readFileSync(join(f.config.knowledgeRoot, f.note.relativePath));
    const oldPreview = readFileSync(join(f.config.knowledgeRoot, f.prepared.preview.relativePath));
    unlinkSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath));
    const { whiteboardMigrationService } =
      await import('../packages/core/knowledge/whiteboard-migrations');
    const service = whiteboardMigrationService(
      f.config,
      f.db,
      f.notes,
      assetService(f.config, f.db, f.notes),
      f.p,
    );
    const preflight = service.preflight(legacy.noteId);
    if (context !== 'unrelated') {
      expect(preflight.issues).toContainEqual({
        code: 'INBOUND_SCAN_INCOMPLETE',
        path: f.note.relativePath,
      });
      expect(() => service.plan({ noteId: legacy.noteId, requestId: randomUUID() })).toThrow();
      expect(f.notes.row(legacy.noteId).path).toBe('Topic/migrating.excalidraw');
    } else {
      expect(preflight.issues).toEqual([]);
      const planned = service.plan({ noteId: legacy.noteId, requestId: randomUUID() });
      const prepared = service.prepare({
        migrationId: planned.id,
        sourceHash: planned.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
      const result = service.commit({ migrationId: prepared.id, requestId: randomUUID() });
      expect(result.noteId).toBe(legacy.noteId);
      expect(f.notes.row(legacy.noteId).path).toBe('Topic/migrating.md');
    }
    expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath))).toEqual(original);
    expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.preview.relativePath))).toEqual(
      oldPreview,
    );
  },
);

it('records every native link token, including duplicate JSON keys, in the complete source proof', async () => {
  const { captureNativeLinkProof, nativeLinkProofUnaffected } =
    await import('../packages/core/knowledge/native-link-proof');
  const sourcePath = '00-Inbox/assets/board.excalidraw';
  const source =
    '{"elements":[{"link":"../../Topic/target.md","link":"https://example.com"}],"elements":[{"link":"../../Topic/other.md"}],"future":{"link":"ignored.md"}}';
  const proof = captureNativeLinkProof(sourcePath, sha256(source), source);
  expect(proof.links).toEqual([
    '../../Topic/target.md',
    'https://example.com',
    '../../Topic/other.md',
  ]);
  expect(
    nativeLinkProofUnaffected(proof, sourcePath, sha256(source), [
      { from: 'Topic/target.md', to: 'Topic/renamed.md' },
    ]),
  ).toBe(false);
  expect(
    nativeLinkProofUnaffected(proof, sourcePath, sha256(source), [
      { from: 'Topic/unrelated.md', to: 'Topic/renamed.md' },
    ]),
  ).toBe(true);
  expect(nativeLinkProofUnaffected(proof, sourcePath, '0'.repeat(64), [])).toBe(false);
  expect(() => captureNativeLinkProof(sourcePath, '0'.repeat(64), source)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }),
  );
});

it.each([
  ['URI path', '[Target](../Topic/a%20b.md#section)', '[Target](../Topic/renamed.md#section)'],
  ['image', '![Target](../Topic/a%20b.md)', '![Target](../Topic/renamed.md)'],
  ['reference definition', '[Target][ref]\n\n[ref]: ../Topic/a%20b.md', '[Target][ref]\n\n[ref]: ../Topic/renamed.md'],
  ['wiki', '[[../Topic/a b.md|Keep label]]', '[[../Topic/renamed.md|Keep label]]'],
])('keeps generic native enumeration active for ordinary %s syntax', (_kind, before, after) => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  f.create('Topic/a b.md', '# Target');
  const path = '00-Inbox/reference.md', note = f.create(path, before);
  const result = collectNativeLinkChanges(f.config, f.db, f.p,
    [{ from: 'Topic/a b.md', to: 'Topic/renamed.md' }],
    { notes: [{ id: note.noteId, path }] });
  expect(result.needs).toEqual([]);
  expect(result.rewrites.get(note.noteId)?.content).toBe(after);
  expect(readFileSync(join(f.config.knowledgeRoot, path), 'utf8')).toBe(before);
});
it('keeps syntax-free original bytes and stable linkified identity URLs unchanged during native enumeration', () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const target = f.create('Topic/target.md', '# Target');
  const content = '\ufeff原始正文\r\n' + f.config.origin + '/?note=' + target.noteId + '\r\n';
  const path = '00-Inbox/plain.md', note = f.create(path, content);
  const original = readFileSync(join(f.config.knowledgeRoot, path));
  const result = collectNativeLinkChanges(f.config, f.db, f.p,
    [{ from: 'Topic/target.md', to: 'Topic/renamed.md' }],
    { notes: [{ id: note.noteId, path }] });
  expect(result.needs).toEqual([]);
  expect(result.rewrites.size).toBe(0);
  expect(readFileSync(join(f.config.knowledgeRoot, path))).toEqual(original);
});
it.each([
  ['invalid UTF-8', () => Buffer.from([0xff]), 'INVALID_UTF8'],
  ['oversized text', () => Buffer.alloc(20 * 1024 * 1024 + 1, 97), 'FILE_TOO_LARGE'],
] as const)('still rejects %s before the syntax-free native fastpath', (_kind, bytes, code) => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  f.create('Topic/target.md', '# Target');
  const path = '00-Inbox/plain.md', note = f.create(path, 'Initial');
  writeFileSync(join(f.config.knowledgeRoot, path), bytes());
  expect(() => collectNativeLinkChanges(f.config, f.db, f.p,
    [{ from: 'Topic/target.md', to: 'Topic/renamed.md' }],
    { notes: [{ id: note.noteId, path }] })).toThrowError(expect.objectContaining({ code }));
});
