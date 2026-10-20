import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from '../packages/core/db.js';
import { workspaceWrite } from '../packages/core/workspace/gate.js';
import { workspaceExec } from '../packages/core/workspace/exec.js';
import { gitTransport, normalizeRemote, type GitExec } from '../apps/server/git/transport.js';
let root: string,
  repo: string,
  db: ReturnType<typeof openDatabase>,
  config: { dataRoot: string; secret: string; origin: string };
const url = 'https://github.com/Owner/Repo.git';
const okay = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-transport-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('/usr/bin/git', ['init', '-q', repo]);
  config = {
    dataRoot: join(root, 'data'),
    secret: 'fixture-installation-secret-with-thirty-two-characters',
    origin: 'http://localhost',
  };
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});
const gate = <T>(work: () => Promise<T>) => workspaceWrite(db, { kind: 'git-test' }, work);
it.each([
  'https://github.com/Owner/Repo',
  url,
  'git@github.com:Owner/Repo.git',
  'ssh://git@github.com/Owner/Repo.git',
])('normalizes an approved remote %s', (value) => {
  expect(normalizeRemote(value)).toMatchObject({
    host: 'github.com',
    repository: 'Owner/Repo',
    url: value.startsWith('https:') ? url : 'ssh://git@github.com/Owner/Repo.git',
  });
});
it.each([
  'file:///repo',
  '/repo',
  'https://user:token@github.com/o/r',
  'https://github.com/o/r?x=1',
  'https://github.com/o/r#ref',
  'https://github.com:443/o/r',
  'ssh://git@github.com:2222/o/r',
  'ssh://root@github.com/o/r',
  'https://github.com/o/../r',
  'https://github.com/o/%2e%2e/r',
  'https://github.com/o/%72',
  'https://evil.test/o/r',
  'https://github.com/o/r/extra',
  'git@github.com:o/../r',
  'https://github.com/o/r\\evil',
])('rejects unsafe remote %s', (value) => {
  expect(() => normalizeRemote(value)).toThrow('GIT_INVALID_REMOTE');
});
it.each([
  'url.https://evil.test/.insteadOf',
  'http.extraHeader',
  'credential.helper',
  'core.sshCommand',
  'filter.foo.clean',
  'include.path',
  'remote.origin.pushurl',
  'remote.origin.uploadpack',
])('rejects untrusted local config before network: %s', async (key) => {
  execFileSync('/usr/bin/git', ['-C', repo, 'config', key, 'hostile-value']);
  let network = false;
  const exec: GitExec = async (cwd, args, opts) => {
    if (args.includes('ls-remote')) {
      network = true;
      return okay;
    }
    return workspaceExec(db, cwd, args, opts);
  };
  await expect(
    gate(() => gitTransport(config, db, { exec }).run(repo, ['ls-remote', url], { url })),
  ).rejects.toThrow('GIT_UNSAFE_CONFIG');
  expect(network).toBe(false);
});
it('keeps HTTPS authentication out of arguments and repository config and disables redirects/helpers', async () => {
  let checked = false;
  const exec: GitExec = async (cwd, args, opts) => {
    if (!args.includes('ls-remote')) return workspaceExec(db, cwd, args, opts);
    checked = true;
    expect(args.join(' ')).not.toContain('private-token');
    expect(args).toContain(
      '--config-env=http.https://github.com/.extraHeader=DOOKNOW_GIT_AUTH_HEADER',
    );
    expect(args).toContain('http.followRedirects=false');
    expect(args).toContain('credential.helper=');
    expect(opts?.env?.DOOKNOW_GIT_AUTH_HEADER).toBe(
      `Authorization: Basic ${Buffer.from('user:private-token').toString('base64')}`,
    );
    return okay;
  };
  await gate(() =>
    gitTransport(config, db, { exec }).run(repo, ['ls-remote', url], {
      url,
      credential: {
        id: 'c',
        name: 'private',
        host: 'github.com',
        kind: 'https',
        username: 'user',
        token: 'private-token',
        updatedAt: 1,
      },
    }),
  );
  expect(checked).toBe(true);
  expect(readFileSync(join(repo, '.git/config'), 'utf8')).not.toContain('private-token');
});
it('uses private SSH files and strict trusted ssh flags, cleaning files even on failure', async () => {
  let keyPath = '',
    knownPath = '';
  const sshUrl = 'ssh://git@github.com/Owner/Repo.git';
  const exec: GitExec = async (cwd, args, opts) => {
    if (!args.includes('ls-remote')) return workspaceExec(db, cwd, args, opts);
    const ssh = opts?.env?.GIT_SSH_COMMAND || '';
    expect(ssh).toContain('/usr/bin/ssh');
    expect(ssh).toContain('StrictHostKeyChecking=yes');
    expect(ssh).toContain('IdentitiesOnly=yes');
    expect(ssh).toContain('IdentityAgent=none');
    expect(ssh).toContain('-F /dev/null');
    keyPath = opts!.env!.DOOKNOW_GIT_KEY_FILE;
    knownPath = opts!.env!.DOOKNOW_GIT_HOSTS_FILE;
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(knownPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath, 'utf8')).toBe('fixture-key');
    expect(args.join(' ')).not.toContain('fixture-key');
    expect(ssh).not.toContain('secret-passphrase');
    return {
      ...okay,
      code: 128,
      stderr: Buffer.from('Permission denied (publickey). secret-passphrase fixture-key'),
    };
  };
  await expect(
    gate(() =>
      gitTransport(config, db, { exec }).run(repo, ['ls-remote', sshUrl], {
        url: sshUrl,
        credential: {
          id: 'c',
          name: 'ssh',
          host: 'github.com',
          kind: 'ssh',
          updatedAt: 1,
          privateKey: 'fixture-key',
          knownHosts: 'trusted-fixture-host',
          passphrase: 'secret-passphrase',
        },
      }),
    ),
  ).rejects.toThrow(/^GIT_AUTH_FAILED$/);
  expect(keyPath).toBeTruthy();
  expect(existsSync(keyPath)).toBe(false);
  expect(existsSync(knownPath)).toBe(false);
});
it('uses real bare Git through a test-only executor while rejecting file URLs in production', async () => {
  const bare = join(root, 'remote.git');
  execFileSync('/usr/bin/git', ['init', '--bare', '-q', bare]);
  const exec: GitExec = (cwd, args, opts) =>
    workspaceExec(
      db,
      cwd,
      args.map((arg) =>
        arg === url
          ? bare
          : arg === 'protocol.file.allow=never'
            ? 'protocol.file.allow=always'
            : arg,
      ),
      { ...opts, env: { ...opts?.env, GIT_ALLOW_PROTOCOL: 'file' } },
    );
  // The test substitute authorizes only its own isolated local bare repository.
  const transport = gitTransport(config, db, { exec });
  await expect(gate(() => transport.run(root, ['ls-remote', url], { url }))).resolves.toMatchObject(
    { code: 0 },
  );
  await expect(
    gate(() =>
      gitTransport(config, db).run(root, ['ls-remote', `file://${bare}`], {
        url: `file://${bare}`,
      }),
    ),
  ).rejects.toThrow('GIT_INVALID_REMOTE');
});
it('sanitizes network errors, preserves local nonzero probes, and refuses an already aborted request', async () => {
  const transport = gitTransport(config, db, {
    exec: async (cwd, args, options) =>
      args.includes('ls-remote')
        ? { ...okay, code: 128, stderr: Buffer.from('fatal: Authentication failed private-token') }
        : workspaceExec(db, cwd, args, options),
  });
  await expect(gate(() => transport.run(repo, ['ls-remote', url], { url }))).rejects.toThrow(
    /^GIT_AUTH_FAILED$/,
  );
  await expect(
    gate(() => gitTransport(config, db).run(repo, ['rev-parse', '--verify', 'HEAD'])),
  ).resolves.toMatchObject({ code: 128 });
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.run(repo, ['ls-remote', url], { url, signal: controller.signal }),
  ).rejects.toThrow('GIT_COMMAND_CANCELLED');
});
it('aborts and reaps a real guarded process and applies process timeouts', async () => {
  const controller = new AbortController();
  await gate(async () => {
    const running = workspaceExec(db, repo, ['-c', 'alias.sleeper=!sleep 30', 'sleeper'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 120);
    expect((await running).code).not.toBe(0);
    expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
  });
  await expect(
    gate(() =>
      workspaceExec(db, repo, ['-c', 'alias.sleeper=!sleep 30', 'sleeper'], { timeoutMs: 100 }),
    ),
  ).rejects.toThrow('GIT_COMMAND_TIMEOUT');
});

it('isolates anonymous HTTP credentials from the account home and always cleans the private home', async () => {
  let isolated = '';
  const originalHome = process.env.HOME;
  const exec: GitExec = async (cwd, args, opts) => {
    if (!args.includes('ls-remote')) return workspaceExec(db, cwd, args, opts);
    isolated = opts!.env!.HOME;
    expect(isolated).toBeTruthy();
    expect(isolated).not.toBe(originalHome);
    expect(statSync(isolated).mode & 0o777).toBe(0o700);
    expect(existsSync(join(isolated, '.netrc'))).toBe(false);
    expect(opts?.env?.DOOKNOW_GIT_AUTH_HEADER).toBeUndefined();
    return okay;
  };
  await gate(() => gitTransport(config, db, { exec }).run(repo, ['ls-remote', url], { url }));
  expect(process.env.HOME).toBe(originalHome);
  expect(existsSync(isolated)).toBe(false);
});
it('refuses SSH host scans for non-allowlisted targets without launching a process', async () => {
  await expect(gitTransport(config, db).scanHost('localhost')).rejects.toThrow(
    'GIT_INVALID_REMOTE',
  );
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_guards'").all()).toEqual(
    [],
  );
});
it.each(['Repo', 'Repo403', 'non-fast-forward', 'timeout', 'TIMEOUT'])(
  'keeps a real proxy transport failure independent of repository name: %s', async (name) => {
    let requests = 0;
    const proxy = createServer((_, response) => response.writeHead(502).end());
    proxy.on('connect', (_, socket) => {
      requests++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>(yes => proxy.listen(0, '127.0.0.1', yes));
    try {
      const proxyURL = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port;
      const remoteURL = 'https://github.com/Owner/' + name + '.git';
      const exec: GitExec = (cwd, args, opts) => workspaceExec(db, cwd, args, {
        ...opts, env: { ...opts?.env, HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL,
          http_proxy: proxyURL, https_proxy: proxyURL, NO_PROXY: '', no_proxy: '' },
      });
      await expect(gate(() => gitTransport(config, db, { exec }).run(repo,
        ['ls-remote', remoteURL], { url: remoteURL, timeoutMs: 5000 })))
        .rejects.toThrow(/^GIT_NETWORK_FAILED$/);
      expect(requests).toBeGreaterThan(0);
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(yes => proxy.close(() => yes()));
    }
  },
);
it('binds the actual network argument to the approved remote rather than a second target', async () => {
  const transport = gitTransport(config, db, { exec: async () => okay });
  await expect(
    transport.run(repo, ['ls-remote', 'https://evil.test/o/r'], { url }),
  ).rejects.toThrow('GIT_INVALID_REMOTE');
  await expect(
    transport.run(repo, ['ls-remote', url, 'https://evil.test/o/r'], { url }),
  ).rejects.toThrow('GIT_INVALID_REMOTE');
});
it.each([
  ['REMOTE HOST IDENTIFICATION HAS CHANGED private-token', 'GIT_HOST_KEY_CHANGED'],
  ['remote: permission to repository denied private-token', 'GIT_PERMISSION_DENIED'],
  ['fatal: unable to get password from user', 'GIT_AUTH_FAILED'],
  ['fatal: unable to access https://github.com/Owner/Repo403.git/: Could not resolve host: github.com', 'GIT_NETWORK_FAILED'],
  ['fatal: The requested URL returned error: 403', 'GIT_PERMISSION_DENIED'],
  ['error: RPC failed; HTTP/2 403 curl 22', 'GIT_PERMISSION_DENIED'],
  [
    'ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.',
    'GIT_PERMISSION_DENIED',
  ],
  ['! [rejected] main -> main (non-fast-forward) private-token', 'GIT_REMOTE_REJECTED'],
  ['failed to connect private-token', 'GIT_NETWORK_FAILED'],
  ['fatal: unable to access https://github.com/Owner/Repo/: SSL connection timeout', 'GIT_COMMAND_TIMEOUT'],
  ['fatal: unable to access https://github.com/Owner/Repo/: Connection timed out after 10000 milliseconds', 'GIT_COMMAND_TIMEOUT'],
  ['From https://github.com/Owner/Repo\n * [new branch] timeout -> origin/timeout\nfatal: early EOF\n', 'GIT_NETWORK_FAILED'],
  ['From https://github.com/Owner/Repo\n * [new branch] non-fast-forward -> origin/non-fast-forward\nfatal: early EOF\n', 'GIT_NETWORK_FAILED'],
  ['fatal: timeout expired', 'GIT_COMMAND_TIMEOUT'],
])('returns only the classified network error for %s', async (stderr, expected) => {
  const transport = gitTransport(config, db, {
    exec: async (cwd, args, options) =>
      args.includes('ls-remote')
        ? { ...okay, code: 128, stderr: Buffer.from(stderr) }
        : workspaceExec(db, cwd, args, options),
  });
  try {
    await gate(() => transport.run(repo, ['ls-remote', url], { url }));
    throw Error('expected rejection');
  } catch (error) {
    expect((error as Error).message).toBe(expected);
    expect(JSON.stringify(error)).not.toContain('private-token');
  }
});

it.each(['non-fast-forward', 'timeout'])(
  'keeps an unknown porcelain remote failure uncertain for branch %s', async (branch) => {
    const transport = gitTransport(config, db, {
      exec: async (cwd, args, options) => args.includes('push')
        ? { code: 1, stdout: Buffer.from('To https://github.com/Owner/Repo.git\n!\tHEAD:refs/heads/' + branch + '\t[remote failure] (remote failed to report status)\nDone\n'), stderr: Buffer.from('error: failed to push some refs\n') }
        : workspaceExec(db, cwd, args, options),
    });
    await expect(gate(() => transport.run(repo, ['push', '--porcelain', '--', url, 'HEAD:refs/heads/' + branch], { url })))
      .rejects.toThrow(/^GIT_NETWORK_FAILED$/);
  },
);

it('reports a porcelain non-fast-forward rejection from stdout as a remote refusal', async () => {
  const transport = gitTransport(config, db, {
    exec: async (cwd, args, options) => args.includes('push')
      ? { code: 1, stdout: Buffer.from('To https://github.com/Owner/Repo.git\n!\t0123456789abcdef0123456789abcdef01234403:refs/heads/main\t[rejected] (non-fast-forward)\nDone\n'), stderr: Buffer.from("error: failed to push some refs to 'ssh://github.com/Owner/Repo.git'\n") }
      : workspaceExec(db, cwd, args, options),
  });
  await expect(gate(() => transport.run(repo, ['push', '--porcelain', '--', url, 'HEAD:refs/heads/main'], { url })))
    .rejects.toThrow(/^GIT_REMOTE_REJECTED$/);
});
it.each([
  ['core.alternateRefsCommand', 'printf "$DOOKNOW_GIT_AUTH_HEADER"'],
  [`remote.${url}.url`, 'https://github.com/Attacker/Other.git'],
  ['remote.git@github.com:Owner/Repo.git.url', 'https://github.com/Attacker/Other.git'],
])(
  'rejects executable alternates or URL-shadowing config before exposing credentials: %s',
  async (key, value) => {
    execFileSync('/usr/bin/git', ['-C', repo, 'config', key, value]);
    let network = false;
    const exposed: string[] = [];
    const exec: GitExec = async (cwd, args, options) => {
      if (options?.env?.DOOKNOW_GIT_AUTH_HEADER) exposed.push(options.env.DOOKNOW_GIT_AUTH_HEADER);
      if (args.includes('fetch')) {
        network = true;
        return okay;
      }
      return workspaceExec(db, cwd, args, options);
    };
    await expect(
      gate(() =>
        gitTransport(config, db, { exec }).run(repo, ['fetch', '--', url], {
          url,
          credential: {
            id: 'c',
            name: 'private',
            kind: 'https',
            host: 'github.com',
            token: 'fixture-secret',
            updatedAt: 1,
          },
        }),
      ),
    ).rejects.toThrow('GIT_UNSAFE_CONFIG');
    expect(network).toBe(false);
    expect(exposed).toEqual([]);
  },
);
it.each(['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts'])(
  'rejects a repository object redirection file before network: %s',
  async (path) => {
    const location = join(repo, '.git', path);
    writeFileSync(location, '/outside/knowledge/objects\n');
    let network = false;
    const exec: GitExec = async (cwd, args, options) => {
      expect(options?.env?.DOOKNOW_GIT_AUTH_HEADER).toBeUndefined();
      if (args.includes('fetch')) {
        network = true;
        return okay;
      }
      return workspaceExec(db, cwd, args, options);
    };
    await expect(
      gate(() => gitTransport(config, db, { exec }).run(repo, ['fetch', '--', url], { url })),
    ).rejects.toThrow('GIT_UNSAFE_CONFIG');
    expect(network).toBe(false);
  },
);
it('rejects a local status clean filter before it can execute repository-controlled code', async () => {
  const sentinel = join(root, 'filter-executed');
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=attack\n');
  writeFileSync(join(repo, 'note.txt'), 'first\n');
  execFileSync('/usr/bin/git', ['-C', repo, 'add', '.']);
  execFileSync('/usr/bin/git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  execFileSync('/usr/bin/git', [
    '-C',
    repo,
    'config',
    'filter.attack.clean',
    `touch '${sentinel}'; cat`,
  ]);
  writeFileSync(join(repo, 'note.txt'), 'other\n');
  let rejected: unknown;
  try {
    await gate(() => gitTransport(config, db).run(repo, ['status', '--porcelain']));
  } catch (error) {
    rejected = error;
  }
  expect(existsSync(sentinel)).toBe(false);
  expect(rejected).toMatchObject({ code: 'GIT_UNSAFE_CONFIG' });
});
