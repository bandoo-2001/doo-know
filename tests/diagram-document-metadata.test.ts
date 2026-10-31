import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
async function fixture() {
  const f = await pluginRuntimeFixture();
  close.push(f.close);
  const runtime = f.platform.get(),
    service = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal),
    source = '- 节点\n',
    title = '图形 [中文] *原始* \\ 文本';
  const intent = diagramCreationService(f.config, f.db, f.principal).reserve({
    path: '00-Inbox/cache.md',
    type: 'mindmap',
    requestId: randomUUID(),
  });
  const prepared = service.prepare({
    target: { kind: 'creation', intentId: intent.id },
    type: 'mindmap',
    source,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    title,
    renderer: diagramRendererVersions.mindmap,
    config: {},
    pngBase64: png,
    requestId: randomUUID(),
  });
  const markdown = renderPreparedDiagramDocument({ prepared, title, source }),
    note = service.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  return { ...f, runtime, note, title, markdown };
}
it('keeps a primary title decoded after streaming snapshot metadata rebuild', async () => {
  const f = await fixture();
  let result = await f.runtime.knowledge.snapshots.read(f.principal, f.note.id, {});
  if (result.kind === 'accepted') {
    await f.runtime.knowledge.snapshots.drain();
    result = await f.runtime.knowledge.snapshots.read(f.principal, f.note.id, {});
  }
  expect(result.kind).toBe('ready');
  expect(await f.runtime.knowledge.info(f.principal, f.note.id)).toMatchObject({
    documentType: 'mindmap',
    title: f.title,
  });
});
it('rebuilds semantic type from source and invalidates the cached type after external edits', async () => {
  const f = await fixture();
  f.db.prepare("UPDATE document_state SET document_type='markdown' WHERE note_id=?").run(f.note.id);
  expect(await f.runtime.knowledge.info(f.principal, f.note.id)).toMatchObject({
    documentType: 'mindmap',
    title: f.title,
  });
  expect(
    f.runtime.notes
      .tree()
      .flatMap((e) => e.children || [])
      .find((e) => e.id === f.note.id)?.documentType,
  ).toBe('mindmap');
  await writeFile(join(f.config.knowledgeRoot, f.note.relativePath), '# 普通笔记\n');
  await f.runtime.knowledge.indexing.reconcile();
  expect(await f.runtime.knowledge.info(f.principal, f.note.id)).not.toHaveProperty(
    'documentType',
    'mindmap',
  );
  expect(
    f.runtime.notes
      .tree()
      .flatMap((e) => e.children || [])
      .find((e) => e.id === f.note.id)?.documentType,
  ).toBeUndefined();
});

it('isolates unreadable declaration candidates so the remaining file tree stays available',async()=>{
 const f=await fixture();
 await writeFile(join(f.config.knowledgeRoot,'00-Inbox/broken.md'),Buffer.concat([Buffer.from('<!-- dooknow:document '),Buffer.from([0xff,0xfe])]));
 const tree=f.runtime.notes.tree(),entries=tree.flatMap(entry=>entry.children||[]);
 expect(entries.find(entry=>entry.id===f.note.id)?.documentType).toBe('mindmap');
 expect(entries.find(entry=>entry.path==='00-Inbox/broken.md')).toMatchObject({type:'note'});
 expect(entries.find(entry=>entry.path==='00-Inbox/broken.md')?.documentType).toBeUndefined();
});
