import { createReadStream, constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { limits } from './limits.js';
import { fail } from './errors.js';
export async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const bytes of readBlocks(file, 0, undefined, signal)) hash.update(bytes);
  return hash.digest('hex');
}
export async function writeAll(fd: FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const r = await fd.write(bytes, offset, bytes.length - offset);
    if (!r.bytesWritten) throw new Error('short write');
    offset += r.bytesWritten;
  }
}
export async function* readBlocks(file: string, start = 0, end?: number, signal?: AbortSignal) {
  if (end != null && end <= start) return;
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const bytes of fd.createReadStream({
      start,
      ...(end != null ? { end: end - 1 } : {}),
      highWaterMark: limits.io,
      autoClose: false,
      signal,
    }))
      yield bytes as Buffer;
  } finally {
    await fd.close();
  }
}
export async function stableStat(file: string) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat({ bigint: true });
    if (!s.isFile() || s.nlink > 1n) fail(400, 'INVALID_PATH');
    if (s.size > BigInt(limits.file)) fail(413, 'FILE_TOO_LARGE');
    return s;
  } finally {
    await fd.close();
  }
}
export function sameFile(
  a: Awaited<ReturnType<typeof stableStat>>,
  b: Awaited<ReturnType<typeof stat>> | any,
) {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size;
}
