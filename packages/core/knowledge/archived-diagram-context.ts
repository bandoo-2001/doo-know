import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
export type ArchivedDiagramContext = {
  folderId: string;
  logicalRoot: string;
  identity: string;
  inventory: string;
};
export function archivedDiagramRoot(
  config: AppConfig,
  db: AppDatabase,
  context: ArchivedDiagramContext,
) {
  if (!/^folder-[a-f0-9-]{36}$/.test(context.folderId)) fail(400, 'INVALID_PATH');
  const row = db
    .prepare('SELECT path,state,identity FROM folder_trash WHERE id=?')
    .get(context.folderId) as any;
  if (
    !row ||
    row.path !== context.logicalRoot ||
    row.state !== 'trashed' ||
    row.identity !== context.identity
  )
    fail(409, 'TRASH_CHANGED');
  let path = safePath(config.knowledgeRoot, '90-Archive', 'folder');
  for (const part of ['.trash', context.folderId, 'tree']) {
    path = join(path, part);
    const s = lstatSync(path, { bigint: true });
    if (s.isSymbolicLink() || !s.isDirectory()) fail(409, 'TRASH_CHANGED');
  }
  const s = lstatSync(path, { bigint: true });
  if (`${s.dev}:${s.ino}` !== context.identity) fail(409, 'TRASH_CHANGED');
  return path;
}
/** Metadata covers every archived entry; content/source hashes are checked separately. */
export function archivedTreeInventory(root: string) {
  const entries: unknown[] = [];
  let count = 0;
  const walk = (path: string, relative: string) => {
    if (++count > 50000) fail(413, 'FOLDER_TOO_LARGE');
    const s = lstatSync(path, { bigint: true });
    if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n)))
      fail(409, 'TRASH_CHANGED');
    entries.push([
      relative,
      String(s.dev),
      String(s.ino),
      String(s.mtimeNs),
      String(s.ctimeNs),
      String(s.size),
    ]);
    if (s.isDirectory())
      for (const name of readdirSync(path).sort())
        walk(join(path, name), relative ? relative + '/' + name : name);
  };
  walk(root, '');
  return sha256(JSON.stringify(entries));
}
