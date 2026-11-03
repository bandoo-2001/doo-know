import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { hasDiagramDeclaration, hasDiagramDeclarationSync } from './diagram-declaration.js';
import { assertDiagramPublication } from './diagram-publication-policy.js';
import { readBlocks } from './file-reader.js';
import { limits } from './limits.js';
import { fail } from './errors.js';

async function fixedMarkdown(file: string, expectedHash: string, signal?: AbortSignal) {
  const blocks: Buffer[] = [],
    hash = createHash('sha256');
  let size = 0;
  for await (const bytes of readBlocks(file, 0, undefined, signal)) {
    size += bytes.length;
    if (size > limits.file) fail(413, 'FILE_TOO_LARGE');
    blocks.push(bytes);
    hash.update(bytes);
  }
  if (hash.digest('hex') !== expectedHash) fail(409, 'VERSION_CONFLICT');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(blocks, size),
    );
  } catch {
    return fail(422, 'INVALID_UTF8');
  }
}
/** Ordinary large notes stay on the streaming patch path. Only reserved-header
 * candidates need the complete bounded main file for primary version validation. */
export async function assertDiagramFilePublication(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  input: {
    operationId: string;
    noteId: string;
    path: string;
    beforeFile: string;
    targetFile: string;
    beforeHash: string;
    targetHash: string;
  },
  signal?: AbortSignal,
) {
  const [beforeCandidate, targetCandidate] = await Promise.all([
    hasDiagramDeclaration(input.beforeFile, signal),
    hasDiagramDeclaration(input.targetFile, signal),
  ]);
  if (!beforeCandidate && !targetCandidate) return;
  const currentMarkdown = beforeCandidate
    ? await fixedMarkdown(input.beforeFile, input.beforeHash, signal)
    : '';
  const markdown = targetCandidate
    ? await fixedMarkdown(input.targetFile, input.targetHash, signal)
    : '';
  assertDiagramPublication(config, db, principal, {
    operationId: input.operationId,
    noteId: input.noteId,
    path: input.path,
    markdown,
    currentMarkdown,
  });
}

export function assertDiagramRestorePublication(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  input: {
    operationId: string;
    noteId: string;
    path: string;
    sourceFile: string;
    sourceHash: string;
  },
) {
  if (!hasDiagramDeclarationSync(input.sourceFile)) return;
  const fd = openSync(input.sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let markdown: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) fail(400, 'INVALID_PATH');
    if (info.size > limits.file) fail(413, 'FILE_TOO_LARGE');
    const bytes = readFileSync(fd);
    if (createHash('sha256').update(bytes).digest('hex') !== input.sourceHash)
      fail(409, 'RESTORE_CONFLICT');
    try {
      markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail(422, 'INVALID_UTF8');
    }
  } finally {
    closeSync(fd);
  }
  // A restored note keeps its identity and must be a fixed complete historical version.
  assertDiagramPublication(config, db, principal, {
    operationId: input.operationId,
    noteId: input.noteId,
    path: input.path,
    markdown,
    currentMarkdown: markdown,
  });
}
