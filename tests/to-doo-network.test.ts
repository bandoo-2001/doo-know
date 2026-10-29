import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createToDooNetwork, isPublicAddress } from '../packages/core/to-doo/network.js';

describe('To Doo controlled network', () => {
  it('rejects private, mapped, metadata and reserved destinations', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.2',
      '169.254.169.254',
      '100.64.0.1',
      '192.168.2.3',
      '198.18.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::2',
      '2001:db8::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects insecure URLs and mixed public/private DNS before sending', async () => {
    let sent = 0;
    const network = createToDooNetwork({
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      send: async () => {
        sent++;
        return { status: 200, headers: {}, body: Buffer.alloc(0) };
      },
    });
    for (const url of [
      'http://example.com/a',
      'https://example.com:8443/a',
      'https://u:p@example.com/a',
      'https://example.com/a',
    ]) {
      await expect(network.request({ url })).rejects.toThrow(
        /network|destination|HTTPS|credentials|port|address/i,
      );
    }
    expect(sent).toBe(0);
  });
  it('pins a resolved address and strips credentials on cross-origin redirects', async () => {
    const seen: { host: string; address: string; authorization?: string }[] = [];
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async (target, input) => {
        seen.push({
          host: target.url.hostname,
          address: target.address,
          authorization: input.headers.authorization,
        });
        return target.url.hostname === 'first.example'
          ? {
              status: 302,
              headers: { location: 'https://second.example/feed' } as Record<string, string>,
              body: Buffer.alloc(0),
            }
          : { status: 200, headers: {} as Record<string, string>, body: Buffer.from('calendar') };
      },
    });
    expect(
      (
        await network.request({
          url: 'https://first.example/feed',
          headers: { authorization: 'Bearer secret' },
        })
      ).body.toString(),
    ).toBe('calendar');
    expect(seen).toEqual([
      { host: 'first.example', address: '8.8.8.8', authorization: 'Bearer secret' },
      { host: 'second.example', address: '8.8.8.8', authorization: undefined },
    ]);
  });
  it('revalidates redirected hosts and bounds decompression', async () => {
    const network = createToDooNetwork({
      resolve: async (host) => [
        { address: host === 'bad.example' ? '10.0.0.1' : '8.8.8.8', family: 4 },
      ],
      send: async () => ({
        status: 302,
        headers: { location: 'https://bad.example/' },
        body: Buffer.alloc(0),
      }),
    });
    await expect(network.request({ url: 'https://public.example/' })).rejects.toThrow(
      /address|destination/i,
    );
    const compressed = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => ({
        status: 200,
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync('x'.repeat(4096)),
      }),
    });
    await expect(
      compressed.request({ url: 'https://public.example/', maxBytes: 512 }),
    ).rejects.toThrow(/budget|large|limit/i);
  });
  it('validates endpoints without sending and bounds stalled DNS lookups', async () => {
    let sent = 0;
    const network = createToDooNetwork({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      send: async () => {
        sent++;
        return { status: 200, headers: {}, body: Buffer.alloc(0) };
      },
    });
    await expect(network.validate('https://private.example/')).rejects.toThrow(/address/i);
    expect(sent).toBe(0);
    const stalled = createToDooNetwork({ resolve: () => new Promise(() => {}) });
    await expect(
      stalled.request({ url: 'https://stalled.example/', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/i);
  });
  it('rejects invalid HTTP header names and values before creating a request', async () => {
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
    });
    await expect(
      network.request({ url: 'https://example.com/', headers: { 'bad:name': 'value' } }),
    ).rejects.toThrow(/header/i);
    await expect(
      network.request({ url: 'https://example.com/', headers: { authorization: '秘密' } }),
    ).rejects.toThrow(/header/i);
  });
});
