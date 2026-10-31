import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramHistoryRestoreService } from '../packages/core/knowledge/diagram-history-restore';
import { webPrincipal } from '../packages/core/knowledge/core';
import { sha256 } from '../packages/core/knowledge/operations';
import { recordRevisionContext } from '../packages/core/knowledge/revision-context';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { emptyWhiteboard } from '../shared/whiteboard';
import type { AppConfig } from '../shared/contracts';
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diagram-history-'));
  config = {
    dataRoot: join(root, 'data'),
    knowledgeRoot: join(root, 'knowledge'),
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
function services() {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes);
  return {
    notes,
    assets,
    primary: primaryDiagramService(config, db, notes, assets, webPrincipal),
    history: diagramHistoryRestoreService(config, db, notes, assets, webPrincipal),
  };
}
function create(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  const s = services(),
    intent = diagramCreationService(config, db, webPrincipal).reserve({
      path: '00-Inbox/current.md',
      type,
      requestId: randomUUID(),
    });
  const source =
    type === 'whiteboard'
      ? JSON.stringify(emptyWhiteboard())
      : type === 'mindmap'
        ? '- Current\n'
        : 'flowchart TD\n A-->B\n';
  const prepared = s.primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type,
    source,
    sourceHash: sha256(source),
    title: 'Current',
    renderer: diagramRendererVersions[type],
    config: {},
    pngBase64,
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({
    prepared,
    title: 'Current',
    source,
    description: 'Current prose\n',
  });
  return s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
}
function legacyRevision(noteId: string) {
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'link', type: 'text', text: 'Historical', link: 'target.md#part' }],
    custom: { retain: true },
  });
  const id = randomUUID(),
    file = id + '.md';
  mkdirSync(join(config.dataRoot, 'history'), { recursive: true });
  writeFileSync(join(config.dataRoot, 'history', file), source);
  const path = (db.prepare('SELECT path FROM notes WHERE id=?').get(noteId) as any).path;
  db.prepare('UPDATE notes SET path=? WHERE id=?').run('00-Inbox/old.excalidraw', noteId);
  recordRevisionContext(config, db, {
    id: randomUUID(),
    note_id: noteId,
    path,
    kind: 'whiteboard-migrate',
    revision_id: id,
    history_file: file,
    original_hash: sha256(source),
    original_mtime: '1',
  });
  db.prepare('UPDATE notes SET path=? WHERE id=?').run(path, noteId);
  return { id, source, file };
}
it('restores old JSON as a freshly prepared scene with final rebased links and preserved Markdown prose', () => {
  const note = create(),
    rev = legacyRevision(note.id),
    s = services();
  const requestId = randomUUID(),
    plan = s.history.plan(note.id, rev.id, note.modifiedAt, requestId);
  expect(s.history.plan(note.id, rev.id, note.modifiedAt, requestId)).toEqual(plan);
  expect(JSON.parse(plan.source).elements[0].link).toBe('../target.md#part');
  expect(JSON.parse(plan.source).custom).toEqual({ retain: true });
  expect(s.notes.getNote(note.id).content).toBe(note.content);
  s.history.prepare(plan.id, {
    sourceHash: sha256(plan.source),
    pngBase64,
    requestId: randomUUID(),
  });
  const commit = { requestId: randomUUID() };
  const restored = s.history.commit(plan.id, commit);
  expect(restored.id).toBe(note.id);
  expect(parseDiagramDocument(restored.content).status).toBe('diagram');
  expect(restored.content).toContain('Current prose');
  expect(restored.content).toContain('Historical');
  expect(s.primary.resolve(note.id).source.content).toBe(plan.source);
  expect(s.history.commit(plan.id, commit)).toEqual(restored);
  expect(readFileSync(join(config.dataRoot, 'history', rev.file), 'utf8')).toBe(rev.source);
});
it('rejects stale current versions and scene substitution without publishing historical bytes', () => {
  const note = create(),
    rev = legacyRevision(note.id),
    s = services();
  const plan = s.history.plan(note.id, rev.id, note.modifiedAt, randomUUID());
  expect(() =>
    s.history.prepare(plan.id, {
      sourceHash: sha256('different'),
      pngBase64,
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }));
  s.history.prepare(plan.id, {
    sourceHash: sha256(plan.source),
    pngBase64,
    requestId: randomUUID(),
  });
  s.notes.saveNote(note.id, note.content + '\nConcurrent prose\n', note.modifiedAt, randomUUID());
  expect(() => s.history.commit(plan.id, { requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
  expect(s.notes.getNote(note.id).content).toContain('Concurrent prose');
});
it('reconciles a committed inner update when the primary and history receipts were interrupted', () => {
  const note = create(),
    rev = legacyRevision(note.id),
    s = services();
  const plan = s.history.plan(note.id, rev.id, note.modifiedAt, randomUUID());
  s.history.prepare(plan.id, { sourceHash: plan.sourceHash, pngBase64, requestId: randomUUID() });
  const requestId = randomUUID(),
    result = s.history.commit(plan.id, { requestId });
  // Durable state immediately after the versioned main write, before outer receipts.
  db.prepare(
    "UPDATE operations SET status='prepared',result=NULL WHERE kind='diagram-primary.commit' AND request_id=?",
  ).run('history-' + plan.id);
  db.prepare(
    "UPDATE operations SET status='prepared',result=NULL WHERE kind='diagram-history.commit' AND request_id=?",
  ).run(requestId);
  db.prepare("UPDATE diagram_history_restores SET status='prepared' WHERE id=?").run(plan.id);
  expect(s.history.commit(plan.id, { requestId })).toEqual(result);
});
it.each(['mindmap', 'flowchart'] as const)(
  'restores %s source and prose using the historical render input',
  (type) => {
    const note = create(type),
      s = services();
    const updated = s.notes.saveNote(
      note.id,
      note.content + '\nLater prose\n',
      note.modifiedAt,
      randomUUID(),
    );
    const revision = (
      db.prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC').get(note.id) as any
    ).id;
    const plan = s.history.plan(note.id, revision, updated.modifiedAt, randomUUID());
    s.history.prepare(plan.id, {
      sourceHash: sha256(plan.source),
      pngBase64,
      requestId: randomUUID(),
    });
    const restored = s.history.commit(plan.id, { requestId: randomUUID() });
    expect(restored.content).toContain('Current prose');
    expect(restored.content).not.toContain('Later prose');
    expect(parseDiagramDocument(restored.content)).toMatchObject({ status: 'diagram', type });
  },
);
