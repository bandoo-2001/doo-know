import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { organizationService } from '../packages/core/organization/service';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
import { archiveFolder, restoreFolder, recoverFolders } from '../packages/core/folders';
import { workspaceExclusive } from '../packages/core/workspace/gate';
import { spawnSync } from 'node:child_process';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { migrateDiagramDocuments } from '../packages/core/knowledge/diagram-document-schema';
import { diagramArtifactService } from '../packages/core/knowledge/diagram-artifacts';
import { serializeDiagramBinding } from '../shared/diagram-binding';
import { normalizeDiagramCode } from '../shared/diagram-portability';
import type { OrganizeInput } from '../shared/organization-contracts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
function fixture(link?: string, type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  const f = organizationFixture(),
    org = organizationService(f.config, f.db, f.notes);
  cleanups.push(async () => {
    await org.close();
    f.close();
  });
  const assets = assetService(f.config, f.db, f.notes);
  const primary = (principal = f.p) =>
    primaryDiagramService(f.config, f.db, f.notes, assets, principal);
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: '00-Inbox/board.md',
    type,
    requestId: randomUUID(),
  });
  const source =
    type === 'mindmap'
      ? '- Child\n'
      : type === 'flowchart'
        ? 'flowchart TD\n A-->B\n'
        : JSON.stringify({
            ...emptyWhiteboard(),
            elements: link ? [{ id: 'a', type: 'rectangle', link }] : [],
          });
  const prepared = primary().prepare({
    target: { kind: 'creation', intentId: intent.id },
    type,
    source,
    sourceHash: sha256(source),
    title: 'Board',
    renderer: diagramRendererVersions[type],
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({ prepared, title: 'Board', source });
  const note = primary().commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  async function move() {
    const c = org.context(f.p),
      d = f.directory('00-Inbox'),
      requestId = randomUUID();
    org.submit(f.p, {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId,
      actions: [
        {
          type: 'move_directory',
          directoryId: d.id,
          toDirectoryId: f.directory('Topic').id,
          name: 'Moved',
          expectedSubtreeRevision: d.subtreeRevision,
        },
      ],
    });
    await org.drain();
    return org.operation(f.p, { requestId });
  }
  const archive = async () =>
    (await workspaceExclusive(f.db, { kind: 'folder.archive' }, async () =>
      archiveFolder(f.config, f.db, '00-Inbox', randomUUID(), () => f.notes.scan()),
    )) as { id: string };
  const restore = (id: string, name?: string) =>
    workspaceExclusive(f.db, { kind: 'folder.restore' }, async () =>
      restoreFolder(f.config, f.db, id, name, randomUUID()),
    );
  return { ...f, org, primary, prepared, note, markdown, source, move, archive, restore };
}

async function organize(f: ReturnType<typeof fixture>, actions: OrganizeInput['actions']) {
  const c = f.org.context(f.p),
    requestId = randomUUID();
  await f.org.submit(f.p, {
    libraryId: c.libraryId,
    expectedStructureRevision: c.structureRevision,
    requestId,
    actions,
  });
  await f.org.drain();
  return f.org.operation(f.p, { requestId });
}
function legacyDependency(targetPath = 'Topic/target.md', linkPath = targetPath) {
  const f = fixture();
  mkdirSync(join(f.config.knowledgeRoot, targetPath.slice(0, targetPath.lastIndexOf('/'))), {
    recursive: true,
  });
  const target = f.create(targetPath, '# Target');
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'a', type: 'rectangle', link: '../../' + linkPath }],
  });
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(f.note.id, {
    kind: 'excalidraw',
    source,
    sourceHash: sha256(source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  f.notes.saveNote(
    f.note.id,
    f.markdown +
      `\n![preview](${prepared.preview.markdownPath})\n\n[source](${prepared.source.markdownPath})\n`,
    f.note.modifiedAt,
    randomUUID(),
  );
  return { f, target, prepared, source };
}

it('rejects a target-only folder move referenced by a consumed native attachment outside the moved root', async () => {
  const { f, prepared, source } = legacyDependency(),
    d = f.directory('Topic');
  const result = await organize(f, [
    {
      type: 'move_directory',
      directoryId: d.id,
      toDirectoryId: f.directory('00-Inbox').id,
      name: 'Moved',
      expectedSubtreeRevision: d.subtreeRevision,
    },
  ]);
  expect(result).toMatchObject({
    status: 'awaiting_preview',
    error: { code: 'DIAGRAM_PREVIEW_REQUIRED' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/target.md'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/Moved'))).toBe(false);
  expect(readFileSync(join(f.config.knowledgeRoot, prepared.source.relativePath), 'utf8')).toBe(
    source,
  );
});

it('rejects an organization target-only note rename referenced by an outside consumed native attachment', async () => {
  const { f, target } = legacyDependency();
  const result = await organize(f, [
    {
      type: 'move_note',
      ...target,
      toDirectoryId: f.directory('Topic').id,
      fileName: 'renamed.md',
    },
  ]);
  expect(result).toMatchObject({
    status: 'awaiting_preview',
    error: { code: 'DIAGRAM_PREVIEW_REQUIRED' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/target.md'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/renamed.md'))).toBe(false);
});

it.each(['simple', 'organization'] as const)(
  'returns opaque403 for an outside-owner native dependency during %s target rename',
  async (kind) => {
    const { f, target } = legacyDependency();
    f.p.knowledgeAll = false;
    f.p.allowedPrefixes = ['Topic'];
    if (kind === 'simple') {
      let error: unknown;
      try {
        mutationCore(f.config, f.db).move(
          f.p,
          target.noteId,
          'Topic',
          'renamed.md',
          target.expectedModifiedAt,
          randomUUID(),
        );
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ code: 'DEPENDENCY_FORBIDDEN', statusCode: 403 });
      expect(JSON.stringify(error)).not.toContain('00-Inbox');
    } else {
      const result = await organize(f, [
        {
          type: 'move_note',
          ...target,
          toDirectoryId: f.directory('Topic').id,
          fileName: 'renamed.md',
        },
      ]);
      expect(result).toMatchObject({ status: 'failed', error: { code: 'DEPENDENCY_FORBIDDEN' } });
      expect(JSON.stringify(result)).not.toContain('00-Inbox');
    }
    expect(existsSync(join(f.config.knowledgeRoot, 'Topic/target.md'))).toBe(true);
    expect(existsSync(join(f.config.knowledgeRoot, 'Topic/renamed.md'))).toBe(false);
  },
);

it.each([false, true])(
  'checks outside native dependencies before undoing a target-only folder move (restricted=%s)',
  async (restricted) => {
    const { f } = legacyDependency('Topic/Targets/target.md', 'Topic/Moved/target.md');
    const d = f.directory('Topic/Targets');
    const moved = await organize(f, [
      {
        type: 'move_directory',
        directoryId: d.id,
        toDirectoryId: f.directory('Topic').id,
        name: 'Moved',
        expectedSubtreeRevision: d.subtreeRevision,
      },
    ]);
    expect(moved.status).toBe('succeeded');
    if (restricted) {
      f.p.knowledgeAll = false;
      f.p.allowedPrefixes = ['Topic'];
    }
    const undo = await f.org.undo(f.p, { operationId: moved.operationId, requestId: randomUUID() });
    await f.org.drain();
    const result = f.org.operation(f.p, { operationId: undo.operation.operationId });
    expect(result).toMatchObject({
      status: restricted ? 'failed' : 'awaiting_preview',
      error: { code: restricted ? 'DEPENDENCY_FORBIDDEN' : 'DIAGRAM_PREVIEW_REQUIRED' },
    });
    expect(JSON.stringify(result)).not.toContain('00-Inbox');
    expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved/target.md'))).toBe(true);
    expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Targets'))).toBe(false);
  },
);

it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'keeps selected-note source access and owner saves for %s after folder relocation while retaining the original context',
  async (type) => {
    const f = fixture(undefined, type);
    expect((await f.move()).status).toBe('succeeded');
    const scoped = { ...f.p, knowledgeAll: false, allowedPrefixes: ['Topic/Moved/board.md'] };
    expect(f.primary(scoped).resolve(f.note.id).capabilities.canEdit).toBe(true);
    const current = f.notes.getNote(f.note.id);
    expect(() =>
      f.notes.saveNote(
        current.id,
        current.content + 'Description\n',
        current.modifiedAt,
        randomUUID(),
      ),
    ).not.toThrow();
    const paths = f.db
      .prepare('SELECT DISTINCT path FROM diagram_document_versions WHERE note_id=? ORDER BY path')
      .all(f.note.id);
    expect(paths).toEqual([{ path: '00-Inbox/board.md' }, { path: 'Topic/Moved/board.md' }]);
  },
);

