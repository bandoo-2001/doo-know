import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const runFile = promisify(execFile);
export async function git(root: string, args: string[], signal?: AbortSignal) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CONFIG_COUNT',
  ])
    delete (env as any)[key];
  return runFile(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.ext.allow=never',
      '--no-pager',
      ...args,
    ],
    { cwd: root, env, signal, maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
  );
}
export async function gitState(root: string) {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { head: null, dirty: false, conflicts: [] as string[], filters: false };
  }
  const filters = await git(root, [
    'config',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process)$',
  ])
    .then((r) => r.stdout.length > 0)
    .catch(() => false);
  const [head, conflicts] = await Promise.all([
    git(root, ['rev-parse', 'HEAD'])
      .then((r) => r.stdout.trim())
      .catch(() => null),
    git(root, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z']).then((r) =>
      r.stdout.split('\0').filter(Boolean),
    ),
  ]);
  const dirty = filters
    ? true
    : await git(root, ['status', '--porcelain=v1', '-z']).then((r) => r.stdout.length > 0);
  return { head, dirty, conflicts, filters };
}
