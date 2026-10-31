import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { whiteboardMigrationService } from '../packages/core/knowledge/whiteboard-migrations';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramArtifactService } from '../packages/core/knowledge/diagram-artifacts';
import { legacyDiagramPreviewService } from '../packages/core/knowledge/legacy-diagram-previews';
import { webPrincipal } from '../packages/core/knowledge/core';
import { beginOperation, sha256 } from '../packages/core/knowledge/operations';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { renderPortableFigure } from '../shared/portable-figure';
import {
  serializeDiagramBinding,
  boundDiagramSources,
  normalizeDiagramCode,
} from '../shared/diagram-portability';
import type { AppConfig } from '../shared/contracts';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migration-native-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost',
    secret: 'test',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes),
    main = notes.createNote('00-Inbox', 'drawing.excalidraw', JSON.stringify(emptyWhiteboard())),
    primary = primaryDiagramService(config, db, notes, assets, webPrincipal),
    service = whiteboardMigrationService(config, db, notes, assets, webPrincipal),
    registry = diagramOperationPreviewRegistry(config, db, webPrincipal, assets);
  return { notes, assets, main, primary, service, registry };
}
function source(link: string) {
  return JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'a', type: 'rectangle', link }],
    future: { retained: true },
  });
}
function inboundPrimary(f: ReturnType<typeof fixture>) {
  const intent = diagramCreationService(config, db, webPrincipal).reserve({
      path: '00-Inbox/inbound.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    scene = source('../drawing.excalidraw'),
    p = f.primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source: scene,
      sourceHash: sha256(scene),
      title: 'Inbound',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    }),
    note = f.primary.commit({
      preparedId: p.id,
      markdown: renderPreparedDiagramDocument({ prepared: p, title: 'Inbound', source: scene }),
      requestId: randomUUID(),
    });
  return { note, p };
}
function prepareNeeds(f: ReturnType<typeof fixture>, job: any) {
  for (const need of job.nativePreviewNeeds || []) {
    const snapshot = f.registry.get(need.snapshotId);
    f.registry.prepare(need.snapshotId, {
      sourceHash: snapshot.sourceHash,
      pngBase64: png,
      requestId: 'migration-native-' + need.snapshotId,
    });
  }
  return f.service.resume(job.id);
}
function prepareMain(f: ReturnType<typeof fixture>, job: any) {
  return f.service.prepare({
    migrationId: job.id,
    sourceHash: job.sourceHash,
    pngBase64: png,
    requestId: randomUUID(),
  });
}
it('prepares every native primary and legacy inbound before cutover, retains fixed originals and rolls back matching previews', () => {
  const f = fixture(),
    primary = inboundPrimary(f),
    legacy = f.notes.createNote('00-Inbox', 'legacy.excalidraw', source('drawing.excalidraw')),
    beforeLegacy = legacy.content;
  let job = f.service.plan({ noteId: f.main.id, requestId: randomUUID() });
  expect(job.nativePreviewNeeds?.length).toBeGreaterThanOrEqual(2);
  expect(f.notes.getNote(f.main.id).relativePath).toBe(f.main.relativePath);
  job = prepareNeeds(f, job);
  expect(job.nativePreviewNeeds).toHaveLength(0);
  job = prepareMain(f, job);
  const result = f.service.commit({ migrationId: job.id, requestId: randomUUID() });
  expect(result.status).toBe('committed');
  expect(f.primary.resolve(primary.note.id).preview!.state).toBe('ready');
  expect(JSON.parse(f.primary.resolve(primary.note.id).source.content!).elements[0].link).toBe(
    '../drawing.md',
  );
  expect(JSON.parse(f.notes.getNote(legacy.id).content).elements[0].link).toBe('drawing.md');
  expect(f.primary.resolve(legacy.id).preview!.state).toBe('ready');
  f.service.rollback({ migrationId: job.id, requestId: randomUUID() });
  expect(f.notes.getNote(legacy.id).content).toBe(beforeLegacy);
  expect(f.primary.resolve(legacy.id).preview!.state).toBe('ready');
  expect(f.notes.getNote(primary.note.id).content).toBe(primary.note.content);
  expect(f.primary.resolve(primary.note.id).preview!.state).toBe('ready');
});
it('prepares ordinary embedded native pairs and retains durable binding authority after migration and rollback', () => {
  const f = fixture(),
    note = f.notes.createNote('00-Inbox', 'embedded.md', '# Embedded'),
    scene = source('../drawing.excalidraw'),
    pair = diagramArtifactService(db, f.notes, f.assets, webPrincipal).prepare(note.id, {
      kind: 'excalidraw',
      source: scene,
      sourceHash: sha256(scene),
      pngBase64: png,
      requestId: randomUUID(),
    }),
    code = JSON.stringify({ source: pair.source.markdownPath }),
    content =
      renderPortableFigure({
        alt: 'EXCALIDRAW 预览',
        previewPath: pair.preview.markdownPath,
        source: { type: 'file', path: pair.source.markdownPath },
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
  f.notes.saveNote(note.id, content, note.modifiedAt);
  let job = f.service.plan({ noteId: f.main.id, requestId: randomUUID() });
  expect(job.nativePreviewNeeds).toHaveLength(1);
  job = prepareNeeds(f, job);
  job = prepareMain(f, job);
  expect(f.service.commit({ migrationId: job.id, requestId: randomUUID() }).status).toBe(
    'committed',
  );
  const saved = f.notes.getNote(note.id),
    group = boundDiagramSources(saved.content)[0];
  expect(group, saved.content).toBeTruthy();
  expect(group.binding.sourceHash).not.toBe(pair.sourceHash);
  const native = readFileSync(join(config.knowledgeRoot, '00-Inbox', group.sourcePath), 'utf8');
  expect(JSON.parse(native).elements[0].link).toBe('../drawing.md');
  expect(
    db
      .prepare(
        "SELECT 1 FROM operations WHERE kind=? AND status='succeeded' AND json_extract(result,'$.sourceHash')=?",
      )
      .get('diagram-artifacts:' + note.id, group.binding.sourceHash),
  ).toBeTruthy();
  f.service.rollback({ migrationId: job.id, requestId: randomUUID() });
  expect(f.notes.getNote(note.id).content).toBe(content);
});
it('discovers late native arrivals as a new stable preview plan and keeps the old target live', () => {
  const f = fixture();
  let job = prepareMain(f, f.service.plan({ noteId: f.main.id, requestId: randomUUID() }));
  const inbound = inboundPrimary(f);
  job = f.service.commit({ migrationId: job.id, requestId: randomUUID() });
  expect(job.status).toBe('awaiting-native-previews');
  expect(job.nativePreviewNeeds).toHaveLength(1);
  expect(f.notes.getNote(f.main.id).relativePath).toBe(f.main.relativePath);
  const first = job.nativePreviewNeeds![0].snapshotId;
  expect(f.service.resume(job.id).nativePreviewNeeds![0].snapshotId).toBe(first);
  job = prepareNeeds(f, job);
  expect(f.service.commit({ migrationId: job.id, requestId: randomUUID() }).status).toBe(
    'committed',
  );
  expect(f.primary.resolve(inbound.note.id).preview!.state).toBe('ready');
});
it.each(['legacy', 'primary', 'embedded', 'ordinary'] as const)(
  'rebuilds an unconsumed %s inbound rewrite after cutover interruption without losing later edits',
  (kind) => {
    const f = fixture();
    let inbound;
    if (kind === 'legacy')
      inbound = f.notes.createNote('00-Inbox', 'inbound.excalidraw', source('drawing.excalidraw'));
    else if (kind === 'primary') inbound = inboundPrimary(f).note;
    else if (kind === 'ordinary')
      inbound = f.notes.createNote('00-Inbox', 'inbound.md', '[Drawing](drawing.excalidraw)');
    else {
      inbound = f.notes.createNote('00-Inbox', 'inbound.md', '# Embedded');
      const scene = source('../drawing.excalidraw'),
        pair = diagramArtifactService(db, f.notes, f.assets, webPrincipal).prepare(inbound.id, {
          kind: 'excalidraw',
          source: scene,
          sourceHash: sha256(scene),
          pngBase64: png,
          requestId: randomUUID(),
        }),
        code = pair.source.markdownPath,
        content =
          renderPortableFigure({
            alt: 'EXCALIDRAW 预览',
            previewPath: pair.preview.markdownPath,
            source: { type: 'file', path: code },
          }) +
          '\n' +
          serializeDiagramBinding({
            kind: 'excalidraw',
            sourceHash: pair.sourceHash,
            codeHash: sha256(code),
          }) +
          '\n\n```excalidraw\n' +
          code +
          '\n```\n';
      inbound = f.notes.saveNote(inbound.id, content, inbound.modifiedAt);
    }
    let job = prepareMain(
      f,
      prepareNeeds(f, f.service.plan({ noteId: f.main.id, requestId: randomUUID() })),
    );
    db.exec(
      "CREATE TRIGGER stop_cutover BEFORE INSERT ON write_intents WHEN NEW.kind='whiteboard-migrate' BEGIN SELECT RAISE(FAIL,'cutover interrupted'); END",
    );
    expect(() => f.service.commit({ migrationId: job.id, requestId: randomUUID() })).toThrow(
      'cutover interrupted',
    );
    db.exec('DROP TRIGGER stop_cutover');
    const current = f.notes.getNote(inbound.id),
      changed =
        kind === 'legacy'
          ? JSON.stringify({ ...JSON.parse(current.content), userEdit: 'keep this edit' })
          : current.content + '\nKeep this user edit.\n';
    f.notes.saveNote(current.id, changed, current.modifiedAt);
    const edited = f.notes.getNote(current.id).content;
    job = prepareNeeds(f, f.service.resume(job.id));
    expect(f.service.commit({ migrationId: job.id, requestId: randomUUID() }).status).toBe(
      'committed',
    );
    expect(f.notes.getNote(current.id).content).toContain(
      kind === 'legacy' ? 'keep this edit' : 'Keep this user edit.',
    );
    if (kind === 'legacy' || kind === 'primary')
      expect(f.primary.resolve(current.id).preview!.state).toBe('ready');
    f.service.rollback({ migrationId: job.id, requestId: randomUUID() });
    expect(f.notes.getNote(current.id).content).toBe(edited);
    if (kind === 'legacy' || kind === 'primary')
      expect(f.primary.resolve(current.id).preview!.state).toBe('ready');
  },
);
it('keeps an unconsumed reference journal when its stable writer has an unknown outcome', () => {
  const f = fixture(),
    inbound = inboundPrimary(f);
  const job = prepareMain(
    f,
    prepareNeeds(f, f.service.plan({ noteId: f.main.id, requestId: randomUUID() })),
  );
  db.exec(
    "CREATE TRIGGER stop_cutover BEFORE INSERT ON write_intents WHEN NEW.kind='whiteboard-migrate' BEGIN SELECT RAISE(FAIL,'cutover interrupted'); END",
  );
  expect(() => f.service.commit({ migrationId: job.id, requestId: randomUUID() })).toThrow(
    'cutover interrupted',
  );
  db.exec('DROP TRIGGER stop_cutover');
  beginOperation(db, webPrincipal, 'update', 'migration-ref-' + job.id + '-' + inbound.note.id, {});
  const before = db
    .prepare('SELECT references_json FROM whiteboard_migrations WHERE id=?')
    .get(job.id);
  expect(() => f.service.resume(job.id)).toThrowError(
    expect.objectContaining({ code: 'REFERENCE_CONFLICT' }),
  );
  expect(
    db.prepare('SELECT references_json FROM whiteboard_migrations WHERE id=?').get(job.id),
  ).toEqual(before);
  expect(f.notes.getNote(inbound.note.id).content).toBe(inbound.note.content);
  expect(f.notes.getNote(f.main.id).relativePath).toBe(f.main.relativePath);
});
it('keeps cutover inactive if any fixed native preview disappears', () => {
  const f = fixture();
  inboundPrimary(f);
  let job = f.service.plan({ noteId: f.main.id, requestId: randomUUID() }),
    need = job.nativePreviewNeeds![0];
  job = prepareNeeds(f, job);
  job = prepareMain(f, job);
  const p = f.registry.prepared(need.snapshotId)!;
  unlinkSync(join(config.knowledgeRoot, p.preview.relativePath));
  expect(() => f.service.commit({ migrationId: job.id, requestId: randomUUID() })).toThrow();
  expect(f.notes.getNote(f.main.id).relativePath).toBe(f.main.relativePath);
});
it('resumes persisted native rewrites after restart and expired registry leases without re-reading changed old baselines', () => {
  const f = fixture(),
    inbound = inboundPrimary(f);
  let job = f.service.plan({ noteId: f.main.id, requestId: randomUUID() });
  job = prepareNeeds(f, job);
  job = prepareMain(f, job);
  db.exec(
    "CREATE TRIGGER stop_native_writer BEFORE INSERT ON operations WHEN NEW.kind='update' AND NEW.request_id LIKE 'migration-ref-%' BEGIN SELECT RAISE(FAIL,'writer interrupted'); END",
  );
  expect(f.service.commit({ migrationId: job.id, requestId: randomUUID() }).status).toBe(
    'references_pending',
  );
  db.exec('DROP TRIGGER stop_native_writer');
  db.prepare('UPDATE diagram_operation_previews SET expires_at=0').run();
  db.prepare('UPDATE diagram_prepared_primaries SET expires_at=0 WHERE note_id=?').run(
    inbound.note.id,
  );
  const reopened = whiteboardMigrationService(config, db, f.notes, f.assets, webPrincipal);
  expect(reopened.resume(job.id).status).toBe('committed');
  expect(f.primary.resolve(inbound.note.id).preview!.state).toBe('ready');
});
it('rejects rollback when a native inbound has later edits and keeps both versions', () => {
  const f = fixture(),
    inbound = inboundPrimary(f);
  let job = f.service.plan({ noteId: f.main.id, requestId: randomUUID() });
  job = prepareMain(f, prepareNeeds(f, job));
  f.service.commit({ migrationId: job.id, requestId: randomUUID() });
  const doc = f.notes.getNote(inbound.note.id);
  f.notes.saveNote(doc.id, doc.content + '\nLater prose\n', doc.modifiedAt);
  expect(() => f.service.rollback({ migrationId: job.id, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'MIGRATION_ROLLBACK_CONFLICT' }),
  );
  expect(f.notes.getNote(inbound.note.id).content).toContain('Later prose');
  expect(f.notes.getNote(f.main.id).relativePath).toBe('00-Inbox/drawing.md');
});
it('reconciles a committed native writer whose reference receipt marker was lost before rollback', () => {
  const f = fixture(),
    inbound = inboundPrimary(f);
  let job = prepareMain(
      f,
      prepareNeeds(f, f.service.plan({ noteId: f.main.id, requestId: randomUUID() })),
    ),
    original = db.prepare.bind(db),
    interrupted = false;
  db.prepare = ((sql: string) => {
    if (
      !interrupted &&
      sql.startsWith('UPDATE whiteboard_migrations SET references_json') &&
      f.notes.getNote(inbound.note.id).content !== inbound.note.content
    ) {
      interrupted = true;
      throw Error('native receipt marker lost');
    }
    return original(sql);
  }) as typeof db.prepare;
  expect(() => f.service.commit({ migrationId: job.id, requestId: randomUUID() })).toThrow(
    'native receipt marker lost',
  );
  db.prepare = original;
  const reopened = whiteboardMigrationService(config, db, f.notes, f.assets, webPrincipal);
  reopened.rollback({ migrationId: job.id, requestId: randomUUID() });
  expect(f.notes.getNote(inbound.note.id).content).toBe(inbound.note.content);
  expect(f.primary.resolve(inbound.note.id).preview!.state).toBe('ready');
});
it('rechecks native grants and refuses late permission loss before switching the target', () => {
  const f = fixture();
  inboundPrimary(f);
  let job = prepareMain(
    f,
    prepareNeeds(f, f.service.plan({ noteId: f.main.id, requestId: randomUUID() })),
  );
  const scoped = {
      ...webPrincipal,
      knowledgeAll: false,
      allowedPrefixes: ['00-Inbox/drawing.excalidraw', '00-Inbox/drawing.md'],
    },
    restricted = whiteboardMigrationService(config, db, f.notes, f.assets, scoped);
  expect(() => restricted.commit({ migrationId: job.id, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ statusCode: 403 }),
  );
  expect(f.notes.getNote(f.main.id).relativePath).toBe(f.main.relativePath);
});
