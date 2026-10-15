import { it, expect } from 'vitest';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { indexWorker } from '../server/indexing/worker.js';
import { setDesiredEmbeddingSpace } from '../server/indexing/space.js';
it('pauses pending jobs without spending attempts when tokenizer is absent and retains the embedding identity', async () => {
  const f = await pluginRuntimeFixture();
  let worker: ReturnType<typeof indexWorker> | undefined;
  try {
    await f.services.knowledge.create({
      directory: '00-Inbox',
      fileName: 'offline.md',
      content: '# still editable',
      requestId: 'offline-create',
    });
    const config = {
      ...f.config,
      tokenizerPython: join(f.root, 'absent-python'),
      embeddingSpaceId: 'fixed-existing-space',
    };
    setDesiredEmbeddingSpace(f.db, config);
    const pending = f.db.prepare('SELECT id,attempts,status FROM index_jobs ORDER BY id').all();
    expect(pending.length).toBeGreaterThan(0);
    worker = indexWorker(
      config,
      f.db,
      f.platform.get().notes,
      f.platform.get().knowledge.snapshots,
    );
    await worker.drain();
    expect(f.db.prepare('SELECT id,attempts,status FROM index_jobs ORDER BY id').all()).toEqual(
      pending,
    );
    expect(await worker.capabilities()).toMatchObject({
      tokenizerReady: false,
      vectorReady: false,
    });
    const unavailable = { ...f.config, embeddingSpaceId: undefined };
    setDesiredEmbeddingSpace(f.db, unavailable);
    expect(unavailable.embeddingSpaceId).toBe('fixed-existing-space');
    expect(
      (
        f.db
          .prepare("SELECT value FROM index_meta WHERE key='desired_embedding_space'")
          .get() as any
      ).value,
    ).toBe('fixed-existing-space');
  } finally {
    await worker?.close();
    await f.close();
  }
});
