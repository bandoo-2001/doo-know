import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';
import { DOO_DATA_DIRECTORY } from '../../shared/storage-paths.js';
/** The current application state directory must never resolve through a symlink. */
export function knowledgeDataDirectory(root: string): string {
  const current = join(root, DOO_DATA_DIRECTORY);
  if (existsSync(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HttpError(503, '应用数据目录必须为真实目录');
  }
  return current;
}
