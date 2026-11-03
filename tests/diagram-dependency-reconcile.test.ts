import { startWatcher } from '../packages/core/indexing/watcher';
import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sourceAccess } from '../packages/core/graph/analysis-source';
import * as gitState from '../packages/core/indexing/git-state';
import { vi } from 'vitest';
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const end of clean.splice(0).reverse()) await end();
});
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  ),
  hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const f = await pluginRuntimeFixture();
  clean.push(f.close);
  const runtime = f.platform.get(),
    service = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal),
    intent = diagramCreationService(f.config, f.db, f.principal).reserve({
      path: '00-Inbox/current.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 't', type: 'text', text: '原文字' }],
    });
  const prepared = service.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      title: '主图',
      source,
      sourceHash: hash(source),
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({ prepared, title: prepared.title, source }),
    note = service.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  f.db
    .prepare(
      'UPDATE document_state SET text_indexed_hash=content_hash,vector_indexed_hash=content_hash WHERE note_id=?',
    )
    .run(note.id);
  return { ...f, runtime, prepared, source, markdown, note };
}
it.each(['source-change', 'source-delete', 'preview-change', 'preview-delete'] as const)(
  'quarantines stale indexes after %s with unchanged Markdown',
  async (kind) => {
    const f = await fixture(),
      source = kind.startsWith('source'),
      path = join(
        f.config.knowledgeRoot,
        source ? f.prepared.source!.relativePath : f.prepared.preview.relativePath,
      );
    if (kind.endsWith('delete')) await unlink(path);
    else
      await writeFile(
        path,
        source ? f.source.replace('原文字', '外部更新') : Buffer.from('not PNG'),
      );
    const result = await f.runtime.knowledge.indexing.reconcile(undefined, false);
    expect(result.conflicted).toBeGreaterThan(0);
    expect(
      f.db
        .prepare(
          'SELECT conflict,text_indexed_hash,vector_indexed_hash FROM document_state WHERE note_id=?',
        )
        .get(f.note.id),
    ).toEqual({ conflict: 1, text_indexed_hash: null, vector_indexed_hash: null });
    expect(sourceAccess(f.config, f.db).current(f.note.id)).toBeUndefined();
    expect(await readFile(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toBe(
      f.markdown,
    );
  },
);
it('restores indexing eligibility after the exact fixed source returns and preserves graph decisions', async () => {
  const f = await fixture();
  f.db.prepare('UPDATE graph_knowledge_user SET data=? WHERE id=1').run(
    JSON.stringify({
      ...JSON.parse(
        (f.db.prepare('SELECT data FROM graph_knowledge_user WHERE id=1').get() as any).data,
      ),
      version: 2,
      decisions: { stable: { decision: 'accept' } },
    }),
  );
  const path = join(f.config.knowledgeRoot, f.prepared.source!.relativePath);
  await writeFile(path, f.source.replace('原文字', '外部更新'));
  await f.runtime.knowledge.indexing.reconcile();
  expect(
    f.db.prepare('SELECT conflict FROM document_state WHERE note_id=?').get(f.note.id),
  ).toEqual({ conflict: 1 });
  await writeFile(path, f.source);
  await f.runtime.knowledge.indexing.reconcile();
  expect(
    f.db.prepare('SELECT conflict FROM document_state WHERE note_id=?').get(f.note.id),
  ).toEqual({ conflict: 0 });
  expect(sourceAccess(f.config, f.db).current(f.note.id)).toBeTruthy();
  expect(
    JSON.parse((f.db.prepare('SELECT data FROM graph_knowledge_user WHERE id=1').get() as any).data)
      .decisions,
  ).toEqual({ stable: { decision: 'accept' } });
});
it('propagates an asset Git conflict even if its current bytes still match', async () => {
  const f = await fixture();
  vi.spyOn(gitState, 'gitState').mockResolvedValue({
    head: 'test',
    dirty: true,
    filters: false,
    conflicts: [f.prepared.source!.relativePath],
  });
  await f.runtime.knowledge.indexing.reconcile();
  expect(
    f.db.prepare('SELECT conflict FROM document_state WHERE note_id=?').get(f.note.id),
  ).toEqual({ conflict: 1 });
});

it('watches referenced source assets without an explicit refresh or treating assets as notes', async () => {
  const f = await fixture(),
    stop = startWatcher(
      { ...f.config, indexing: { enabled: true, watch: true } },
      f.db,
      f.runtime.knowledge.indexing,
    );
  try {
    await writeFile(
      join(f.config.knowledgeRoot, f.prepared.source!.relativePath),
      f.source.replace('原文字', '来自文件监听'),
    );
    await vi.waitFor(
      () =>
        expect(
          f.db.prepare('SELECT conflict FROM document_state WHERE note_id=?').get(f.note.id),
        ).toEqual({ conflict: 1 }),
      { timeout: 4000, interval: 50 },
    );
    expect(f.db.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
  } finally {
    stop();
  }
});
