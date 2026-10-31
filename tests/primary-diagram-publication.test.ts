import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';
import { emptyWhiteboard } from '../shared/whiteboard';
import { applyPreparedDiagramDocument, diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { mutationCore } from '../packages/core/knowledge/core';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const principal: Principal = {
  id: 'owner',
  clientId: 'editor',
  scopes: ['knowledge:read', 'knowledge:write'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'primary-publication-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost',
    secret: 'test-only',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function services(p = principal) {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes);
  return {
    notes,
    assets,
    primary: primaryDiagramService(config, db, notes, assets, p),
    core: mutationCore(config, db),
  };
}
function prepare(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  const intent = diagramCreationService(config, db, principal).reserve({
      path: '00-Inbox/图形.md',
      type,
      requestId: randomUUID(),
    }),
    source =
      type === 'whiteboard'
        ? JSON.stringify({
            ...emptyWhiteboard(),
            elements: [{ id: 'text', type: 'text', text: '可检索文字' }],
          })
        : type === 'mindmap'
          ? '- 子节点\n'
          : 'flowchart TD\n A-->B\n';
  const prepared = services().primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type,
    source,
    sourceHash: sha(source),
    title: '系统 [架构]',
    renderer: diagramRendererVersions[type],
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({
    prepared,
    title: prepared.title,
    source,
    description: '说明\n',
  });
  return { intent, source, prepared, markdown };
}

it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'activates a complete %s using the original reserved UUID and a Markdown content response',
  (type) => {
    const { intent, prepared, markdown } = prepare(type),
      s = services(),
      request = { preparedId: prepared.id, markdown, requestId: randomUUID() },
      published = s.primary.commit(request);
    expect(published).toMatchObject({
      id: intent.noteId,
      relativePath: intent.relativePath,
      documentType: type,
      content: markdown,
      title: '系统 [架构]',
    });
    expect(readFileSync(join(config.knowledgeRoot, intent.relativePath), 'utf8')).toBe(markdown);
    expect(s.notes.getNote(intent.noteId)).toMatchObject({ documentType: type, content: markdown });
    expect(
      s.notes
        .tree()
        .find((entry) => entry.path === '00-Inbox')
        ?.children?.find((entry) => entry.id === intent.noteId)?.documentType,
    ).toBe(type);
    expect(diagramCreationService(config, db, principal).get(intent.id).status).toBe('published');
    expect(s.primary.commit(request)).toEqual(published);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM diagram_document_versions WHERE note_id=?')
        .get(intent.noteId),
    ).toEqual({ count: 1 });
  },
);

