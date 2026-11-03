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
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
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
