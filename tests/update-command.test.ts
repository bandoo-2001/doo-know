import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

it('enables environment proxy without flags, honors NO_PROXY and preserves command arguments', async () => {
  let proxyRequests = 0;
  const target = createServer((_, res) => res.end('direct'));
  const proxy = createServer((_, res) => {
    proxyRequests++;
    res.end('proxied');
  });
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
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const module = pathToFileURL(resolve('scripts/environment-proxy.ts')).href;
    const code = `import { withEnvironmentProxy } from ${JSON.stringify(module)};
      await withEnvironmentProxy(async () => {
        console.log(await (await fetch('http://proxy-test.invalid/')).text());
        console.log(await (await fetch('http://127.0.0.1:${(target.address() as any).port}/')).text());
        console.log(process.argv.slice(1).join('|'));
        console.log('PID:' + process.pid);
      });`;
    const execution = promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        code,
        'update',
        '--version',
        '1.2.0-rc.1',
      ],
      {
        timeout: 15000,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_USE_ENV_PROXY: '',
          HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}`,
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          ALL_PROXY: '',
          all_proxy: '',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '',
        },
      },
    );
    const { stdout } = await execution;
    expect(stdout).toContain('PID:' + execution.child.pid);
    expect(stdout).toMatch(/(?:direct|proxied)\ndirect\nupdate\|--version\|1.2.0-rc.1/);
    expect(proxyRequests).toBe(1);
  } finally {
    proxy.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => proxy.close(() => r())),
      new Promise<void>((r) => target.close(() => r())),
    ]);
  }
}, 20000);

it('explains network, proxy, HTTP and release errors without printing sensitive causes', async () => {
  const { managementError } = await import('../scripts/management-error.js');
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']) {
    const message = managementError(
      new Error('GITHUB_DOWNLOAD_FAILED', {
        cause: Object.assign(new Error('http://user:secret@proxy.invalid'), { code }),
      }),
    );
    expect(message).toMatch(/网络|代理|超时|域名/);
    expect(message).not.toMatch(/secret|proxy.invalid|GITHUB_DOWNLOAD_FAILED/);
  }
  expect(managementError(new Error('GITHUB_RELEASE_OR_ASSET_NOT_FOUND'))).toMatch(/版本|安装包/);
  expect(managementError(new Error('GITHUB_RATE_LIMITED'))).toMatch(/频繁|限流/);
  expect(managementError(new Error('GITHUB_NO_PUBLISHED_RELEASE'))).toMatch(/尚无|没有/);
  expect(managementError(new Error('GITHUB_ACCESS_DENIED'))).toMatch(/拒绝|权限/);
  expect(managementError(new Error('已存在另一管理操作'))).toBe('已存在另一管理操作');
});

it('explains the real nested fetch failure after the GitHub downloader wraps it', async () => {
  const { artifactFetch } = await import('../apps/server/platform/distribution.js');
  const { managementError } = await import('../scripts/management-error.js');
  const unavailable = createServer();
  await new Promise<void>((r) => unavailable.listen(0, '127.0.0.1', r));
  const port = (unavailable.address() as any).port;
  await new Promise<void>((r) => unavailable.close(() => r()));
  const realFetch = globalThis.fetch;
  const intercepted = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      realFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }),
    );
  let failure: any;
  try {
    await artifactFetch(
      {},
      new URL('https://github.com/fixture/repository/releases/download/v1.0.0/release.json'),
    );
  } catch (e) {
    failure = e;
  } finally {
    intercepted.mockRestore();
  }
  expect(failure?.message).toBe('GITHUB_DOWNLOAD_FAILED');
  expect(failure?.cause?.cause?.code).toBe('ECONNREFUSED');
  expect(managementError(failure)).toMatch(/无法连接下载服务器或代理/);
});

it('recognizes nested TLS and aggregate DNS failures without exposing their messages', async () => {
  const { managementError } = await import('../scripts/management-error.js');
  const certificate = new Error('GITHUB_DOWNLOAD_FAILED', {
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('https://user:fixture-secret@private.invalid/'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    }),
  });
  expect(managementError(certificate)).toMatch(/证书.*校验/);
  const dns = new Error('GITHUB_DOWNLOAD_FAILED', {
    cause: new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('fixture-secret'), { code: 'EAI_AGAIN' }),
      ]),
    }),
  });
  expect(managementError(dns)).toMatch(/无法解析.*域名/);
  expect(managementError(certificate) + managementError(dns)).not.toMatch(
    /fixture-secret|private\.invalid|GITHUB_DOWNLOAD_FAILED/,
  );
  const cyclic = new Error('GITHUB_DOWNLOAD_FAILED') as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  expect(managementError(cyclic)).toMatch(/下载失败/);
});

it('rejects malformed proxy configuration with a readable message without exposing its value', async () => {
  const module = pathToFileURL(resolve('scripts/environment-proxy.ts')).href;
  const code = `import { withEnvironmentProxy } from ${JSON.stringify(module)};
    withEnvironmentProxy(async () => console.log('unexpected')).catch(e => { console.error(e.message); process.exitCode = 1; });`;
  try {
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          HTTPS_PROXY: 'http://fixture-secret@bad host:abc',
          https_proxy: '',
          HTTP_PROXY: '',
          http_proxy: '',
        },
        timeout: 5000,
      },
    );
    throw Error('expected invalid proxy to fail');
  } catch (e: any) {
    expect(e.stderr).toMatch(/代理.*地址|代理.*格式/);
    expect(e.stderr).not.toMatch(/fixture-secret|bad host|ERR_INVALID_URL/);
  }
});

it('explains an interrupted real download body instead of displaying terminated', async () => {
  const { artifactFetch } = await import('../apps/server/platform/distribution.js');
  const { managementError } = await import('../scripts/management-error.js');
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-length': '99999' });
    res.write('partial');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await artifactFetch(
      {},
      new URL(`http://127.0.0.1:${(server.address() as any).port}/`),
    );
    let failure: unknown;
    try {
      await response.text();
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(managementError(failure)).toMatch(/下载.*中断|网络|代理/);
    expect(managementError(failure)).not.toContain('terminated');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
