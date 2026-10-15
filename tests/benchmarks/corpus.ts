import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { openDatabase } from '../../packages/core/db.js';
import type { registerAgentRoutes } from '../../apps/server/agent/routes.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';
import { hashFile, writeAll } from '../../packages/core/knowledge/file-reader.js';
import { syntheticFixture, type BenchmarkDocument } from './fixtures.js';
import { ResourceMonitor } from './support.js';
import type { AppConfig } from '../../shared/contracts.js';
import type { IndexedChunk } from '../../packages/core/indexing/chunks.js';

export const noise = [
  '兰花适合通风的窗台，盆土微湿，观察叶片颜色。',
  '海边沙滩有细砂和贝壳，潮水每天改变岸边形状。',
  '晚餐烤面包搭配苹果和酸奶，放凉后再切片。',
  '小提琴练习从慢速音阶开始，保持肩膀自然放松。',
  '山间徒步需要舒适鞋子，午后云层厚时留意天气。',
  '花园里的蜜蜂采集花粉，春季开花时活动频繁。',
  '木桌表面保持干燥，杯子下放软垫保护桌面。',
  '星空摄影选择晴朗夜晚，远离灯光并稳固三脚架。',
];

type Core = Awaited<ReturnType<typeof registerAgentRoutes>>;
export async function seedCorpus(
  count: number,
  config: AppConfig,
  db: ReturnType<typeof openDatabase>,
  core: Core,
  runtime: any,
  seed: number,
) {
  if (count < 21) throw new Error('Semantic corpus requires at least 21 chunks');
  const fixture = syntheticFixture(seed),
    forbidden: BenchmarkDocument = {
      path: '00-Inbox/forbidden/sentinel.md',
      title: 'Private ACL sentinel',
      content: '# Private ACL sentinel\nprivate_acl_sentinel_qz9981\n',
    },
    templates = [...fixture.documents, forbidden]
      .map((d) => ({ title: d.title, content: d.content }))
      .concat(noise.map((content) => ({ title: '隔离对照资料', content: content + '\n' })));
  const before = performance.now(),
    monitor = new ResourceMonitor([runtime.pid]),
    embeddings: number[][] = [];
  const tokenCounts = await core.worker.tokenizer.count(templates.map((t) => t.content)),
    embeddingTokenCounts = await core.worker.tokenizer.count(
      templates.map((t) => `${t.title}\n${t.content}`),
    );
  for (let i = 0; i < templates.length; i += 16)
    embeddings.push(
      ...(await core.worker.client!.documents(
        templates.slice(i, i + 16).map((t) => `${t.title}\n${t.content}`),
      )),
    );
  const uniqueEmbeddingMs = performance.now() - before,
    generation = `benchmark-${count}`,
    segmentId = `bulk-${count}`,
    segment = join(runtime.indexes, 'corpus.f32'),
    fd = await open(segment, 'wx', 0o600);
  db.prepare('INSERT INTO vector_generations VALUES(?,?,?,?,?,?,?)').run(
    generation,
    runtime.spaceId,
    '',
    '',
    'preparing',
    null,
    Date.now(),
  );
  const insertVector = db.prepare('INSERT INTO vector_rows VALUES(?,?,?,?,?)'),
    insertSegmentRow = db.prepare('INSERT INTO vector_segment_rows VALUES(?,?,?,?,?,?)');
  let row = 0,
    textStageMs = 0,
    vectorWriteMs = 0,
    noiseOrdinal = 0,
    noteCount = 0;
  try {
    while (row < count) {
      const primary = row < 21,
        document = primary
          ? [...fixture.documents, forbidden][row]
          : {
              path: `00-Inbox/benchmark/noise/${String(noiseOrdinal++).padStart(5, '0')}.md`,
              title: '隔离对照资料',
              content: '',
            },
        templateIds = primary
          ? [row]
          : Array.from(
              { length: Math.min(64, count - row) },
              (_, i) => 21 + ((row + i + seed) % noise.length),
            ),
        body = primary ? document.content : templateIds.map((i) => templates[i].content).join(''),
        noteId = `benchmark-note-${noteCount++}`,
        sourceHash = sha256(body),
        file = join(config.knowledgeRoot, document.path);
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeFile(file, body, { mode: 0o600, flag: 'wx' });
      const physical = await stat(file, { bigint: true });
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(noteId, document.path);
      db.prepare(
        'INSERT INTO document_state(note_id,content_hash,mtime_ns,size_bytes,source_revision,text_indexed_hash,vector_indexed_hash,last_checked_at,title,longest_line_bytes) VALUES(?,?,?,?,1,?,?,?,?,?)',
      ).run(
        noteId,
        sourceHash,
        physical.mtimeNs.toString(),
        Number(physical.size),
        sourceHash,
        sourceHash,
        new Date().toISOString(),
        document.title,
        Math.max(...body.split('\n').map((line) => Buffer.byteLength(line))),
      );
      const version = { noteId, sourceRevision: 1, contentHash: sourceHash };
      let offset = 0,
        line = 1;
      const chunks: IndexedChunk[] = templateIds.map((id, ordinal) => {
        const content = primary ? body : templates[id].content,
          startByte = offset,
          startLine = line,
          embeddingInput = `${document.title}\n${content}`;
        offset += Buffer.byteLength(content);
        line += content.split('\n').length - 1;
        return {
          chunkId: sha256(`${noteId}:${sourceHash}:${ordinal}`),
          noteId,
          sourceHash,
          chunkerId: 'benchmark-synthetic-v1',
          ordinal,
          headingPath: [document.title],
          startLine,
          endLine: line,
          startByte,
          endByte: offset,
          content,
          embeddingInput,
          embeddingInputHash: sha256(embeddingInput),
          tokenCount: tokenCounts[id],
          embeddingTokenCount: embeddingTokenCounts[id],
        };
      });
      const stageStart = performance.now();
      for (let i = 0; i < chunks.length; i += 16)
        await core.worker.text.stage(
          version,
          document.title,
          document.path,
          chunks.slice(i, i + 16),
        );
      if (core.worker.text.publish(version, 'benchmark-synthetic-v1') !== 'published')
        throw new Error('Synthetic text publication failed');
      textStageMs += performance.now() - stageStart;
      const vectorStart = performance.now();
      db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          insertVector.run(generation, row + i, c.chunkId, noteId, sourceHash);
          insertSegmentRow.run(
            segmentId,
            row + i,
            c.chunkId,
            noteId,
            sourceHash,
            c.embeddingInputHash,
          );
        }
        for (const target of ['text', 'vector'])
          db.prepare(
            'INSERT INTO index_jobs(id,note_id,source_revision,source_hash,target,space_id,status) VALUES(?,?,1,?,?,?,?)',
          ).run(
            `${noteId}-${target}`,
            noteId,
            sourceHash,
            target,
            target === 'vector' ? runtime.spaceId : '',
            'done',
          );
      })();
      for (let start = 0; start < templateIds.length; start += 32) {
        const ids = templateIds.slice(start, start + 32),
          bytes = Buffer.alloc(ids.length * 2048);
        for (let i = 0; i < ids.length; i++)
          for (let col = 0; col < 512; col++)
            bytes.writeFloatLE(embeddings[ids[i]][col], (i * 512 + col) * 4);
        await writeAll(fd, bytes);
      }
      vectorWriteMs += performance.now() - vectorStart;
      row += chunks.length;
      if (row >= 64 && row % 10000 < 64)
        console.log(
          JSON.stringify({
            progress: 'materializing real-embedding synthetic corpus',
            chunks: row,
            target: count,
          }),
        );
    }
    await fd.sync();
  } finally {
    await fd.close();
  }
  const checksum = await hashFile(segment),
    manifest = join(runtime.indexes, 'generation.json'),
    manifestFd = await open(manifest, 'wx', 0o600);
  try {
    await writeAll(
      manifestFd,
      Buffer.from(
        JSON.stringify({ generation, embeddingSpaceId: runtime.spaceId, dimensions: 512 }).slice(
          0,
          -1,
        ) +
          ',"segments":[' +
          JSON.stringify({ id: segmentId, file: segment, checksum }).slice(0, -1) +
          ',"rows":[',
      ),
    );
    let first = true,
      buffer = '';
    for (const entry of db
      .prepare(
        'SELECT chunk_id,note_id,source_hash FROM vector_rows WHERE generation=? ORDER BY row',
      )
      .iterate(generation) as Iterable<any>) {
      const part =
        (first ? '' : ',') +
        JSON.stringify({
          chunkId: entry.chunk_id,
          noteId: entry.note_id,
          sourceHash: entry.source_hash,
        });
      first = false;
      buffer += part;
      if (Buffer.byteLength(buffer) >= 48000) {
        await writeAll(manifestFd, Buffer.from(buffer));
        buffer = '';
      }
    }
    await writeAll(manifestFd, Buffer.from(buffer + ']}]}'));
    await manifestFd.sync();
  } finally {
    await manifestFd.close();
  }
  const manifestHash = await hashFile(manifest);
  db.prepare('UPDATE vector_generations SET manifest_path=?,checksum=?,status=? WHERE id=?').run(
    manifest,
    manifestHash,
    'active',
    generation,
  );
  db.prepare('INSERT INTO vector_segments VALUES(?,?,?,?,?,?,?,?)').run(
    segmentId,
    runtime.spaceId,
    'benchmark-bulk',
    1,
    'synthetic-mixed-note-segment',
    segment,
    checksum,
    count,
  );
  db.prepare('INSERT INTO generation_segments VALUES(?,?)').run(generation, segmentId);
  db.prepare("INSERT INTO index_meta VALUES('active_generation',?)").run(generation);
  const loadStart = performance.now();
  await core.worker.client!.call('/generations/load', {
    manifestPath: manifest,
    checksum: manifestHash,
    spaceId: runtime.spaceId,
  });
  const resources = monitor.finish();
  return {
    fixture,
    build: {
      totalMs: performance.now() - before,
      uniqueEmbeddingMs,
      uniqueEmbeddingInputs: templates.length,
      vectorRows: count,
      documentCount: noteCount,
      vectorBytes: count * 2048,
      textStageMs,
      vectorWriteMs,
      generationLoadMs: performance.now() - loadStart,
      resources,
      method:
        'Actual text.stage/publish plus streamed bulk vector fixture; repeated texts reuse real BGE embeddings. This is not a production full-job rebuild of unique documents.',
    },
  };
}
