import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { knowledgeDataDirectory } from './knowledge-data-path.js';
import { DOO_ASSETS_DIRECTORY } from '../../shared/storage-paths.js';

export const ASSET_ALIASES_FILE = 'library/asset-aliases.json';
export type StorageAssetAlias = { from: string; to: string; sha256: string; assetId?: string };
const relative = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  posix.normalize(value) === value &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value
    .split('/')
    .some((part) => part === '..' || part.startsWith('.') || !part || /[\x00-\x1f]/.test(part));
export function readStorageAssetAliases(root: string): StorageAssetAlias[] {
  const data = knowledgeDataDirectory(root),
    file = join(data, ASSET_ALIASES_FILE);
  if (!existsSync(file)) return [];
  for (const path of [join(data, 'library'), file]) {
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      (info.isFile() && (info.nlink !== 1 || info.size > 4 * 1024 * 1024))
    )
      throw Error('资源迁移映射文件不可用');
  }
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  const value = envelope.format === 1 && envelope.data ? envelope.data : envelope;
  if (value.version !== 1 || !Array.isArray(value.aliases)) throw Error('资源迁移映射格式不正确');
  const seen = new Set<string>();
  for (const entry of value.aliases) {
    if (
      !entry ||
      !relative(entry.from) ||
      !relative(entry.to) ||
      !entry.from.split('/').includes('assets') ||
      !entry.to.split('/').includes(DOO_ASSETS_DIRECTORY) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      seen.has(entry.from)
    )
      throw Error('资源迁移映射格式不正确');
    seen.add(entry.from);
  }
  return value.aliases;
}
/** Old immutable history references resolve only through exact, persisted migration entries. */
export function resolveStorageAssetAlias(root: string, path: string): string {
  if (!path.split('/').includes('assets') || existsSync(join(root, path))) return path;
  return readStorageAssetAliases(root).find((entry) => entry.from === path)?.to || path;
}
