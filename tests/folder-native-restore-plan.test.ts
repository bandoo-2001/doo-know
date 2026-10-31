import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { webPrincipal } from '../packages/core/knowledge/core';
import { archiveFolder, restoreFolder, recoverFolders } from '../packages/core/folders';
import { workspaceExclusive } from '../packages/core/workspace/gate';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
async function fixture(inbound = false) {
  const f = organizationFixture();
  cleanup.push(f.close);
  const assets = assetService(f.config, f.db, f.notes),
    primary = primaryDiagramService(f.config, f.db, f.notes, assets, webPrincipal),
    registry = diagramOperationPreviewRegistry(f.config, f.db, webPrincipal, assets);
  function board(path: string, link: string) {
    const intent = diagramCreationService(f.config, f.db, webPrincipal).reserve({
      path,
      type: 'whiteboard',
      requestId: randomUUID(),
    });
    const source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'a', type: 'rectangle', link }],
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
    return primary.commit({
      preparedId: prepared.id,
      markdown: renderPreparedDiagramDocument({ prepared, title: 'Board', source }),
      requestId: randomUUID(),
    });
  }
  const original = board('00-Inbox/board.md', '../../00-Inbox/inside.md');
  f.create('00-Inbox/inside.md', '# Inside');
  const outside = inbound ? board('Topic/outside.md', '../../00-Inbox/inside.md') : undefined;
  const plain = inbound
    ? f.create('Topic/incoming.md', '# Incoming\n\n[Inside](../00-Inbox/inside.md)')
    : undefined;
  const archived = await workspaceExclusive(f.db, { kind: 'folder.archive' }, async () =>
    archiveFolder(f.config, f.db, '00-Inbox', randomUUID(), () => f.notes.scan()),
  );
  const requestId = randomUUID();
  const restore = () =>
    workspaceExclusive(f.db, { kind: 'folder.restore' }, async () =>
      restoreFolder(f.config, f.db, archived.id, 'Restored', requestId),
    );
  async function prepare() {
    let required: any;
    try {
      await restore();
    } catch (error) {
      required = (error as any).details;
    }
    expect(required?.documents).toHaveLength(inbound ? 2 : 1);
    const snapshots = required.documents.map((need: any) => registry.get(need.snapshotId));
    for (const fixed of snapshots)
      registry.prepare(fixed.id, {
        sourceHash: fixed.sourceHash,
        pngBase64: png,
        requestId: randomUUID(),
      });
    return snapshots;
  }
  return {
    ...f,
    assets,
    primary,
    registry,
    original,
    outside,
    plain,
    archived,
    requestId,
    restore,
    prepare,
  };
}
it('restores a renamed archived folder only after its exact final native source is prepared, retaining UUID and original backup', async () => {
  const f = await fixture();
  const [fixed] = await f.prepare();
  expect(JSON.parse(fixed.source).elements[0].link).toBe('../inside.md');
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
    active: 0,
  });
  await f.restore();
  expect(f.notes.row(f.original.id).path).toBe('Restored/board.md');
  expect(f.primary.resolve(f.original.id).source.hash).toBe(fixed.sourceHash);
  expect(f.primary.resolve(f.original.id).preview?.state).toBe('ready');
  const plan = f.db
    .prepare(
      'SELECT plan FROM folder_native_restore_plans WHERE operation_id=(SELECT operation_id FROM folder_trash WHERE id=?)',
    )
    .get(f.archived.id) as any;
  expect(readFileSync(join(f.config.dataRoot, JSON.parse(plan.plan).files[0].backup), 'utf8')).toBe(
    f.original.content,
  );
});
it('prepares active outside native dependencies and remaps ordinary inbound links before restoring the folder', async () => {
  const f = await fixture(true);
  const fixed = await f.prepare();
  const outside = fixed.find((s: any) => s.input.noteId === f.outside!.id);
  expect(JSON.parse(outside.source).elements[0].link).toBe('../../Restored/inside.md');
  expect(f.notes.getNote(f.outside!.id).content).toBe(f.outside!.content);
  await f.restore();
  expect(f.primary.resolve(f.outside!.id).source.hash).toBe(outside.sourceHash);
  expect(f.primary.resolve(f.outside!.id).preview?.state).toBe('ready');
  expect(f.notes.getNote(f.plain!.noteId).content).toContain('../Restored/inside.md');
});
it('rejects changed archive metadata and fixed active inventory instead of replacing an awaiting restore plan', async () => {
  const f = await fixture();
  await f.prepare();
  f.create('Topic/after-plan.md', '# New');
  await expect(f.restore()).rejects.toMatchObject({ code: 'STRUCTURE_VERSION_CONFLICT' });
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
    active: 0,
  });
});
it('never activates a tampered private archive preparation', async () => {
  const f = await fixture();
  const [fixed] = await f.prepare();
  writeFileSync(
    join(f.config.dataRoot, 'diagram-operation-previews', fixed.id, 'source'),
    'tampered',
  );
  await expect(f.restore()).rejects.toMatchObject({ code: 'DIAGRAM_ARTIFACT_CONFLICT' });
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
    active: 0,
  });
});
for (const point of ['archived_note', 'active_note', 'directory_renamed', 'metadata'])
  it(
    'recovers the same frozen archived/active restore journal after process exit at ' + point,
    async () => {
      const f = await fixture(true);
      const prepared = await f.prepare();
      const { spawnSync } = await import('node:child_process');
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'tests/support/folder-native-restore-child.ts',
          JSON.stringify(f.config),
          f.archived.id,
          'Restored',
          f.requestId,
          point,
        ],
        { encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(91);
      await workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
        recoverFolders(f.config, f.db),
      );
      expect(f.notes.row(f.original.id).path).toBe('Restored/board.md');
      for (const snapshot of prepared) {
        expect(f.primary.resolve(snapshot.input.noteId).source.hash).toBe(snapshot.sourceHash);
        expect(f.primary.resolve(snapshot.input.noteId).preview?.state).toBe('ready');
      }
      expect(f.notes.getNote(f.plain!.noteId).content).toContain('../Restored/inside.md');
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM notes WHERE active=1').get()).toEqual({
        count: 4,
      });
      expect(await f.restore()).toMatchObject({
        id: f.archived.id,
        relativePath: 'Restored',
        deleted: false,
      });
    },
  );
