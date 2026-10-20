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
async function fixture(unbound = false, managedNotes = false) {
  const root = await mkdtemp(join(tmpdir(), 'git-remote-safety-')),
    seed = join(root, 'seed'),
    local = join(root, 'library'),
    a = join(root, 'a.git'),
    b = join(root, 'b.git');
  await mkdir(seed);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, managedNotes ? 'README.md' : 'note.md'), '# Base\n');
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
    plugins,
    get service() {
      return service;
    },
    setPluginState(value: string) {
      pluginState = value;
    },
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
    h.db.prepare('INSERT INTO git_remote_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
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
    h.setBefore(async () => {
      invoked = true;
    });
    const result = await h.run({ kind: 'push', expectedHead: git(h.local, 'rev-parse', 'HEAD') });
    expect(result).toMatchObject({ status: 'failed', error: 'GIT_PLUGIN_DISABLED' });
    expect(invoked).toBe(false);
  } finally {
    await h.close();
  }
}, 60000);

for (const interruption of ['before-merge', 'after-merge'] as const) {
  it(`reconciles the recorded pull target ${interruption} without fetching a newer tip and refreshes an unwatched index`, async () => {
    const h = await fixture(false, true);
    try {
      await h.run({ kind: 'connect', url: A });
      await h.platform.get().knowledge.indexing.reconcile(undefined, true);
      expect(h.db.prepare('SELECT path FROM notes WHERE active=1').all()).toEqual([
        { path: 'README.md' },
      ]);
      await mkdir(join(h.seed, '00-Inbox'));
      await writeFile(join(h.seed, '00-Inbox/added.md'), '# Recorded target\n');
      git(h.seed, 'rm', 'README.md');
      git(h.seed, 'add', '.');
      git(h.seed, 'commit', '-m', 'Recorded target');
      git(h.seed, 'push', 'origin', 'main');
      const target = git(h.seed, 'rev-parse', 'HEAD');
      const interrupt = async (args: string[]) => {
        if (args.includes('merge'))
          throw Object.assign(Error('GIT_TASK_INTERRUPTED'), { code: 'GIT_TASK_INTERRUPTED' });
      };
      if (interruption === 'before-merge') h.setBefore(interrupt);
      else h.setAfter(interrupt);
      const pending = await h.run({ kind: 'pull' });
      expect(pending.status).toBe('needs_reconciliation');
      expect(pending.result).toMatchObject({ target });
      h.setBefore(undefined);
      h.setAfter(undefined);
      await writeFile(join(h.seed, 'newer.md'), '# Requires a new pull\n');
      git(h.seed, 'add', '.');
      git(h.seed, 'commit', '-m', 'Newer');
      git(h.seed, 'push', 'origin', 'main');
      await h.restart();
      let fetched = false;
      h.setBefore(async (args) => {
        if (args.includes('fetch') || args.includes('ls-remote')) fetched = true;
      });
      h.service.retry('owner', pending.id);
      await expect
        .poll(() => h.service.job('owner', pending.id).status, { timeout: 20000 })
        .not.toMatch(/queued|running/);
      expect(h.service.job('owner', pending.id)).toMatchObject({
        status: 'succeeded',
        result: { commit: target, refreshRequired: true },
      });
      expect(fetched).toBe(false);
      expect(git(h.local, 'rev-parse', 'HEAD')).toBe(target);
      expect(await readFile(join(h.local, '00-Inbox/added.md'), 'utf8')).toBe(
        '# Recorded target\n',
      );
      expect(await lstat(join(h.local, 'newer.md')).catch(() => null)).toBeNull();
      expect(h.db.prepare('SELECT path FROM notes WHERE active=1 ORDER BY path').all()).toEqual([
        { path: '00-Inbox/added.md' },
      ]);
    } finally {
      await h.close();
    }
  }, 60000);
}

