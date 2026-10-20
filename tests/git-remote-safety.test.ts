import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../packages/core/db.js';
import { createAuth } from '../apps/server/auth.js';
import { platformRuntime } from '../apps/server/platform/runtime.js';
import { gitRemoteService } from '../apps/server/git/service.js';
import { localGitTransport } from './support/git-remote-fixture.js';
const A = 'https://github.com/fixture/notes.git',
  B = 'https://gitee.com/fixture/notes.git';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
async function fixture(unbound = false) {
  const root = await mkdtemp(join(tmpdir(), 'git-remote-safety-')),
    seed = join(root, 'seed'),
    local = join(root, 'library'),
    a = join(root, 'a.git'),
    b = join(root, 'b.git');
  await mkdir(seed);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'note.md'), '# Base\n');
  await writeFile(join(seed, '.gitignore'), 'private.md\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Base');
  execFileSync('git', ['clone', '--bare', seed, a], { stdio: 'pipe' });
  execFileSync('git', ['clone', '--bare', seed, b], { stdio: 'pipe' });
  git(seed, 'remote', 'add', 'origin', a);
  if (!unbound) {
    execFileSync('git', ['clone', a, local], { stdio: 'pipe' });
    git(local, 'remote', 'set-url', 'origin', A);
    git(local, 'config', 'user.name', 'Fixture');
    git(local, 'config', 'user.email', 'fixture@example.invalid');
  }
  const config: any = {
    dataRoot: join(root, 'data'),
    ...(unbound ? {} : { knowledgeRoot: local }),
    secret: 'fixture-secret-at-least-thirty-two-characters',
    origin: 'http://localhost',
    allowedKnowledgeBases: [root],
    indexing: { enabled: false, watch: false },
  };
  const db = openDatabase(config.dataRoot);
  await createAuth(config, db);
  const platform = platformRuntime(config, db);
  await platform.activate();
  let pluginState = 'enabled';
  const plugins: any = {
    list: () => [{ id: 'git', state: pluginState }],
    install: async () => {},
    enable: async () => {},
  };
  const base = localGitTransport(db, { [A]: a, [B]: b });
  let before: ((args: string[]) => Promise<void>) | undefined,
    after: ((args: string[]) => Promise<void>) | undefined;
  const options = {
    exec: async (cwd: string, args: string[], opts: any) => {
      await before?.(args);
      const r = await base(cwd, args, opts);
      await after?.(args);
      return r;
    },
  };
  let service = gitRemoteService(config, db, platform, plugins, options);
  return {
    root,
    seed,
    local,
    a,
    b,
    db,
    platform,
    get service() {
      return service;
    },
    setPluginState(value: string) { pluginState = value; },
    setBefore(fn: typeof before) {
      before = fn;
    },
    setAfter(fn: typeof after) {
      after = fn;
    },
    async restart() {
      await service.close();
      service = gitRemoteService(config, db, platform, plugins, options);
    },
    async run(input: any) {
      const j = service.start('owner', { requestId: crypto.randomUUID(), ...input });
      await expect
        .poll(() => service.job('owner', j.id).status, { timeout: 20000 })
        .not.toMatch(/queued|running/);
      return service.job('owner', j.id);
    },
    async close() {
      await service.close();
      await platform.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
it('never overwrites an ignored local note during fast-forward pull', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    await writeFile(join(h.local, 'private.md'), '# Private local content\n');
    await writeFile(join(h.seed, 'private.md'), '# Cloud content\n');
    git(h.seed, 'add', '--force', 'private.md');
    git(h.seed, 'commit', '-m', 'Cloud adds ignored path');
    git(h.seed, 'push', 'origin', 'main');
    const pulled = await h.run({ kind: 'pull' });
    expect(pulled.status).not.toBe('succeeded');
    expect(await readFile(join(h.local, 'private.md'), 'utf8')).toBe('# Private local content\n');
  } finally {
    await h.close();
  }
}, 60000);
it('refuses old push retries after the configured remote changes', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    await writeFile(join(h.local, 'note.md'), '# Pending A\n');
    git(h.local, 'add', '.');
    git(h.local, 'commit', '-m', 'Only for A');
    let fail = true;
    h.setBefore(async (args) => {
      if (fail && args.includes('push')) {
        fail = false;
        throw Object.assign(Error('GIT_NETWORK_FAILED'), { code: 'GIT_NETWORK_FAILED' });
      }
    });
    const pending = await h.run({ kind: 'push', expectedHead: git(h.local, 'rev-parse', 'HEAD') });
    expect(pending.status).toBe('needs_reconciliation');
    expect((await h.run({ kind: 'connect', url: B })).status).toBe('succeeded');
    const originalB = git(h.b, 'rev-parse', 'HEAD');
    const retry = h.service.retry('owner', pending.id);
    await expect.poll(() => h.service.job('owner', retry.id).status).not.toMatch(/queued|running/);
    expect(h.service.job('owner', retry.id).error).toBe('GIT_CONNECTION_CHANGED');
    expect(git(h.b, 'rev-parse', 'HEAD')).toBe(originalB);
  } finally {
    await h.close();
  }
}, 60000);
it('rejects repository operations when the platform reports a replaced root', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    await rename(h.local, h.local + '-original');
    execFileSync('git', ['clone', h.a, h.local], { stdio: 'pipe' });
    git(h.local, 'remote', 'set-url', 'origin', A);
    expect(h.platform.status().code).toBe('SOURCE_UNAVAILABLE');
    let invoked = false;
    h.setBefore(async () => {
      invoked = true;
    });
    await expect(Promise.resolve().then(() => h.run({ kind: 'pull' }))).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(invoked).toBe(false);
  } finally {
    await h.close();
  }
}, 60000);
it('does not delete a replacement directory occupying the private clone stage path', async () => {
  const h = await fixture(true);
  let replaced = '';
  try {
    h.setAfter(async (args) => {
      if (args.includes('clone')) {
        replaced = args.at(-1)!;
        await rename(replaced, replaced + '-original');
        await mkdir(replaced);
        await writeFile(join(replaced, 'keep.md'), '# Preserve replacement\n');
      }
    });
    const job = await h.run({ kind: 'clone', url: A, name: 'imported', parentPath: h.root });
    expect(job.status).toBe('failed');
    expect(await readFile(join(replaced, 'keep.md'), 'utf8')).toBe('# Preserve replacement\n');
  } finally {
    await h.close();
  }
}, 60000);
it('reconciles a crash after atomic clone publication without cloning or replacing the directory again', async () => {
  const h = await fixture(true);
  try {
    const target = join(h.root, 'imported');
    execFileSync('git', ['clone', h.a, target], { stdio: 'pipe' });
    git(target, 'remote', 'set-url', 'origin', A);
    const s = await lstat(target, { bigint: true }),
      id = crypto.randomUUID();
    const input = {
      kind: 'clone',
      requestId: 'published-clone',
      url: A,
      name: 'imported',
      parentPath: h.root,
    };
    h.db
      .prepare('INSERT INTO git_remote_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        'owner',
        input.requestId,
        'clone',
        JSON.stringify(input),
        null,
        0,
        'running',
        'publishing',
        null,
        JSON.stringify({
          knowledgeRoot: target,
          stage: join(h.root, '.dooknow-clone-' + crypto.randomUUID()),
          dev: String(s.dev),
          ino: String(s.ino),
          cloned: false,
          publishing: true,
        }),
        Date.now(),
        Date.now(),
      );
    await h.restart();
    let network = false;
    h.setBefore(async (args) => {
      if (args.includes('clone')) network = true;
    });
    const retried = h.service.retry('owner', id);
    await expect
      .poll(() => h.service.job('owner', retried.id).status, { timeout: 20000 })
      .toBe('succeeded');
    expect(h.platform.status().knowledgeRoot).toBe(target);
    expect(network).toBe(false);
    expect(await readFile(join(target, 'note.md'), 'utf8')).toBe('# Base\n');
  } finally {
    await h.close();
  }
}, 60000);
it('never labels public read access as verified push permission when no push occurred', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    let pushes = 0;
    h.setBefore(async (args) => {
      if (args.includes('push')) pushes++;
    });
    const j = await h.run({ kind: 'push', expectedHead: git(h.local, 'rev-parse', 'HEAD') });
    expect(j.status).toBe('succeeded');
    expect(pushes).toBe(0);
    expect((await h.service.status('owner')).connection?.writeVerified).toBe(false);
  } finally {
    await h.close();
  }
}, 60000);

it('blocks sync after the user disables the Git plugin', async () => {
  const h = await fixture();
  try {
    expect((await h.run({ kind: 'connect', url: A })).status).toBe('succeeded');
    h.setPluginState('disabled');
    let invoked = false;
    h.setBefore(async () => { invoked = true; });
    const result = await h.run({ kind: 'push', expectedHead: git(h.local, 'rev-parse', 'HEAD') });
    expect(result).toMatchObject({ status: 'failed', error: 'GIT_PLUGIN_DISABLED' });
    expect(invoked).toBe(false);
  } finally { await h.close(); }
}, 60000);
