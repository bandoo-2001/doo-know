import { it, expect } from 'vitest';
import { mkdir, writeFile, readFile, access, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFixture } from '../support/fixture.js';
import { gitState } from '../../packages/core/indexing/git-state.js';
const exec = promisify(execFile);
const git = (root: string, args: string[]) =>
  exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root },
  );
it('reads Git state without refreshing or locking the repository index', async () => {
  const f = await createFixture();
  try {
    await git(f.knowledgeRoot, ['init', '--initial-branch=main']);
    const file = join(f.knowledgeRoot, '00-Inbox/readonly-status.md');
    await writeFile(file, '# Same content');
    await git(f.knowledgeRoot, ['add', '.']);
    await git(f.knowledgeRoot, ['commit', '-m', 'fixture']);
    const index = join(f.knowledgeRoot, '.git/index');
    const before = await readFile(index);
    await utimes(file, 2000000000, 2000000000);
    const state = await gitState(f.knowledgeRoot);
    expect(state.dirty).toBe(false);
    expect(await readFile(index)).toEqual(before);
  } finally {
    await f.close();
  }
});
it('explicit managed pull updates actual Markdown, disables hooks and refuses dirty worktrees', async () => {
  const f = await createFixture();
  try {
    const bare = join(f.root, 'remote.git'),
      other = join(f.root, 'other clone');
    await git(f.root, ['init', '--bare', '--initial-branch=main', bare]);
    await git(f.knowledgeRoot, ['init', '--initial-branch=main']);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/seed.md'), 'SEED');
    await git(f.knowledgeRoot, ['add', '.']);
    await git(f.knowledgeRoot, ['commit', '-m', 'fixture seed']);
    await git(f.knowledgeRoot, ['remote', 'add', 'origin', bare]);
    await git(f.knowledgeRoot, ['push', '-u', 'origin', 'main']);
    await git(f.root, ['clone', bare, other]);
    await writeFile(join(other, '00-Inbox/中文 空格.md'), 'REMOTE_NEW');
    await writeFile(join(other, '00-Inbox/seed.md'), 'REMOTE_EDIT');
    await git(other, ['add', '.']);
    await git(other, ['commit', '-m', 'fixture update']);
    await git(other, ['push']);
    const hookMarker = join(f.root, 'hook-ran');
    await writeFile(
      join(f.knowledgeRoot, '.git/hooks/post-merge'),
      `#!/bin/sh\ntouch '${hookMarker}'\n`,
      { mode: 0o700 },
    );
    const secret = join(f.root, 'auth.key');
    await writeFile(secret, 'fixture-configuration-secret-at-least-thirty-two-characters', {
      mode: 0o600,
    });
    const env = {
      ...process.env,
      KNOWLEDGE_ROOT: f.knowledgeRoot,
      DATA_ROOT: f.dataRoot,
      AUTH_SECRET_FILE: secret,
      APP_ORIGIN: f.config.origin,
      GIT_SYNC_ENABLED: '1',
      EMBEDDED_FILE_WORKER: '0',
    };
    const command = ['--import', 'tsx', 'scripts/git-sync.ts'];
    const run = await exec(process.execPath, command, { cwd: process.cwd(), env });
    expect(JSON.parse(run.stdout).status).toBe('succeeded');
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/中文 空格.md'), 'utf8')).toBe(
      'REMOTE_NEW',
    );
    await expect(access(hookMarker)).rejects.toThrow();
    await writeFile(join(f.knowledgeRoot, '00-Inbox/seed.md'), 'UNCOMMITTED_LOCAL');
    await expect(
      exec(process.execPath, command, { cwd: process.cwd(), env }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/seed.md'), 'utf8')).toBe(
      'UNCOMMITTED_LOCAL',
    );
  } finally {
    await f.close();
  }
});