it('registers the current logical publication context for a byte-identical simple rename', () => {
  const f = fixture();
  mutationCore(f.config, f.db).move(
    webPrincipal,
    f.note.id,
    '00-Inbox',
    'renamed.md',
    f.note.modifiedAt,
    randomUUID(),
  );
  expect(
    f.db
      .prepare('SELECT path FROM diagram_document_versions WHERE note_id=? ORDER BY path')
      .all(f.note.id),
  ).toEqual([{ path: '00-Inbox/board.md' }, { path: '00-Inbox/renamed.md' }]);
  expect(
    f
      .primary({ ...f.p, knowledgeAll: false, allowedPrefixes: ['00-Inbox/renamed.md'] })
      .resolve(f.note.id).capabilities.canEdit,
  ).toBe(true);
});

it('upgrades a persisted old two-column version key without losing the old publication context', () => {
  const f = fixture();
  f.db.exec(`DROP INDEX diagram_published_bindings;
    ALTER TABLE diagram_document_versions RENAME TO saved_versions;
    CREATE TABLE diagram_document_versions(note_id TEXT NOT NULL REFERENCES notes(id),document_hash TEXT NOT NULL,path TEXT NOT NULL,document_type TEXT NOT NULL,source_hash TEXT NOT NULL,render_hash TEXT NOT NULL,preview_hash TEXT NOT NULL,manifest TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(note_id,document_hash));
    INSERT INTO diagram_document_versions SELECT * FROM saved_versions;
    DROP TABLE saved_versions;`);
  migrateDiagramDocuments(f.db);
  migrateDiagramDocuments(f.db);
  mutationCore(f.config, f.db).move(
    webPrincipal,
    f.note.id,
    '00-Inbox',
    'renamed.md',
    f.note.modifiedAt,
    randomUUID(),
  );
  expect(
    f.db
      .prepare('SELECT path FROM diagram_document_versions WHERE note_id=? ORDER BY path')
      .all(f.note.id),
  ).toEqual([{ path: '00-Inbox/board.md' }, { path: '00-Inbox/renamed.md' }]);
});

