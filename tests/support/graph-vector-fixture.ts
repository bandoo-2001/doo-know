import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import { openDatabase } from '../../packages/core/db.js';
import { observeSource } from '../../packages/core/indexing/state.js';
import { FlatFileStore } from '../../packages/core/indexing/flat-file.js';
import type { VectorRuntimeClient } from '../../packages/core/indexing/vector-store.js';
import { hash } from '../../packages/core/graph/analysis-source.js';

export function basisVector(axis = 0) {
  const vector = Array<number>(512).fill(0);
  vector[axis] = 1;
  return vector;
}
/** Real SQLite/cache/segment publication, with only the external runtime loader replaced. */
export function graphVectorFixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-vector-'));
  const config: AppConfig = {
    knowledgeRoot: join(root, 'notes'),
    dataRoot: join(root, 'data'),
    secret: 'test',
    origin: 'http://test',
    embeddingSpaceId: 'fixture-bge-512',
  };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  db.prepare("INSERT INTO index_meta VALUES('desired_embedding_space',?)").run(
    config.embeddingSpaceId,
  );
  const store = new FlatFileStore(
    db,
    join(config.dataRoot, 'indexes'),
    { call: async () => ({}) } as unknown as VectorRuntimeClient,
    config.embeddingSpaceId!,
  );
  async function note(
    id: string,
    path: string,
    body: string,
    vectors = [basisVector()],
    spans?: [number, number][],
  ) {
    const file = join(config.knowledgeRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    db.prepare(
      'INSERT INTO notes(id,path) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path',
    ).run(id, path);
    const bytes = Buffer.from(body),
      source = observeSource(
        db,
        id,
        hash(body),
        statSync(file, { bigint: true }).mtimeNs.toString(),
        bytes.length,
      );
    db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(id);
    const ranges = spans ?? [[0, bytes.length]];
    const points = ranges.map(([start, end], ordinal) => {
      const content = bytes.subarray(start, end).toString('utf8'),
        chunkId = hash([id, source.contentHash, ordinal].join('\0')),
        inputHash = hash(id + '\0' + ordinal + '\0' + content),
        startLine = 1 + bytes.subarray(0, start).filter((b) => b === 10).length,
        endLine = Math.max(
          startLine,
          startLine +
            bytes.subarray(start, end).filter((b) => b === 10).length -
            (bytes[end - 1] === 10 ? 1 : 0),
        );
      db.prepare(
        `INSERT OR REPLACE INTO chunks(chunk_id,note_id,source_hash,source_revision,chunker_id,ordinal,heading_path,start_line,end_line,content,input_hash,title,path,active,start_byte,end_byte) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      ).run(
        chunkId,
        id,
        source.contentHash,
        source.sourceRevision,
        'fixture-chunker',
        ordinal,
        '[]',
        startLine,
        endLine,
        content,
        inputHash,
        id,
        path,
        start,
        end,
      );
      return { chunkId, noteId: id, sourceHash: source.contentHash, inputHash };
    });
    db.prepare(
      'UPDATE document_state SET text_indexed_hash=content_hash,title=? WHERE note_id=?',
    ).run(id, id);
    for (let i = 0; i < points.length; i += 16)
      await store.prepare(source, points.slice(i, i + 16), vectors.slice(i, i + 16), false);
    await store.publish(await store.finalize(source));
    return { source, points };
  }
  return {
    root,
    config,
    db,
    store,
    note,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
