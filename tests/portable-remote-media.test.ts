import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { stageRemoteResource, isPublicAddress } from '../packages/core/portable-delivery/remote';
it.each([
  '127.0.0.1',
  '10.1.2.3',
  '169.254.169.254',
  '192.168.0.1',
  '0.0.0.0',
  '::1',
  '::ffff:127.0.0.1',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
])('denies private/special %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
it('streams real HTTP bytes with DNS pinning, bounded redirects and no credentials, rejects rebinding and deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-remote-')),
    requests: any[] = [];
  const bytes = await readFile(join(import.meta.dirname, 'fixtures/media/sample.wav'));
  const server = createServer((req, res) => {
    requests.push(req.headers);
    if (req.url === '/slow') return;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/media' });
      res.end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  let resolutions = 0;
  const deps = {
    resolve: async () => {
      resolutions++;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    request: (url: URL, options: any, cb: any) => {
      expect(options.headers.Cookie).toBeUndefined();
      options.lookup(url.hostname, {}, (e: any, ip: any) => expect(ip).toBe('93.184.216.34'));
      return request(
        `http://127.0.0.1:${port}${url.pathname}`,
        { ...options, lookup: undefined },
        cb,
      );
    },
  };
  try {
    const result = await stageRemoteResource('https://fixture.test/redirect', {
      destination: join(root, 'out'),
      ...deps,
    });
    expect(result.mime).toBe('audio/wav');
    expect(await readFile(join(root, 'out'))).toEqual(bytes);
    expect(resolutions).toBe(2);
    expect(requests.every((h) => !h.cookie && !h.authorization)).toBe(true);
    await expect(
      stageRemoteResource('https://fixture.test/loop', {
        destination: join(root, 'loop'),
        ...deps,
      }),
    ).rejects.toThrow(/redirect/i);
    let hops = 0;
    await expect(
      stageRemoteResource('https://fixture.test/redirect', {
        destination: join(root, 'rebind'),
        ...deps,
        resolve: async () => [{ address: ++hops === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow(/address/i);
    await expect(
      stageRemoteResource('https://fixture.test/slow', {
        destination: join(root, 'slow'),
        ...deps,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timeout/i);
    await expect(
      stageRemoteResource('http://user:password@fixture.test/media', {
        destination: join(root, 'creds'),
        ...deps,
      }),
    ).rejects.toThrow(/credentials/i);
    await expect(
      stageRemoteResource('https://fixture.test/media', {
        destination: join(root, 'quota'),
        ...deps,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/quota/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
