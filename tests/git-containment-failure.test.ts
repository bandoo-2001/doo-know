import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import { gitRemoteService } from '../apps/server/git/service.js';
import { localGitTransport } from './support/git-remote-fixture.js';

it('fails a push refused before execution without uncertain status or replay, then permits a new request after repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-containment-failure-'));
  const local = join(root, 'library'),
    remote = join(root, 'remote.git'),
    dataRoot = join(root, 'data');
  await mkdir(local);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('/usr/bin/git', ['init', '--bare', '--initial-branch=main', remote], {
    stdio: 'pipe',
  });
  git(local, 'init', '--initial-branch=main');
  git(local, 'config', 'user.name', 'Fixture');
  git(local, 'config', 'user.email', 'fixture@example.invalid');
  const original = '# 合法本地原文\r\n保留空白  \r\n';
  await writeFile(join(local, 'note.md'), original);
  git(local, 'add', '.');
  git(local, 'commit', '-m', 'Retained local original');
  const expectedHead = git(local, 'rev-parse', 'HEAD'),
    db = openDatabase(dataRoot);
  const url = 'https://github.com/fixture/library.git',
    runner = localGitTransport(db, { [url]: remote });
  const platform: any = {
    status: () => ({ knowledgeRoot: local, bindingVersion: 1 }),
    get: () => ({
      config: { knowledgeRoot: local },
      knowledge: { indexing: { refresh: async () => ({}) } },
    }),
  };
  const plugins: any = { list: () => [{ id: 'git', state: 'enabled', installedVersion: '1.1.0' }] };
  let blocked = true,
    refusals = 0,
    executedPushes = 0;
  const service = gitRemoteService(
    { dataRoot, secret: 'fixture-only-long-enough-secret', origin: 'http://localhost' } as any,
    db,
    platform,
    plugins,
    {
      exec: (cwd, args, options) => {
        if (args.includes('push')) {
          if (blocked) {
            refusals++;
            throw Object.assign(Error('fixture process containment unavailable'), {
              code: 'PROCESS_CONTAINMENT_UNAVAILABLE',
              statusCode: 503,
            });
          }
          executedPushes++;
        }
        return runner(cwd, args, options);
      },
    },
  );
  async function finish(input: any) {
    const started = service.start('owner', input);
    await expect
      .poll(() => service.job('owner', started.id).status, { timeout: 15000 })
      .not.toMatch(/queued|running/);
    return service.job('owner', started.id);
  }
  try {
    expect(
      (await finish({ kind: 'connect', url, branch: 'main', requestId: randomUUID() })).status,
    ).toBe('succeeded');
    const request = { kind: 'push' as const, expectedHead, requestId: randomUUID() };
    const failed = await finish(request);
    expect(failed).toMatchObject({ status: 'failed', error: 'PROCESS_CONTAINMENT_UNAVAILABLE' });
    expect(service.start('owner', request).id).toBe(failed.id);
    await new Promise((yes) => setImmediate(yes));
    expect(refusals).toBe(1);
    expect(executedPushes).toBe(0);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('');
    blocked = false;
    expect((await finish({ ...request, requestId: randomUUID() })).status).toBe('succeeded');
    expect(executedPushes).toBe(1);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(await readFile(join(local, 'note.md'), 'utf8')).toBe(original);
  } finally {
    await service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
