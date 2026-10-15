import { accessSync, constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import type { AppDatabase } from '../db.js';
import { workspacePermit } from './gate.js';
import { guardedProcess, type ProcessOptions } from '../processes/guarded.js';
import { fail } from '../knowledge/errors.js';
export type ExecOptions = Omit<ProcessOptions, 'signal'>;
function systemGit() {
  for (const path of [
    '/usr/bin/git',
    '/usr/local/bin/git',
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((p) => join(p, 'git')),
  ]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  fail(503, 'GIT_DEPENDENCY_MISSING');
}
export function workspaceExec(
  db: AppDatabase,
  root: string,
  args: string[],
  options: ExecOptions = {},
) {
  const token = workspacePermit(db, false),
    binary = systemGit();
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0')))
    fail(400, 'INVALID_GIT_ARGUMENT');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith('GIT_') &&
      !k.startsWith('NODE_') &&
      !['LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'].includes(k)
    )
      env[k] = v;
  Object.assign(
    env,
    {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PAGER: 'cat',
      GIT_ATTR_NOSYSTEM: '1',
      LC_ALL: 'C.UTF-8',
    },
    options.env || {},
  );
  return guardedProcess(db, { kind: 'workspace', token }, binary, args, root, {
    ...options,
    env,
  }).wait.catch((error) => {
    if (error?.code === 'PROCESS_OUTPUT_TOO_LARGE')
      error.code = error.message = 'GIT_OUTPUT_TOO_LARGE';
    if (error?.code === 'PROCESS_TIMEOUT') error.code = error.message = 'GIT_COMMAND_TIMEOUT';
    throw error;
  });
}
