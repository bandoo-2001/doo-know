import { expect, it } from 'vitest';
import { installNetwork } from '../scripts/install-network.js';
import type { networkInterfaces } from 'node:os';
const interfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.93.35.65', family: 'IPv4', internal: false }],
  wifi0: [
    { address: '192.168.1.233', family: 'IPv4', internal: false },
    { address: '2001:db8::1', family: 'IPv6', internal: false },
    { address: 'fe80::1234', family: 'IPv6', internal: false },
  ],
} as unknown as ReturnType<typeof networkInterfaces>;
it('prefers the LAN URL and allows exact interface addresses including Tailscale and loopback', () => {
  const config = installNetwork({}, interfaces);
  expect(config).toMatchObject({
    host: '0.0.0.0',
    port: 5173,
    origin: 'http://192.168.1.233:5173',
  });
  expect(config.allowedOrigins).toEqual(
    expect.arrayContaining([
      'http://192.168.1.233:5173',
      'http://100.93.35.65:5173',
      'http://172.17.0.1:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]),
  );
  expect(config.allowedOrigins).not.toContain('http://0.0.0.0:5173');
  expect(config.allowedOrigins).not.toContain('http://[2001:db8::1]:5173');
  expect(new Set(config.allowedOrigins).size).toBe(config.allowedOrigins.length);
});
it('restricts an explicit loopback listener and preserves explicit origin and port', () => {
  expect(installNetwork({ host: '127.0.0.1', port: '6000' }, interfaces)).toEqual({
    host: '127.0.0.1',
    port: 6000,
    origin: 'http://127.0.0.1:6000',
    allowedOrigins: ['http://127.0.0.1:6000'],
    autoAllowedOrigins: true,
  });
  expect(installNetwork({ origin: 'https://know.example.com' }, interfaces).allowedOrigins).toEqual(
    ['https://know.example.com'],
  );
});
it('formats IPv6, excludes link-local aliases and falls back to loopback without interfaces', () => {
  const config = installNetwork({ host: '::' }, interfaces);
  expect(config.origin).toBe('http://[2001:db8::1]:5173');
  expect(config.allowedOrigins).toEqual([
    'http://[2001:db8::1]:5173',
    'http://[::1]:5173',
    'http://localhost:5173',
  ]);
  expect(installNetwork({}, {}).allowedOrigins).toEqual([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
});