it('blocks pull with a clean index and an unresolved Git intent for this binding only', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    const before = git(h.local, 'rev-parse', 'HEAD');
    await writeFile(join(h.seed, 'note.md'), '# Remote\n');
    git(h.seed, 'add', '.');
    git(h.seed, 'commit', '-m', 'Remote');
    git(h.seed, 'push', 'origin', 'main');
    h.db.exec(
      'CREATE TABLE IF NOT EXISTS plugin_operation_intents(operation_id TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,details TEXT NOT NULL)',
    );
    const details = {
      phase: 'refPublished',
      commit: before,
      preview: { root: h.local, binding: h.platform.status().bindingVersion },
    };
    h.db
      .prepare('INSERT INTO plugin_operation_intents VALUES(?,?,?)')
      .run('pending', 'git', JSON.stringify(details));
    expect(git(h.local, 'status', '--porcelain')).toBe('');
    const blocked = await h.run({ kind: 'pull' });
    expect(blocked).toMatchObject({ status: 'failed', error: 'GIT_RECONCILIATION_REQUIRED' });
    expect(git(h.local, 'rev-parse', 'HEAD')).toBe(before);
    expect(await readFile(join(h.local, 'note.md'), 'utf8')).toBe('# Base\n');
    h.db
      .prepare('UPDATE plugin_operation_intents SET details=?')
      .run(JSON.stringify({ ...details, preview: { ...details.preview, binding: -1 } }));
    expect((await h.run({ kind: 'pull' })).status).toBe('succeeded');
  } finally {
    await h.close();
  }
}, 60000);

for (const action of ['cancel', 'close'] as const) {
  it(`propagates ${action} and progress to automatic installation without enabling or binding`, async () => {
    const h = await fixture(true);
    try {
      h.setPluginState('absent');
      let published = false,
        enabled = false,
        aborted = false;
      h.plugins.list = () => [];
      h.plugins.enable = async () => {
        enabled = true;
      };
      h.plugins.install = async (_id: string, options: any = {}) => {
        options.onPhase?.('downloading');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          options.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(Error('aborted'));
            },
            { once: true },
          );
        });
        options.signal?.throwIfAborted();
        published = true;
      };
      const job = h.service.start('owner', {
        kind: 'clone',
        requestId: crypto.randomUUID(),
        url: A,
        name: 'imported',
        parentPath: h.root,
      });
      await expect
        .poll(() => h.service.job('owner', job.id).phase, { timeout: 3000 })
        .toBe('downloading');
      const started = Date.now();
      if (action === 'cancel') h.service.cancel('owner', job.id);
      else await h.service.close();
      await expect
        .poll(() => h.service.job('owner', job.id).status, { timeout: 1000 })
        .not.toMatch(/queued|running/);
      expect(Date.now() - started).toBeLessThan(500);
      expect(aborted).toBe(true);
      expect(published).toBe(false);
      expect(enabled).toBe(false);
      expect(h.platform.status().knowledgeRoot).toBeFalsy();
      expect(await lstat(join(h.root, 'imported')).catch(() => null)).toBeNull();
    } finally {
      await h.close();
    }
  }, 60000);
}

it('rejects a compressible committed tree before checkout can expand beyond the import budget', async () => {
  const h = await fixture(true);
  try {
    const { createHash } = await import('node:crypto');
    const { createDeflate } = await import('node:zlib');
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const chunk = Buffer.alloc(1024 * 1024),
      size = chunk.length * 1024 + 1;
    const header = Buffer.from(`blob ${size}\0`),
      hash = createHash('sha1').update(header);
    for (let i = 0; i < 1024; i++) hash.update(chunk);
    hash.update(Buffer.alloc(1));
    const oid = hash.digest('hex'),
      objects = join(h.a, 'objects', oid.slice(0, 2));
    await mkdir(objects, { recursive: true });
    // ~1 MiB compressed fixture; never materialize its 1 GiB working file, even in RED.
    await pipeline(
      Readable.from(
        (function* () {
          yield header;
          for (let i = 0; i < 1024; i++) yield chunk;
          yield Buffer.alloc(1);
        })(),
      ),
      createDeflate(),
      createWriteStream(join(objects, oid.slice(2))),
    );
    const tree = execFileSync('git', ['-C', h.a, 'mktree'], {
      input: `100644 blob ${oid}\thuge.md\n`,
      encoding: 'utf8',
    }).trim();
    const commit = execFileSync(
      'git',
      [
        '-C',
        h.a,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        tree,
        '-m',
        'Oversized',
      ],
      { encoding: 'utf8' },
    ).trim();
    git(h.a, 'update-ref', 'refs/heads/main', commit);
    let checkout = false;
    h.setBefore(async (args) => {
      if (args.includes('checkout')) {
        checkout = true;
        throw Error('TEST_BLOCKED_OVERSIZED_CHECKOUT');
      }
    });
    const job = await h.run({ kind: 'clone', url: A, name: 'imported', parentPath: h.root });
    expect(job).toMatchObject({ status: 'failed', error: 'GIT_CLONE_TOO_LARGE' });
    expect(checkout).toBe(false);
    expect(await lstat(join(h.root, 'imported')).catch(() => null)).toBeNull();
  } finally {
    await h.close();
  }
}, 60000);

