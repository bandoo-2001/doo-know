import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { organizationService } from '../packages/core/organization/service';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { emptyWhiteboard } from '../shared/whiteboard';
import { mutationCore } from '../packages/core/knowledge/core';
import { sha256 } from '../packages/core/knowledge/operations';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
async function archived(self = false, relocate = true) {
  const f = organizationFixture();
  const org = organizationService(f.config, f.db, f.notes);
  cleanup.push(async () => {
    await org.close();
    f.close();
  });
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p),
    core = mutationCore(f.config, f.db);
  const target = f.create('Topic/target.md', '# Target');
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: '00-Inbox/board.md',
    type: 'whiteboard',
    requestId: randomUUID(),
  });
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [
      { id: 'a', type: 'rectangle', link: '../../Topic/target.md' },
      ...(self ? [{ id: 'self', type: 'rectangle', link: '../board.md' }] : []),
    ],
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
  const file = join(f.config.knowledgeRoot, note.relativePath),
    original = readFileSync(file, 'utf8');
  core.archive(f.p, note.id, statSync(file, { bigint: true }).mtimeNs.toString(), randomUUID());
  if (relocate) {
    const context = org.context(f.p),
      job = await org.submit(f.p, {
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
    expect(org.operation(f.p, { operationId: job.operation.operationId }).status).toBe('succeeded');
  }
  return {
    ...f,
    org,
    assets,
    core,
    note,
    source,
    prepared,
    original,
    file,
    registry: diagramOperationPreviewRegistry(f.config, f.db, f.p, assets),
  };
}
it('restores an archived primary using its captured target UUID and a newly prepared final native source', async () => {
  const f = await archived(),
    requestId = randomUUID();
  let details: any;
  try {
    f.core.restore(f.p, f.note.id, undefined, requestId);
  } catch (e: any) {
    expect(e.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
    details = e.details;
  }
  expect(details?.documents).toHaveLength(1);
  expect(existsSync(f.file)).toBe(false);
  const snapshot = f.registry.get(details.documents[0].snapshotId);
  expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/renamed.md');
  f.registry.prepare(snapshot.id, {
    sourceHash: snapshot.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  const restored = f.core.restore(f.p, f.note.id, undefined, requestId);
  expect(restored).toMatchObject({ id: f.note.id, restored: true });
  const parsed = parseDiagramDocument(readFileSync(f.file, 'utf8'));
  expect(parsed.status).toBe('diagram');
  if (parsed.status === 'diagram')
    expect(parsed.primary.binding.sourceHash).toBe(snapshot.sourceHash);
  expect(readFileSync(join(f.config.knowledgeRoot, f.prepared.source!.relativePath), 'utf8')).toBe(
    f.source,
  );
  expect(f.core.restore(f.p, f.note.id, undefined, requestId)).toEqual(restored);
});
async function prepare(
  f: Awaited<ReturnType<typeof archived>>,
  requestId: string,
  fileName?: string,
) {
  let details: any;
  try {
    f.core.restore(f.p, f.note.id, fileName, requestId);
  } catch (e: any) {
    expect(e.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
    details = e.details;
  }
  expect(details?.documents.length).toBeGreaterThan(0);
  return details.documents.map((need: any) => {
    const snapshot = f.registry.get(need.snapshotId);
    const prepared = f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
    return { snapshot, prepared };
  });
}
it('uses the optional restore filename without changing the UUID or native payload format', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId, 'renamed-board.md');
  expect(f.core.restore(f.p, f.note.id, 'renamed-board.md', requestId)).toMatchObject({
    id: f.note.id,
    relativePath: '00-Inbox/renamed-board.md',
  });
  expect(
    parseDiagramDocument(
      readFileSync(join(f.config.knowledgeRoot, '00-Inbox/renamed-board.md'), 'utf8'),
    ).status,
  ).toBe('diagram');
});
for (const artifact of ['source', 'preview'] as const)
  it('preserves the original trash bytes when prepared ' + artifact + ' is tampered', async () => {
    const f = await archived(),
      requestId = randomUUID(),
      [{ snapshot }] = await prepare(f, requestId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(f.config.dataRoot, 'diagram-operation-previews', snapshot.id, artifact),
      'tampered',
    );
    expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
    expect(existsSync(f.file)).toBe(false);
    expect(
      readFileSync(
        join(f.config.knowledgeRoot, '90-Archive/.trash', f.note.id, 'board.md'),
        'utf8',
      ),
    ).toBe(f.original);
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({
      active: 0,
    });
  });
it('denies a revoked current grant when the caller retains its old write ceiling', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  f.config.agent!.policies = [{ ...f.p, scopes: ['knowledge:read'] }];
  expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  expect(existsSync(f.file)).toBe(false);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});
it('preserves trash if an occupied destination appears after preview preparation', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(f.file, 'external');
  expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  expect(readFileSync(f.file, 'utf8')).toBe('external');
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});
it('rejects a missing preparation receipt rather than trusting surviving source and PNG bytes', async () => {
  const f = await archived(),
    requestId = randomUUID(),
    [{ prepared }] = await prepare(f, requestId);
  f.db.prepare('DELETE FROM diagram_prepared_primaries WHERE id=?').run(prepared.id);
  expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  expect(existsSync(f.file)).toBe(false);
});
it('rewrites raw legacy JSON in its existing format and refuses a .md filename', async () => {
  const f = organizationFixture(),
    org = organizationService(f.config, f.db, f.notes);
  cleanup.push(async () => {
    await org.close();
    f.close();
  });
  const target = f.create('Topic/target.md', '# Target'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../Topic/target.md' }],
    }),
    note = f.create('00-Inbox/legacy.excalidraw', source),
    core = mutationCore(f.config, f.db);
  core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
  const context = org.context(f.p),
    job = await org.submit(f.p, {
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
  expect(org.operation(f.p, { operationId: job.operation.operationId }).status).toBe('succeeded');
  expect(() => core.restore(f.p, note.noteId, 'legacy.md', randomUUID())).toThrowError();
  const requestId = randomUUID();
  let need: any;
  try {
    core.restore(f.p, note.noteId, 'renamed.excalidraw', requestId);
  } catch (e: any) {
    need = e.details.documents[0];
  }
  const registry = diagramOperationPreviewRegistry(
      f.config,
      f.db,
      f.p,
      assetService(f.config, f.db, f.notes),
    ),
    snapshot = registry.get(need.snapshotId);
  expect(JSON.parse(snapshot.source).elements[0].link).toBe('../Topic/renamed.md');
  registry.prepare(snapshot.id, {
    sourceHash: snapshot.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  core.restore(f.p, note.noteId, 'renamed.excalidraw', requestId);
  const restored = JSON.parse(
    readFileSync(join(f.config.knowledgeRoot, '00-Inbox/renamed.excalidraw'), 'utf8'),
  );
  expect(restored.elements[0].link).toBe('../Topic/renamed.md');
});
for (const stage of [
  'asset_copy',
  'asset_link',
  'main_link',
  'activate',
  'trash_unlink',
  'complete',
])
  it(
    'replays the same authorized restore journal after a real child exits at ' + stage,
    async () => {
      const f = await archived(),
        requestId = randomUUID(),
        [{ snapshot }] = await prepare(f, requestId);
      const { spawnSync } = await import('node:child_process');
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'tests/support/note-trash-restore-child.ts',
          JSON.stringify(f.config),
          f.note.id,
          requestId,
          stage,
        ],
        { encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(92);
      await f.core.recover();
      expect(f.db.prepare('SELECT id,active FROM notes WHERE id=?').get(f.note.id)).toEqual({
        id: f.note.id,
        active: 1,
      });
      const parsed = parseDiagramDocument(readFileSync(f.file, 'utf8'));
      expect(parsed.status).toBe('diagram');
      if (parsed.status === 'diagram')
        expect(parsed.primary.binding.sourceHash).toBe(snapshot.sourceHash);
      expect(f.core.restore(f.p, f.note.id, undefined, requestId)).toMatchObject({
        id: f.note.id,
        restored: true,
      });
    },
  );
it('never recovers an intent which crashed before the authorized durable marker', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/note-trash-restore-child.ts',
      JSON.stringify(f.config),
      f.note.id,
      requestId,
      'unauthorized_intent',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(92);
  await f.core.recover();
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
  expect(existsSync(f.file)).toBe(false);
  expect(
    readFileSync(join(f.config.knowledgeRoot, '90-Archive/.trash', f.note.id, 'board.md'), 'utf8'),
  ).toBe(f.original);
});
it('restores an outside copy after moving its source folder while retained historic assets keep their original anchor', async () => {
  const f = organizationFixture(),
    org = organizationService(f.config, f.db, f.notes);
  cleanup.push(async () => {
    await org.close();
    f.close();
  });
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p),
    core = mutationCore(f.config, f.db),
    registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets);
  f.create('Topic/target.md', '# Target');
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
      path: 'Topic/board.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../target.md' }],
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
  const original = primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: 'Board', source }),
    requestId: randomUUID(),
  });
  const { documentCopyService } = await import('../packages/core/knowledge/document-copy');
  const copied = documentCopyService(f.config, f.db, f.notes, assets, f.p).copy(original.id, {
    folderPath: '00-Inbox',
    fileName: 'copied.md',
    expectedModifiedAt: original.modifiedAt,
    expectedContentHash: sha256(original.content),
    requestId: randomUUID(),
  });
  expect(f.notes.getNote(copied.id).content).toContain('../Topic/_doo-assets/');
  core.archive(f.p, copied.id, copied.modifiedAt, randomUUID());
  const context = org.context(f.p),
    folder = f.directory('Topic'),
    job = await org.submit(f.p, {
      ...context,
      requestId: randomUUID(),
      expectedStructureRevision: context.structureRevision,
      actions: [
        {
          type: 'move_directory',
          directoryId: folder.id,
          toDirectoryId: f.directory('00-Inbox').id,
          name: 'NewTopic',
          expectedSubtreeRevision: folder.subtreeRevision,
        },
      ],
    });
  await org.drain();
  let operation = org.operation(f.p, { operationId: job.operation.operationId });
  if (operation.status === 'awaiting_preview') {
    for (const need of operation.previewRequired!.documents) {
      const snapshot = registry.get(need.snapshotId);
      registry.prepare(snapshot.id, {
        sourceHash: snapshot.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    }
    await org.resume(f.p, { operationId: operation.operationId });
    await org.drain();
    operation = org.operation(f.p, { operationId: operation.operationId });
  }
  expect(operation.status, JSON.stringify(operation)).toBe('succeeded');
  expect(readFileSync(join(f.config.knowledgeRoot, prepared.source!.relativePath), 'utf8')).toBe(
    source,
  );
  const requestId = randomUUID();
  let need: any;
  try {
    core.restore(f.p, copied.id, undefined, requestId);
  } catch (e: any) {
    expect(e.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
    need = e.details.documents[0];
  }
  expect(need).toBeDefined();
  const fixed = registry.get(need.snapshotId);
  expect(JSON.parse(fixed.source).elements[0].link).toBe('../NewTopic/target.md');
  registry.prepare(fixed.id, {
    sourceHash: fixed.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  expect(core.restore(f.p, copied.id, undefined, requestId)).toMatchObject({
    id: copied.id,
    restored: true,
  });
  expect(primary.resolve(copied.id).source.hash).toBe(fixed.sourceHash);
  expect(primary.resolve(copied.id).preview?.state).toBe('ready');
  expect(readFileSync(join(f.config.knowledgeRoot, prepared.source!.relativePath), 'utf8')).toBe(
    source,
  );
});
for (const bound of [true, false])
  it(
    'restores ordinary prose and ' +
      (bound ? 'bound' : 'unbound v1') +
      ' native pairs with matching final preview',
    async () => {
      const f = organizationFixture(),
        org = organizationService(f.config, f.db, f.notes);
      cleanup.push(async () => {
        await org.close();
        f.close();
      });
      const assets = assetService(f.config, f.db, f.notes),
        core = mutationCore(f.config, f.db),
        target = f.create('Topic/target.md', '# Target'),
        note = f.create('00-Inbox/group.md', '# Group');
      const { diagramArtifactService } =
        await import('../packages/core/knowledge/diagram-artifacts');
      const { serializeDiagramBinding } = await import('../shared/diagram-binding');
      const { normalizeDiagramCode, boundDiagramSources } =
        await import('../shared/diagram-portability');
      const { renderPortableFigure } = await import('../shared/portable-figure');
      const source = JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'a', type: 'rectangle', link: '../../Topic/target.md' }],
      });
      const pair = diagramArtifactService(f.db, f.notes, assets, f.p).prepare(note.noteId, {
        kind: 'excalidraw',
        source,
        sourceHash: sha256(source),
        pngBase64: png,
        requestId: randomUUID(),
      });
      const figure = renderPortableFigure({
        alt: 'EXCALIDRAW 预览',
        previewPath: pair.preview.markdownPath,
        source: { type: 'file', path: pair.source.markdownPath },
      });
      const content =
        '# Group\n\n[Prose](../Topic/target.md#part)\n\n' +
        figure +
        (bound
          ? '\n' +
            serializeDiagramBinding({
              kind: 'excalidraw',
              sourceHash: pair.sourceHash,
              codeHash: sha256(normalizeDiagramCode(pair.source.markdownPath)),
            }) +
            '\n\n```excalidraw\n' +
            pair.source.markdownPath +
            '\n```\n'
          : '');
      expect(boundDiagramSources(content)).toHaveLength(bound ? 1 : 0);
      core.update(f.p, note.noteId, content, note.expectedModifiedAt, randomUUID());
      const file = join(f.config.knowledgeRoot, '00-Inbox/group.md');
      core.archive(
        f.p,
        note.noteId,
        statSync(file, { bigint: true }).mtimeNs.toString(),
        randomUUID(),
      );
      const context = org.context(f.p),
        job = await org.submit(f.p, {
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
      expect(org.operation(f.p, { operationId: job.operation.operationId }).status).toBe(
        'succeeded',
      );
      const registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets),
        requestId = randomUUID();
      let need: any;
      try {
        core.restore(f.p, note.noteId, undefined, requestId);
      } catch (e: any) {
        expect(e.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
        need = e.details.documents[0];
      }
      expect(need.role).toBe('embedded');
      const snapshot = registry.get(need.snapshotId),
        prepared = registry.prepare(snapshot.id, {
          sourceHash: snapshot.sourceHash,
          pngBase64: png,
          requestId: randomUUID(),
        });
      core.restore(f.p, note.noteId, undefined, requestId);
      const restored = readFileSync(file, 'utf8');
      expect(restored).toContain('../Topic/renamed.md#part');
      expect(restored).toContain(prepared.preview.markdownPath);
      expect(
        JSON.parse(
          readFileSync(join(f.config.knowledgeRoot, prepared.source!.relativePath), 'utf8'),
        ).elements[0].link,
      ).toBe('../../Topic/renamed.md');
      if (bound)
        expect(boundDiagramSources(restored)[0].binding.sourceHash).toBe(snapshot.sourceHash);
      expect(readFileSync(join(f.config.knowledgeRoot, pair.source.relativePath), 'utf8')).toBe(
        source,
      );
    },
  );
it('rechecks current grants after after-image preparation and before the durable commit marker', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  const original = f.db.prepare.bind(f.db);
  let revoked = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql),
      run = statement.run.bind(statement);
    statement.run = ((...args: any[]) => {
      const result = run(...args);
      if (!revoked && sql.startsWith('INSERT INTO note_trash_restore_plans')) {
        revoked = true;
        f.config.agent!.policies = [{ ...f.p, scopes: ['knowledge:read'] }];
      }
      return result;
    }) as any;
    return statement;
  }) as any;
  try {
    expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  } finally {
    f.db.prepare = original;
  }
  expect(revoked).toBe(true);
  expect(
    f.db
      .prepare("SELECT status FROM operations WHERE kind='restore' AND request_id=?")
      .get(requestId),
  ).toEqual({ status: 'failed' });
  expect(existsSync(f.file)).toBe(false);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});
