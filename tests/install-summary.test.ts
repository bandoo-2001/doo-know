import { expect, it } from 'vitest';
import { installSummary } from '../scripts/install-summary.js';

const interfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4' }],
  eth0: [
    { address: '192.168.1.233', family: 'IPv4' },
    { address: '2001:db8::1', family: 'IPv6' },
  ],
} as unknown as ReturnType<typeof import('node:os').networkInterfaces>;

it('does not advertise LAN addresses for loopback-only listeners', () => {
  const output = installSummary({ origin: 'http://127.0.0.1:5173' }, interfaces);
  expect(output).toContain('http://127.0.0.1:5173');
  expect(output).toContain('仅允许本机');
  expect(output).not.toContain('192.168.1.233');
});
it('lists IPv4 interfaces for IPv4 wildcard with origin and reachability guidance', () => {
  const output = installSummary(
    { host: '0.0.0.0', port: 6000, origin: 'https://know.example.com' },
    interfaces,
  );
  expect(output).toContain('http://192.168.1.233:6000');
  expect(output).toContain('https://know.example.com');
  expect(output).toContain('防火墙');
  expect(output).toContain('访问来源');
  expect(output).not.toContain('http://[2001:db8::1]');
});
it('formats IPv6 URLs and distinguishes foreground mode', () => {
  const output = installSummary(
    { host: '::', port: 6000, origin: 'http://[::1]:6000', serviceManaged: false },
    interfaces,
  );
  expect(output).toContain('http://[2001:db8::1]:6000');
  expect(output).toContain('系统双栈');
  expect(output).toContain('dooknow serve');
  expect(output).not.toContain('start / stop');
});
