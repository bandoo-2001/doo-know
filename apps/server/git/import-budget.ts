import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../../../packages/core/knowledge/errors.js';

const maxBytes = 1024 * 1024 * 1024;
const maxEntries = 100000;
const reserve = 512 * 1024 * 1024;
export type ImportUsage = { bytes: number; entries: number };
function check(usage: ImportUsage) {
  if (usage.bytes > maxBytes || usage.entries > maxEntries) fail(413, 'GIT_CLONE_TOO_LARGE');
}
export async function measureImport(path: string): Promise<ImportUsage> {
  const usage = { bytes: 0, entries: 0 };
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const stat = await lstat(file).catch((error) => {
        // Git atomically renames temporary packs during download.
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) continue;
      usage.entries++;
      if (!stat.isDirectory()) usage.bytes += Number(stat.size);
      check(usage);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(file);
    }
  }
  await visit(path);
  return usage;
}
export async function checkImportSpace(path: string, additionalBytes = 0) {
  const disk = await statfs(path);
  if (Number(disk.bavail) * Number(disk.bsize) - additionalBytes < reserve)
    fail(409, 'INSUFFICIENT_DISK_SPACE');
}
/** ls-tree -rlz includes blob sizes without decompressing a working copy. */
export function checkImportTree(output: Buffer, staged: ImportUsage): number {
  let bytes = 0,
    entries = 0;
  const directories = new Set<string>();
  for (const entry of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = entry.match(/^100(?:644|755) blob [a-f0-9]+\s+(\d+)\t([\s\S]+)$/);
    if (!match) fail(409, 'UNSUPPORTED_GIT_ENTRY');
    bytes += Number(match[1]);
    entries++;
    const parts = match[2].split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    check({ bytes: staged.bytes + bytes, entries: staged.entries + entries + directories.size });
  }
  return bytes;
}
