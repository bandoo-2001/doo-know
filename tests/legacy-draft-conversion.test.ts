import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { whiteboardMigrationService } from '../packages/core/knowledge/whiteboard-migrations';
import { legacyDraftConversionService } from '../packages/core/knowledge/legacy-draft-conversion';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
import { parseDiagramDocument } from '../shared/diagram-document';
import type { AppConfig } from '../shared/contracts';
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-draft-convert-'));
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
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
function setup() {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes),
    core = mutationCore(config, db);
  core.create(webPrincipal, '00-Inbox', 'target.md', '# Target', randomUUID());
  const old = core.create(
    webPrincipal,
    '00-Inbox',
    'drawing.excalidraw',
    JSON.stringify(emptyWhiteboard()),
    randomUUID(),
  );
  const before = notes.getNote(old.id),
    migration = whiteboardMigrationService(config, db, notes, assets, webPrincipal);
  const planned = migration.plan({ noteId: old.id, requestId: randomUUID() });
  migration.prepare({
    migrationId: planned.id,
    sourceHash: planned.sourceHash,
    pngBase64,
    requestId: randomUUID(),
  });
  migration.commit({ migrationId: planned.id, requestId: randomUUID() });
  const current = notes.getNote(old.id),
    parsed = parseDiagramDocument(current.content);
  if (parsed.status !== 'diagram') throw Error('invalid fixture');
  const draft = JSON.stringify({
    ...JSON.parse(before.content),
    elements: [{ id: 'draft', type: 'text', text: '未保存场景', link: 'target.md' }],
    future: { keep: 'draft' },
  });
  return {
    notes,
    assets,
    current,
    before,
    draft,
    convert: legacyDraftConversionService(config, db, notes, assets, webPrincipal),
    input: {
      draft,
      baseRevision: JSON.stringify([before.modifiedAt, null]),
      expectedDocumentHash: sha256(current.content),
      expectedSourceHash: parsed.primary.binding.sourceHash,
    },
  };
}
it('converts a matching pre-migration JSON draft into native input without writing JSON or replacing Markdown prose', () => {
  const f = setup();
  const described = f.notes.saveNote(
    f.current.id,
    f.current.content + '\n服务器说明必须保留。\n',
    f.current.modifiedAt,
    randomUUID(),
  );
  const result = f.convert(f.current.id, {
    ...f.input,
    expectedDocumentHash: sha256(described.content),
  });
  expect(result.expectedDocumentHash).toBe(sha256(described.content));
  expect(JSON.parse(result.source)).toMatchObject({
    elements: [{ text: '未保存场景', link: '../target.md' }],
    future: { keep: 'draft' },
  });
  expect(f.notes.getNote(f.current.id).content).toBe(described.content);
  expect(parseDiagramDocument(described.content).status).toBe('diagram');
});
it('rejects unmatched old versions, changed current versions and foreign scene identities', () => {
  const f = setup();
  for (const bad of [
    { baseRevision: '1' },
    { expectedDocumentHash: 'a'.repeat(64) },
    { draft: JSON.stringify({ ...emptyWhiteboard(), dooknow: { id: randomUUID() } }) },
  ])
    expect(() => f.convert(f.current.id, { ...f.input, ...bad })).toThrow();
  expect(f.notes.getNote(f.current.id).content).toBe(f.current.content);
});
it('does not adopt a legacy scene over a changed migrated native source', () => {
  const f = setup();
  const parsed = parseDiagramDocument(f.current.content);
  if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw')
    throw Error('invalid');
  // An external native edit is still a conflict even when the main Markdown timestamp did not change.
  writeFileSync(
    join(config.knowledgeRoot, '00-Inbox', parsed.primary.source.path),
    JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'new', type: 'text', text: '别人的新编辑' }],
    }),
  );
  expect(() => f.convert(f.current.id, f.input)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }),
  );
});
