import { isKnowledgeDataPath } from '../../../shared/storage-paths.js';
import { assetByteLimit } from '../../../shared/media.js';
import { createHash } from 'node:crypto';
import { createReadStream, constants, openSync } from 'node:fs';
import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import { validName } from '../files.js';
import { fail } from '../knowledge/errors.js';

export const manifestName = 'dooknow-portable.json';
const file = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['document', 'asset']),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const manifestSchema = z
  .object({
    format: z.literal('dooknow-portable'),
    version: z.literal(1),
    files: z.array(file).min(1).max(limits.files),
    selected: z.array(z.string()).min(1).max(limits.documents),
  })
  .strict();
export type PortableManifest = z.infer<typeof manifestSchema>;
export function portablePath(path: string) {
  if (
    !path ||
    posix.normalize(path) !== path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !validName(part)) ||
    isKnowledgeDataPath(path)
  )
    fail(400, 'INVALID_PORTABLE_PATH');
  return path;
}
export function validateManifest(value: unknown): PortableManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) fail(400, 'INVALID_PORTABLE_MANIFEST');
  const seen = new Set<string>();
  let bytes = 0,
    documents = 0;
  for (const file of parsed.data.files) {
    portablePath(file.path);
    const key = file.path.normalize('NFC').toLowerCase();
    if (
      file.path === manifestName ||
      seen.has(key) ||
      file.sizeBytes > (file.kind === 'document' ? 20 * 1024 ** 2 : assetByteLimit(file.path))
    )
      fail(400, 'INVALID_PORTABLE_MANIFEST');
    seen.add(key);
    bytes += file.sizeBytes;
    documents += +(file.kind === 'document');
    if (bytes > limits.packageBytes || documents > limits.documents)
      fail(413, 'PORTABLE_BUDGET_EXCEEDED');
  }
  for (const path of parsed.data.selected)
    if (!parsed.data.files.some((file) => file.kind === 'document' && file.path === path))
      fail(400, 'INVALID_PORTABLE_MANIFEST');
  return parsed.data;
}
export async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path, {
    fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    autoClose: true,
  }))
    hash.update(bytes);
  return hash.digest('hex');
}
/** Extraction is already private; reject extra entries and aliases before trusting any manifest. */
export function directoryFiles(root: string) {
  const files: string[] = [],
    seen = new Set<string>();
  function walk(directory: string, prefix: string) {
    for (const name of readdirSync(directory)) {
      const path = prefix ? prefix + '/' + name : name;
      portablePath(path);
      const key = path.normalize('NFC').toLowerCase(),
        stat = lstatSync(join(root, path));
      if (
        seen.has(key) ||
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      )
        fail(400, 'INVALID_PORTABLE_ENTRY');
      seen.add(key);
      if (seen.size > limits.files * 2 + 1) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
      if (stat.isDirectory()) walk(join(root, path), path);
      else files.push(path);
    }
  }
  walk(root, '');
  return files;
}
