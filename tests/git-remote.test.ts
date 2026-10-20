import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../packages/core/db.js';
import { workspaceExec } from '../packages/core/workspace/exec.js';
import { gitRemoteService } from '../apps/server/git/service.js';
import { platformRuntime } from '../apps/server/platform/runtime.js';
import { createAuth } from '../apps/server/auth.js';
import { localGitTransport } from './support/git-remote-fixture.js';

it('marks interrupted jobs for reconciliation after restart without replaying remote writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-job-recovery-')),
    db = openDatabase(join(root, 'data'));
  const config: any = {
    dataRoot: join(root, 'data'),
    secret: 'fixture-recovery-key-at-least-thirty-two',
    origin: 'http://localhost',
  };
  const platform: any = { status: () => ({ knowledgeRoot: root, bindingVersion: 7 }) },
    plugins: any = { list: () => [] };
  let commands = 0;
  const options = {
    exec: async () => {
      commands++;
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
  let service = gitRemoteService(config, db, platform, plugins, options);
  try {
    const input = {
      kind: 'push' as const,
      requestId: 'recover-this-push',
      expectedHead: 'a'.repeat(40),
    };
    const task = service.start('owner', input);
    await service.close();
    db.prepare("UPDATE git_remote_jobs SET status='running',phase='pushing' WHERE id=?").run(
      task.id,
    );
    service = gitRemoteService(config, db, platform, plugins, options);
    expect(service.job('owner', task.id)).toMatchObject({
      status: 'needs_reconciliation',
      error: 'GIT_TASK_INTERRUPTED',
    });
    expect(service.start('owner', input).id).toBe(task.id);
    expect(() => service.start('owner', { ...input, expectedHead: 'b'.repeat(40) })).toThrow(
      'REQUEST_ID_REUSED',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(commands).toBe(0);
  } finally {
    await service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('connects an existing library, pushes a fixed commit once, checks remote updates and pulls only fast-forward changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-remote-'));
  const local = join(root, 'library'),
    remote = join(root, 'remote.git'),
    editor = join(root, 'editor');
  await mkdir(local);
  const command = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'pipe' });
  command(local, 'init', '--initial-branch=main');
  command(local, 'config', 'user.name', 'Fixture');
  command(local, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(local, 'note.md'), '# First\n');
  command(local, 'add', '.');
  command(local, 'commit', '-m', 'First');
  const db = openDatabase(join(root, 'data'));
  const platform: any = {
    status: () => ({ knowledgeRoot: local, bindingVersion: 1 }),
    get: () => ({
      config: { knowledgeRoot: local },
      knowledge: { indexing: { refresh: async () => ({}) } },
    }),
  };
  const plugins: any = {
    list: () => [{ id: 'git', state: 'enabled', installedVersion: '1.1.0' }],
    install: async () => {},
    enable: async () => {},
  };
  const runner = localGitTransport(db, { 'https://github.com/fixture/library.git': remote });
  let losePushReply = true,
    pushes = 0;
  const service = gitRemoteService(
    {
      dataRoot: join(root, 'data'),
      secret: 'fixture-only-long-enough-key',
      origin: 'http://localhost',
    } as any,
    db,
    platform,
    plugins,
    {
      exec: async (cwd, args, opts) => {
        const r = await runner(cwd, args, opts);
        if (args.includes('push')) {
          pushes++;
          if (losePushReply && r.code === 0) {
            losePushReply = false;
            throw Object.assign(Error('GIT_NETWORK_FAILED'), { code: 'GIT_NETWORK_FAILED' });
          }
        }
        return r;
      },
    },
  );
  async function finish(input: any) {
    const started = service.start('owner', { requestId: crypto.randomUUID(), ...input });
    await expect
      .poll(() => service.job('owner', started.id).status, { timeout: 15000 })
      .not.toMatch(/queued|running/);
    return service.job('owner', started.id);
  }
  try {
    expect(
      (await finish({ kind: 'connect', url: 'https://github.com/fixture/library', branch: 'main' }))
        .status,
    ).toBe('succeeded');
    const expectedHead = command(local, 'rev-parse', 'HEAD');
    const uncertain = await finish({ kind: 'push', expectedHead });
    expect(uncertain.status).toBe('needs_reconciliation');
    expect(command(remote, 'rev-parse', 'refs/heads/main')).toBe(expectedHead);
    const retried = service.retry('owner', uncertain.id);
    await expect.poll(() => service.job('owner', retried.id).status, { timeout: 15000 }).toBe('succeeded');
    const pushed = service.job('owner', retried.id);
    expect(pushes).toBe(1);
    const replay = service.start('owner', {
      kind: 'push',
      expectedHead,
      requestId: pushed.requestId,
    });
    expect(replay.id).toBe(pushed.id);
    expect(command(local, 'rev-list', '--count', 'HEAD')).toBe('1');
    execFileSync('git', ['clone', remote, editor], { stdio: 'pipe' });
    command(editor, 'config', 'user.name', 'Other');
    command(editor, 'config', 'user.email', 'other@example.invalid');
    await writeFile(join(editor, 'note.md'), '# Remote update\n');
    command(editor, 'add', '.');
    command(editor, 'commit', '-m', 'Remote update');
    command(editor, 'push', 'origin', 'main');
    expect((await finish({ kind: 'check' })).status).toBe('succeeded');
    expect((await service.status('owner')).connection?.behind).toBe(1);
    await writeFile(join(local, 'note.md'), '# Unsaved file\n');
    const refused = await finish({ kind: 'pull' });
    expect(refused.status).toBe('failed');
    expect(refused.error).toBe('GIT_LOCAL_CHANGES');
    expect(await readFile(join(local, 'note.md'), 'utf8')).toBe('# Unsaved file\n');
    await writeFile(join(local, 'note.md'), '# First\n');
    expect((await finish({ kind: 'pull' })).status).toBe('succeeded');
    expect(await readFile(join(local, 'note.md'), 'utf8')).toBe('# Remote update\n');
    expect((await service.status('owner')).connection).toMatchObject({ ahead: 0, behind: 0 });
    await writeFile(join(local, 'note.md'), '# Local divergence\n');
    command(local, 'add', '.');
    command(local, 'commit', '-m', 'Local');
    await writeFile(join(editor, 'note.md'), '# Other divergence\n');
    command(editor, 'add', '.');
    command(editor, 'commit', '-m', 'Other');
    command(editor, 'push', 'origin', 'main');
    const diverged = await finish({ kind: 'pull' });
    expect(diverged.error).toBe('GIT_DIVERGED');
    expect(await readFile(join(local, 'note.md'), 'utf8')).toBe('# Local divergence\n');
    expect(() => service.job('someone-else', pushed.id)).toThrow();
  } finally {
    await service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);

it('clones into a new allowed directory, binds automatically and never replaces an existing destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-remote-clone-')),
    remote = join(root, 'remote.git'),
    seed = join(root, 'seed'),
    dataRoot = join(root, 'data'),
    parent = join(root, 'libraries');
  await mkdir(parent);
  await mkdir(seed);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'welcome.md'), '# Imported notes\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Seed');
  execFileSync('git', ['clone', '--bare', seed, remote], { stdio: 'pipe' });
  const db = openDatabase(dataRoot),
    config: any = {
      dataRoot,
      secret: 'fixture-key-at-least-thirty-two-characters',
      origin: 'http://localhost',
      allowedKnowledgeBases: [root],
      indexing: { enabled: false, watch: false },
    };
  await createAuth(config, db);
  const platform = platformRuntime(config, db);
  let enabled = false;
  const plugins: any = {
    list: () => (enabled ? [{ id: 'git', state: 'enabled' }] : []),
    install: async () => {},
    enable: async () => {
      enabled = true;
    },
  };
  const service = gitRemoteService(config, db, platform, plugins, {
    exec: localGitTransport(db, { 'https://gitee.com/fixture/notes.git': remote }),
  });
  const finish = async (input: any) => {
    const j = service.start('owner', {
      requestId: crypto.randomUUID(),
      kind: 'clone',
      url: 'https://gitee.com/fixture/notes',
      parentPath: parent,
      ...input,
    });
    await expect
      .poll(() => service.job('owner', j.id).status, { timeout: 20000 })
      .not.toMatch(/queued|running/);
    return service.job('owner', j.id);
  };
  try {
    await mkdir(join(parent, 'existing'));
    await writeFile(join(parent, 'existing', 'keep.txt'), 'Do not overwrite');
    const refused = await finish({ name: 'existing' });
    expect(refused.error).toBe('DIRECTORY_EXISTS');
    expect(await readFile(join(parent, 'existing', 'keep.txt'), 'utf8')).toBe('Do not overwrite');
    const cloned = await finish({ name: 'imported' });
    expect(cloned.status, JSON.stringify(cloned)).toBe('succeeded');
    expect(cloned.result).toMatchObject({ bound: true, branch: 'main' });
    expect(platform.status().knowledgeRoot).toBe(join(parent, 'imported'));
    expect(enabled).toBe(true);
    expect(await readFile(join(parent, 'imported', 'welcome.md'), 'utf8')).toBe(
      '# Imported notes\n',
    );
    const state = await service.status('owner');
    expect(state.repository).toBe('ready');
    expect(state.connection?.url).toBe('https://gitee.com/fixture/notes.git');
  } finally {
    await service.close();
    await platform.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