it('aborts an in-progress clone when staging exceeds its byte budget', async () => {
  const h = await fixture(true);
  try {
    let stopped = false;
    h.setAfter(async (args) => {
      if (!args.includes('clone')) return;
      const { open } = await import('node:fs/promises');
      const file = await open(join(args.at(-1)!, 'sparse-budget-fixture'), 'w');
      await file.truncate(1024 * 1024 * 1024 + 1);
      await file.close();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    h.setBefore(async (args) => {
      if (args.includes('checkout')) stopped = true;
    });
    const job = await h.run({ kind: 'clone', url: A, name: 'imported', parentPath: h.root });
    expect(job).toMatchObject({ status: 'failed', error: 'GIT_CLONE_TOO_LARGE' });
    expect(stopped).toBe(false);
  } finally {
    await h.close();
  }
}, 60000);

it('retains published clone recovery when interrupted plugin installation changed the visible phase', async () => {
  const h = await fixture(true);
  try {
    const target = join(h.root, 'imported');
    execFileSync('git', ['clone', h.a, target], { stdio: 'pipe' });
    git(target, 'remote', 'set-url', 'origin', A);
    const s = await lstat(target, { bigint: true }),
      id = crypto.randomUUID();
    const input = {
      kind: 'clone',
      requestId: 'published-install-interrupted',
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
        'downloading',
        null,
        JSON.stringify({
          knowledgeRoot: target,
          cloned: true,
          dev: String(s.dev),
          ino: String(s.ino),
        }),
        Date.now(),
        Date.now(),
      );
    await h.restart();
    let cloned = false;
    h.setBefore(async (args) => {
      if (args.includes('clone')) cloned = true;
    });
    h.service.retry('owner', id);
    await expect
      .poll(() => h.service.job('owner', id).status, { timeout: 20000 })
      .not.toMatch(/queued|running/);
    expect(h.service.job('owner', id).status).toBe('succeeded');
    expect(h.platform.status().knowledgeRoot).toBe(target);
    expect(cloned).toBe(false);
    expect(await readFile(join(target, 'note.md'), 'utf8')).toBe('# Base\n');
  } finally {
    await h.close();
  }
}, 60000);

it('refuses recorded pull recovery after branch or HEAD changes without fetching or overwriting local work', async () => {
  const h = await fixture();
  try {
    await h.run({ kind: 'connect', url: A });
    await writeFile(join(h.seed, 'note.md'), '# Recorded\n');
    git(h.seed, 'add', '.');
    git(h.seed, 'commit', '-m', 'Recorded');
    git(h.seed, 'push', 'origin', 'main');
    h.setBefore(async (args) => {
      if (args.includes('merge'))
        throw Object.assign(Error('GIT_TASK_INTERRUPTED'), { code: 'GIT_TASK_INTERRUPTED' });
    });
    const pending = await h.run({ kind: 'pull' });
    expect(pending.status).toBe('needs_reconciliation');
    let fetched = false;
    h.setBefore(async (args) => {
      if (args.includes('fetch') || args.includes('ls-remote')) fetched = true;
    });
    git(h.local, 'switch', '-c', 'other');
    h.service.retry('owner', pending.id);
    await expect
      .poll(() => h.service.job('owner', pending.id).status, { timeout: 20000 })
      .not.toMatch(/queued|running/);
    expect(h.service.job('owner', pending.id).error).toBe('GIT_BRANCH_CHANGED');
    git(h.local, 'switch', 'main');
    await writeFile(join(h.local, 'local.md'), '# Local work\n');
    git(h.local, 'add', '.');
    git(h.local, 'commit', '-m', 'Local work');
    const localHead = git(h.local, 'rev-parse', 'HEAD');
    h.service.retry('owner', pending.id);
    await expect
      .poll(() => h.service.job('owner', pending.id).status, { timeout: 20000 })
      .not.toMatch(/queued|running/);
    expect(h.service.job('owner', pending.id).error).toBe('GIT_RECONCILIATION_REQUIRED');
    expect(git(h.local, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(fetched).toBe(false);
    expect(await readFile(join(h.local, 'local.md'), 'utf8')).toBe('# Local work\n');
  } finally {
    await h.close();
  }
}, 60000);
