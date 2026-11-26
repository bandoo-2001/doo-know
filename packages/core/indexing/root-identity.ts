import type { KnowledgeSourceProblem } from '../../../shared/platform-contracts.js';
import { fail } from '../knowledge/errors.js';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';

export class KnowledgeRootTypeError extends Error {
  constructor(readonly kind: 'symlink' | 'not_directory') {
    super(kind);
  }
}

export function readKnowledgeRootIdentity(root: string) {
  const stat = lstatSync(root, { bigint: true });
  if (stat.isSymbolicLink()) throw new KnowledgeRootTypeError('symlink');
  if (!stat.isDirectory()) throw new KnowledgeRootTypeError('not_directory');
  readdirSync(root);
  return JSON.stringify({
    path: realpathSync(root),
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
}

/** Validate the filesystem without modifying the recorded binding. */
export function verifyKnowledgeRootIdentity(root: string, expected?: string) {
  let observed: string;
  try {
    observed = readKnowledgeRootIdentity(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    let sourceProblem: KnowledgeSourceProblem = 'unavailable';
    if (error instanceof KnowledgeRootTypeError) sourceProblem = error.kind;
    else if (code === 'ENOENT') sourceProblem = 'missing';
    else if (code === 'ENOTDIR') sourceProblem = 'not_directory';
    else if (code === 'EACCES' || code === 'EPERM') sourceProblem = 'permission_denied';
    fail(503, 'SOURCE_UNAVAILABLE', '原文目录不可用', true, { sourceProblem });
  }
  if (expected !== undefined && observed !== expected)
    fail(503, 'SOURCE_UNAVAILABLE', '原文目录与绑定记录不一致', true, { sourceProblem: 'replaced' });
  return observed;
}
