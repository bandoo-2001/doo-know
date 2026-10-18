import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';

it.each([false, true])(
  'loads fallback environment before the first fetch even with proxy support already enabled: %s',
  async (alreadyEnabled) => {
    const module = pathToFileURL(resolve('scripts/environment-proxy.ts')).href;
    const code = `import { withEnvironmentProxy } from ${JSON.stringify(module)};
    await withEnvironmentProxy(async () => {
      console.log(JSON.stringify({ proxy:process.env.HTTPS_PROXY, noProxy:process.env.NO_PROXY, flags:process.execArgv.filter(v=>v==='--use-env-proxy').length, pid:process.pid }));
    }, async () => ({ HTTPS_PROXY:'http://127.0.0.1:7890', NO_PROXY:'localhost' }));`;
    const execution = promisify(execFile)(
      process.execPath,
      [
        ...(alreadyEnabled ? ['--use-env-proxy'] : []),
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        code,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_USE_ENV_PROXY: '',
          HTTPS_PROXY: '',
          HTTP_PROXY: '',
          https_proxy: '',
          http_proxy: '',
          NO_PROXY: '',
          no_proxy: '',
        },
        timeout: 10000,
      },
    );
    const { stdout } = await execution;
    expect(JSON.parse(stdout)).toEqual({
      proxy: 'http://127.0.0.1:7890',
      noProxy: 'localhost',
      flags: 1,
      pid: execution.child.pid,
    });
  },
);

it('bypasses real local health requests when a shell provides only a download proxy', async () => {
  let proxyRequests = 0;
  const target = createServer((_, response) => response.end('local health ready'));
  const proxy = createServer((_, response) => {
    proxyRequests++;
    response.writeHead(502).end();
  });
  proxy.on('connect', (_, socket) => {
    proxyRequests++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((yes) => target.listen(0, '127.0.0.1', yes));
  await new Promise<void>((yes) => proxy.listen(0, '127.0.0.1', yes));
  try {
    const module = pathToFileURL(resolve('scripts/environment-proxy.ts')).href;
    const code = `import { withEnvironmentProxy } from ${JSON.stringify(module)};
      await withEnvironmentProxy(async () => console.log(JSON.stringify({ body:await (await fetch('http://127.0.0.1:${(target.address() as any).port}/healthz')).text(), noProxy:process.env.NO_PROXY })));`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_USE_ENV_PROXY: '',
      HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}`,
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
    };
    delete env.NO_PROXY;
    delete env.no_proxy;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      { env, timeout: 10000 },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      body: 'local health ready',
      noProxy: 'localhost,127.0.0.1,::1',
    });
    expect(proxyRequests).toBe(0);
  } finally {
    proxy.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((yes) => proxy.close(() => yes())),
      new Promise<void>((yes) => target.close(() => yes())),
    ]);
  }
});

it.each([false, true, 'existing-proxy' as const])(
  'initializes the real fetch dispatcher with the remembered proxy: startup flag %s',
  async (alreadyEnabled) => {
    let requests = 0;
    const target = createServer((_, response) => response.end('remembered proxy works'));
    const proxy = createServer();
    proxy.on('connect', (_, socket, head) => {
      requests++;
      const upstream = connect((target.address() as any).port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    });
    await new Promise<void>((yes) => target.listen(0, '127.0.0.1', yes));
    await new Promise<void>((yes) => proxy.listen(0, '127.0.0.1', yes));
    try {
      const module = pathToFileURL(resolve('scripts/environment-proxy.ts')).href;
      const code = `import { withEnvironmentProxy } from ${JSON.stringify(module)};
      await withEnvironmentProxy(async () => console.log(JSON.stringify({ body:await (await fetch('http://saved-proxy-fixture.invalid/')).text(), lowercase:process.env.http_proxy })),
        async () => ({ HTTP_PROXY:'http://127.0.0.1:${(proxy.address() as any).port}' }));`;
      const result = await promisify(execFile)(
        process.execPath,
        [
          ...(alreadyEnabled ? ['--use-env-proxy'] : []),
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          code,
        ],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            NODE_USE_ENV_PROXY: '',
            HTTPS_PROXY: '',
            HTTP_PROXY:
              alreadyEnabled === 'existing-proxy'
                ? 'http://127.0.0.1:' + (proxy.address() as any).port
                : '',
            https_proxy: '',
            http_proxy: '',
            NO_PROXY: '',
            no_proxy: '',
            ALL_PROXY: '',
            all_proxy: '',
          },
          timeout: 10000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({ body: 'remembered proxy works' });
      expect(requests).toBe(1);
    } finally {
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((yes) => proxy.close(() => yes())),
        new Promise<void>((yes) => target.close(() => yes())),
      ]);
    }
  },
);
