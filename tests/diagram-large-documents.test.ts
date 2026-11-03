import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import type { AppConfig } from '../shared/contracts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const principal = {
  id: 'owner',
  clientId: 'large-diagram',
  scopes: ['knowledge:read', 'knowledge:write'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'large-diagram-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test-only',
    origin: 'http://localhost',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
it('keeps every label byte in a valid whiteboard Markdown main file above the ordinary note limit', () => {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes),
    primary = primaryDiagramService(config, db, notes, assets, principal);
  const intent = diagramCreationService(config, db, principal).reserve({
      path: '00-Inbox/large.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    text = '中文标签 '.repeat(100_000),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'label', type: 'text', text }],
    });
  const prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source,
      sourceHash: sha(source),
      title: '大白板',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({
      prepared,
      title: prepared.title,
      source,
      description: '说明原样。\n',
    });
  expect(Buffer.byteLength(markdown)).toBeGreaterThan(1024 * 1024);
  const saved = primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  expect(saved.content).toBe(markdown);
  expect(notes.getNote(intent.noteId).content).toBe(markdown);
  const next = primary.prepare({
    target: {
      kind: 'document',
      noteId: intent.noteId,
      expectedDocumentHash: sha(markdown),
      expectedSourceHash: sha(source),
    },
    type: 'whiteboard',
    source,
    sourceHash: sha(source),
    title: prepared.title,
    renderer: prepared.renderer,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  expect(next.documentHash).toBe(sha(markdown));
  expect(
    primary.commit({
      preparedId: next.id,
      markdown: renderPreparedDiagramDocument({
        prepared: next,
        title: next.title,
        source,
        description: '更新说明。\n',
      }),
      requestId: randomUUID(),
    }).id,
  ).toBe(intent.noteId);
});
it('retains the ordinary Markdown size limit instead of accepting arbitrary large full writes', () => {
  const notes = noteService(config, db);
  expect(() =>
    notes.createNote('00-Inbox', 'ordinary.md', '# 普通\n' + 'a'.repeat(1024 * 1024)),
  ).toThrowError(expect.objectContaining({ statusCode: 413 }));
});