it('blocks simple target rename when another primary would need changed native source bytes', () => {
  const f = fixture('../../Topic/target.md'),
    target = f.create('Topic/target.md', '# Target');
  expect(() =>
    mutationCore(f.config, f.db).move(
      webPrincipal,
      target.noteId,
      'Topic',
      'renamed.md',
      target.expectedModifiedAt,
      randomUUID(),
    ),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREVIEW_REQUIRED' }));
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/target.md'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/renamed.md'))).toBe(false);
});

it('restores a renamed folder with asset catalog and scoped proofs at its restored paths', async () => {
  const f = fixture(),
    archived = await f.archive();
  await f.restore(archived.id, 'Restored');
  expect(f.notes.row(f.note.id).path).toBe('Restored/board.md');
  expect(
    f.db.prepare("SELECT count(*) AS n FROM assets WHERE path LIKE 'Restored/assets/%'").get(),
  ).toEqual({ n: 2 });
  expect(
    f
      .primary({ ...f.p, knowledgeAll: false, allowedPrefixes: ['Restored/board.md'] })
      .resolve(f.note.id).source.content,
  ).toBe(f.source);
  const current = f.notes.getNote(f.note.id);
  expect(() =>
    f.notes.saveNote(
      current.id,
      current.content + 'Description\n',
      current.modifiedAt,
      randomUUID(),
    ),
  ).not.toThrow();
});

