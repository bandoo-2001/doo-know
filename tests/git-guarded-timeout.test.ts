import { expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { workspacePermit, workspaceProcess, workspaceExclusive } from '../packages/core/workspace/gate.js';
import { gitRemoteService } from '../apps/server/git/service.js';
import { localGitTransport } from './support/git-remote-fixture.js';

it('keeps a push uncertain when timeout cleanup retains a live guard, then reconciles without another push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-guarded-timeout-'));
  const local = join(root, 'library'), remote = join(root, 'remote.git'), dataRoot = join(root, 'data');
  await mkdir(local);
  const command = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'pipe' });
  command(local, 'init', '--initial-branch=main');command(local, 'config', 'user.name', 'Fixture');command(local, 'config', 'user.email', 'fixture@example.invalid');
  const content = '# 保留推送后的原文\r\n\r\n不能因回执丢失而重写  \r\n';
  await writeFile(join(local, 'note.md'), content);command(local, 'add', '.');command(local, 'commit', '-m', 'Retained content');
  const expectedHead = command(local, 'rev-parse', 'HEAD'), db = openDatabase(dataRoot);
  const url = 'https://github.com/fixture/library.git', runner = localGitTransport(db, { [url]: remote });
  let worker: ChildProcess | undefined, pushes = 0;
  async function stopWorker() {
    const current = worker;worker = undefined;
    if (current && current.exitCode === null && current.signalCode === null)
      await new Promise<void>(yes => { current.once('close', () => yes());current.kill('SIGKILL'); });
  }
  const platform: any = { status: () => ({ knowledgeRoot: local, bindingVersion: 1 }),
    get: () => ({ config: { knowledgeRoot: local }, knowledge: { indexing: { refresh: async () => ({}) } } }) };
  const plugins: any = { list: () => [{ id: 'git', state: 'enabled', installedVersion: '1.1.0' }] };
  const service = gitRemoteService({ dataRoot, secret: 'fixture-only-long-enough-key', origin: 'http://localhost' } as any,
    db, platform, plugins, { exec: async (cwd, args, opts) => {
      const result = await runner(cwd, args, opts);
      if (args.includes('push') && ++pushes === 1 && result.code === 0) {
        // Model the real release boundary with an actual registered live resource.
        // The push has completed, while its reply timed out and cleanup is pending.
        worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        await new Promise<void>((yes, no) => { worker!.once('spawn', yes);worker!.once('error', no); });
        const identity = workspaceProcess(worker.pid!);
        db.prepare('INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,0)')
          .run(workspacePermit(db), identity.pid, identity.start);
        throw Object.assign(Error('GIT_COMMAND_TIMEOUT'), { code: 'GIT_COMMAND_TIMEOUT' });
      }
      return result;
    } });
  async function finish(input: any) {
    const job = service.start('owner', { requestId: crypto.randomUUID(), ...input });
    await expect.poll(() => service.job('owner', job.id).status, { timeout: 15000 }).not.toMatch(/queued|running/);
    return service.job('owner', job.id);
  }
  try {
    expect((await finish({ kind: 'connect', url, branch: 'main' })).status).toBe('succeeded');
    const outcome = await finish({ kind: 'push', expectedHead });
    expect(outcome).toMatchObject({ status: 'needs_reconciliation', error: 'GIT_COMMAND_TIMEOUT' });
    expect(command(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
    expect(command(local, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(await readFile(join(local, 'note.md'), 'utf8')).toBe(content);
    expect((db.prepare('SELECT count(*) n FROM workspace_guards').get() as { n: number }).n).toBe(1);
    await expect(workspaceExclusive(db, { kind: 'fixture-blocked', waitMs: 30 }, async () => {}))
      .rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    await stopWorker();
    const retried = service.retry('owner', outcome.id);
    await expect.poll(() => service.job('owner', retried.id).status, { timeout: 15000 }).toBe('succeeded');
    expect(pushes).toBe(1);
    expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
  } finally { await stopWorker();await service.close();db.close();await rm(root, { recursive: true, force: true }); }
});
