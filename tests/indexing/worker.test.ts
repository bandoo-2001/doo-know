import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { startVectorRuntime } from '../support/vector-runtime.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../server/db.js';
import { noteService } from '../../server/notes.js';
import { snapshotService } from '../../server/knowledge/snapshots.js';
import { reconcileService } from '../../server/indexing/reconcile.js';
import { indexWorker } from '../../server/indexing/worker.js';
import { createApp } from '../../server/app.js';
it('rebuilds lexical chunk identities when enabling vectors after a text-only index', async () => {
  const f = await createFixture({ agent: agentConfig });
  let runtime: Awaited<ReturnType<typeof startVectorRuntime>> | undefined,
    restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/enable-vector.md'),
      '# 经验知识\n\n知识库使用Markdown保存长期经验。',
    );
    const text = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '经验', mode: 'text', freshness: 'strict' },
    });
    expect(text.statusCode).toBe(200);
    expect(text.json().data.results).toHaveLength(1);
    const noteId = text.json().data.results[0].noteId;
    await f.app.close();
    runtime = await startVectorRuntime(f.dataRoot);
    restarted = await createApp({
      ...f.config,
      embeddingSpaceId: runtime.spaceId,
      vectorServiceUrl: runtime.url,
      vectorServiceToken: runtime.token,
      indexing: { enabled: true, watch: false, embedded: false },
    });
    const semantic = await restarted.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '如何保存学习经验', mode: 'semantic', freshness: 'strict' },
    });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json().data.results[0]?.noteId).toBe(noteId);
  } finally {
    await restarted?.close();
    await runtime?.close();
    await f.close();
  }
}, 30000);
it('publishes full text and real local vectors through durable jobs and keeps lexical work available offline', async () => {
  const f = await createFixture({ agent: agentConfig }),
    runtime = await startVectorRuntime(f.dataRoot),
    db = openDatabase(f.dataRoot);
  const config = {
    ...f.config,
    embeddingSpaceId: runtime.spaceId,
    vectorServiceUrl: runtime.url,
    vectorServiceToken: runtime.token,
  };
  const notes = noteService(config, db),
    snapshots = snapshotService(config, db, notes),
    indexing = reconcileService(config, db),
    worker = indexWorker(config, db, notes, snapshots);
  try {
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/worker.md'),
      '# 知识整理\n\n知识库使用 Markdown 记录长期经验。',
    );
    await indexing.reconcile(undefined, true);
    await worker.drain();
    let state = db.prepare('SELECT * FROM document_state').get() as any;
    expect(state.text_indexed_hash).toBe(state.content_hash);
    expect(state.vector_indexed_hash).toBe(state.content_hash);
    expect(
      (db.prepare("SELECT count(*) n FROM index_jobs WHERE status<>'done'").get() as any).n,
    ).toBe(0);
    await runtime.close();
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/worker.md'),
      '# 新知识\n\n向量服务离线时文本仍更新。',
    );
    await indexing.reconcile(undefined, true);
    await worker.drain();
    state = db.prepare('SELECT * FROM document_state').get() as any;
    expect(state.text_indexed_hash).toBe(state.content_hash);
    expect(state.vector_indexed_hash).not.toBe(state.content_hash);
    expect(
      (
        db
          .prepare(
            "SELECT status FROM index_jobs WHERE target='vector' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as any
      ).status,
    ).toBe('retry_wait');
  } finally {
    await worker.close();
    await snapshots.close();
    await indexing.close();
    db.close();
    await runtime.close();
    await f.close();
  }
});
