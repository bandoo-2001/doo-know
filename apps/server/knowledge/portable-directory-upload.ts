import type { FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { portablePath } from '../../../packages/core/portable-delivery/manifest.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
/** A browser sends package-relative paths as multipart field names, never local disk paths. */
export async function stagePortableDirectory(
  req: FastifyRequest,
  directory: string,
  resize: (bytes: number) => void,
  check: () => void,
  allocate?: (path: string, fields: Record<string, string>) => Promise<string | undefined>,
) {
  const fields: Record<string, string> = {},
    seen = new Set<string>(),
    directories = new Map<string, string>();
  let total = 0,
    count = 0;
  for await (const part of req.parts({
    preservePath: true,
    limits: {
      fileSize: limits.packageBytes,
      files: limits.files + 1,
      fields: 2,
      parts: limits.files + 3,
      fieldSize: 2048,
      fieldNameSize: 2000,
    },
  })) {
    check();
    if (part.type === 'file') {
      const path = portablePath(part.fieldname === 'file' ? part.filename : part.fieldname);
      const key = path.normalize('NFC').toLowerCase();
      if (path.length > 2000) fail(400, 'INVALID_PORTABLE_PATH');
      if (seen.has(key) || directories.has(key)) fail(400, 'INVALID_PORTABLE_ENTRY');
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join('/'),
          alias = directory.normalize('NFC').toLowerCase();
        if (seen.has(alias) || (directories.has(alias) && directories.get(alias) !== directory))
          fail(400, 'INVALID_PORTABLE_ENTRY');
        directories.set(alias, directory);
      }
      seen.add(key);
      if (++count > limits.files + 1) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
      const absolute = (await allocate?.(path, fields)) ?? join(directory, path);
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
      await pipeline(
        part.file,
        new Transform({
          transform(chunk, _encoding, callback) {
            try {
              check();
              total += chunk.length;
              if (total > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
              resize(total);
              callback(null, chunk);
            } catch (error) {
              callback(error as Error);
            }
          },
        }),
        createWriteStream(absolute, { flags: 'wx', mode: 0o600 }),
      );
      if (part.file.truncated) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
    } else {
      if (
        !['folderPath', 'requestId'].includes(part.fieldname) ||
        Object.hasOwn(fields, part.fieldname) ||
        part.valueTruncated ||
        typeof part.value !== 'string'
      )
        fail(400, 'INVALID_PORTABLE_UPLOAD');
      fields[part.fieldname] = part.value;
    }
  }
  if (!count || !fields.requestId) fail(400, 'INVALID_PORTABLE_UPLOAD');
  return { folderPath: fields.folderPath ?? '00-Inbox', requestId: fields.requestId };
}
