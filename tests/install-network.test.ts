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
  ],
} as unknown as ReturnType<typeof networkInterfaces>;
it('defaults to all IPv4 interfaces with a LAN login URL ahead of VPN and container networks', () => {
  expect(installNetwork({}, interfaces)).toEqual({
    host: '0.0.0.0',
    port: 5173,
    origin: 'http://192.168.1.233:5173',
  });
});
it('respects explicit host, port and origin', () => {
  expect(installNetwork({ host: '127.0.0.1', port: '6000' }, interfaces)).toEqual({
    host: '127.0.0.1',
    port: 6000,
    origin: 'http://127.0.0.1:6000',
  });
  expect(installNetwork({ origin: 'https://know.example.com' }, interfaces).origin).toBe(
    'https://know.example.com',
  );
});
it('supports IPv6 and falls back to loopback when no external interface exists', () => {
  expect(installNetwork({ host: '::' }, interfaces).origin).toBe('http://[2001:db8::1]:5173');
  expect(installNetwork({}, {}).origin).toBe('http://127.0.0.1:5173');
});
