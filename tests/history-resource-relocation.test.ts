import { afterEach, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { organizationFixture } from './support/organization-fixture';
import { organizationService } from '../packages/core/organization/service';
import { syncDirectoryCatalog } from '../packages/core/organization/catalog';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { diagramHistoryRestoreService } from '../packages/core/knowledge/diagram-history-restore';
import {
  revisionContext,
  revisionRestoreSource,
} from '../packages/core/knowledge/revision-context';
import { recoveryService } from '../packages/core/recovery';
import { snapshotService } from '../packages/core/knowledge/snapshots';
import { fileJobService } from '../packages/core/knowledge/file-jobs';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
import { diagramArtifactService } from '../packages/core/knowledge/diagram-artifacts';
import { renderPortableFigure } from '../shared/portable-figure';
import {
  serializeDiagramBinding,
  boundDiagramSources,
  normalizeDiagramCode,
} from '../shared/diagram-portability';
import { localReference, references } from '../packages/core/render';
import { webPrincipal } from '../packages/core/knowledge/core';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const f = organizationFixture(),
    org = organizationService(f.config, f.db, f.notes);
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, f.p);
  const registry = diagramOperationPreviewRegistry(f.config, f.db, f.p, assets);
  mkdirSync(join(f.config.knowledgeRoot, 'Topic/Folder/assets'), { recursive: true });
  const target = f.create('Topic/Folder/target.md', '# Target');
  cleanup.push(async () => {
    await org.close();
    f.close();
  });
  async function organize(actions: any[]) {
    const context = org.context(f.p);
    const reply = await org.submit(f.p, {
      libraryId: context.libraryId,
      expectedStructureRevision: context.structureRevision,
      requestId: randomUUID(),
      actions,
    });
    await org.drain();
    let op = org.operation(f.p, { operationId: reply.operation.operationId });
    if (op.status === 'awaiting_preview') {
      for (const need of op.previewRequired!.documents) {
        const snapshot = registry.get(need.snapshotId);
        registry.prepare(snapshot.id, {
          sourceHash: snapshot.sourceHash,
          pngBase64: png,
          requestId: randomUUID(),
        });
      }
      await org.resume(f.p, { operationId: op.operationId });
      await org.drain();
      op = org.operation(f.p, { operationId: op.operationId });
    }
    expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
  }
  async function moveFolder() {
    syncDirectoryCatalog(f.config, f.db);
    const folder = f.directory('Topic/Folder');
    await organize([
      {
        type: 'move_directory',
        directoryId: folder.id,
        toDirectoryId: f.directory('00-Inbox').id,
        name: 'Moved',
        expectedSubtreeRevision: folder.subtreeRevision,
      },
    ]);
    const note = f.notes.getNote(target.noteId);
    await organize([
      {
        type: 'move_note',
        noteId: target.noteId,
        expectedModifiedAt: note.modifiedAt,
        expectedContentHash: sha256(note.content),
        toDirectoryId: f.directory('00-Inbox/Moved').id,
        fileName: 'renamed.md',
      },
    ]);
  }
  return { ...f, org, assets, primary, target, moveFolder, organize, registry };
}
async function diagramFixture() {
  const f = fixture();
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    future: { retain: true },
    elements: [
      { id: 'node', type: 'text', text: 'Version one', link: '../target.md#part' },
      { id: 'self', type: 'text', text: 'Self', link: '../board.md' },
    ],
  });
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: 'Topic/Folder/board.md',
    type: 'whiteboard',
    requestId: randomUUID(),
  });
  const prepare = (source: string, target: any) =>
    f.primary.prepare({
      target,
      type: 'whiteboard',
      source,
      sourceHash: sha256(source),
      title: 'Board',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    });
  const p1 = prepare(source, { kind: 'creation', intentId: intent.id });
  let note = f.primary.commit({
    preparedId: p1.id,
    markdown: renderPreparedDiagramDocument({ prepared: p1, title: 'Board', source }),
    requestId: randomUUID(),
  });
  const image = f.assets.upload(
    note.id,
    'body.png',
    'image/png',
    Buffer.from(png, 'base64'),
    randomUUID(),
  );
  const prose =
    '\nHistorical prose\n\n![body](' +
    image.markdownPath +
    ')\n\n[[target#part|Target *label*]]\n\n`[[target]]`\n';
  note = f.notes.saveNote(note.id, note.content + prose, note.modifiedAt, randomUUID());
  const v1 = note;
  const source2 = source.replace('Version one', 'Version two'),
    p2 = prepare(source2, {
      kind: 'document',
      noteId: note.id,
      expectedDocumentHash: sha256(note.content),
      expectedSourceHash: sha256(source),
    });
  note = f.primary.commit({
    preparedId: p2.id,
    markdown: renderPreparedDiagramDocument({
      prepared: p2,
      title: 'Board',
      source: source2,
      description: 'Later prose',
    }),
    requestId: randomUUID(),
  });
  const revision = (
    f.db
      .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
      .get(note.id) as any
  ).id;
  return { ...f, source, v1, note, revision, p1, image };
}
it.each([false, true, 'untyped'] as const)(
  'restores retained v1 source, prose, attachments, note targets and self links after real folder move and target rename (legacy context %s)',
  async (legacy) => {
    const f = await diagramFixture();
    await f.moveFolder();
    if (legacy) {
      // Reproduce previously recorded manifests that had paths/hashes but no stable asset IDs.
      const row = f.db
        .prepare('SELECT resources_manifest FROM revisions WHERE id=?')
        .get(f.revision) as any;
      f.db
        .prepare('UPDATE revisions SET resources_manifest=?,references_manifest=NULL WHERE id=?')
        .run(
          JSON.stringify(JSON.parse(row.resources_manifest).map(({ assetId, ...r }: any) => r)),
          f.revision,
        );
      if (legacy === 'untyped') {
        f.db
          .prepare('UPDATE revisions SET content_hash=NULL,logical_path=NULL WHERE id=?')
          .run(f.revision);
        f.db
          .prepare('UPDATE write_intents SET revision_id=NULL WHERE revision_id=?')
          .run(f.revision);
      }
    }
    const current = f.notes.getNote(f.note.id),
      history = diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p);
    const plan = history.plan(f.note.id, f.revision, current.modifiedAt, randomUUID());
    expect(
      revisionContext(f.config, f.db, f.note.id, f.revision).resources.find(
        (r) => r.role === 'source',
      )?.assetId,
    ).toBe(f.p1.source!.id);
    expect(JSON.parse(plan.source)).toMatchObject({
      future: { retain: true },
      elements: [{ text: 'Version one', link: '../renamed.md#part' }, { link: '../board.md' }],
    });
    expect(plan.baseMarkdown).toContain('Historical prose');
    expect(plan.baseMarkdown).toContain('[Target \\*label\\*](<renamed.md#part>)');
    expect(plan.baseMarkdown).toContain('`[[target]]`');
    history.prepare(plan.id, {
      sourceHash: plan.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
    const result = history.commit(plan.id, { requestId: randomUUID() });
    expect(result.id).toBe(f.note.id);
    expect(result.content).toContain(f.image.markdownPath);
    expect(f.primary.resolve(result.id)?.source?.content).toBe(plan.source);
    expect(f.primary.resolve(result.id)?.preview?.state).toBe('ready');
  },
);
it('does not reveal the new private path of a historical linked note to a selected-note restore principal', async () => {
  const f = fixture(),
    note = f.notes.createNote('Topic/Folder', 'limited.md', '[Target](target.md)\n');
  f.notes.saveNote(note.id, 'Current prose\n', note.modifiedAt, randomUUID());
  const revision = (
    f.db
      .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
      .get(note.id) as any
  ).id;
  await f.moveFolder();
  const current = f.notes.getNote(note.id),
    limited = { ...f.p, knowledgeAll: false, allowedPrefixes: [current.relativePath] };
  expect(() =>
    revisionRestoreSource(f.config, f.db, note.id, revision, current.relativePath, limited),
  ).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN_REFERENCE', statusCode: 403, details: {} }),
  );
  const snapshots = snapshotService(f.config, f.db, f.notes),
    files = fileJobService(f.config, f.db, f.notes, snapshots);
  cleanup.unshift(async () => {
    await files.close();
    await snapshots.close();
  });
  const requestId = randomUUID();
  await expect(
    files.restore(limited, note.id, revision, current.modifiedAt, requestId),
  ).rejects.toMatchObject({ code: 'FORBIDDEN_REFERENCE', statusCode: 403, details: {} });
  expect(
    f.db.prepare('SELECT id FROM operations WHERE request_id=?').get(requestId),
  ).toBeUndefined();
  expect(f.notes.getNote(note.id).content).toBe(current.content);
});
it.each(['source', 'preview'] as const)(
  'reports a tampered retained %s explicitly after the asset identity moved',
  async (role) => {
    const f = await diagramFixture();
    await f.moveFolder();
    const id = role === 'source' ? f.p1.source!.id : f.p1.preview.id;
    const path = (f.db.prepare('SELECT path FROM assets WHERE id=?').get(id) as any).path;
    writeFileSync(
      join(f.config.knowledgeRoot, path),
      role === 'source' ? f.source + ' ' : 'tampered PNG',
    );
    expect(() =>
      diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p).plan(
        f.note.id,
        f.revision,
        f.notes.getNote(f.note.id).modifiedAt,
        randomUUID(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }));
  },
);
it('refuses old moved resources when neither captured identity nor exact move evidence survived', async () => {
  const f = await diagramFixture();
  await f.moveFolder();
  const row = f.db
    .prepare('SELECT resources_manifest FROM revisions WHERE id=?')
    .get(f.revision) as any;
  f.db
    .prepare('UPDATE revisions SET resources_manifest=?,references_manifest=NULL WHERE id=?')
    .run(
      JSON.stringify(JSON.parse(row.resources_manifest).map(({ assetId, ...rest }: any) => rest)),
      f.revision,
    );
  f.db.prepare('UPDATE organization_jobs SET manifest=NULL').run();
  expect(() =>
    diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p).plan(
      f.note.id,
      f.revision,
      f.notes.getNote(f.note.id).modifiedAt,
      randomUUID(),
    ),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }));
});
it('refuses relative ordinary history when its original logical path has no surviving evidence', () => {
  const f = fixture(),
    note = f.notes.createNote('Topic/Folder', 'unknown.md', '[Target](target.md)\n');
  f.notes.saveNote(note.id, 'Current\n', note.modifiedAt, randomUUID());
  const revision = (
    f.db
      .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
      .get(note.id) as any
  ).id;
  f.db
    .prepare(
      'UPDATE revisions SET logical_path=NULL,content_hash=NULL,references_manifest=NULL WHERE id=?',
    )
    .run(revision);
  f.db.prepare('UPDATE write_intents SET revision_id=NULL WHERE revision_id=?').run(revision);
  expect(() =>
    revisionRestoreSource(f.config, f.db, note.id, revision, '00-Inbox/target.md', f.p),
  ).toThrowError(expect.objectContaining({ code: 'REVISION_PATH_UNKNOWN' }));
});
it('keeps individually moved main files attached to resources left in their original directory', async () => {
  const f = await diagramFixture(),
    current = f.notes.getNote(f.note.id);
  await f.organize([
    {
      type: 'move_note',
      noteId: f.note.id,
      expectedModifiedAt: current.modifiedAt,
      expectedContentHash: sha256(current.content),
      toDirectoryId: f.directory('00-Inbox').id,
      fileName: 'standalone.md',
    },
  ]);
  const plan = diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p).plan(
    f.note.id,
    f.revision,
    f.notes.getNote(f.note.id).modifiedAt,
    randomUUID(),
  );
  expect(plan.baseMarkdown).toContain('../Topic/Folder/' + f.image.markdownPath);
  expect(JSON.parse(plan.source).elements.map((e: any) => e.link)).toEqual([
    '../../Topic/Folder/target.md#part',
    '../standalone.md',
  ]);
});
it('prepares the relocated authoritative mindmap outline while preserving its supported plain-text syntax', async () => {
  const f = fixture(),
    source = '- [[target.md]]\n',
    intent = diagramCreationService(f.config, f.db, f.p).reserve({
      path: 'Topic/Folder/map.md',
      type: 'mindmap',
      requestId: randomUUID(),
    });
  const prepare = (text: string, target: any) =>
    f.primary.prepare({
      target,
      type: 'mindmap',
      source: text,
      sourceHash: sha256(text),
      title: 'Map',
      renderer: diagramRendererVersions.mindmap,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    });
  const p1 = prepare(source, { kind: 'creation', intentId: intent.id }),
    v1 = f.primary.commit({
      preparedId: p1.id,
      markdown: renderPreparedDiagramDocument({
        prepared: p1,
        title: 'Map',
        source,
        description: 'Historical map prose',
      }),
      requestId: randomUUID(),
    });
  const p2 = prepare('- Current\n', {
    kind: 'document',
    noteId: v1.id,
    expectedDocumentHash: sha256(v1.content),
    expectedSourceHash: sha256(source),
  });
  f.primary.commit({
    preparedId: p2.id,
    markdown: renderPreparedDiagramDocument({ prepared: p2, title: 'Map', source: '- Current\n' }),
    requestId: randomUUID(),
  });
  const revision = (
    f.db
      .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
      .get(v1.id) as any
  ).id;
  await f.moveFolder();
  const current = f.notes.getNote(v1.id),
    history = diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p),
    plan = history.plan(v1.id, revision, current.modifiedAt, randomUUID());
  expect(plan.source).toBe('- [[renamed.md]]\n');
  history.prepare(plan.id, {
    sourceHash: plan.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  const result = history.commit(plan.id, { requestId: randomUUID() });
  expect(result.content).toContain('Historical map prose');
  expect(f.primary.resolve(v1.id)?.source?.content).toBe(plan.source);
});
it('prepares native groups in historical diagram prose before creating a primary-history plan receipt', async () => {
  const f = await diagramFixture(),
    initial = f.notes.getNote(f.note.id),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'body', type: 'text', text: 'Historical body', link: '../target.md' }],
    });
  const pair = diagramArtifactService(f.db, f.notes, f.assets, f.p).prepare(initial.id, {
      kind: 'excalidraw',
      source,
      sourceHash: sha256(source),
      pngBase64: png,
      requestId: randomUUID(),
    }),
    code = pair.source.markdownPath;
  const group =
    renderPortableFigure({
      alt: 'EXCALIDRAW 预览',
      previewPath: pair.preview.markdownPath,
      source: { type: 'file', path: code },
    }) +
    '\n' +
    serializeDiagramBinding({
      kind: 'excalidraw',
      sourceHash: pair.sourceHash,
      codeHash: sha256(normalizeDiagramCode(code)),
    }) +
    '\n\n```excalidraw\n' +
    code +
    '\n```\n';
  const withGroup = f.notes.saveNote(
    initial.id,
    initial.content + '\nBody native history\n\n' + group,
    initial.modifiedAt,
    randomUUID(),
  );
  f.notes.saveNote(initial.id, initial.content, withGroup.modifiedAt, randomUUID());
  const revision = (
    f.db
      .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
      .get(initial.id) as any
  ).id;
  await f.moveFolder();
  const current = f.notes.getNote(initial.id),
    history = diagramHistoryRestoreService(f.config, f.db, f.notes, f.assets, f.p),
    requestId = randomUUID();
  let error: any;
  try {
    history.plan(initial.id, revision, current.modifiedAt, requestId);
  } catch (cause) {
    error = cause;
  }
  expect(error).toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
  expect(
    f.db.prepare('SELECT id FROM operations WHERE request_id=?').get(requestId),
  ).toBeUndefined();
  for (const need of error.details.documents) {
    const snapshot = f.registry.get(need.snapshotId);
    f.registry.prepare(snapshot.id, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: randomUUID(),
    });
  }
  const plan = history.plan(initial.id, revision, current.modifiedAt, requestId);
  history.prepare(plan.id, {
    sourceHash: plan.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
  const result = history.commit(plan.id, { requestId: randomUUID() }),
    native = boundDiagramSources(result.content)[0];
  expect(result.content).toContain('Body native history');
  expect(
    JSON.parse(
      f.assets.file(localReference(result.relativePath, native.sourcePath)!).bytes.toString('utf8'),
    ).elements[0].link,
  ).toBe('../renamed.md');
});
it.each([
  [false, false, 'folder-rename'],
  [true, false, 'folder-rename'],
  [false, true, 'folder-rename'],
  [true, true, 'folder-rename'],
  [false, false, 'individual'],
  [true, true, 'individual'],
  [false, false, 'folder'],
] as const)(
  'restores native history through the correct source base (background %s, unbound pair %s, move %s)',
  async (background, unbound, move) => {
    const f = fixture(),
      note = f.notes.createNote('Topic/Folder', 'embedded.md', '# Ordinary\n');
    const source = JSON.stringify({
      ...emptyWhiteboard(),
      future: { retain: true },
      elements: [{ id: 'link', type: 'text', text: 'Old native', link: '../target.md' }],
    });
    const pair = diagramArtifactService(f.db, f.notes, f.assets, f.p).prepare(note.id, {
      kind: 'excalidraw',
      source,
      sourceHash: sha256(source),
      pngBase64: png,
      requestId: randomUUID(),
    });
    const code = pair.source.markdownPath,
      managed =
        renderPortableFigure({
          alt: 'EXCALIDRAW 预览',
          previewPath: pair.preview.markdownPath,
          source: { type: 'file', path: code },
        }) +
        '\n' +
        serializeDiagramBinding({
          kind: 'excalidraw',
          sourceHash: pair.sourceHash,
          codeHash: sha256(normalizeDiagramCode(code)),
        }) +
        '\n\n```excalidraw\n' +
        code +
        '\n```\n',
      group = unbound
        ? renderPortableFigure({
            alt: 'EXCALIDRAW 预览',
            previewPath: pair.preview.markdownPath,
            source: { type: 'file', path: code },
          })
        : managed;
    const original =
      '# Historical\n\n' +
      group +
      '\nPreserve prose and `[[target]]`.\n\n' +
      (background ? 'x'.repeat(2 * 1024 * 1024) : 'Tail');
    f.create('Topic/Folder/embedded.md', original);
    const snapshots = snapshotService(f.config, f.db, f.notes),
      files = fileJobService(f.config, f.db, f.notes, snapshots);
    cleanup.unshift(async () => {
      await files.close();
      await snapshots.close();
    });
    await snapshots.read(f.p, note.id, {}, 'web');
    await snapshots.drain();
    const page = await snapshots.read(f.p, note.id, {}, 'web');
    if (page.kind !== 'ready') throw Error('snapshot');
    const changed = await files.submit(
      f.p,
      note.id,
      {
        snapshotId: page.data.snapshotId,
        expectedModifiedAt: page.data.modifiedAt,
        expectedContentHash: page.data.sourceHash,
        requestId: randomUUID(),
        edits: [{ type: 'replace_text', before: group, after: 'Later prose\n' }],
      },
      'web',
    );
    if (changed.kind !== 'accepted') throw Error('operation');
    await files.drain();
    const updated = files.operation(f.p, changed.operation.operationId);
    expect(updated.status).toBe('succeeded');
    const revision = (
      f.db
        .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
        .get(note.id) as any
    ).id;
    if (move === 'individual') {
      const target = f.notes.getNote(f.target.noteId),
        receipt = updated.result as any;
      await f.organize([
        {
          type: 'move_note',
          noteId: note.id,
          expectedModifiedAt: receipt.modifiedAt,
          expectedContentHash: receipt.contentHash,
          toDirectoryId: f.directory('00-Inbox').id,
          fileName: 'embedded.md',
        },
        {
          type: 'move_note',
          noteId: target.id,
          expectedModifiedAt: target.modifiedAt,
          expectedContentHash: sha256(target.content),
          toDirectoryId: f.directory('00-Inbox').id,
          fileName: 'target.md',
        },
      ]);
    } else if (move === 'folder') {
      syncDirectoryCatalog(f.config, f.db);
      const folder = f.directory('Topic/Folder');
      await f.organize([
        {
          type: 'move_directory',
          directoryId: folder.id,
          toDirectoryId: f.directory('00-Inbox').id,
          name: 'Moved',
          expectedSubtreeRevision: folder.subtreeRevision,
        },
      ]);
    } else await f.moveFolder();
    const currentPath =
        move === 'individual' ? '00-Inbox/embedded.md' : '00-Inbox/Moved/embedded.md',
      expectedLink = move === 'folder-rename' ? '../renamed.md' : '../target.md',
      requiresPreview = move !== 'folder';
    await snapshots.available(f.p, note.id, {});
    await snapshots.drain();
    const current = await snapshots.available(f.p, note.id, {});
    if ('operation' in current) throw Error('snapshot');
    const requestId = randomUUID(),
      recovery = recoveryService(f.config, f.db, f.notes);
    let preview: any;
    try {
      if (background) await files.restore(f.p, note.id, revision, current.modified_at, requestId);
      else recovery.restoreRevision(note.id, revision, current.modified_at, requestId);
    } catch (error) {
      preview = error;
    }
    if (requiresPreview) {
      expect(preview).toMatchObject({
        code: 'DIAGRAM_PREVIEW_REQUIRED',
        details: { documents: expect.any(Array) },
      });
      expect(
        f.db.prepare('SELECT id FROM operations WHERE request_id=?').get(requestId),
      ).toBeUndefined();
      expect(
        readFileSync(join(f.config.knowledgeRoot, currentPath), 'utf8').slice(0, 256),
      ).toContain('Later prose');
    } else expect(preview).toBeUndefined();
    const registry = background
      ? f.registry
      : diagramOperationPreviewRegistry(f.config, f.db, webPrincipal, f.assets);
    let preparedNative: ReturnType<typeof registry.prepare> | undefined;
    for (const need of preview?.details.documents ?? []) {
      const snapshot = registry.get(need.snapshotId);
      expect(JSON.parse(snapshot.source)).toMatchObject({
        future: { retain: true },
        elements: [{ link: expectedLink }],
      });
      if (move === 'individual') expect(snapshot.source).toBe(source);
      preparedNative = registry.prepare(snapshot.id, {
        sourceHash: snapshot.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    }
    if (background && requiresPreview) {
      const restored = await files.restore(f.p, note.id, revision, current.modified_at, requestId);
      if (restored.kind !== 'accepted') throw Error('operation');
      await files.drain();
      expect(files.operation(f.p, restored.operation.operationId).status).toBe('succeeded');
    } else if (requiresPreview)
      recovery.restoreRevision(note.id, revision, current.modified_at, requestId);
    const restored = readFileSync(join(f.config.knowledgeRoot, currentPath), 'utf8'),
      native = boundDiagramSources(restored)[0];
    if (!unbound) expect(native).toBeDefined();
    expect(restored.slice(0, 2048)).toContain('Preserve prose and `[[target]]`.');
    if (!unbound) {
      expect(native.code.trim()).toBe(native.sourcePath);
      expect(sha256(normalizeDiagramCode(native.code))).toBe(native.binding.codeHash);
    }
    const actualSource = localReference(
        currentPath,
        unbound
          ? references(restored).find((url) => url.endsWith('.excalidraw'))!
          : native.sourcePath,
      )!,
      scene = JSON.parse(f.assets.file(actualSource).bytes.toString('utf8'));
    expect(scene.elements[0].link).toBe(expectedLink);
    expect(localReference(actualSource, scene.elements[0].link)).toBe(
      f.notes.row(f.target.noteId).path,
    );
    const retained = (f.db.prepare('SELECT path FROM assets WHERE id=?').get(pair.source.id) as any)
      .path;
    expect(f.assets.file(retained).bytes.toString('utf8')).toBe(source);
    if (requiresPreview) {
      expect(actualSource).toBe(preparedNative!.source!.relativePath);
      const previewPath = localReference(
        currentPath,
        unbound ? references(restored).find((url) => url.endsWith('.png'))! : native.previewPath,
      )!;
      expect(previewPath).toBe(preparedNative!.preview.relativePath);
      expect(sha256(f.assets.file(previewPath).bytes)).toBe(preparedNative!.previewHash);
    } else expect(actualSource).toBe(retained);
  },
);
it.each([false, true])(
  'uses the same identity mapping in ordinary small/background restores (%s)',
  async (background) => {
    const f = fixture(),
      imagePath = 'Topic/Folder/assets/body.png';
    writeFileSync(join(f.config.knowledgeRoot, imagePath), Buffer.from(png, 'base64'));
    f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run(randomUUID(), imagePath);
    const original =
      '# Historical\n\n![body](assets/body.png) [[target|Target]]\n\n`[[target]]`\n\n' +
      (background ? 'x'.repeat(2 * 1024 * 1024) : 'Original');
    const note = f.create('Topic/Folder/note.md', original),
      snapshots = snapshotService(f.config, f.db, f.notes),
      files = fileJobService(f.config, f.db, f.notes, snapshots);
    cleanup.unshift(async () => {
      await files.close();
      await snapshots.close();
    });
    await snapshots.read(f.p, note.noteId, {}, 'web');
    await snapshots.drain();
    const page = await snapshots.read(f.p, note.noteId, {}, 'web');
    if (page.kind !== 'ready') throw Error('snapshot');
    const reply = await files.submit(
      f.p,
      note.noteId,
      {
        snapshotId: page.data.snapshotId,
        expectedModifiedAt: page.data.modifiedAt,
        expectedContentHash: page.data.sourceHash,
        requestId: randomUUID(),
        edits: [{ type: 'replace_text', before: '# Historical', after: '# Current' }],
      },
      'web',
    );
    if (reply.kind !== 'accepted') throw Error('operation');
    await files.drain();
    expect(files.operation(f.p, reply.operation.operationId).status).toBe('succeeded');
    const revision = (
      f.db
        .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
        .get(note.noteId) as any
    ).id;
    await f.moveFolder();
    const expected = (f.db.prepare('SELECT path FROM notes WHERE id=?').get(note.noteId) as any)
      .path;
    const current = readFileSync(join(f.config.knowledgeRoot, expected), 'utf8');
    const modifiedAt = await snapshots.available(f.p, note.noteId, {});
    await snapshots.drain();
    const meta = await snapshots.available(f.p, note.noteId, {});
    if ('operation' in meta) throw Error('snapshot');
    if (background) {
      const restored = await files.restore(
        f.p,
        note.noteId,
        revision,
        meta.modified_at,
        randomUUID(),
      );
      if (restored.kind !== 'accepted') throw Error('operation');
      await files.drain();
      expect(files.operation(f.p, restored.operation.operationId).status).toBe('succeeded');
    } else
      recoveryService(f.config, f.db, f.notes).restoreRevision(
        note.noteId,
        revision,
        meta.modified_at,
        randomUUID(),
      );
    const body = readFileSync(join(f.config.knowledgeRoot, expected), 'utf8');
    expect(body.slice(0, 512)).toContain('# Historical');
    expect(body.slice(0, 512)).toContain('![body](assets/body.png) [Target](<renamed.md>)');
    expect(body.slice(0, 512)).toContain('`[[target]]`');
    expect(sha256(body)).not.toBe(sha256(current));
  },
);