for (const conflict of ['published_source', 'lost_receipt', 'main_mtime'])
  it('preserves original trash after a committing journal conflicts on ' + conflict, async () => {
    const f = await archived(),
      requestId = randomUUID(),
      [{ prepared }] = await prepare(f, requestId),
      { spawnSync } = await import('node:child_process');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/support/note-trash-restore-child.ts',
        JSON.stringify(f.config),
        f.note.id,
        requestId,
        conflict === 'main_mtime' ? 'main_link' : 'asset_link',
      ],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(92);
    const { writeFileSync, utimesSync } = await import('node:fs');
    if (conflict === 'published_source')
      writeFileSync(join(f.config.knowledgeRoot, prepared.source!.relativePath), 'external edit');
    else if (conflict === 'lost_receipt')
      f.db.prepare('DELETE FROM diagram_prepared_primaries WHERE id=?').run(prepared.id);
    else utimesSync(f.file, new Date(10000), new Date(10000));
    const report = await f.core.recover();
    expect(report.conflicted).toBe(1);
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({
      active: 0,
    });
    expect(
      readFileSync(
        join(f.config.knowledgeRoot, '90-Archive/.trash', f.note.id, 'board.md'),
        'utf8',
      ),
    ).toBe(f.original);
  });
it('backfills an old archive only from the exact published hash and recorded target identity', async () => {
  const f = await archived(),
    requestId = randomUUID();
  f.db.prepare('DELETE FROM note_archive_contexts WHERE note_id=?').run(f.note.id);
  f.db
    .prepare("UPDATE write_intents SET original_hash=NULL WHERE note_id=? AND kind='archive'")
    .run(f.note.id);
  f.create('Topic/target.md', '# Unrelated replacement');
  const [{ snapshot }] = await prepare(f, requestId);
  expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/renamed.md');
  expect(f.core.restore(f.p, f.note.id, undefined, requestId)).toMatchObject({ restored: true });
});
it('archives and restores unchanged ordinary files above 20MB using the existing streaming path', async () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const core = mutationCore(f.config, f.db),
    content = '# Large\n' + 'x'.repeat(21 * 1024 * 1024),
    note = f.create('00-Inbox/large.md', content);
  core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
  const requestId = randomUUID(),
    result = core.restore(f.p, note.noteId, undefined, requestId);
  expect(result).toMatchObject({ id: note.noteId, restored: true, contentHash: sha256(content) });
  expect(core.restore(f.p, note.noteId, undefined, requestId)).toEqual(result);
});

