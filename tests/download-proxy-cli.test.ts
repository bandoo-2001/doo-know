import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { connect, createServer as createProbe } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDownloadProxy } from '../apps/server/platform/download-proxy.js';
import { loadHostConfig } from '../apps/server/platform/config.js';
import { initializeOwner } from '../apps/server/auth.js';

const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-proxy-cli-')),
    installRoot = join(root, 'install');
  const profile = join(root, 'custom profile.json'),
    secretFile = join(root, 'auth.key');
  let proxyRequests = 0,
    directRequests = 0;
  const metadata = {
    version: '1.2.3',
    file: 'dooknow-1.2.3-linux-x64.tar.gz',
    sha256: '0'.repeat(64),
    platform: 'linux-x64',
    databaseCompatibility: 2,
  };
  const target = createServer((request, response) => {
    directRequests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/healthz' ? { ready: true } : metadata));
  });
  const proxy = createServer();
  proxy.on('connect', (_, socket, head) => {
    proxyRequests++;
    const upstream = connect((target.address() as any).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((yes) => target.listen(0, '127.0.0.1', yes));
  await new Promise<void>((yes) => proxy.listen(0, '127.0.0.1', yes));
  const source = `http://127.0.0.1:${(target.address() as any).port}`;
  await mkdir(join(installRoot, 'releases/1.2.3'), { recursive: true });
  await writeFile(
    join(installRoot, 'releases/1.2.3/release.json'),
    JSON.stringify({ ...metadata, source }),
  );
  await symlink('releases/1.2.3', join(installRoot, 'current'));
  await writeFile(secretFile, 'fixture-only-secret-at-least-thirty-two-characters', {
    mode: 0o600,
  });
  await writeFile(
    profile,
    JSON.stringify({
      installRoot,
      secretFile,
      dataRoot: join(root, 'data'),
      serviceManaged: false,
      origin: source,
      port: (target.address() as any).port,
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_OPTIONS: '',
    NODE_USE_ENV_PROXY: '',
    DOOKNOW_INSTALL_ROOT: installRoot,
  };
  const run = (command: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []) =>
    execute(process.execPath, ['--import', 'tsx', resolve('scripts/manage.ts'), command, ...args], {
      cwd: resolve('.'),
      env: { ...env, ...extra },
      timeout: 15000,
    });
  return {
    root,
    installRoot,
    profile,
    env,
    run,
    source,
    proxyAddress: `http://127.0.0.1:${(proxy.address() as any).port}`,
    counts: () => ({ proxyRequests, directRequests }),
    close: async () => {
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((yes) => proxy.close(() => yes())),
        new Promise<void>((yes) => target.close(() => yes())),
      ]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('candidate migrate remembers inherited settings and the unmodified legacy launcher updates in a fresh terminal', async () => {
  const f = await fixture();
  try {
    await f.run('migrate', { HTTP_PROXY: f.proxyAddress, NO_PROXY: '' }, ['--profile', f.profile]);
    expect(loadDownloadProxy(f.profile, {})).toEqual({ HTTP_PROXY: f.proxyAddress, NO_PROXY: '' });
    expect((await readFile(join(f.installRoot, 'profile.path'), 'utf8')).trim()).toBe(f.profile);
    const launcher = join(f.root, 'dooknow');
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    const bytes = `#!/bin/sh\nexport DOOKNOW_INSTALL_ROOT=${quote(f.installRoot)}\nexec ${quote(process.execPath)} --import tsx ${quote(resolve('scripts/manage.ts'))} "$@"\n`;
    await writeFile(launcher, bytes, { mode: 0o700 });
    const updated = await execute(launcher, ['update'], {
      cwd: resolve('.'),
      env: f.env,
      timeout: 15000,
    });
    expect(JSON.parse(updated.stdout)).toEqual({ version: '1.2.3', unchanged: true });
    expect(f.counts()).toEqual({ proxyRequests: 1, directRequests: 1 });
    expect(await readFile(launcher, 'utf8')).toBe(bytes);
  } finally {
    await f.close();
  }
});

it('native install remembers its successful download environment without changing its profile', async () => {
  const f = await fixture(),
    probe = createProbe();
  try {
    await new Promise<void>((yes) => probe.listen(0, '127.0.0.1', yes));
    const port = (probe.address() as any).port;
    await new Promise<void>((yes) => probe.close(() => yes()));
    const profile = JSON.parse(await readFile(f.profile, 'utf8'));
    profile.port = port;
    await writeFile(f.profile, JSON.stringify(profile));
    await initializeOwner(
      loadHostConfig({ profileFile: f.profile }, {}),
      'fixture_owner',
      'fixture-password-eight-or-more',
    );
    const before = await readFile(f.profile);
    const installed = await f.run('install', { HTTPS_PROXY: f.proxyAddress }, [
      '--profile',
      f.profile,
      '--no-service',
    ]);
    expect(installed.stdout).toContain('账号已存在');
    expect(loadDownloadProxy(f.profile, {})).toEqual({
      HTTPS_PROXY: f.proxyAddress,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    expect(await readFile(f.profile)).toEqual(before);
  } finally {
    probe.close();
    await f.close();
  }
});

it('status ignores the fallback and explicit update settings can bypass damaged saved state', async () => {
  const f = await fixture();
  try {
    await f.run('migrate', {}, ['--profile', f.profile]);
    await writeFile(f.profile + '.download-proxy.json', '{damaged', { mode: 0o600 });
    const status = await f.run('status');
    expect(JSON.parse(status.stdout).health.ready).toBe(true);
    expect(f.counts().proxyRequests).toBe(0);
    await expect(f.run('update')).rejects.toMatchObject({
      stderr: expect.stringContaining('保存的下载代理设置无法安全读取'),
    });
    const result = await f.run('update', { HTTP_PROXY: f.proxyAddress });
    expect(JSON.parse(result.stdout).unchanged).toBe(true);
    expect(loadDownloadProxy(f.profile, {})).toEqual({
      HTTP_PROXY: f.proxyAddress,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    await writeFile(f.profile + '.download-proxy.json', '{damaged');
    const skipped = await f.run('update', { DOOKNOW_NO_SAVED_PROXY: '1' });
    expect(JSON.parse(skipped.stdout).unchanged).toBe(true);
    expect(await readFile(f.profile + '.download-proxy.json', 'utf8')).toBe('{damaged');
  } finally {
    await f.close();
  }
});

it('warns without changing successful update results when saving is unsafe', async () => {
  const f = await fixture();
  try {
    await f.run('migrate', {}, ['--profile', f.profile]);
    const outside = join(f.root, 'untouched');
    await writeFile(outside, 'preserve original material');
    await symlink(outside, f.profile + '.download-proxy.json');
    const result = await f.run('update', { HTTP_PROXY: f.proxyAddress });
    expect(JSON.parse(result.stdout)).toEqual({ version: '1.2.3', unchanged: true });
    expect(result.stderr).toContain('本次操作已完成，但无法记住下载代理');
    expect(result.stderr).not.toContain(f.proxyAddress);
    expect(await readFile(outside, 'utf8')).toBe('preserve original material');
  } finally {
    await f.close();
  }
});

it('serve reuses the saved download proxy before fetch and still bypasses local health', async () => {
  const f = await fixture(),
    probe = createProbe();
  let serving: ReturnType<typeof f.run> | undefined;
  try {
    await f.run('migrate', { HTTP_PROXY: f.proxyAddress }, ['--profile', f.profile]);
    await new Promise<void>((yes) => probe.listen(0, '127.0.0.1', yes));
    const port = (probe.address() as any).port;
    await new Promise<void>((yes) => probe.close(() => yes()));
    const profile = JSON.parse(await readFile(f.profile, 'utf8'));
    profile.port = port;
    profile.origin = 'http://127.0.0.1:' + port;
    await writeFile(f.profile, JSON.stringify(profile));
    serving = f.run('serve', {}, ['--profile', f.profile]);
    void serving.catch(() => {});
    await expect
      .poll(
        async () => {
          try {
            return (await readFile('/proc/' + serving!.child.pid + '/cmdline', 'utf8'))
              .split('\0')
              .includes('--use-env-proxy');
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const env = await readFile('/proc/' + serving.child.pid + '/environ', 'utf8');
    expect(env.split('\0')).toContain('HTTP_PROXY=' + f.proxyAddress);
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(profile.origin + '/healthz')).status;
          } catch {
            return 0;
          }
        },
        { timeout: 5000 },
      )
      .toBe(200);
    expect(f.counts().proxyRequests).toBe(0);
  } finally {
    serving?.child.kill('SIGTERM');
    await serving?.catch(() => {});
    probe.close();
    await f.close();
  }
}, 20000);
