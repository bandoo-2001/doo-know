import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { workspacePermit } from '../../../packages/core/workspace/gate.js';

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
function openDirectory(path: string) {
  let fd = openSync(sep, flags);
  try {
    for (const part of resolve(path).split(sep).filter(Boolean)) {
      const next = openSync(join(fdPath(fd), part), flags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
const segment = (name: string) =>
  name.length > 0 && name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
export function trashFile<T>(
  root: string,
  id: string,
  name: string,
  work: (file: string, fingerprint: string, size: number, parent: number) => T,
): T {
  if (!segment(id) || !segment(name)) fail(400, 'INVALID_PATH');
  const parent = openDirectory(join(root, '90-Archive', '.trash', id));
  try {
    const file = join(fdPath(parent), name),
      info = lstatSync(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail(400, 'INVALID_PATH');
    // Open the leaf without following links and compare it with lstat before exposing metadata.
    const leaf = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pinned = fstatSync(leaf, { bigint: true });
      if (
        pinned.ino !== info.ino ||
        pinned.dev !== info.dev ||
        !pinned.isFile() ||
        pinned.nlink !== 1n
      )
        fail(409, 'TRASH_CHANGED');
    } finally {
      closeSync(leaf);
    }
    const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
    return work(file, fingerprint, Number(info.size), parent);
  } finally {
    closeSync(parent);
  }
}
export function purgeTrashFile(
  db: AppDatabase,
  root: string,
  id: string,
  expected: { name: string; fingerprint: string },
) {
  workspacePermit(db);
  const row = db.prepare('SELECT active,trash_path FROM notes WHERE id=?').get(id) as
    | { active: number; trash_path: string | null }
    | undefined;
  if (!row || row.active || !row.trash_path) fail(409, 'TRASH_CHANGED');
  if (row.trash_path !== expected.name) fail(409, 'TRASH_CHANGED');
  if (
    db
      .prepare(
        "SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted')",
      )
      .get(id)
  )
    fail(409, 'OPERATION_IN_PROGRESS');
  return trashFile(root, id, row.trash_path, (file, fingerprint, _size, parent) => {
    if (fingerprint !== expected.fingerprint) fail(409, 'TRASH_CHANGED');
    // Only the explicitly selected ordinary trash leaf is removed. Metadata/history/backups
    // remain governed by their own retention policies; never recursively remove a directory.
    unlinkSync(file);
    fsyncSync(parent);
    db.prepare('UPDATE notes SET trash_path=NULL WHERE id=? AND active=0').run(id);
    db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
    return { id, ok: true };
  });
}
