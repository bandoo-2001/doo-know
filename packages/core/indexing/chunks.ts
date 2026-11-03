import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { Chunk } from '../../../shared/knowledge-contracts.js';
import type { TokenizerClient } from './tokenizer-client.js';
import { readBlocks } from '../knowledge/file-reader.js';
import { utf8Prefix } from '../knowledge/limits.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { createHash } from 'node:crypto';
import { diagramHeaderProbe, diagramTextSpans } from '../../../shared/diagram-text-projection.js';
import { chunkInventory } from './scan-proof.js';
import { isWhiteboard, MAX_WHITEBOARD_BYTES } from '../../../shared/whiteboard.js';
import { whiteboardTextSpans } from '../../../shared/whiteboard-text-spans.js';
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
    const inventory = chunkInventory(),
      rawHash = createHash('sha256');
    let scanned = 0;
    const record = (chunk: IndexedChunk) => {
      inventory.add(chunk);
      return chunk;
    };
    const complete = () => {
      if (scanned !== snapshot.size_bytes || rawHash.digest('hex') !== snapshot.source_hash)
        fail(409, 'INDEX_VERSION_CONFLICT');
      const proof = inventory.finish();
      db.prepare('INSERT OR REPLACE INTO index_scan_proofs VALUES(?,?,?,?,?,?)').run(
        snapshot.note_id,
        snapshot.source_hash,
        chunkerId,
        scanned,
        proof.count,
        proof.digest,
      );
    };
    if (isWhiteboard(note.path)) {
      if (snapshot.size_bytes > MAX_WHITEBOARD_BYTES) fail(413, 'FILE_TOO_LARGE');
      const parts: Buffer[] = [];
      for await (const bytes of readBlocks(snapshot.path)) {
        scanned += bytes.length;
        if (scanned > MAX_WHITEBOARD_BYTES) fail(413, 'FILE_TOO_LARGE');
        rawHash.update(bytes);
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts),
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      let ordinal = 0;
      for (const span of whiteboardTextSpans(source)) {
        const decoded = Buffer.from(span.text);
        let rawChar = span.from,
          rawByte = span.startByte,
          offset = 0;
        while (offset < decoded.length) {
          let part = utf8Prefix(decoded.subarray(offset), 8192),
            text = part.toString('utf8');
          const rawOffsets = [rawChar];
          // A JSON escape represents one UTF-16 unit; actual surrogate pairs remain two units.
          for (let i = 0; i < text.length; i++) {
            rawChar += source[rawChar] === '\\' ? (source[rawChar + 1] === 'u' ? 6 : 2) : 1;
            rawOffsets.push(rawChar);
          }
          let rawPart = source.slice(rawOffsets[0], rawChar);
          const bounded = utf8Prefix(Buffer.from(rawPart), 8192).toString('utf8').length;
          if (bounded < rawPart.length) {
            let length = 0;
            while (length < text.length && rawOffsets[length + 1] - rawOffsets[0] <= bounded)
              length++;
            if (/[\uD800-\uDBFF]/.test(text[length - 1])) length--;
            text = text.slice(0, length);
            part = Buffer.from(text);
            rawChar = rawOffsets[length];
            rawOffsets.length = length + 1;
            rawPart = source.slice(rawOffsets[0], rawChar);
          }
          const result = await tokenizer.split(text, note.title || note.path),
            inputs = result.slices.map((s) =>
              result.header ? result.header + '\n' + s.content : s.content,
            ),
            counts = await tokenizer.count(inputs);
          let end = 0;
          for (let i = 0; i < result.slices.length; i++) {
            const slice = result.slices[i];
            if (counts[i] > 512) fail(413, 'CHUNK_TOKEN_LIMIT');
            if (
              !Number.isInteger(slice.startByte) ||
              !Number.isInteger(slice.endByte) ||
              slice.startByte < 0 ||
              slice.startByte > end ||
              slice.endByte <= slice.startByte ||
              slice.endByte > part.length ||
              !Buffer.from(slice.content).equals(part.subarray(slice.startByte, slice.endByte))
            )
              fail(500, 'CHUNKER_INVALID_RANGE');
            const fromChar = part.subarray(0, slice.startByte).toString('utf8').length,
              toChar = part.subarray(0, slice.endByte).toString('utf8').length,
              from = rawOffsets[fromChar],
              to = rawOffsets[toChar],
              startByte = rawByte + Buffer.byteLength(source.slice(rawOffsets[0], from)),
              endByte = rawByte + Buffer.byteLength(source.slice(rawOffsets[0], to));
            yield record({
              chunkId: sha256(
                [snapshot.note_id, snapshot.source_hash, chunkerId, ordinal].join('\0'),
              ),
              noteId: snapshot.note_id,
              sourceHash: snapshot.source_hash,
              chunkerId,
              ordinal: ordinal++,
              headingPath: ['白板文字'],
              startLine: span.startLine,
              endLine: span.endLine,
              startByte,
              endByte,
              content: bytes.subarray(startByte, endByte).toString('utf8'),
              tokenCount: slice.tokenCount,
              embeddingInput: inputs[i],
              embeddingInputHash: sha256(inputs[i]),
              embeddingTokenCount: counts[i],
            });
            end = Math.max(end, slice.endByte);
          }
          if (end !== part.length) fail(409, 'INDEX_INCOMPLETE');
          rawByte += Buffer.byteLength(rawPart);
          offset += part.length;
        }
      }
      if (!ordinal) {
        // Preserve title/path search for empty scenes without fabricating source text.
        const input = note.title || note.path,
          count = (await tokenizer.count([input]))[0];
        if (count > 512) fail(413, 'CHUNK_TOKEN_LIMIT');
        yield record({
          chunkId: sha256([snapshot.note_id, snapshot.source_hash, chunkerId, 0].join('\0')),
          noteId: snapshot.note_id,
          sourceHash: snapshot.source_hash,
          chunkerId,
          ordinal: 0,
          headingPath: ['白板文字'],
          startLine: 1,
          endLine: 1,
          startByte: 0,
          endByte: 0,
          content: '',
          tokenCount: 0,
          embeddingInput: input,
          embeddingInputHash: sha256(input),
          embeddingTokenCount: count,
        });
      }
      complete();
      return;
    }
    const probe = diagramHeaderProbe(),
      decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    let candidate: boolean | undefined;
    for await (const bytes of readBlocks(snapshot.path)) {
      candidate = probe.push(decoder.decode(bytes, { stream: true }));
      if (candidate !== undefined) break;
    }
    candidate ??= probe.push(decoder.decode()) ?? probe.finish();
    if (candidate) {
      if (snapshot.size_bytes > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
      const parts: Buffer[] = [];
      for await (const bytes of readBlocks(snapshot.path)) {
        scanned += bytes.length;
        if (scanned > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
        rawHash.update(bytes);
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const spans = diagramTextSpans(markdown);
      if (!spans) fail(422, 'INVALID_DIAGRAM_DOCUMENT');
      let ordinal = 0;
      for (const span of spans) {
        let offset = span.startByte,
          partLine = span.startLine;
        while (offset < span.endByte) {
          const part = utf8Prefix(bytes.subarray(offset, span.endByte), 8192);
          const result = await tokenizer.split(part.toString('utf8'), note?.title || note?.path);
          const inputs = result.slices.map((s) =>
            result.header ? result.header + '\n' + s.content : s.content,
          );
          const counts = await tokenizer.count(inputs);
          let end = offset;
          for (let i = 0; i < result.slices.length; i++) {
            const slice = result.slices[i];
            if (counts[i] > 512) fail(413, 'CHUNK_TOKEN_LIMIT');
            if (
              !Number.isInteger(slice.startByte) ||
              !Number.isInteger(slice.endByte) ||
              slice.startByte < 0 ||
              slice.startByte > end - offset ||
              slice.endByte <= slice.startByte ||
              slice.endByte > part.length ||
              !Buffer.from(slice.content).equals(part.subarray(slice.startByte, slice.endByte))
            )
              fail(500, 'CHUNKER_INVALID_RANGE');
            const startByte = offset + slice.startByte,
              endByte = offset + slice.endByte;
            const startLine =
              partLine + part.subarray(0, slice.startByte).filter((b) => b === 10).length;
            const contentBytes = bytes.subarray(startByte, endByte);
            yield record({
              chunkId: sha256(
                [snapshot.note_id, snapshot.source_hash, chunkerId, ordinal].join('\0'),
              ),
              noteId: snapshot.note_id,
              sourceHash: snapshot.source_hash,
              chunkerId,
              ordinal: ordinal++,
              headingPath: [],
              startLine,
              endLine: Math.max(
                startLine,
                startLine +
                  contentBytes.filter((b) => b === 10).length -
                  (contentBytes.at(-1) === 10 ? 1 : 0),
              ),
              startByte,
              endByte,
              content: slice.content,
              tokenCount: slice.tokenCount,
              embeddingInput: inputs[i],
              embeddingInputHash: sha256(inputs[i]),
              embeddingTokenCount: counts[i],
            });
            end = Math.max(end, endByte);
          }
          if (end !== offset + part.length) fail(409, 'INDEX_INCOMPLETE');
          partLine += part.filter((b) => b === 10).length;
          offset += part.length;
        }
      }
      complete();
      return;
    }
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
          if (startByte + slice.startByte > emittedEnd) fail(409, 'INDEX_INCOMPLETE');
          if (
            slice.startByte < 0 ||
            slice.endByte > bytes.length ||
            slice.endByte <= slice.startByte ||
            !Buffer.from(slice.content).equals(bytes.subarray(slice.startByte, slice.endByte))
          )
            fail(500, 'CHUNKER_INVALID_RANGE');
          if (counts[i] > 512) fail(413, 'CHUNK_TOKEN_LIMIT');
          const before = bytes.subarray(0, slice.startByte),
            contentBytes = bytes.subarray(slice.startByte, slice.endByte),
            line = startLine + before.filter((b) => b === 10).length,
            endLine =
              line +
              contentBytes.filter((b) => b === 10).length -
              (contentBytes.at(-1) === 10 ? 1 : 0);
          yield record({
            chunkId: sha256(
              [snapshot.note_id, snapshot.source_hash, chunkerId, ordinal].join('\0'),
            ),
            noteId: snapshot.note_id,
            sourceHash: snapshot.source_hash,
            chunkerId,
            ordinal: ordinal++,
            headingPath: heading.filter((title) => typeof title === 'string'),
            startLine: line,
            endLine: Math.max(line, endLine),
            content: slice.content,
            embeddingInputHash: sha256(inputs[i]),
            startByte: startByte + slice.startByte,
            endByte: end,
            tokenCount: slice.tokenCount,
            embeddingInput: inputs[i],
            embeddingTokenCount: counts[i],
          });
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
      scanned += bytes.length;
      rawHash.update(bytes);
      pending = Buffer.concat([pending, bytes]);
      yield* flush(false);
    }
    yield* flush(true);
    if (emittedEnd !== scanned) fail(409, 'INDEX_INCOMPLETE');
    complete();
  }
  return { chunkDocument };
}
