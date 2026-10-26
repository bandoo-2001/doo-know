import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { safePath } from '../files.js';
import { authorizePath } from '../agent/auth.js';
import { acquireRead, chargeRate } from '../agent/budgets.js';
import { readBlocks, sameFile, stableStat } from '../knowledge/file-reader.js';
import { messageSize } from '../knowledge/limits.js';
import { fail } from '../knowledge/errors.js';
import {isWhiteboard,whiteboardText} from '../../../shared/whiteboard.js';

export function researchService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  async function fetch(
    p: Principal,
    noteId: string,
    chunkId: string | undefined,
    version: { sourceHash?: string; sourceRevision?: string },
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(version.sourceHash || '') ||
      !/^[1-9][0-9]*$/.test(version.sourceRevision || '') ||
      !Number.isSafeInteger(Number(version.sourceRevision))
    )
      fail(400, 'INVALID_RESEARCH_VERSION');
    const note = notes.row(noteId);
    authorizePath(p, note.path);
    const source = () =>
      db.prepare('SELECT * FROM document_state WHERE note_id=?').get(noteId) as any;
    const valid = () => {
      const current = source();
      if (
        !current?.active ||
        current.conflict ||
        current.content_hash !== version.sourceHash ||
        current.source_revision !== Number(version.sourceRevision)
      )
        fail(409, 'RESULT_STALE');
      return current;
    };
    const state = valid(),
      file = safePath(config.knowledgeRoot, note.path, 'note'),
      before = await stableStat(file);
    if (state.mtime_ns !== before.mtimeNs.toString() || state.size_bytes !== Number(before.size))
      fail(409, 'RESULT_STALE');
    const chunk = chunkId
      ? (db
          .prepare(
            'SELECT * FROM chunks WHERE note_id=? AND chunk_id=? AND active=1 AND source_hash=? AND source_revision=?',
          )
          .get(noteId, chunkId, version.sourceHash, state.source_revision) as any)
      : null;
    if (chunkId && !chunk) fail(409, 'RESULT_STALE');
    if (!chunkId && before.size > 16384n) fail(413, 'RESEARCH_OBJECT_TOO_LARGE');
    const release = acquireRead(db, p, 'mcp');
    try {
      const hash = createHash('sha256'),
        parts: Buffer[] = [];
      let bytes = 0;
      for await (const block of readBlocks(file, 0, undefined, AbortSignal.timeout(5000))) {
        hash.update(block);
        bytes += block.length;
        if (!chunkId) {
          if (bytes > 16384) fail(409, 'RESULT_STALE');
          parts.push(block);
        }
      }
      if (
        !sameFile(before, await stableStat(safePath(config.knowledgeRoot, note.path, 'note'))) ||
        hash.digest('hex') !== version.sourceHash
      )
        fail(409, 'RESULT_STALE');
      valid();
      authorizePath(p, notes.row(noteId).path);
      let text: string;
      try {
        text = chunk
          ? chunk.content
          : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
      } catch {
        fail(422, 'INVALID_UTF8');
      }
      if (!chunk && isWhiteboard(note.path)) text = whiteboardText(text);
      const title = [...(state.title || basename(note.path, '.md'))].slice(0, 256).join('');
      const data = {
        id: chunkId || noteId,
        title,
        text,
        url: `${config.origin}/?note=${encodeURIComponent(noteId)}${chunk ? '#L' + chunk.start_line : ''}`,
        metadata: {
          noteId,
          objectType: chunk ? 'chunk' : 'note',
          sourceHash: version.sourceHash,
          sourceRevision: state.source_revision,
          modifiedAt: before.mtimeNs.toString(),
          relativePath: note.path,
          ...(chunk
            ? {
                chunkId,
                // Preserve strict types while omitting legacy absent ancestors.
                headingPath: JSON.parse(chunk.heading_path).filter((title: unknown) => title != null),
                startLine: chunk.start_line,
                endLine: chunk.end_line,
                startByte: chunk.start_byte,
                endByte: chunk.end_byte,
              }
            : {}),
        },
      };
      if (Buffer.byteLength(text) > 16384 || messageSize(data) > 65536)
        fail(413, 'RESEARCH_OBJECT_TOO_LARGE');
      db.transaction(() => chargeRate(db, p, 'mcp', Buffer.byteLength(text))).immediate();
      return data;
    } finally {
      release();
    }
  }
  return { fetch };
}
