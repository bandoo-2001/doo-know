import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  fsyncSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { sha256 } from './operations.js';
import { fsyncDirectory } from './core.js';
import { recordRevisionContext } from './revision-context.js';
import { fail } from './errors.js';
/** Promote a journal's immutable original into the ordinary typed history once. */
export function recordOperationRevision(
  config: AppConfig,
  db: AppDatabase,
  input: {
    operationId: string;
    noteId: string;
    logicalPath: string;
    beforeHash: string;
    modifiedAt: string;
    backupPath: string;
  },
) {
  const hash = sha256(input.operationId + '\0' + input.noteId),
    revisionId = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join('-'),
    file = revisionId + '.md';
  if (db.prepare('SELECT 1 FROM revisions WHERE id=?').get(revisionId)) return;
  const source = openSync(input.backupPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = fstatSync(source, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 20n * 1024n * 1024n)
      fail(409, 'REVISION_CONTENT_CONFLICT');
    bytes = readFileSync(source);
    const after = fstatSync(source, { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      sha256(bytes) !== input.beforeHash
    )
      fail(409, 'REVISION_CONTENT_CONFLICT');
  } finally {
    closeSync(source);
  }
  const directory = join(config.dataRoot, 'history');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, file);
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      sha256(readFileSync(path)) !== input.beforeHash
    )
      fail(409, 'REVISION_CONTENT_CONFLICT');
  } else {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(directory);
  }
  recordRevisionContext(config, db, {
    id: input.operationId,
    note_id: input.noteId,
    path: input.logicalPath,
    kind: 'organization',
    revision_id: revisionId,
    history_file: file,
    original_hash: input.beforeHash,
    original_mtime: input.modifiedAt,
  });
}
