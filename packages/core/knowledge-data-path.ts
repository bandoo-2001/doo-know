import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';
import { DOO_DATA_DIRECTORY, LEGACY_DATA_DIRECTORY } from '../../shared/storage-paths.js';
/** Resolve old state before migration without creating a second, divergent library. */
export function knowledgeDataDirectory(root: string): string {
  const current = join(root, DOO_DATA_DIRECTORY),
    legacy = join(root, LEGACY_DATA_DIRECTORY);
  const present = [current, legacy].filter((path) => existsSync(path));
  for (const path of present) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HttpError(503, '应用数据目录必须为真实目录');
  }
  if (present.length > 1)
    throw new HttpError(409, '同时存在 _doo-data 与旧 _data，请先核对迁移，不能自动合并');
  return present[0] || current;
}