it('maps the inactive archived UUID to its requested filename for native self-links', async () => {
  const f = await archived(true),
    requestId = randomUUID(),
    [{ snapshot }] = await prepare(f, requestId, 'renamed-board.md');
  expect(JSON.parse(snapshot.source).elements[1].link).toBe('../renamed-board.md');
  expect(f.core.restore(f.p, f.note.id, 'renamed-board.md', requestId)).toMatchObject({
    id: f.note.id,
    relativePath: '00-Inbox/renamed-board.md',
  });
});
it('rebases a captured ordinary self-link when the restore filename changes', async () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const core = mutationCore(f.config, f.db),
    note = f.create('00-Inbox/self.md', '# Self\n\n[Self](self.md#part)\n');
  core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
  expect(core.restore(f.p, note.noteId, 'new-self.md', randomUUID())).toMatchObject({
    id: note.noteId,
    relativePath: '00-Inbox/new-self.md',
  });
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/new-self.md'), 'utf8')).toContain(
    '(new-self.md#part)',
  );
});
it('rechecks root identity after preparing bytes and before recording the authorized marker', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  const original = f.db.prepare.bind(f.db),
    root = f.config.knowledgeRoot,
    { mkdirSync } = await import('node:fs');
  let changed = false;
  const replacement = join(f.root, 'replacement-root');
  mkdirSync(replacement);
  f.db.prepare = ((sql: string) => {
    const statement = original(sql),
      run = statement.run.bind(statement);
    statement.run = ((...args: any[]) => {
      const result = run(...args);
      if (!changed && sql.startsWith('INSERT INTO note_trash_restore_plans')) {
        changed = true;
        f.config.knowledgeRoot = replacement;
      }
      return result;
    }) as any;
    return statement;
  }) as any;
  try {
    expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  } finally {
    f.db.prepare = original;
    f.config.knowledgeRoot = root;
  }
  expect(changed).toBe(true);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
  expect(existsSync(f.file)).toBe(false);
});
it('rejects backup of an authorized committing note journal until recovery completes', async () => {
  const f = await archived(),
    requestId = randomUUID();
  await prepare(f, requestId);
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/note-trash-restore-child.ts',
      JSON.stringify(f.config),
      f.note.id,
      requestId,
      'asset_copy',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(92);
  const { backup } = await import('../apps/server/backup');
  await expect(backup(f.config, join(f.root, 'pending-backup'))).rejects.toThrow(
    '笔记恢复尚未恢复一致',
  );
  await f.core.recover();
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 1 });
});
it('restores an archived note from a verified backup at new host paths using retained identity evidence', async () => {
  const f = await archived(),
    { backup, restore } = await import('../apps/server/backup');
  const destination = join(f.root, 'backup');
  await backup(f.config, destination);
  const config = {
    ...f.config,
    knowledgeRoot: join(f.root, 'restored-knowledge'),
    dataRoot: join(f.root, 'restored-data'),
  };
  await restore(destination, config);
  const { openDatabase } = await import('../packages/core/db'),
    { noteService } = await import('../packages/core/notes'),
    { webPrincipal } = await import('../packages/core/knowledge/core');
  const db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db),
      assets = assetService(config, db, notes),
      core = mutationCore(config, db),
      p = { ...webPrincipal, allowedPrefixes: ['00-Inbox', 'Topic'] },
      registry = diagramOperationPreviewRegistry(config, db, p, assets),
      requestId = randomUUID();
    let need: any;
    try {
      core.restore(p, f.note.id, undefined, requestId);
    } catch (e: any) {
      expect(e.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
      need = e.details.documents[0];
    }
    const snapshot = registry.get(need.snapshotId);
    expect(JSON.parse(snapshot.source).elements[0].link).toBe('../../Topic/renamed.md');
    registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
    expect(core.restore(p, f.note.id, undefined, requestId)).toMatchObject({
      id: f.note.id,
      restored: true,
    });
    expect(existsSync(join(config.knowledgeRoot, '00-Inbox/board.md'))).toBe(true);
  } finally {
    db.close();
  }
});

