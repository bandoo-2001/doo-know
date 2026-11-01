import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { whiteboardMigrationService } from '../packages/core/knowledge/whiteboard-migrations';
import { emptyWhiteboard } from '../shared/whiteboard';
import { resolveWhiteboardResource } from '../packages/core/knowledge/diagram-resource-resolver';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { sha256 } from '../packages/core/knowledge/operations';
import { markdown } from '../packages/core/render';
import type { AppConfig } from '../shared/contracts';
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-migration-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test',
    origin: 'http://localhost',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function setup(source = JSON.stringify(emptyWhiteboard())) {
  const notes = noteService(config, db);
  const old = notes.createNote('00-Inbox', 'drawing.excalidraw', source);
  const assets = assetService(config, db, notes);
  return {
    notes,
    old,
    service: whiteboardMigrationService(config, db, notes, assets, webPrincipal),
  };
}
function prepare(f: ReturnType<typeof setup>) {
  const plan = f.service.plan({ noteId: f.old.id, requestId: randomUUID() });
  return f.service.prepare({
    migrationId: plan.id,
    sourceHash: plan.sourceHash,
    pngBase64,
    requestId: randomUUID(),
  });
}
it('keeps the same UUID, favorites and old-path resolution while preserving the original outside the scanner', () => {
  const f = setup();
  db.prepare('INSERT INTO note_favorites VALUES(?,?)').run('owner', f.old.id);
  const prepared = prepare(f);
  expect(f.notes.getNote(f.old.id).relativePath).toMatch(/excalidraw$/);
  const requestId = randomUUID();
  const result = f.service.commit({ migrationId: prepared.id, requestId });
  expect(result.noteId).toBe(f.old.id);
  expect(f.notes.getNote(f.old.id)).toMatchObject({
    relativePath: '00-Inbox/drawing.md',
    documentType: 'whiteboard',
  });
  expect(db.prepare('SELECT note_id FROM note_favorites').get()).toEqual({ note_id: f.old.id });
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.excalidraw'))).toBe(false);
  expect(readFileSync(join(config.dataRoot, result.backupPath), 'utf8')).toBe(f.old.content);
  expect(
    resolveWhiteboardResource(
      config,
      db,
      f.notes,
      webPrincipal,
      '00-Inbox/inbound.md',
      'drawing.excalidraw',
    ).noteId,
  ).toBe(f.old.id);
  expect(f.service.commit({ migrationId: prepared.id, requestId })).toEqual(result);
  f.notes.scan();
  expect(db.prepare('SELECT count(*) count FROM notes WHERE active=1').get()).toEqual({ count: 1 });
  expect(() =>
    mutationCore(config, db).update(
      webPrincipal,
      f.old.id,
      f.old.content,
      f.old.modifiedAt,
      randomUUID(),
    ),
  ).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
});
it('rebases the exact final native source before PNG preparation and preserves unknown scene fields', () => {
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    future: { custom: true },
    elements: [{ id: 'link', type: 'text', text: 'target', link: 'target.md#part' }],
  });
  const f = setup(source);
  writeFileSync(join(config.knowledgeRoot, '00-Inbox/target.md'), '# Target');
  const plan = f.service.plan({ noteId: f.old.id, requestId: randomUUID() });
  expect(JSON.parse(plan.source)).toMatchObject({
    future: { custom: true },
    elements: [{ link: '../target.md#part' }],
  });
  expect(plan.sourceHash).toBe(sha256(plan.source));
  expect(() =>
    f.service.prepare({
      migrationId: plan.id,
      sourceHash: sha256(source),
      pngBase64,
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }));
});
it('reports target conflicts, unknown scene versions and missing dependencies without changing originals', () => {
  const f = setup();
  writeFileSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'), 'existing');
  expect(f.service.preflight(f.old.id).issues).toContainEqual(
    expect.objectContaining({ code: 'NAME_CONFLICT' }),
  );
  expect(() => f.service.plan({ noteId: f.old.id, requestId: randomUUID() })).toThrow();
  unlinkSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'));
  writeFileSync(
    join(config.knowledgeRoot, f.old.relativePath),
    JSON.stringify({ ...emptyWhiteboard(), version: 99 }),
  );
  expect(f.service.preflight(f.old.id).issues).toContainEqual(
    expect.objectContaining({ code: 'DIAGRAM_SOURCE_VERSION_UNSUPPORTED' }),
  );
  writeFileSync(
    join(config.knowledgeRoot, f.old.relativePath),
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'x', type: 'text', link: 'missing.md' }],
    }),
  );
  expect(f.service.preflight(f.old.id).issues).toContainEqual(
    expect.objectContaining({ code: 'MISSING_REFERENCE' }),
  );
});
it('rewrites inbound standard links and upgrades private embeds to portable PNG plus main-document links', () => {
  const f = setup();
  const inbound = f.notes.createNote(
    '00-Inbox',
    'inbound.md',
    '[Board](drawing.excalidraw)\n\n```excalidraw\ndrawing.excalidraw\n```\n',
  );
  const p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const content = f.notes.getNote(inbound.id).content;
  expect(content).toContain('[Board](drawing.md)');
  expect(content).toMatch(/!\[.*\]\(assets\/.*\.png\)/);
  expect(content).toContain('[白板文档](drawing.md)');
});
it('preserves the label and navigation of inbound wiki links during migration', () => {
  const f = setup();
  const inbound = f.notes.createNote(
    '00-Inbox',
    'inbound.md',
    'See [[drawing.excalidraw#heading|Custom *Board* Label]]\n',
  );
  const p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  expect(markdown.render(f.notes.getNote(inbound.id).content)).toContain(
    '<a href="drawing.md#heading">Custom *Board* Label</a>',
  );
});
it('refuses changed baselines and missing prepared PNG, then resumes without duplicate identities', async () => {
  const f = setup();
  const p = prepare(f);
  unlinkSync(join(config.knowledgeRoot, p.prepared!.preview.relativePath));
  expect(() => f.service.commit({ migrationId: p.id, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }),
  );
  expect(f.notes.getNote(f.old.id).relativePath).toBe(f.old.relativePath);
});
it('rolls back only unchanged migrated documents and keeps both versions when edited', () => {
  const f = setup();
  const p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const doc = f.notes.getNote(f.old.id);
  f.notes.saveNote(f.old.id, doc.content + '\nEdited\n', doc.modifiedAt);
  expect(() => f.service.rollback({ migrationId: p.id, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'MIGRATION_ROLLBACK_CONFLICT' }),
  );
  expect(f.notes.getNote(f.old.id).content).toContain('Edited');
  expect(
    existsSync(join(config.dataRoot, 'whiteboard-migrations', p.id, 'original.excalidraw')),
  ).toBe(true);
});
it('rolls back an unchanged migration with stable identity and leaves its generated Markdown in controlled recovery storage', () => {
  const f = setup();
  const p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  f.service.rollback({ migrationId: p.id, requestId: randomUUID() });
  expect(f.notes.getNote(f.old.id)).toMatchObject({
    relativePath: f.old.relativePath,
    content: f.old.content,
  });
  f.notes.scan();
  expect(db.prepare('SELECT count(*) count FROM notes WHERE active=1').get()).toEqual({ count: 1 });
});

