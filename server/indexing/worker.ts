import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { SnapshotService } from '../knowledge/snapshots.js';
import { webPrincipal } from '../knowledge/core.js';
import { safePath } from '../files.js';
import { fail, KnowledgeError } from '../knowledge/errors.js';
import { TokenizerClient } from './tokenizer-client.js';
import { chunkService, type IndexedChunk } from './chunks.js';
import { textIndexService } from './text.js';
import { indexJobService, type LeasedIndexJob } from './jobs.js';
import { VectorRuntimeClient } from './vector-store.js';
import { FlatFileStore } from './flat-file.js';
import { stageTags } from './tags.js';
export function indexWorker(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  snapshots: SnapshotService,
) {
  if (config.embeddingSpaceId)
    db.prepare("INSERT OR IGNORE INTO index_meta VALUES('desired_embedding_space',?)").run(
      config.embeddingSpaceId,
    );
  const workerId = `index:${process.pid}:${randomUUID()}`,
    tokenizer = new TokenizerClient({
      runtimeRoot: config.vectorRuntimeRoot,
      modelDir: config.modelDir,
      python: config.tokenizerPython,
    }),
    text = textIndexService(db, tokenizer),
    chunks = chunkService(config, db, tokenizer),
    jobs = indexJobService(db, { spaceId: config.embeddingSpaceId });
  const client =
    config.embeddingSpaceId && config.vectorServiceUrl && config.vectorServiceToken
      ? new VectorRuntimeClient(
          config.vectorServiceUrl,
          config.vectorServiceToken,
          config.embeddingSpaceId,
        )
      : null;
  const vectors = client
      ? new FlatFileStore(db, join(config.dataRoot, 'indexes'), client, config.embeddingSpaceId!)
      : null,
    rule = 'bge-320-48-v1:' + (config.embeddingSpaceId || 'jieba-0.42.1-local-bge');
  let lastMaintenance = 0;
  let current: Promise<void> | undefined,
    closing = false;
  let readiness = {
    tokenizerReady: false,
    vectorReady: false,
    tokenizerError: 'NOT_PREPARED' as string | undefined,
    vectorError: 'NOT_PREPARED' as string | undefined,
  };
  let checkedAt = 0,
    checking: Promise<typeof readiness> | undefined;
  function capabilities(force = false) {
    if (closing)
      return Promise.resolve({ ...readiness, tokenizerReady: false, vectorReady: false });
    if (checking) return checking;
    if (!force && Date.now() - checkedAt < 5000) return Promise.resolve({ ...readiness });
    checking = (async () => {
      const result = await Promise.allSettled([
        tokenizer.count([]),
        client
          ? client.call('/describe')
          : Promise.reject(new KnowledgeError(503, 'VECTOR_NOT_CONFIGURED', '向量组件未配置')),
      ]);
      const t = result[0],
        v = result[1];
      readiness = {
        tokenizerReady: t.status === 'fulfilled',
        vectorReady:
          v.status === 'fulfilled' &&
          v.value.spaceId === config.embeddingSpaceId &&
          v.value.dimensions === 512,
        tokenizerError:
          t.status === 'rejected' ? t.reason?.code || 'TOKENIZER_UNAVAILABLE' : undefined,
        vectorError:
          v.status === 'rejected'
            ? v.reason?.code || 'VECTOR_UNAVAILABLE'
            : v.value.spaceId !== config.embeddingSpaceId
              ? 'EMBEDDING_SPACE_MISMATCH'
              : undefined,
      };
      checkedAt = Date.now();
      return { ...readiness };
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  }
  const ensure = (job: LeasedIndexJob) => {
    if (closing) fail(503, 'WORKER_STOPPING');
    if (!jobs.valid(job)) fail(409, 'LEASE_LOST');
  };
  const reader = { ...webPrincipal, id: 'system:index-worker', clientId: 'indexer' };
  async function runJob(job: LeasedIndexJob) {
    const heartbeat = setInterval(() => jobs.heartbeat(job), 15000);
    heartbeat.unref();
    let snapshotId: string | undefined;
    try {
      ensure(job);
      let snapshot = await snapshots.available(reader, job.noteId, {});
      while ('operation' in snapshot) {
        ensure(job);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const op = snapshots.operation(snapshot.operation.operationId);
        if (op.status === 'succeeded' && op.snapshotId) {
          snapshot = await snapshots.check(reader, job.noteId, op.snapshotId);
          break;
        }
        if (!['queued', 'running'].includes(op.status))
          fail(503, op.error?.code || 'SNAPSHOT_FAILED');
      }
      if (snapshot.source_hash !== job.contentHash) fail(409, 'INDEX_VERSION_CONFLICT');
      snapshotId = snapshot.id;
      db.prepare('UPDATE read_snapshots SET refs=refs+1 WHERE id=?').run(snapshotId);
      if (job.target === 'text') await stageTags(db, job, snapshot.path, () => jobs.valid(job));
      const row = notes.row(job.noteId),
        title =
          (db.prepare('SELECT title FROM document_state WHERE note_id=?').get(job.noteId) as any)
            ?.title || row.path;
      let batch: IndexedChunk[] = [],
        count = 0;
      const stage = async () => {
        if (!batch.length) return;
        ensure(job);
        if (job.target === 'text')
          await text.stage(job, title, row.path, batch, () => jobs.valid(job));
        else {
          if (!client || !vectors) fail(503, 'VECTOR_NOT_CONFIGURED');
          const output: number[][] = [];
          const missing: { index: number; input: string }[] = [];
          for (let i = 0; i < batch.length; i++) {
            const cached = vectors.cached(batch[i].embeddingInputHash);
            if (cached) output[i] = cached;
            else missing.push({ index: i, input: batch[i].embeddingInput });
          }
          if (missing.length) {
            const computed = await client.documents(missing.map((x) => x.input));
            for (let i = 0; i < missing.length; i++) output[missing[i].index] = computed[i];
          }
          ensure(job);
          await vectors.prepare(
            job,
            batch.map((c) => ({
              chunkId: c.chunkId,
              noteId: c.noteId,
              sourceHash: c.sourceHash,
              inputHash: c.embeddingInputHash,
            })),
            output,
            false,
          );
        }
        ensure(job);
        jobs.checkpoint(job, count);
        batch = [];
      };
      for await (const chunk of chunks.chunkDocument(snapshot.id, rule)) {
        ensure(job);
        count = chunk.ordinal + 1;
        if (chunk.ordinal < job.checkpoint) continue;
        batch.push(chunk);
        if (batch.length === 16) {
          await stage();
          if (jobs.preempt(job)) return;
        }
      }
      await stage();
      ensure(job);
      const file = safePath(config.knowledgeRoot, row.path, 'note'),
        physical = await stat(file, { bigint: true });
      if (
        physical.mtimeNs.toString() !== snapshot.modified_at ||
        Number(physical.size) !== snapshot.size_bytes
      )
        fail(409, 'INDEX_VERSION_CONFLICT');
      if (job.target === 'text') {
        if (text.publish(job, rule, () => jobs.valid(job)) !== 'published')
          fail(409, 'INDEX_VERSION_CONFLICT');
      } else {
        if (!vectors) fail(503, 'VECTOR_NOT_CONFIGURED');
        const prepared = await vectors.finalize(job);
        ensure(job);
        if ((await vectors.publish(prepared, () => jobs.valid(job))) !== 'published')
          fail(409, 'INDEX_VERSION_CONFLICT');
      }
      jobs.complete(job);
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : 'INDEX_WORK_FAILED';
      if (
        [
          'TOKENIZER_UNAVAILABLE',
          'TOKENIZER_TIMEOUT',
          'TOKENIZER_BUSY',
          'VECTOR_UNAVAILABLE',
          'VECTOR_NOT_CONFIGURED',
          'EMBEDDING_SPACE_MISMATCH',
          'LOCAL_MODEL_MISSING',
        ].includes(code)
      ) {
        jobs.defer(job, code);
        checkedAt = 0;
      } else jobs.fail(job, code);
    } finally {
      clearInterval(heartbeat);
      if (snapshotId)
        db.prepare('UPDATE read_snapshots SET refs=max(0,refs-1) WHERE id=?').run(snapshotId);
      if (snapshotId) await snapshots.releaseInternal(snapshotId);
    }
  }
  async function drain() {
    if (current) return current;
    if (closing) return;
    current = (async () => {
      const ready = await capabilities();
      const targets: ('text' | 'vector')[] = ready.tokenizerReady
        ? ['text', ...(ready.vectorReady ? ['vector' as const] : [])]
        : [];
      let job: LeasedIndexJob | null;
      while (!closing && (job = jobs.claim(workerId, targets))) {
        await runJob(job);
        if (!checkedAt) break;
      }
      if (ready.vectorReady && vectors && !closing && Date.now() - lastMaintenance >= 60000) {
        lastMaintenance = Date.now();
        await vectors.compact().catch(() => {});
        await vectors.maintain().catch(() => {});
      }
    })().finally(() => {
      current = undefined;
    });
    return current;
  }
  async function close() {
    closing = true;
    await current;
    await checking;
    await tokenizer.close();
  }
  return {
    drain,
    close,
    jobs,
    text,
    vectors,
    client,
    tokenizer,
    capabilities,
    readiness: () => ({ ...readiness }),
  };
}