for (const change of ['content', 'mtime'] as const)
  it(
    'preserves a conflicting live dependency after a crashed archive restore (' + change + ')',
    async () => {
      const f = await fixture(true);
      await f.prepare();
      const { spawnSync } = await import('node:child_process');
      const { utimesSync } = await import('node:fs');
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'tests/support/folder-native-restore-child.ts',
          JSON.stringify(f.config),
          f.archived.id,
          'Restored',
          f.requestId,
          'archived_note',
        ],
        { encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(91);
      const outside = join(f.config.knowledgeRoot, f.outside!.relativePath);
      if (change === 'content') writeFileSync(outside, '# External replacement');
      else utimesSync(outside, new Date(), new Date(Date.now() + 60000));
      await expect(
        workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
          recoverFolders(f.config, f.db),
        ),
      ).rejects.toMatchObject({ code: 'TRASH_CHANGED' });
      expect(readFileSync(outside, 'utf8')).toBe(
        change === 'content' ? '# External replacement' : f.outside!.content,
      );
      expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
        active: 0,
      });
    },
  );
it('rebinds a copied in-progress native restore only at the verified backup boundary and recovers its fixed hashes', async () => {
  const f = await fixture(true);
  const prepared = await f.prepare();
  const { spawnSync } = await import('node:child_process');
  const { renameSync, cpSync, lstatSync, realpathSync } = await import('node:fs');
  const { rebindRestoredFolders } = await import('../packages/core/folders');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/folder-native-restore-child.ts',
      JSON.stringify(f.config),
      f.archived.id,
      'Restored',
      f.requestId,
      'archived_note',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  const original = join(f.root, 'original-knowledge');
  renameSync(f.config.knowledgeRoot, original);
  cpSync(original, f.config.knowledgeRoot, { recursive: true, preserveTimestamps: true });
  const root = lstatSync(f.config.knowledgeRoot, { bigint: true });
  f.db.prepare("UPDATE index_meta SET value=? WHERE key='root_identity'").run(
    JSON.stringify({
      path: realpathSync(f.config.knowledgeRoot),
      dev: String(root.dev),
      ino: String(root.ino),
    }),
  );
  rebindRestoredFolders(f.config, f.db);
  await workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
    recoverFolders(f.config, f.db),
  );
  expect(f.notes.row(f.original.id).path).toBe('Restored/board.md');
  for (const fixed of prepared)
    expect(f.primary.resolve(fixed.input.noteId).source.hash).toBe(fixed.sourceHash);
});
it('rejects invalid UTF-8 before creating a mutable restore journal and preserves the archived bytes', async () => {
  const f = await fixture();
  const file = join(
      f.config.knowledgeRoot,
      '90-Archive',
      '.trash',
      f.archived.id,
      'tree',
      'inside.md',
    ),
    bytes = Buffer.concat([Buffer.from('[Board](../00-Inbox/board.md)'), Buffer.from([255])]);
  writeFileSync(file, bytes);
  await expect(f.restore()).rejects.toMatchObject({ code: 'INVALID_UTF8' });
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.db.prepare('SELECT state FROM folder_trash WHERE id=?').get(f.archived.id)).toEqual({
    state: 'trashed',
  });
});
it('returns opaque dependency denial before exposing previews when an outside ordinary backlink is not writable', async () => {
  const f = await fixture();
  f.create('Topic/private.md', '# Private\n\n[Inside](../00-Inbox/inside.md)');
  const limited = {
    ...webPrincipal,
    id: 'limited',
    clientId: 'limited-client',
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:archive', 'knowledge:organize'],
    knowledgeAll: false,
    allowedPrefixes: ['00-Inbox', 'Restored'],
  };
  await expect(
    workspaceExclusive(f.db, { kind: 'folder.restore' }, async () =>
      restoreFolder(f.config, f.db, f.archived.id, 'Restored', randomUUID(), limited),
    ),
  ).rejects.toMatchObject({ statusCode: 403, code: 'DEPENDENCY_FORBIDDEN' });
  expect(
    f.notes.getNote(
      (f.db.prepare('SELECT id FROM notes WHERE path=?').get('Topic/private.md') as { id: string })
        .id,
    ).content,
  ).toContain('../00-Inbox/inside.md');
});
it('does not leave an authorized recovery marker when final rights are revoked before restore publication', async () => {
  const f = organizationFixture();
  cleanup.push(f.close);
  const note = f.create('00-Inbox/inside.md', '# Inside\n\n[Self](inside.md)');
  const archived = await workspaceExclusive(f.db, { kind: 'folder.archive' }, async () =>
    archiveFolder(f.config, f.db, '00-Inbox', randomUUID(), () => f.notes.scan()),
  );
  const actor = { ...f.p, scopes: [...f.p.scopes, 'knowledge:archive'] };
  let calls = 0;
  const revalidate = () => (++calls < 3 ? actor : { ...actor, scopes: [] });
  await expect(
    workspaceExclusive(f.db, { kind: 'folder.restore' }, async () =>
      restoreFolder(f.config, f.db, archived.id, 'Restored', randomUUID(), actor, revalidate),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(f.db.prepare('SELECT state FROM folder_trash WHERE id=?').get(archived.id)).toEqual({
    state: 'trashed',
  });
  await workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
    recoverFolders(f.config, f.db),
  );
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(note.noteId)).toEqual({
    active: 0,
  });
});
it.each(['ordinary content', 'extra file'] as const)(
  'rejects %s changed after the restore directory rename',
  async (change) => {
    const f = organizationFixture();
    cleanup.push(f.close);
    const note = f.create('00-Inbox/inside.md', '# Original plain');
    const archived = await workspaceExclusive(f.db, { kind: 'folder.archive' }, async () =>
      archiveFolder(f.config, f.db, '00-Inbox', randomUUID(), () => f.notes.scan()),
    );
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/support/folder-native-restore-child.ts',
        JSON.stringify(f.config),
        archived.id,
        'Restored',
        randomUUID(),
        'directory_renamed',
      ],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(91);
    if (change === 'ordinary content')
      writeFileSync(join(f.config.knowledgeRoot, 'Restored/inside.md'), '# External');
    else writeFileSync(join(f.config.knowledgeRoot, 'Restored/unplanned.md'), '# New outside plan');
    await expect(
      workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
        recoverFolders(f.config, f.db),
      ),
    ).rejects.toMatchObject({ code: 'TRASH_CHANGED' });
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(note.noteId)).toEqual({
      active: 0,
    });
    expect(readFileSync(join(f.config.knowledgeRoot, 'Restored/inside.md'), 'utf8')).toBe(
      change === 'ordinary content' ? '# External' : '# Original plain',
    );
    expect(() => f.notes.scan()).toThrow();
    expect(
      f.db.prepare('SELECT id FROM notes WHERE path=?').get('Restored/unplanned.md'),
    ).toBeUndefined();
  },
);
it('keeps partial live dependency rewrites behind a recovery barrier until the fixed folder transaction completes', async () => {
  const f = await fixture(true);
  await f.prepare();
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/folder-native-restore-child.ts',
      JSON.stringify(f.config),
      f.archived.id,
      'Restored',
      f.requestId,
      'active_note',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  expect(() => f.notes.getNote(f.outside!.id)).toThrowError(
    expect.objectContaining({ code: 'FOLDER_RECOVERY_REQUIRED' }),
  );
  await workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
    recoverFolders(f.config, f.db),
  );
  expect(f.primary.resolve(f.outside!.id).preview?.state).toBe('ready');
});
it('backs up private final PNG/source preparations and their retained restore materials', async () => {
  const f = await fixture();
  const [fixed] = await f.prepare();
  const { backup } = await import('../apps/server/backup');
  const destination = join(f.root, 'backup');
  await backup(f.config, destination);
  expect(
    readFileSync(
      join(destination, 'data', 'diagram-operation-previews', fixed.id, 'source'),
      'utf8',
    ),
  ).toBe(fixed.source);
  expect(
    readFileSync(
      join(destination, 'data', 'diagram-operation-previews', fixed.id, 'preview'),
    ).subarray(0, 8),
  ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await f.restore();
  const complete = join(f.root, 'complete-backup');
  await backup(f.config, complete);
  const row = f.db
    .prepare(
      'SELECT p.plan FROM folder_native_restore_plans p JOIN folder_trash f ON f.operation_id=p.operation_id WHERE f.id=?',
    )
    .get(f.archived.id) as { plan: string };
  const plan = JSON.parse(row.plan);
  expect(readFileSync(join(complete, 'data', plan.files[0].backup), 'utf8')).toBe(
    f.original.content,
  );
  const { restore } = await import('../apps/server/backup'),
    { openDatabase } = await import('../packages/core/db'),
    { noteService } = await import('../packages/core/notes');
  const restoredConfig = {
    ...f.config,
    knowledgeRoot: join(f.root, 'restored-knowledge'),
    dataRoot: join(f.root, 'restored-data'),
  };
  await restore(complete, restoredConfig);
  const db = openDatabase(restoredConfig.dataRoot);
  try {
    const notes = noteService(restoredConfig, db);
    notes.scan();
    const primary = primaryDiagramService(
      restoredConfig,
      db,
      notes,
      assetService(restoredConfig, db, notes),
      webPrincipal,
    );
    expect(notes.row(f.original.id).path).toBe('Restored/board.md');
    expect(primary.resolve(f.original.id).source.hash).toBe(fixed.sourceHash);
    expect(primary.resolve(f.original.id).preview?.state).toBe('ready');
  } finally {
    db.close();
  }
});
it('preserves a rewritten active ordinary backlink changed after directory rename and refuses activation/index publication', async () => {
  const f = await fixture(true);
  await f.prepare();
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/folder-native-restore-child.ts',
      JSON.stringify(f.config),
      f.archived.id,
      'Restored',
      f.requestId,
      'directory_renamed',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  const incoming = join(f.config.knowledgeRoot, 'Topic/incoming.md');
  writeFileSync(incoming, '# External after rename');
  await expect(
    workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
      recoverFolders(f.config, f.db),
    ),
  ).rejects.toMatchObject({ code: 'TRASH_CHANGED' });
  expect(readFileSync(incoming, 'utf8')).toBe('# External after rename');
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
    active: 0,
  });
  expect(
    (
      f.db
        .prepare('SELECT content_hash FROM document_state WHERE note_id=?')
        .get(f.plain!.noteId) as { content_hash?: string } | undefined
    )?.content_hash,
  ).not.toBe(sha256('# Incoming\n\n[Inside](../Restored/inside.md)'));
});
it('does not accept altered active ordinary bytes even when their owned publication timestamp is restored exactly', async () => {
  const f = await fixture(true);
  await f.prepare();
  const { spawnSync } = await import('node:child_process'),
    { utimesSync, lstatSync } = await import('node:fs');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/folder-native-restore-child.ts',
      JSON.stringify(f.config),
      f.archived.id,
      'Restored',
      f.requestId,
      'directory_renamed_known_time',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  const raw = f.db
      .prepare(
        'SELECT p.plan FROM folder_native_restore_plans p JOIN folder_trash f ON f.operation_id=p.operation_id WHERE f.id=?',
      )
      .get(f.archived.id) as { plan: string },
    entry = JSON.parse(raw.plan).files.find((v: any) => v.path === 'Topic/incoming.md');
  const incoming = join(f.config.knowledgeRoot, entry.path);
  writeFileSync(incoming, '# Forged current ordinary content');
  utimesSync(incoming, 1000000000, 1000000000);
  expect(lstatSync(incoming, { bigint: true }).mtimeNs.toString()).toBe(
    entry.publicationEvidence.mtime,
  );
  await expect(
    workspaceExclusive(f.db, { kind: 'folder.recover', recovery: true }, async () =>
      recoverFolders(f.config, f.db),
    ),
  ).rejects.toMatchObject({ code: 'TRASH_CHANGED' });
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.original.id)).toEqual({
    active: 0,
  });
  expect(readFileSync(incoming, 'utf8')).toBe('# Forged current ordinary content');
});
