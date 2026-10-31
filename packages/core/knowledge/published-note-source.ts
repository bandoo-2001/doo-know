import { operationError } from './operations.js';
import { fileVersionStamp } from './file-reader.js';
import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readFileSync,
  lstatSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { limits } from './limits.js';
import { fail } from './errors.js';
export type PublicationReadState = {
  state: 'pending' | 'conflicted';
  code?: string;
  operationId: string;
};
export type PublishedNoteSource = {
  file: string;
  modifiedAt?: string;
  expectedHash?: string;
  publication?: PublicationReadState;
};
const verified = new WeakMap<AppDatabase, Map<string, string>>();
function verifyHistory(db: AppDatabase, file: string, expected: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limits.file)) throw Error();
    const signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, expected].join(
      ':',
    );
    const cache = verified.get(db) || new Map<string, string>();
    verified.set(db, cache);
    if (cache.get(file) !== signature) {
      const hash = createHash('sha256'),
        bytes = Buffer.allocUnsafe(limits.io);
      let length: number;
      while ((length = readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, length));
      const after = fstatSync(fd, { bigint: true });
      if (
        hash.digest('hex') !== expected ||
        info.mtimeNs !== after.mtimeNs ||
        info.ctimeNs !== after.ctimeNs ||
        info.size !== after.size
      )
        throw Error();
      // Only a small verification cache; authoritative evidence remains in the file and journal.
      if (cache.size >= 128) cache.clear();
      cache.set(file, signature);
    }
  } finally {
    closeSync(fd);
  }
}
/** A primary filesystem write is not published until its durable database record succeeds. */
export function publishedNoteSource(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  path: string,
): PublishedNoteSource {
  const pending = db
    .prepare(
      "SELECT w.id,w.history_file,w.original_hash,w.original_mtime,w.status AS intent_status,o.status AS operation_status,o.error FROM write_intents w JOIN operations o ON o.id=w.id JOIN diagram_pending_publications p ON p.operation_id=w.id WHERE w.note_id=? AND w.path=? AND w.kind IN ('update','patch') AND w.status IN ('prepared','conflicted') ORDER BY w.rowid DESC LIMIT 1",
    )
    .get(noteId, path) as
    | {
        id: string;
        history_file: string | null;
        original_hash: string | null;
        original_mtime: string | null;
        intent_status: string;
        operation_status: string;
        error: string | null;
      }
    | undefined;
  if (!pending) return { file: safePath(config.knowledgeRoot, path, 'note') };
  try {
    if (
      !pending.history_file ||
      !/^[A-Za-z0-9-]+\.md$/.test(pending.history_file) ||
      !pending.original_hash ||
      !pending.original_mtime
    )
      throw Error();
    const directory = join(config.dataRoot, 'history'),
      dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error();
    const file = join(directory, pending.history_file);
    verifyHistory(db, file, pending.original_hash);
    return {
      file,
      modifiedAt: pending.original_mtime,
      expectedHash: pending.original_hash,
      publication: {
        state:
          pending.intent_status === 'conflicted' ||
          pending.operation_status === 'needs_reconciliation'
            ? 'conflicted'
            : 'pending',
        operationId: pending.id,
        ...(pending.error ? { code: operationError(pending.error).code } : {}),
      },
    };
  } catch {
    return fail(
      409,
      'DIAGRAM_PUBLISHED_VERSION_UNAVAILABLE',
      '最后完整版本的恢复证据不可用，请核对保存状态',
      true,
    );
  }
}
export function readPublishedMarkdown(source: PublishedNoteSource) {
  const fd = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.file))
      fail(409, 'DIAGRAM_PUBLISHED_VERSION_UNAVAILABLE');
    const bytes = readFileSync(fd),
      after = fstatSync(fd, { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      createHash('sha256').update(bytes).digest('hex') !== source.expectedHash
    )
      fail(409, 'DIAGRAM_PUBLISHED_VERSION_UNAVAILABLE');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail(422, 'INVALID_UTF8');
    }
    const modifiedAt = source.modifiedAt!;
    return {
      content,
      signature: fileVersionStamp(after),
      modifiedAt,
      updatedAt: new Date(Number(BigInt(modifiedAt) / 1000000n)).toISOString(),
      publication: source.publication,
    };
  } finally {
    closeSync(fd);
  }
}

const versions = new WeakMap<AppDatabase, Map<string, { stamp: string; hash: string }>>();
/** Hash a mutable main at most once per physical version; callers authorize the logical note. */
export function readableSourceVersion(db: AppDatabase, source: PublishedNoteSource) {
  const fd = openSync(
    source.file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.file))
      fail(409, 'SOURCE_UNAVAILABLE');
    const stamp = fileVersionStamp(before),
      cache = versions.get(db) || new Map<string, { stamp: string; hash: string }>();
    versions.set(db, cache);
    let hash =
      source.expectedHash ||
      (cache.get(source.file)?.stamp === stamp && cache.get(source.file)!.hash);
    if (!hash) {
      const digest = createHash('sha256'),
        bytes = Buffer.allocUnsafe(limits.io);
      let count: number;
      while ((count = readSync(fd, bytes)) > 0) digest.update(bytes.subarray(0, count));
      hash = digest.digest('hex');
    }
    const after = fstatSync(fd, { bigint: true });
    if (fileVersionStamp(after) !== stamp) fail(409, 'VERSION_CONFLICT');
    if (cache.size >= 128) cache.clear();
    cache.set(source.file, { stamp, hash });
    return {
      contentHash: hash,
      modifiedAt: source.modifiedAt ?? before.mtimeNs.toString(),
      sizeBytes: Number(before.size),
      ...(source.publication ? { publication: source.publication } : {}),
    };
  } finally {
    closeSync(fd);
  }
}
