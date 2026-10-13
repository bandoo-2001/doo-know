import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { reconcileService } from '../server/indexing/reconcile.js';
import { indexJobService } from '../server/indexing/jobs.js';
const config = loadConfig(),
  db = openDatabase(config.dataRoot),
  indexing = reconcileService(config, db),
  jobs = indexJobService(db, { spaceId: config.embeddingSpaceId });
const allowed = new Set(['--full-hash', '--retry-failed', '--rebuild-text', '--rebuild-vector']);
if (process.argv.slice(2).some((flag) => !allowed.has(flag)) || process.argv.length < 3)
  throw new Error(
    '用法：index:maintain -- --full-hash|--retry-failed|--rebuild-text|--rebuild-vector',
  );
try {
  if (process.argv.includes('--full-hash')) await indexing.reconcile(undefined, true);
  if (process.argv.includes('--retry-failed')) jobs.retry();
  for (const target of ['text', 'vector'] as const)
    if (process.argv.includes('--rebuild-' + target))
      db.transaction(() => {
        for (const n of db
          .prepare(
            'SELECT note_id,source_revision,content_hash FROM document_state WHERE active=1 AND content_hash IS NOT NULL AND conflict=0',
          )
          .iterate() as Iterable<any>) {
          if (target === 'vector' && !config.embeddingSpaceId)
            throw new Error('重建向量必须配置经过校验的模型空间');
          jobs.enqueue(
            { noteId: n.note_id, sourceRevision: n.source_revision, contentHash: n.content_hash },
            target,
          );
          db.prepare(
            "UPDATE index_jobs SET status='pending',attempts=0,next_run_at=0,checkpoint=0,error=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE note_id=? AND target=? AND source_revision=? AND source_hash=? AND space_id=?",
          ).run(
            n.note_id,
            target,
            n.source_revision,
            n.content_hash,
            target === 'vector' ? config.embeddingSpaceId : '',
          );
          db.prepare(
            `UPDATE document_state SET ${target === 'text' ? 'text' : 'vector'}_indexed_hash=NULL WHERE note_id=?`,
          ).run(n.note_id);
        }
      })();
  console.log('索引维护请求已完成；持久任务由索引 worker 执行。');
} finally {
  await indexing.close();
  db.close();
}
