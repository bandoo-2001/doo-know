import { expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { workspaceExec } from '../packages/core/workspace/exec.js';
import {
  workspaceExclusive,
  workspacePermit,
  workspaceProcess,
} from '../packages/core/workspace/gate.js';
import { gitRemoteService } from '../apps/server/git/service.js';
import type { GitExec } from '../apps/server/git/transport.js';
import type { GitJobInput } from '../shared/git-contracts.js';
import { localGitTransport } from './support/git-remote-fixture.js';

const url = 'https://github.com/fixture/library.git';
const content = '# 保留原文\r\n\r\n取消任务不应重写正文  \r\n';
const command = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-cancellation-'));
  const local = join(root, 'library'),
    remote = join(root, 'remote.git');
  await mkdir(local);
  command(local, 'init', '--initial-branch=main');
  command(local, 'config', 'user.name', 'Fixture');
  command(local, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(local, 'note.md'), content);
  command(local, 'add', '.');
  command(local, 'commit', '-m', 'Original content');
  execFileSync('git', ['clone', '--bare', local, remote], { stdio: 'pipe' });
  const originalHead = command(local, 'rev-parse', 'HEAD');
  const dataRoot = join(root, 'data'),
    db = openDatabase(dataRoot);
  const run = localGitTransport(db, { [url]: remote });
  let execute: GitExec = run;
  let refresh = async () => ({});
  const platform: any = {
    status: () => ({ knowledgeRoot: local, bindingVersion: 1 }),
    get: () => ({
      config: { knowledgeRoot: local },
      knowledge: { indexing: { refresh: () => refresh() } },
    }),
  };
  const plugins: any = { list: () => [{ id: 'git', state: 'enabled' }] };
  const service = gitRemoteService(
    { dataRoot, secret: 'fixture-only-long-enough-key', origin: 'http://localhost' } as any,
    db,
    platform,
    plugins,
    { exec: (...args) => execute(...args) },
  );
  const start = (input: Omit<GitJobInput, 'requestId'>) =>
    service.start('owner', { requestId: crypto.randomUUID(), ...input });
  async function finish(id: string) {
    await expect
      .poll(() => service.job('owner', id).status, { timeout: 15000 })
      .not.toMatch(/queued|running/);
    return service.job('owner', id);
  }
  async function advanceRemote() {
    const seed = join(root, 'seed');
    execFileSync('git', ['clone', remote, seed], { stdio: 'pipe' });
    const updated = '# 云端新版本\r\n\r\n保留格式  \r\n';
    await writeFile(join(seed, 'note.md'), updated);
    command(seed, 'add', '.');
    command(
      seed,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Remote update',
    );
    command(seed, 'push', 'origin', 'main');
    return { head: command(seed, 'rev-parse', 'HEAD'), content: updated };
  }
  return {
    db,
    local,
    remote,
    service,
    originalHead,
    run,
    start,
    finish,
    advanceRemote,
    setExecute(next: GitExec) {
      execute = next;
    },
    setRefresh(next: typeof refresh) {
      refresh = next;
    },
    async connect() {
      expect(await finish(start({ kind: 'connect', url }).id)).toMatchObject({
        status: 'succeeded',
      });
    },
    async close() {
      await service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('records a user-cancelled remote check after its guarded process is stopped', async () => {
  const h = await fixture();
  try {
    await h.connect();
    const entered = deferred();
    h.setExecute((cwd, args, opts) => {
      if (!args.includes('ls-remote')) return h.run(cwd, args, opts);
      // Pause the network boundary with a real guarded child, without external network access.
      const waiting = workspaceExec(h.db, cwd, ['-c', 'alias.sleeper=!sleep 30', 'sleeper'], opts);
      entered.resolve();
      return waiting;
    });
    const job = h.start({ kind: 'check' });
    await entered.promise;
    await expect
      .poll(
        () => (h.db.prepare('SELECT count(*) n FROM workspace_guards').get() as { n: number }).n,
        { timeout: 5000 },
      )
      .toBe(1);
    h.service.cancel('owner', job.id);
    const result = await h.finish(job.id);
    expect(result).toMatchObject({ status: 'cancelled', error: 'GIT_COMMAND_CANCELLED' });
    expect(command(h.local, 'rev-parse', 'HEAD')).toBe(h.originalHead);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe(content);
    expect(h.db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
    expect(h.db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
    expect(h.service.cancel('owner', job.id)).toEqual(result);
  } finally {
    await h.close();
  }
});

it('cancels a queued job before any Git command starts', async () => {
  const h = await fixture();
  try {
    let executions = 0;
    h.setExecute((...args) => {
      executions++;
      return h.run(...args);
    });
    const job = h.start({ kind: 'test', url });
    h.service.cancel('owner', job.id);
    expect(await h.finish(job.id)).toMatchObject({
      status: 'cancelled',
      error: 'GIT_COMMAND_CANCELLED',
    });
    expect(executions).toBe(0);
  } finally {
    await h.close();
  }
});

it('keeps cancellation uncertain while a registered worker still holds the workspace', async () => {
  const h = await fixture();
  let worker: ChildProcess | undefined;
  async function stopWorker() {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const current = worker;
      await new Promise<void>((resolve) => {
        current.once('close', () => resolve());
        current.kill('SIGKILL');
      });
    }
  }
  try {
    await h.connect();
    let jobId = '';
    h.setExecute(async (cwd, args, opts) => {
      const result = await h.run(cwd, args, opts);
      if (args.includes('ls-remote')) {
        // Keep a real registered resource alive so gate cleanup cannot claim completion.
        worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => {
          worker!.once('spawn', resolve);
          worker!.once('error', reject);
        });
        const identity = workspaceProcess(worker.pid!);
        h.db
          .prepare(
            'INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,0)',
          )
          .run(workspacePermit(h.db), identity.pid, identity.start);
        h.service.cancel('owner', jobId);
      }
      return result;
    });
    jobId = h.start({ kind: 'check' }).id;
    expect(await h.finish(jobId)).toMatchObject({
      status: 'needs_reconciliation',
      error: 'GIT_COMMAND_CANCELLED',
    });
    expect(h.db.prepare('SELECT pid FROM workspace_guards').all()).toEqual([{ pid: worker!.pid }]);
    await expect(
      workspaceExclusive(h.db, { kind: 'cancelled-worker-blocked', waitMs: 30 }, async () => {}),
    ).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(command(h.local, 'rev-parse', 'HEAD')).toBe(h.originalHead);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe(content);
    await stopWorker();
    await workspaceExclusive(h.db, { kind: 'cancelled-worker-released' }, async () => {});
    expect(h.db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
  } finally {
    await stopWorker();
    await h.close();
  }
});

it('continues to report service shutdown as interruption rather than user cancellation', async () => {
  const h = await fixture();
  try {
    const entered = deferred();
    h.setExecute(async (cwd, args, opts) => {
      if (args.includes('ls-remote')) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) resolve();
          else opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return h.run(cwd, args, opts);
    });
    const job = h.start({ kind: 'test', url });
    await entered.promise;
    await h.service.close();
    expect(await h.finish(job.id)).toMatchObject({
      status: 'failed',
      error: 'GIT_TASK_INTERRUPTED',
    });
  } finally {
    await h.close();
  }
});

it('keeps a cancelled push uncertain when the remote accepted it before the reply', async () => {
  const h = await fixture();
  try {
    await h.connect();
    await writeFile(join(h.local, 'note.md'), content + '\r\n本地新提交\r\n');
    command(h.local, 'add', '.');
    command(h.local, 'commit', '-m', 'New local version');
    const expectedHead = command(h.local, 'rev-parse', 'HEAD');
    let pushes = 0,
      jobId = '';
    h.setExecute(async (cwd, args, opts) => {
      const result = await h.run(cwd, args, opts);
      if (args.includes('push') && result.code === 0) {
        pushes++;
        h.service.cancel('owner', jobId);
      }
      return result;
    });
    jobId = h.start({ kind: 'push', expectedHead }).id;
    expect(await h.finish(jobId)).toMatchObject({
      status: 'needs_reconciliation',
      error: 'GIT_COMMAND_CANCELLED',
    });
    expect(command(h.remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
    expect(command(h.local, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe(content + '\r\n本地新提交\r\n');
    h.service.retry('owner', jobId);
    expect(await h.finish(jobId)).toMatchObject({ status: 'succeeded' });
    expect(pushes).toBe(1);
  } finally {
    await h.close();
  }
});

it('keeps a cancelled pull uncertain when its fast-forward completed before the reply', async () => {
  const h = await fixture();
  try {
    await h.connect();
    const updated = await h.advanceRemote();
    let merges = 0,
      jobId = '';
    h.setExecute(async (cwd, args, opts) => {
      const result = await h.run(cwd, args, opts);
      if (args.includes('merge') && result.code === 0) {
        merges++;
        h.service.cancel('owner', jobId);
      }
      return result;
    });
    jobId = h.start({ kind: 'pull' }).id;
    expect(await h.finish(jobId)).toMatchObject({
      status: 'needs_reconciliation',
      error: 'GIT_COMMAND_CANCELLED',
      result: { before: h.originalHead, target: updated.head },
    });
    expect(command(h.local, 'rev-parse', 'HEAD')).toBe(updated.head);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe(updated.content);
    h.service.retry('owner', jobId);
    expect(await h.finish(jobId)).toMatchObject({
      status: 'succeeded',
      result: { commit: updated.head },
    });
    expect(merges).toBe(1);
  } finally {
    await h.close();
  }
});

it('preserves confirmed pull success when cancellation arrives during index refresh', async () => {
  const h = await fixture();
  const refreshing = deferred(),
    release = deferred();
  try {
    await h.connect();
    const updated = await h.advanceRemote();
    h.setRefresh(async () => {
      refreshing.resolve();
      await release.promise;
      return {};
    });
    const job = h.start({ kind: 'pull' });
    await refreshing.promise;
    h.service.cancel('owner', job.id);
    release.resolve();
    const result = await h.finish(job.id);
    expect(result).toMatchObject({ status: 'succeeded', result: { commit: updated.head } });
    expect(result.error).toBeUndefined();
    expect(command(h.local, 'rev-parse', 'HEAD')).toBe(updated.head);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe(updated.content);
    expect(h.service.cancel('owner', job.id)).toEqual(result);
  } finally {
    release.resolve();
    await h.close();
  }
});