it.each(['source', 'preview'] as const)(
  'refuses a tampered retained %s before restoring or activating a folder',
  async (role) => {
    const f = fixture(),
      archived = await f.archive();
    const relative =
      role === 'source' ? f.prepared.source!.relativePath : f.prepared.preview.relativePath;
    const trash = join(f.config.knowledgeRoot, '90-Archive/.trash', archived.id, 'tree');
    const file = join(trash, relative.slice('00-Inbox/'.length)),
      original = readFileSync(file);
    writeFileSync(
      file,
      role === 'source'
        ? JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#000' } })
        : Buffer.from('broken PNG'),
    );
    await expect(f.restore(archived.id)).rejects.toMatchObject({
      code: 'DIAGRAM_ARTIFACT_CONFLICT',
    });
    expect(existsSync(trash)).toBe(true);
    expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox'))).toBe(false);
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({
      active: 0,
    });
    writeFileSync(file, original);
    await f.restore(archived.id);
    expect(f.primary().resolve(f.note.id).capabilities.canEdit).toBe(true);
  },
);

it('refuses a primary replaced by raw scene JSON in folder trash instead of restoring JSON into its .md path', async () => {
  const f = fixture(),
    archived = await f.archive();
  const trash = join(f.config.knowledgeRoot, '90-Archive/.trash', archived.id, 'tree');
  writeFileSync(join(trash, 'board.md'), f.source);
  await expect(f.restore(archived.id)).rejects.toMatchObject({ code: 'DIAGRAM_ARTIFACT_CONFLICT' });
  expect(existsSync(join(trash, 'board.md'))).toBe(true);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
});

it('blocks a native source link rebase before an organization move exposes any destination', async () => {
  const f = fixture('../../Topic/target.md');
  f.create('Topic/target.md', '# Target');
  const result = await f.move();
  expect(result).toMatchObject({
    status: 'awaiting_preview',
    error: { code: 'DIAGRAM_PREVIEW_REQUIRED' },
  });
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved'))).toBe(false);
});

it('blocks folder archive when another active note retains its resources', async () => {
  const f = fixture();
  f.create('Topic/reference.md', '[preview](../' + f.prepared.preview.relativePath + ')');
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/board.md'))).toBe(true);
});

it('keeps resources still required by an individually trashed primary outside the folder tree', async () => {
  const f = fixture();
  mutationCore(f.config, f.db).archive(webPrincipal, f.note.id, f.note.modifiedAt, randomUUID());
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
  expect(existsSync(join(f.config.knowledgeRoot, f.prepared.preview.relativePath))).toBe(true);
});

it('keeps shared previews referenced by an ordinary individually trashed note', async () => {
  const f = fixture(),
    outside = f.create(
      'Topic/reference.md',
      '[preview](../' + f.prepared.preview.relativePath + ')',
    );
  mutationCore(f.config, f.db).archive(
    webPrincipal,
    outside.noteId,
    outside.expectedModifiedAt,
    randomUUID(),
  );
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
});

it('keeps shared previews referenced by another recoverable folder tree', async () => {
  const f = fixture();
  f.create('Topic/reference.md', '[preview](../' + f.prepared.preview.relativePath + ')');
  await workspaceExclusive(f.db, { kind: 'folder.archive' }, async () =>
    archiveFolder(f.config, f.db, 'Topic', randomUUID(), () => f.notes.scan()),
  );
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
});