it('recovers a cutover interrupted after target publication without registering another note', async () => {
  const f = setup(),
    p = prepare(f),
    requestId = randomUUID();
  const originalPrepare = db.prepare.bind(db);
  let interrupted = false;
  db.prepare = ((sql: string) => {
    if (!interrupted && sql.startsWith('UPDATE notes SET path=?,active=1')) {
      interrupted = true;
      throw Error('simulated record interruption');
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  expect(() => f.service.commit({ migrationId: p.id, requestId })).toThrow(
    'simulated record interruption',
  );
  db.prepare = originalPrepare;
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'))).toBe(true);
  expect(f.notes.getNote(f.old.id).relativePath).toBe(f.old.relativePath);
  f.notes.scan();
  expect(db.prepare('SELECT count(*) count FROM notes WHERE active=1').get()).toEqual({ count: 1 });
  const report = await mutationCore(config, db).recover();
  expect(report.recovered).toBe(1);
  const result = f.service.commit({ migrationId: p.id, requestId });
  expect(result.status).toBe('committed');
  expect(f.notes.getNote(f.old.id).relativePath).toBe('00-Inbox/drawing.md');
  expect(db.prepare('SELECT count(*) count FROM revisions WHERE note_id=?').get(f.old.id)).toEqual({
    count: 1,
  });
});
it('never completes interrupted publication when the fixed source has disappeared', async () => {
  const f = setup(),
    p = prepare(f),
    requestId = randomUUID(),
    originalPrepare = db.prepare.bind(db);
  let interrupted = false;
  db.prepare = ((sql: string) => {
    if (!interrupted && sql.startsWith('UPDATE notes SET path=?,active=1')) {
      interrupted = true;
      throw Error('interrupted');
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  expect(() => f.service.commit({ migrationId: p.id, requestId })).toThrow();
  db.prepare = originalPrepare;
  unlinkSync(join(config.knowledgeRoot, p.prepared!.source!.relativePath));
  expect((await mutationCore(config, db).recover()).conflicted).toBe(1);
  expect(f.notes.getNote(f.old.id).relativePath).toBe(f.old.relativePath);
  expect(() => f.service.resume(p.id)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }),
  );
});
it('blocks new note creation at a planned destination and binds retries to parameters', () => {
  const f = setup(),
    requestId = randomUUID(),
    plan = f.service.plan({ noteId: f.old.id, requestId });
  expect(() => f.notes.createNote('00-Inbox', 'drawing.md', 'ordinary')).toThrowError(
    expect.objectContaining({ code: 'NAME_CONFLICT' }),
  );
  expect(f.service.plan({ noteId: f.old.id, requestId }).id).toBe(plan.id);
  const other = f.notes.createNote(
    '00-Inbox',
    'other.excalidraw',
    JSON.stringify(emptyWhiteboard()),
  );
  expect(() => f.service.plan({ noteId: other.id, requestId })).toThrowError(
    expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
  );
});
it('keeps an affected native inbound document explicitly pending before cutover', () => {
  const f = setup();
  f.notes.createNote(
    '00-Inbox',
    'inbound.excalidraw',
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'x', type: 'text', link: 'drawing.excalidraw' }],
    }),
  );
  const plan = f.service.plan({ noteId: f.old.id, requestId: randomUUID() });
  expect(plan.status).toBe('awaiting-native-previews');
  expect(
    f.service.prepare({
      migrationId: plan.id,
      sourceHash: plan.sourceHash,
      pngBase64,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 'awaiting-native-previews' });
  expect(f.notes.getNote(f.old.id).relativePath).toBe(f.old.relativePath);
});
it('checks current rights when resolving an old alias instead of reusing the old path grant', () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const reader = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: [f.old.relativePath] };
  expect(() =>
    resolveWhiteboardResource(
      config,
      db,
      f.notes,
      reader,
      '00-Inbox/parent.md',
      'drawing.excalidraw',
    ),
  ).toThrowError(expect.objectContaining({ statusCode: 403 }));
});
it('recovers rollback interrupted after recreating the original main file', async () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const originalPrepare = db.prepare.bind(db);
  let interrupted = false;
  db.prepare = ((sql: string) => {
    if (!interrupted && sql.startsWith('UPDATE notes SET path=?,active=1')) {
      interrupted = true;
      throw Error('rollback record interruption');
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  expect(() => f.service.rollback({ migrationId: p.id, requestId: randomUUID() })).toThrow(
    'rollback record interruption',
  );
  db.prepare = originalPrepare;
  f.notes.scan();
  expect(db.prepare('SELECT count(*) count FROM notes WHERE active=1').get()).toEqual({ count: 1 });
  expect((await mutationCore(config, db).recover()).recovered).toBe(1);
  expect(f.notes.getNote(f.old.id)).toMatchObject({
    relativePath: f.old.relativePath,
    content: f.old.content,
  });
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'))).toBe(false);
});
it('restores version-protected inbound Markdown when rolling back and refuses changed inbound copies', () => {
  const f = setup();
  const inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Board](drawing.excalidraw)\n');
  const p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  f.service.rollback({ migrationId: p.id, requestId: randomUUID() });
  expect(f.notes.getNote(inbound.id).content).toBe(inbound.content);
});
it.each(['writing', 'pending'])('reconciles a %s inbound receipt before rollback', (status) => {
  const f = setup(),
    inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Board](drawing.excalidraw)\n'),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  // A crash can retain the previous journal marker after the versioned writer committed.
  const refs = JSON.parse(
    (db.prepare('SELECT references_json FROM whiteboard_migrations WHERE id=?').get(p.id) as any)
      .references_json,
  );
  refs[0].status = status;
  db.prepare(
    "UPDATE whiteboard_migrations SET references_json=?,status='references_pending' WHERE id=?",
  ).run(JSON.stringify(refs), p.id);
  expect(f.service.rollback({ migrationId: p.id, requestId: randomUUID() }).status).toBe(
    'rolled_back',
  );
  expect(f.notes.getNote(inbound.id).content).toBe('[Board](drawing.excalidraw)\n');
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'))).toBe(false);
});
it.each(['writing', 'pending'])(
  'protects later edits behind a %s inbound receipt during rollback',
  (status) => {
    const f = setup(),
      inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Board](drawing.excalidraw)\n'),
      p = prepare(f);
    f.service.commit({ migrationId: p.id, requestId: randomUUID() });
    const refs = JSON.parse(
      (db.prepare('SELECT references_json FROM whiteboard_migrations WHERE id=?').get(p.id) as any)
        .references_json,
    );
    refs[0].status = status;
    db.prepare(
      "UPDATE whiteboard_migrations SET references_json=?,status='references_pending' WHERE id=?",
    ).run(JSON.stringify(refs), p.id);
    const current = f.notes.getNote(inbound.id);
    f.notes.saveNote(inbound.id, current.content + 'Later edit\n', current.modifiedAt);
    expect(() => f.service.rollback({ migrationId: p.id, requestId: randomUUID() })).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_ROLLBACK_CONFLICT' }),
    );
    expect(f.notes.getNote(inbound.id).content).toContain('Later edit');
    expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'))).toBe(true);
  },
);
it('refuses rollback while an attempted inbound rewrite still has an unknown outcome', () => {
  const f = setup(),
    inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Board](drawing.excalidraw)\n'),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const refs = JSON.parse(
    (db.prepare('SELECT references_json FROM whiteboard_migrations WHERE id=?').get(p.id) as any)
      .references_json,
  );
  refs[0].status = 'writing';
  db.prepare(
    "UPDATE whiteboard_migrations SET references_json=?,status='references_pending' WHERE id=?",
  ).run(JSON.stringify(refs), p.id);
  db.prepare(
    "UPDATE operations SET status='prepared',result=NULL WHERE kind='update' AND request_id=?",
  ).run('migration-ref-' + p.id + '-' + inbound.id);
  expect(() => f.service.rollback({ migrationId: p.id, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'MIGRATION_ROLLBACK_CONFLICT' }),
  );
  expect(f.notes.getNote(inbound.id).content).toBe('[Board](drawing.md)\n');
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/drawing.md'))).toBe(true);
});
it('backs up and restores the authoritative original, journal and stable alias', async () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const { backup, restore } = await import('../apps/server/backup');
  const destination = join(root, 'backup'),
    restored = {
      ...config,
      knowledgeRoot: join(root, 'restored-knowledge'),
      dataRoot: join(root, 'restored-data'),
    };
  await backup(config, destination);
  await restore(destination, restored);
  const restoredDb = openDatabase(restored.dataRoot);
  try {
    const notes = noteService(restored, restoredDb);
    notes.scan();
    expect(notes.getNote(f.old.id).relativePath).toBe('00-Inbox/drawing.md');
    expect(readFileSync(join(restored.dataRoot, p.backupPath), 'utf8')).toBe(f.old.content);
    expect(
      resolveWhiteboardResource(
        restored,
        restoredDb,
        notes,
        webPrincipal,
        '00-Inbox/readme.md',
        'drawing.excalidraw',
      ).noteId,
    ).toBe(f.old.id);
    const service = whiteboardMigrationService(
      restored,
      restoredDb,
      notes,
      assetService(restored, restoredDb, notes),
      webPrincipal,
    );
    service.rollback({ migrationId: p.id, requestId: randomUUID() });
    expect(notes.getNote(f.old.id).content).toBe(f.old.content);
  } finally {
    restoredDb.close();
  }
});
it('rebuilds stable identities and old-path aliases from portable library data', () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  const other = openDatabase(join(root, 'rebuilt-data'));
  try {
    const cfg = { ...config, dataRoot: join(root, 'rebuilt-data') },
      notes = noteService(cfg, other);
    notes.scan();
    expect(notes.getNote(f.old.id).relativePath).toBe('00-Inbox/drawing.md');
    expect(
      resolveWhiteboardResource(
        cfg,
        other,
        notes,
        webPrincipal,
        '00-Inbox/readme.md',
        'drawing.excalidraw',
      ).noteId,
    ).toBe(f.old.id);
  } finally {
    other.close();
  }
});
it('resumes a prepared migration after verified backup restoration to a different directory', async () => {
  const f = setup(),
    p = prepare(f),
    { backup, restore } = await import('../apps/server/backup'),
    destination = join(root, 'prepared-backup'),
    restored = {
      ...config,
      knowledgeRoot: join(root, 'restored-prepared-knowledge'),
      dataRoot: join(root, 'restored-prepared-data'),
    };
  await backup(config, destination);
  await restore(destination, restored);
  const other = openDatabase(restored.dataRoot);
  try {
    const notes = noteService(restored, other),
      service = whiteboardMigrationService(
        restored,
        other,
        notes,
        assetService(restored, other, notes),
        webPrincipal,
      );
    expect(service.commit({ migrationId: p.id, requestId: randomUUID() }).status).toBe('committed');
    expect(notes.getNote(f.old.id).relativePath).toBe('00-Inbox/drawing.md');
  } finally {
    other.close();
  }
});
it('preserves real ToDoo task source and material references under the stable migrated UUID', async () => {
  const f = setup(),
    { createToDooService } = await import('../packages/core/to-doo/service'),
    todo = createToDooService(config, db, f.notes);
  try {
    const task = todo.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: {
        title: 'Use board',
        source: { noteId: f.old.id, quote: 'Board source' },
        noteRefs: [{ noteId: f.old.id, role: 'material' }],
      },
    });
    const before = todo.snapshot().tasks.find((t) => t.id === task.ids[0]);
    expect(before?.source?.noteId).toBe(f.old.id);
    const p = prepare(f);
    f.service.commit({ migrationId: p.id, requestId: randomUUID() });
    const after = todo.snapshot().tasks.find((t) => t.id === task.ids[0]);
    expect(after?.source).toEqual(before?.source);
    expect(after?.noteRefs).toEqual(before?.noteRefs);
    expect(f.notes.getNote(after!.noteRefs[0].noteId).relativePath).toBe('00-Inbox/drawing.md');
  } finally {
    todo.close();
  }
});
it('resumes a reference rewrite interrupted after its ordinary writer committed', () => {
  const f = setup(),
    inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Board](drawing.excalidraw)\n'),
    p = prepare(f),
    originalPrepare = db.prepare.bind(db);
  let interrupted = false;
  db.prepare = ((sql: string) => {
    if (
      !interrupted &&
      sql.startsWith('UPDATE whiteboard_migrations SET references_json') &&
      f.notes.getNote(inbound.id).content === '[Board](drawing.md)\n'
    ) {
      interrupted = true;
      throw Error('reference journal interruption');
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  expect(() => f.service.commit({ migrationId: p.id, requestId: randomUUID() })).toThrow(
    'reference journal interruption',
  );
  db.prepare = originalPrepare;
  expect(f.service.resume(p.id)).toMatchObject({
    status: 'committed',
    references: [{ noteId: inbound.id, status: 'rewritten' }],
  });
  expect(
    db.prepare('SELECT count(*) count FROM revisions WHERE note_id=?').get(inbound.id),
  ).toEqual({ count: 1 });
});
it('prevents indexing reconciliation from discovering a retired original as another note', async () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  writeFileSync(join(config.knowledgeRoot, f.old.relativePath), f.old.content);
  const { reconcileService } = await import('../packages/core/indexing/reconcile');
  await reconcileService(config, db).reconcile();
  expect(db.prepare('SELECT count(*) count FROM notes WHERE active=1').get()).toEqual({ count: 1 });
  expect(f.notes.getNote(f.old.id).relativePath).toBe('00-Inbox/drawing.md');
});
it('rechecks newly added native inbound links before cutover instead of publishing a broken native graph', () => {
  const f = setup(),
    p = prepare(f);
  f.notes.createNote(
    '00-Inbox',
    'late-native.excalidraw',
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'late', type: 'text', link: 'drawing.excalidraw' }],
    }),
  );
  expect(f.service.commit({ migrationId: p.id, requestId: randomUUID() })).toMatchObject({
    status: 'awaiting-native-previews',
  });
  expect(f.notes.getNote(f.old.id).relativePath).toBe(f.old.relativePath);
});
it('records migration and rollback history under the original UUID with their actual format and logical resource context', () => {
  const f = setup(),
    p = prepare(f);
  f.service.commit({ migrationId: p.id, requestId: randomUUID() });
  f.service.rollback({ migrationId: p.id, requestId: randomUUID() });
  const revisions = db
    .prepare(
      'SELECT note_id,document_type,payload_format,logical_path,content_hash,resources_manifest FROM revisions WHERE note_id=? ORDER BY rowid',
    )
    .all(f.old.id) as any[];
  expect(revisions).toHaveLength(2);
  expect(revisions[0]).toMatchObject({
    note_id: f.old.id,
    document_type: 'whiteboard',
    payload_format: 'excalidraw',
    logical_path: f.old.relativePath,
    content_hash: sha256(f.old.content),
  });
  expect(revisions[1]).toMatchObject({
    note_id: f.old.id,
    document_type: 'whiteboard',
    payload_format: 'markdown',
    logical_path: '00-Inbox/drawing.md',
  });
  expect(JSON.parse(revisions[1].resources_manifest)).toHaveLength(2);
});
