import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const f = await pluginRuntimeFixture();
  close.push(f.close);
  const runtime = f.platform.get(),
    primary = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal);
  const intent = diagramCreationService(f.config, f.db, f.principal).reserve({
    path: '00-Inbox/published.md',
    type: 'whiteboard',
    requestId: randomUUID(),
  });
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'label', type: 'text', text: '完整版本文字' }],
  });
  const first = primary.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'whiteboard',
    source,
    sourceHash: hash(source),
    title: '完整标题',
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({
      prepared: first,
      title: first.title,
      source,
      description: '已发布说明\n',
    }),
    note = primary.commit({ preparedId: first.id, markdown, requestId: randomUUID() });
  const nextSource = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'label', type: 'text', text: '尚未完成的文字' }],
  });
  const next = primary.prepare({
    target: {
      kind: 'document',
      noteId: note.id,
      expectedDocumentHash: hash(markdown),
      expectedSourceHash: hash(source),
    },
    type: 'whiteboard',
    source: nextSource,
    sourceHash: hash(nextSource),
    title: '未完成标题',
    renderer: first.renderer,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const nextMarkdown = renderPreparedDiagramDocument({
    prepared: next,
    title: next.title,
    source: nextSource,
    description: '未完成说明\n',
  });
  f.db.exec(
    "CREATE TRIGGER keep_publication_pending BEFORE UPDATE OF active ON notes WHEN NEW.active=1 BEGIN SELECT RAISE(FAIL,'fixture recording interruption'); END",
  );
  expect(() =>
    primary.commit({ preparedId: next.id, markdown: nextMarkdown, requestId: randomUUID() }),
  ).toThrow();
  expect(await readFile(join(f.config.knowledgeRoot, note.relativePath), 'utf8')).toBe(
    nextMarkdown,
  );
  return { ...f, runtime, primary, first, next, note, markdown, nextMarkdown };
}
it('serves the last complete raw Markdown with a pending marker until update recovery succeeds', async () => {
  const f = await fixture(),
    current = f.runtime.notes.getNote(f.note.id);
  expect(current).toMatchObject({
    content: f.markdown,
    title: '完整标题',
    modifiedAt: f.note.modifiedAt,
    publication: { state: 'pending' },
  });
  f.db.exec('DROP TRIGGER keep_publication_pending');
  await f.runtime.knowledge.core.recover();
  expect(f.runtime.notes.getNote(f.note.id).content).toBe(f.nextMarkdown);
  expect(f.runtime.notes.getNote(f.note.id)).not.toHaveProperty('publication');
});
it('keeps range snapshots and metadata bound to the published version while recording is pending', async () => {
  const f = await fixture(),
    k = f.runtime.knowledge;
  let page = await k.snapshots.read(f.principal, f.note.id, {});
  if (page.kind === 'accepted') {
    await k.snapshots.drain();
    page = await k.snapshots.read(f.principal, f.note.id, {});
  }
  if (page.kind !== 'ready') throw Error('snapshot not ready');
  expect(page.data).toMatchObject({
    content: f.markdown,
    sourceHash: hash(f.markdown),
    modifiedAt: f.note.modifiedAt,
  });
  expect(await k.info(f.principal, f.note.id)).toMatchObject({
    contentHash: hash(f.markdown),
    modifiedAt: f.note.modifiedAt,
    publication: { state: 'pending' },
  });
});
it('does not expose newly referenced working assets through published resource proof', async () => {
  const f = await fixture();
  await expect(f.runtime.assets.publicAsset(f.note.id, f.next.preview.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  expect((await f.runtime.assets.publicAsset(f.note.id, f.first.preview.id)).bytes).toEqual(png);
});
it('does not index an unrecorded working main file during reconciliation', async () => {
  const f = await fixture();
  await f.runtime.knowledge.indexing.reconcile();
  expect(
    f.db.prepare('SELECT content_hash FROM document_state WHERE note_id=?').get(f.note.id),
  ).toEqual({ content_hash: hash(f.markdown) });
});
it('does not silently fall back to unrecorded main bytes if the old complete-version evidence is missing', async () => {
  const f = await fixture(),
    pending = f.db
      .prepare(
        "SELECT history_file FROM write_intents WHERE note_id=? AND kind='update' AND status='prepared'",
      )
      .get(f.note.id) as { history_file: string };
  await unlink(join(f.config.dataRoot, 'history', pending.history_file));
  expect(() => f.runtime.notes.getNote(f.note.id)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_PUBLISHED_VERSION_UNAVAILABLE' }),
  );
});

it('retains the published identity and readable evidence if the unrecorded working file disappears', async () => {
  const f = await fixture();
  await unlink(join(f.config.knowledgeRoot, f.note.relativePath));
  f.runtime.notes.scan();
  await f.runtime.knowledge.indexing.reconcile();
  expect(f.runtime.notes.getNote(f.note.id)).toMatchObject({
    content: f.markdown,
    publication: { state: 'pending' },
  });
  expect((await f.runtime.assets.publicAsset(f.note.id, f.first.preview.id)).bytes).toEqual(png);
});

it('surfaces resource recovery failures and blocks generic keep-disk from bypassing a graph version',async()=>{
 const f=await fixture();f.db.exec('DROP TRIGGER keep_publication_pending');await unlink(join(f.config.knowledgeRoot,f.next.preview.relativePath));await f.runtime.knowledge.core.recover();
 expect(f.runtime.notes.getNote(f.note.id).publication).toMatchObject({state:'conflicted',code:'DIAGRAM_ARTIFACT_CONFLICT'});
 const {conflictService}=await import('../packages/core/knowledge/conflicts');const conflicts=conflictService(f.config,f.db),list=await conflicts.list(),item=list.items.find(value=>value.noteId===f.note.id);
 expect(item).toMatchObject({resolvable:false,reason:'DIAGRAM_RECONCILIATION_REQUIRED'});
 await expect(conflicts.resolve(item!.id,{strategy:'keep_disk',expectedModifiedAt:item!.disk!.modifiedAt,expectedContentHash:item!.disk!.contentHash,requestId:randomUUID()})).rejects.toMatchObject({code:'DIAGRAM_RECONCILIATION_REQUIRED'});
});