for (const primary of [true, false])
  it(
    'rechecks current policy after unchanged ' +
      (primary ? 'primary' : 'ordinary') +
      ' restore intent insertion',
    async () => {
      const f = primary
        ? await archived(false, false)
        : (() => {
            const f = organizationFixture();
            cleanup.push(async () => f.close());
            const note = f.create('00-Inbox/plain.md', '# Plain'),
              core = mutationCore(f.config, f.db);
            core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
            return {
              ...f,
              core,
              note: { id: note.noteId },
              file: join(f.config.knowledgeRoot, '00-Inbox/plain.md'),
            };
          })();
      const original = f.db.prepare.bind(f.db);
      let revoked = false;
      f.db.prepare = ((sql: string) => {
        const statement = original(sql),
          run = statement.run.bind(statement);
        statement.run = ((...args: any[]) => {
          const result = run(...args);
          if (!revoked && sql.startsWith('INSERT INTO write_intents')) {
            revoked = true;
            f.config.agent!.policies = [{ ...f.p, scopes: ['knowledge:read'] }];
          }
          return result;
        }) as any;
        return statement;
      }) as any;
      try {
        expect(() => f.core.restore(f.p, f.note.id, undefined, randomUUID())).toThrowError();
      } finally {
        f.db.prepare = original;
      }
      expect(revoked).toBe(true);
      expect(existsSync(f.file)).toBe(false);
      expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({
        active: 0,
      });
    },
  );
