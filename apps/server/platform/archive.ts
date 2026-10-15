import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import { Parser, extract } from 'tar';
import { fail, KnowledgeError } from '../../../packages/core/knowledge/errors.js';
export async function validateArchive(
  file: string,
  options: { maxBytes?: number; maxEntries?: number } = {},
) {
  const seen = new Set<string>();
  let bytes = 0,
    files = 0;
  const limit = options.maxBytes ?? 2 * 1024 ** 3,
    entries = options.maxEntries ?? 100000;
  return new Promise<{ bytes: number; files: number }>((resolve, reject) => {
    const input = createReadStream(file);
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        try {
          const raw = entry.path,
            name = posix.normalize(raw).replace(/\/$/, '');
          if (
            !['File', 'OldFile', 'Directory'].includes(entry.type) ||
            !name ||
            raw.startsWith('/') ||
            raw.includes('\\') ||
            /[\x00-\x1f]/.test(raw) ||
            raw.split('/').includes('..') ||
            name.startsWith('../') ||
            seen.has(name)
          )
            fail(400, 'INVALID_ARCHIVE_ENTRY');
          seen.add(name);
          bytes += entry.size;
          if (seen.size > entries || !Number.isSafeInteger(bytes) || bytes > limit)
            fail(413, 'ARCHIVE_LIMIT_EXCEEDED');
          if (entry.type !== 'Directory') files++;
        } catch (error) {
          parser.abort(error as Error);
        }
        entry.resume();
      },
    });
    parser.once('error', (error) => {
      input.destroy();
      reject(
        error instanceof KnowledgeError
          ? error
          : Object.assign(Error('INVALID_ARCHIVE'), { code: 'INVALID_ARCHIVE' }),
      );
    });
    parser.once('end', () => resolve({ bytes, files }));
    input.once('error', (error) => parser.abort(error));
    input.pipe(parser as any);
  });
}
export async function extractArchive(
  file: string,
  destination: string,
  options: { maxBytes?: number; maxEntries?: number } = {},
) {
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(400, 'INVALID_EXTRACTION_TARGET');
  await validateArchive(file, options);
  await extract({
    file,
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter: (_path, entry) => ['File', 'OldFile', 'Directory'].includes((entry as any).type),
    chmod: true,
    processUmask: 0o077,
  });
}