it('rejects unprepared or mismatched primary writes before exposing any partial file', () => {
  const { intent, prepared, markdown } = prepare(),
    s = services();
  expect(() =>
    s.primary.commit({
      preparedId: prepared.id,
      markdown: markdown.replace('# 系统', '# 新系统'),
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREVIEW_REQUIRED' }));
  expect(existsSync(join(config.knowledgeRoot, intent.relativePath))).toBe(false);
  expect(() =>
    s.core.create(principal, '00-Inbox', 'bypass.md', markdown, randomUUID()),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_CREATION_REQUIRED' }));
  writeFileSync(
    join(config.knowledgeRoot, prepared.source!.relativePath),
    JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#eee' } }),
  );
  expect(() =>
    s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }));
  expect(db.prepare('SELECT count(*) AS count FROM notes WHERE active=1').get()).toEqual({
    count: 0,
  });
});

it('allows description-only writes but raw updates cannot bypass preview or conversion policy', () => {
  const { intent, prepared, markdown } = prepare(),
    s = services(),
    published = s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  const updated = s.core.update(
    principal,
    intent.noteId,
    markdown + '补充说明\n',
    published.modifiedAt,
    randomUUID(),
  );
  expect(s.notes.getNote(intent.noteId).content).toBe(markdown + '补充说明\n');
  let failure: any;
  try {
    s.core.update(
      principal,
      intent.noteId,
      markdown.replace('# 系统', '# 不同标题'),
      updated.modifiedAt,
      randomUUID(),
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'DIAGRAM_PREVIEW_REQUIRED',
    details: { documents: [expect.objectContaining({ noteId: intent.noteId, role: 'primary' })] },
  });
  expect(() =>
    s.core.update(principal, intent.noteId, '# 删除类型标记\n', updated.modifiedAt, randomUUID()),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED' }));
});

it('uses published resource proofs for selected-note grants without widening directory access', () => {
  const { intent, prepared, markdown, source } = prepare(),
    s = services();
  s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  const selected = { ...principal, allowedPrefixes: [intent.relativePath] },
    selectedService = services(selected);
  const next = selectedService.primary.prepare({
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
  expect(next.noteId).toBe(intent.noteId);
});

it('rejects an actual source change after preparation and keeps the previously published main file', () => {
  const { intent, prepared, markdown, source } = prepare(),
    s = services();
  s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  const next = s.primary.prepare({
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
  writeFileSync(
    join(config.knowledgeRoot, prepared.source!.relativePath),
    JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#eee' } }),
  );
  expect(() =>
    s.primary.commit({
      preparedId: next.id,
      markdown: renderPreparedDiagramDocument({ prepared: next, title: next.title, source }),
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }));
  expect(readFileSync(join(config.knowledgeRoot, intent.relativePath), 'utf8')).toBe(markdown);
});

it('recovers a committed file after a database recording failure without creating a second identity', async () => {
  const { intent, prepared, markdown } = prepare(),
    request = { preparedId: prepared.id, markdown, requestId: randomUUID() };
  db.exec(
    "CREATE TRIGGER publication_record_failure BEFORE UPDATE OF active ON notes WHEN NEW.active=1 BEGIN SELECT RAISE(FAIL,'fixture record interruption'); END",
  );
  expect(() => services().primary.commit(request)).toThrow();
  db.exec('DROP TRIGGER publication_record_failure');
  db.close();
  db = openDatabase(config.dataRoot);
  await services().core.recover();
  const result = services().primary.commit(request);
  expect(result.id).toBe(intent.noteId);
  expect(services().notes.getNote(intent.noteId).content).toBe(markdown);
  expect(db.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 1 });
  expect(diagramCreationService(config, db, principal).get(intent.id).status).toBe('published');
});

it('preserves unsupported document versions as ordinary Markdown source without claiming a complete primary', () => {
  const raw =
      '<!-- dooknow:document {"version":99,"type":"whiteboard","engine":"excalidraw","future":"保留"} -->\n\n# 外部未来格式\n\n正文原样。\n',
    s = services();
  const created = s.core.create(principal, '00-Inbox', 'future.md', raw, randomUUID());
  expect(s.notes.getNote(created.id)).toMatchObject({ content: raw, documentType: 'markdown' });
  expect(
    s.core.update(principal, created.id, raw + '补充说明\n', created.modifiedAt, randomUUID()).id,
  ).toBe(created.id);
  expect(db.prepare('SELECT count(*) AS count FROM diagram_document_versions').get()).toEqual({
    count: 0,
  });
});

it('keeps recovery unresolved if a committed main file has lost its fixed PNG', async () => {
  const { intent, prepared, markdown } = prepare(),
    request = { preparedId: prepared.id, markdown, requestId: randomUUID() },
    s = services();
  db.exec(
    "CREATE TRIGGER publication_missing_preview BEFORE UPDATE OF active ON notes WHEN NEW.active=1 BEGIN SELECT RAISE(FAIL,'fixture record interruption'); END",
  );
  expect(() => s.primary.commit(request)).toThrow();
  db.exec('DROP TRIGGER publication_missing_preview');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(config.knowledgeRoot, prepared.preview.relativePath));
  const recovered = await services().core.recover();
  expect(recovered.recovered).toBe(0);
  expect(db.prepare('SELECT active FROM notes WHERE id=?').get(intent.noteId)).toEqual({
    active: 0,
  });
  expect(diagramCreationService(config, db, principal).get(intent.id).status).not.toBe('published');
  expect(() => services().primary.commit(request)).toThrow();
});

it('does not confirm cancellation once creation has entered a recoverable filesystem commit', async () => {
  const { intent, prepared, markdown } = prepare(),
    s = services();
  db.exec(
    "CREATE TRIGGER publication_cancel_interruption BEFORE UPDATE OF active ON notes WHEN NEW.active=1 BEGIN SELECT RAISE(FAIL,'fixture record interruption'); END",
  );
  expect(() =>
    s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
  ).toThrow();
  db.exec('DROP TRIGGER publication_cancel_interruption');
  expect(() => diagramCreationService(config, db, principal).cancel(intent.id)).toThrowError(
    expect.objectContaining({ code: 'CREATION_COMMIT_IN_PROGRESS' }),
  );
  await services().core.recover();
  expect(diagramCreationService(config, db, principal).get(intent.id).status).toBe('published');
});

it('binds explicit preparedId to its own source, render, preview and asset destinations', () => {
  const { intent, prepared: first, source } = prepare(),
    s = services();
  const second = s.primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'whiteboard',
    source,
    sourceHash: sha(source),
    title: '不同标题',
    renderer: first.renderer,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({ prepared: second, title: second.title, source });
  expect(() =>
    s.primary.commit({ preparedId: first.id, markdown, requestId: randomUUID() }),
  ).toThrowError(expect.objectContaining({ code: 'DIAGRAM_PREPARATION_MISMATCH' }));
  expect(existsSync(join(config.knowledgeRoot, intent.relativePath))).toBe(false);
});

it('keeps explicit preparation ownership while allowing an authorized raw writer to reuse the same fixed snapshot', () => {
  const { intent, prepared, markdown, source } = prepare(),
    s = services();
  const published = s.primary.commit({
    preparedId: prepared.id,
    markdown,
    requestId: randomUUID(),
  });
  const next = s.primary.prepare({
    target: {
      kind: 'document',
      noteId: intent.noteId,
      expectedDocumentHash: sha(markdown),
      expectedSourceHash: sha(source),
    },
    type: 'whiteboard',
    source,
    sourceHash: sha(source),
    title: '已准备的新标题',
    renderer: prepared.renderer,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const nextMarkdown = renderPreparedDiagramDocument({ prepared: next, title: next.title, source }),
    other = { ...principal, clientId: 'another-editor' };
  expect(() =>
    services(other).primary.commit({
      preparedId: next.id,
      markdown: nextMarkdown,
      requestId: randomUUID(),
    }),
  ).toThrowError(expect.objectContaining({ statusCode: 403 }));
  services().core.update(other, intent.noteId, nextMarkdown, published.modifiedAt, randomUUID());
  expect(s.notes.getNote(intent.noteId).content).toBe(nextMarkdown);
});

it('releases an uncommitted creation claim and reuses its reserved inactive identity on a fresh retry', () => {
  const { intent, prepared, markdown } = prepare(),
    s = services();
  db.function('fixture_remove_preview', () => {
    unlinkSync(join(config.knowledgeRoot, prepared.preview.relativePath));
    return 1;
  });
  db.exec(
    "CREATE TRIGGER publication_precommit_loss AFTER INSERT ON write_intents WHEN NEW.kind='create' BEGIN SELECT fixture_remove_preview(); END",
  );
  expect(() =>
    s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
  ).toThrow();
  db.exec('DROP TRIGGER publication_precommit_loss');
  expect(existsSync(join(config.knowledgeRoot, prepared.preview.relativePath))).toBe(false);
  expect(db.prepare('SELECT active FROM notes WHERE id=?').get(intent.noteId)).toEqual({
    active: 0,
  });
  expect(diagramCreationService(config, db, principal).get(intent.id)).toMatchObject({
    status: 'prepared',
  });
  expect(
    diagramCreationService(config, db, principal).get(intent.id).commitOperationId,
  ).toBeUndefined();
  writeFileSync(join(config.knowledgeRoot, prepared.preview.relativePath), png);
  const result = s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  expect(result.id).toBe(intent.noteId);
  expect(db.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 1 });
});

it('releases an abandoned creation claim when recovery proves that the target was never retained', async () => {
  const { intent, prepared, markdown } = prepare(),
    s = services();
  db.exec(
    "CREATE TRIGGER creation_unapplied_record BEFORE UPDATE OF active ON notes WHEN NEW.active=1 BEGIN SELECT RAISE(FAIL,'fixture interruption'); END",
  );
  expect(() =>
    s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
  ).toThrow();
  db.exec('DROP TRIGGER creation_unapplied_record');
  unlinkSync(join(config.knowledgeRoot, intent.relativePath));
  expect((await s.core.recover()).unapplied).toBe(1);
  expect(
    diagramCreationService(config, db, principal).get(intent.id).commitOperationId,
  ).toBeUndefined();
  expect(s.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }).id).toBe(
    intent.noteId,
  );
});

it('keeps operation status metadata bounded while replaying the exact committed Markdown response',()=>{
 const {prepared,markdown}=prepare(),s=services(),request={preparedId:prepared.id,markdown,requestId:randomUUID()},saved=s.primary.commit(request);
 const row=db.prepare("SELECT result FROM operations WHERE kind='diagram-primary.commit' AND request_id=?").get(request.requestId) as {result:string};
 expect(JSON.parse(row.result)).not.toHaveProperty('content');
 expect(Buffer.byteLength(row.result)).toBeLessThan(4096);
 expect(s.primary.commit(request)).toEqual(saved);
 expect(saved.content).toBe(markdown);
});

it.each(['whiteboard','mindmap','flowchart'] as const)('publishes a prepared %s replacement without rewriting surrounding prose or unknown metadata',type=>{
 const f=prepare(type),s=services(),prefix='\uFEFF---\r\ncustom: retained\r\n---\r\n\r\n',description='\r\n用户说明  \r\n';
 const markdown=prefix+f.markdown.replace('"version":1','"future":{"keep":42},"version":1').replace('"render":{','"render":{"future":{"keep":true},')+description;
 const first=s.primary.commit({preparedId:f.prepared.id,markdown,requestId:randomUUID()}),source=f.source.replace('可检索文字','新的标签').replace('子节点','新节点').replace('A-->B','A[新]-->B');
 const next=s.primary.prepare({target:{kind:'document',noteId:first.id,expectedDocumentHash:sha(markdown),expectedSourceHash:sha(f.source)},type,source,sourceHash:sha(source),title:first.title,renderer:f.prepared.renderer,config:{layout:'second'},pngBase64:png.toString('base64'),requestId:randomUUID()});
 const updated=applyPreparedDiagramDocument({markdown,prepared:next,source});
 const saved=s.primary.commit({preparedId:next.id,markdown:updated,requestId:randomUUID()});
 expect(saved.content).toBe(updated);expect(saved.content.startsWith(prefix)).toBe(true);expect(saved.content.endsWith(description)).toBe(true);
 expect(saved.content).toContain('"future":{"keep":42}');expect(saved.content).toContain('"future":{"keep":true}');
 expect(s.notes.getNote(saved.id).content).toBe(updated);
});
it('replays a consumed primary commit using current authorized identity and current content without rewriting', () => {
  const { prepared, markdown } = prepare(),
    s = services(),
    request = { preparedId: prepared.id, markdown, requestId: randomUUID() },
    saved = s.primary.commit(request);
  const current = markdown + '\nLater owner prose\n';
  s.core.update(principal, saved.id, current, saved.modifiedAt, randomUUID());
  const moved = s.core.move(
    principal,
    saved.id,
    '00-Inbox',
    'renamed.md',
    s.notes.getNote(saved.id).modifiedAt,
    randomUUID(),
  );
  const before = s.notes.getNote(saved.id),
    count = (db.prepare('SELECT count(*) n FROM write_intents').get() as { n: number }).n;
  const replay = s.primary.commit(request);
  expect(replay.relativePath).toBe(moved.relativePath);
  expect(replay.content).toBe(before.content);
  expect(replay.modifiedAt).toBe(before.modifiedAt);
  expect(replay.content).toContain('Later owner prose');
  expect((db.prepare('SELECT count(*) n FROM write_intents').get() as { n: number }).n).toBe(count);
  expect(() =>
    services({ ...principal, allowedPrefixes: ['00-Inbox/图形.md'] }).primary.commit(request),
  ).toThrow();
});