for (const change of ['mode', 'inode'])
  it(
    'rejects a ' +
      change +
      ' change to an owned temporary asset after copy but before publication evidence',
    async () => {
      const f = await archived(),
        requestId = randomUUID(),
        [{ prepared }] = await prepare(f, requestId),
        { spawnSync } = await import('node:child_process');
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'tests/support/note-trash-restore-child.ts',
          JSON.stringify(f.config),
          f.note.id,
          requestId,
          'asset_copy',
        ],
        { encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(92);
      const { readdirSync, chmodSync, writeFileSync, renameSync } = await import('node:fs'),
        parent = join(f.config.knowledgeRoot, '00-Inbox/_doo-assets'),
        temp = join(
          parent,
          readdirSync(parent).find((name) => name.startsWith('.doo-note-restore-'))!,
        );
      if (change === 'mode') chmodSync(temp, 0o644);
      else {
        const replacement = temp + '.replacement';
        writeFileSync(replacement, readFileSync(temp), { mode: 0o600 });
        renameSync(replacement, temp);
      }
      const report = await f.core.recover();
      expect(report.conflicted).toBe(1);
      expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({
        active: 0,
      });
      expect(existsSync(join(f.config.knowledgeRoot, prepared.source!.relativePath))).toBe(false);
      expect(
        readFileSync(
          join(f.config.knowledgeRoot, '90-Archive/.trash', f.note.id, 'board.md'),
          'utf8',
        ),
      ).toBe(f.original);
    },
  );
