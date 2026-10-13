import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { Chunk } from '../../shared/knowledge-contracts.js';
import type { TokenizerClient } from './tokenizer-client.js';
import { readBlocks } from '../knowledge/file-reader.js';
import { utf8Prefix } from '../knowledge/limits.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
export type IndexedChunk = Chunk & {
  startByte: number;
  endByte: number;
  tokenCount: number;
  embeddingInput: string;
  embeddingTokenCount: number;
};
export function chunkService(config: AppConfig, db: AppDatabase, tokenizer: TokenizerClient) {
  async function* chunkDocument(
    snapshotId: string,
    chunkerId: string,
  ): AsyncGenerator<IndexedChunk> {
    const snapshot = db.prepare('SELECT * FROM read_snapshots WHERE id=?').get(snapshotId) as any;
    if (!snapshot || snapshot.source_hash === 'preparing') fail(404, 'SNAPSHOT_NOT_FOUND');
    const note = db
      .prepare(
        'SELECT n.path,d.title FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.id=?',
      )
      .get(snapshot.note_id) as any;
    let pending = Buffer.alloc(0),
      startByte = 0,
      startLine = 1,
      ordinal = 0,
      emittedEnd = 0,
      heading: string[] = [],
      headingOrdinal = 0;
    let nextHeading = db
      .prepare('SELECT * FROM outline_offsets WHERE snapshot_id=? AND ordinal=?')
      .get(snapshotId, 0) as any;
    const headings = () => {
      while (nextHeading && nextHeading.byte <= startByte) {
        heading[nextHeading.level - 1] = nextHeading.title;
        heading.length = nextHeading.level;
        nextHeading = db
          .prepare('SELECT * FROM outline_offsets WHERE snapshot_id=? AND ordinal=?')
          .get(snapshotId, ++headingOrdinal);
      }
    };
    async function* flush(final: boolean) {
      while (pending.length && (final || pending.length >= 8192)) {
        if (startByte + pending.length <= emittedEnd) {
          pending = Buffer.alloc(0);
          break;
        }
        headings();
        let take = Math.min(8192, pending.length),
          atHeading = false;
        if (nextHeading && nextHeading.byte > startByte && nextHeading.byte < startByte + take) {
          take = nextHeading.byte - startByte;
          atHeading = true;
        } else {
          const paragraph = pending.subarray(0, take).lastIndexOf(Buffer.from('\n\n'));
          if (paragraph >= 2048) take = paragraph + 2;
        }
        const bytes = utf8Prefix(pending, take);
        if (!bytes.length) break;
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
          result = await tokenizer.split(text, [note?.title || note?.path, ...heading].join('\n'));
        const inputs = result.slices.map((s) =>
            result.header ? result.header + '\n' + s.content : s.content,
          ),
          counts = await tokenizer.count(inputs);
        for (let i = 0; i < result.slices.length; i++) {
          const slice = result.slices[i],
            end = startByte + slice.endByte;
          if (end <= emittedEnd) continue;
          if (counts[i] > 512) fail(413, 'CHUNK_TOKEN_LIMIT');
          const before = bytes.subarray(0, slice.startByte),
            contentBytes = bytes.subarray(slice.startByte, slice.endByte),
            line = startLine + before.filter((b) => b === 10).length,
            endLine =
              line +
              contentBytes.filter((b) => b === 10).length -
              (contentBytes.at(-1) === 10 ? 1 : 0);
          yield {
            chunkId: sha256(
              [snapshot.note_id, snapshot.source_hash, chunkerId, ordinal].join('\0'),
            ),
            noteId: snapshot.note_id,
            sourceHash: snapshot.source_hash,
            chunkerId,
            ordinal: ordinal++,
            headingPath: [...heading],
            startLine: line,
            endLine: Math.max(line, endLine),
            content: slice.content,
            embeddingInputHash: sha256(inputs[i]),
            startByte: startByte + slice.startByte,
            endByte: end,
            tokenCount: slice.tokenCount,
            embeddingInput: inputs[i],
            embeddingTokenCount: counts[i],
          };
          emittedEnd = end;
        }
        const consumed =
          atHeading || (final && bytes.length === pending.length)
            ? bytes.length
            : result.carryStartByte;
        if (!Number.isInteger(consumed) || consumed <= 0 || consumed > bytes.length)
          fail(500, 'CHUNKER_NO_PROGRESS');
        startLine += pending.subarray(0, consumed).filter((b) => b === 10).length;
        startByte += consumed;
        pending = Buffer.from(pending.subarray(consumed));
      }
    }
    for await (const bytes of readBlocks(snapshot.path)) {
      pending = Buffer.concat([pending, bytes]);
      yield* flush(false);
    }
    yield* flush(true);
  }
  return { chunkDocument };
}