it('blocks folder archive and move while an unpublished creation still leases its resources', async () => {
  const f = fixture();
  const intent = diagramCreationService(f.config, f.db, f.p).reserve({
    path: '00-Inbox/draft.md',
    type: 'whiteboard',
    requestId: randomUUID(),
  });
  f.primary().prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'whiteboard',
    source: f.source,
    sourceHash: sha256(f.source),
    title: 'Draft',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
  expect(await f.move()).toMatchObject({
    status: 'failed',
    error: { code: 'DIAGRAM_RESOURCES_RETAINED' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/board.md'))).toBe(true);
});

it('protects a legacy embedded preparation that has not been consumed by saved Markdown', async () => {
  const f = fixture(),
    source = 'flowchart TD\n A-->B';
  diagramArtifactService(f.db, f.notes, assetService(f.config, f.db, f.notes), f.p).prepare(
    f.note.id,
    {
      kind: 'mermaid',
      source,
      sourceHash: sha256(source),
      pngBase64: png,
      requestId: randomUUID(),
    },
  );
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
  expect(await f.move()).toMatchObject({
    status: 'failed',
    error: { code: 'DIAGRAM_RESOURCES_RETAINED' },
  });
});

it('permits normal folder movement after a legacy preparation was consumed by a saved bound group', async () => {
  const f = fixture(),
    source = 'flowchart TD\n A-->B';
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(f.note.id, {
    kind: 'mermaid',
    source,
    sourceHash: sha256(source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  const group = `\n![MERMAID 预览](${prepared.preview.markdownPath})\n\n[图形源文件](${prepared.source.markdownPath})\n\n${serializeDiagramBinding({ kind: 'mermaid', sourceHash: sha256(source), codeHash: sha256(normalizeDiagramCode(source)) })}\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
  f.notes.saveNote(f.note.id, f.markdown + group, f.note.modifiedAt, randomUUID());
  expect((await f.move()).status).toBe('succeeded');
  expect(f.primary().resolve(f.note.id).capabilities.canEdit).toBe(true);
  expect(
    existsSync(
      join(
        f.config.knowledgeRoot,
        prepared.source.relativePath.replace('00-Inbox/', 'Topic/Moved/'),
      ),
    ),
  ).toBe(true);
});

it('does not permanently block a consumed legacy receipt when only a saved historical resource pair remains', async () => {
  const f = fixture(),
    source = 'flowchart TD\n A-->B';
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(f.note.id, {
    kind: 'mermaid',
    source,
    sourceHash: sha256(source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  const saved = f.notes.saveNote(
    f.note.id,
    f.markdown +
      `\n![preview](${prepared.preview.markdownPath})\n\n[source](${prepared.source.markdownPath})\n`,
    f.note.modifiedAt,
    randomUUID(),
  );
  f.notes.saveNote(f.note.id, f.markdown, saved.modifiedAt, randomUUID());
  expect((await f.move()).status).toBe('succeeded');
});

it('blocks native link rebases in consumed legacy source attachments before moving their folder', async () => {
  const f = fixture(),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../../Topic/target.md' }],
    });
  f.create('Topic/target.md', '# Target');
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(f.note.id, {
    kind: 'excalidraw',
    source,
    sourceHash: sha256(source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  f.notes.saveNote(
    f.note.id,
    f.markdown +
      `\n![preview](${prepared.preview.markdownPath})\n\n[source](${prepared.source.markdownPath})\n`,
    f.note.modifiedAt,
    randomUUID(),
  );
  expect(await f.move()).toMatchObject({
    status: 'awaiting_preview',
    error: { code: 'DIAGRAM_PREVIEW_REQUIRED' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved'))).toBe(false);
});

it('protects native links in a consumed legacy attachment after its asset identity was relocated', async () => {
  const f = fixture(),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link: '../target.md' }],
    });
  const target = f.create('00-Inbox/target.md', '# Target');
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    f.p,
  ).prepare(f.note.id, {
    kind: 'excalidraw',
    source,
    sourceHash: sha256(source),
    pngBase64: png,
    requestId: randomUUID(),
  });
  f.notes.saveNote(
    f.note.id,
    f.markdown +
      `\n![preview](${prepared.preview.markdownPath})\n\n[source](${prepared.source.markdownPath})\n`,
    f.note.modifiedAt,
    randomUUID(),
  );
  expect((await f.move()).status).toBe('succeeded');
  const current = f.notes.getNote(target.noteId);
  expect(() =>
    mutationCore(f.config, f.db).move(
      webPrincipal,
      target.noteId,
      'Topic/Moved',
      'renamed.md',
      current.modifiedAt,
      randomUUID(),
    ),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREVIEW_REQUIRED' }));
});

it('blocks folder archive when an outside recoverable revision still refers to its preview', async () => {
  const f = fixture(),
    outside = f.create(
      'Topic/reference.md',
      '[preview](../' + f.prepared.preview.relativePath + ')',
    );
  const current = f.notes.getNote(outside.noteId);
  f.notes.saveNote(current.id, '# Removed current reference\n', current.modifiedAt, randomUUID());
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
});

it('keeps an outside historical resource when its note has moved and its old logical path is unavailable', async () => {
  const f = fixture(),
    outside = f.create(
      'Topic/reference.md',
      '[preview](../' + f.prepared.preview.relativePath + ')',
    );
  const current = f.notes.getNote(outside.noteId);
  const saved = f.notes.saveNote(
    current.id,
    '# Current body without references\n',
    current.modifiedAt,
    randomUUID(),
  );
  mutationCore(f.config, f.db).move(
    webPrincipal,
    current.id,
    '',
    'moved-history-owner.md',
    saved.modifiedAt,
    randomUUID(),
  );
  await expect(f.archive()).rejects.toMatchObject({ code: 'DIAGRAM_RESOURCES_RETAINED' });
});

it('recovers a relocated proof context after the organization worker dies during metadata commit', async () => {
  const f = fixture(),
    c = f.org.context(f.p),
    d = f.directory('00-Inbox');
  const input = {
    libraryId: c.libraryId,
    expectedStructureRevision: c.structureRevision,
    requestId: randomUUID(),
    actions: [
      {
        type: 'move_directory',
        directoryId: d.id,
        toDirectoryId: f.directory('Topic').id,
        name: 'Moved',
        expectedSubtreeRevision: d.subtreeRevision,
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
      'metadata',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  await f.org.recover();
  await f.org.drain();
  expect(f.org.operation(f.p, { requestId: input.requestId }).status).toBe('succeeded');
  expect(
    f
      .primary({ ...f.p, knowledgeAll: false, allowedPrefixes: ['Topic/Moved/board.md'] })
      .resolve(f.note.id).capabilities.canEdit,
  ).toBe(true);
  expect(
    f.db
      .prepare('SELECT count(*) AS n FROM diagram_document_versions WHERE note_id=?')
      .get(f.note.id),
  ).toEqual({ n: 2 });
});

it('undoes folder relocation with both original and relocated publication contexts intact', async () => {
  const f = fixture(),
    moved = await f.move();
  const undo = await f.org.undo(f.p, { operationId: moved.operationId, requestId: randomUUID() });
  await f.org.drain();
  expect(f.org.operation(f.p, { operationId: undo.operation.operationId }).status).toBe(
    'succeeded',
  );
  expect(f.notes.row(f.note.id).path).toBe('00-Inbox/board.md');
  expect(
    f
      .primary({ ...f.p, knowledgeAll: false, allowedPrefixes: ['00-Inbox/board.md'] })
      .resolve(f.note.id).capabilities.canEdit,
  ).toBe(true);
  const current = f.notes.getNote(f.note.id);
  expect(() =>
    f.notes.saveNote(
      current.id,
      current.content + 'Description\n',
      current.modifiedAt,
      randomUUID(),
    ),
  ).not.toThrow();
});

it('rechecks fixed bytes and records proofs idempotently after folder restore metadata fails', async () => {
  const f = fixture(),
    archived = await f.archive();
  f.db.exec(
    "CREATE TRIGGER fail_restore BEFORE UPDATE OF active ON notes WHEN NEW.active=1 AND OLD.active=0 BEGIN SELECT RAISE(ABORT,'test metadata failure'); END",
  );
  await expect(f.restore(archived.id, 'Restored')).rejects.toMatchObject({
    code: 'OPERATION_OUTCOME_UNKNOWN',
  });
  f.db.exec('DROP TRIGGER fail_restore');
  const recover = () =>
    workspaceExclusive(f.db, { kind: 'folder.recover' }, async () =>
      recoverFolders(f.config, f.db),
    );
  const source = join(
    f.config.knowledgeRoot,
    'Restored',
    f.prepared.source!.relativePath.slice('00-Inbox/'.length),
  );
  writeFileSync(
    source,
    JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#000' } }),
  );
  await expect(recover()).rejects.toMatchObject({ code: 'DIAGRAM_ARTIFACT_CONFLICT' });
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.note.id)).toEqual({ active: 0 });
  writeFileSync(source, f.source);
  await recover();
  await recover();
  expect(
    f
      .primary({ ...f.p, knowledgeAll: false, allowedPrefixes: ['Restored/board.md'] })
      .resolve(f.note.id).capabilities.canEdit,
  ).toBe(true);
  expect(
    f.db
      .prepare('SELECT count(*) AS n FROM diagram_document_versions WHERE note_id=?')
      .get(f.note.id),
  ).toEqual({ n: 2 });
});

it('rejects conflicting restored asset catalog identities before moving the folder out of trash', async () => {
  const f = fixture(),
    archived = await f.archive();
  f.db
    .prepare('INSERT INTO assets(id,path) VALUES(?,?)')
    .run(randomUUID(), 'Restored/' + f.prepared.preview.relativePath.slice('00-Inbox/'.length));
  await expect(f.restore(archived.id, 'Restored')).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
  expect(existsSync(join(f.config.knowledgeRoot, 'Restored'))).toBe(false);
  expect(existsSync(join(f.config.knowledgeRoot, '90-Archive/.trash', archived.id, 'tree'))).toBe(
    true,
  );
});

it('does not relocate assets created in a new live folder that reused the archived folder name', async () => {
  const f = fixture(),
    archived = await f.archive();
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox'));
  const current = f.create('00-Inbox/new.md', '# New live folder');
  const uploaded = assetService(f.config, f.db, f.notes).upload(
    current.noteId,
    'new.png',
    'image/png',
    Buffer.from(png, 'base64'),
  );
  await f.restore(archived.id, 'Restored');
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(uploaded.id)).toEqual({
    path: uploaded.relativePath,
  });
  expect(existsSync(join(f.config.knowledgeRoot, uploaded.relativePath))).toBe(true);
  expect(f.primary().resolve(f.note.id).capabilities.canEdit).toBe(true);
});

it('does not steal an archived asset identity whose catalog now belongs to another live location', async () => {
  const f = fixture(),
    archived = await f.archive();
  writeFileSync(join(f.config.knowledgeRoot, 'Topic/shared.png'), Buffer.from(png, 'base64'));
  f.db
    .prepare('UPDATE assets SET path=? WHERE id=?')
    .run('Topic/shared.png', f.prepared.preview.id);
  await expect(f.restore(archived.id, 'Restored')).rejects.toMatchObject({
    code: 'DIAGRAM_RESOURCES_RETAINED',
  });
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(f.prepared.preview.id)).toEqual({
    path: 'Topic/shared.png',
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Restored'))).toBe(false);
});