it('renames an unchanged archived reference-free ordinary file above 20MB without loading or rewriting its body', async () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const core = mutationCore(f.config, f.db),
    content = '# Large\n' + 'x'.repeat(21 * 1024 * 1024),
    note = f.create('00-Inbox/large.md', content);
  core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
  const result = core.restore(f.p, note.noteId, 'renamed-large.md', randomUUID());
  expect(result).toMatchObject({
    id: note.noteId,
    relativePath: '00-Inbox/renamed-large.md',
    contentHash: sha256(content),
  });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/large.md'))).toBe(false);
});
it('never activates an unchanged ordinary intent that crashed before the final authorization marker', async () => {
  const f = organizationFixture();
  cleanup.push(async () => f.close());
  const core = mutationCore(f.config, f.db),
    note = f.create('00-Inbox/plain.md', '# Plain'),
    requestId = randomUUID();
  core.archive(f.p, note.noteId, note.expectedModifiedAt, randomUUID());
  const { spawnSync } = await import('node:child_process'),
    child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/support/note-trash-restore-child.ts',
        JSON.stringify(f.config),
        note.noteId,
        requestId,
        'unauthorized_intent',
      ],
      { encoding: 'utf8' },
    );
  expect(child.status, child.stderr).toBe(92);
  expect((await core.recover()).conflicted).toBe(1);
  expect((await core.recover()).recovered).toBe(0);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(note.noteId)).toEqual({
    active: 0,
  });
  expect(
    readFileSync(
      join(f.config.knowledgeRoot, '90-Archive/.trash', note.noteId, 'plain.md'),
      'utf8',
    ),
  ).toBe('# Plain');
});
it('rechecks captured target read rights for an unchanged primary after restore intent insertion', async () => {
  const f = await archived(false, false),
    requestId = randomUUID(),
    original = f.db.prepare.bind(f.db);
  let revoked = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql),
      run = statement.run.bind(statement);
    statement.run = ((...args: any[]) => {
      const result = run(...args);
      if (!revoked && sql.startsWith('INSERT INTO write_intents')) {
        revoked = true;
        f.config.agent!.policies = [{ ...f.p, knowledgeAll: false, allowedPrefixes: ['00-Inbox'] }];
      }
      return result;
    }) as any;
    return statement;
  }) as any;
  try {
    expect(() => f.core.restore(f.p, f.note.id, undefined, requestId)).toThrowError();
  } finally {
    f.db.prepare = original;
  }
  expect(revoked).toBe(true);
  expect(existsSync(f.file)).toBe(false);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
  expect(
    readFileSync(join(f.config.knowledgeRoot, '90-Archive/.trash', f.note.id, 'board.md'), 'utf8'),
  ).toBe(f.original);
  expect((await f.core.recover()).recovered).toBe(0);
  expect((await f.core.recover()).recovered).toBe(0);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});
