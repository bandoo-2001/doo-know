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
