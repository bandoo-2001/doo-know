import { expect, it } from 'vitest';
import { installSummary } from '../scripts/install-summary.js';

it('explains loopback-only listening without advertising unconfigured addresses', () => {
  const output = installSummary({ origin: 'http://127.0.0.1:5173' });
  expect(output).toContain('http://127.0.0.1:5173');
  expect(output).toContain('仅允许本机');
  expect(output).not.toContain('192.168.1.233');
});
it('lists only configured login origins with reachability guidance', () => {
  const output = installSummary({
    host: '0.0.0.0',
    port: 6000,
    origin: 'http://192.168.1.233:6000',
    allowedOrigins: [
      'http://192.168.1.233:6000',
      'http://100.93.35.65:6000',
      'http://127.0.0.1:6000',
    ],
  });
  expect(output).toContain('http://192.168.1.233:6000');
  expect(output).toContain('http://100.93.35.65:6000');
  expect(output).toContain('均已允许登录');
  expect(output).toContain('防火墙');
  expect(output.match(/http:\/\/192\.168\.1\.233:6000/g)).toHaveLength(1);
  expect(output).not.toContain('登录及写入请求需使用配置地址');
});
it('formats IPv6 listener and distinguishes foreground mode', () => {
  const output = installSummary({
    host: '::',
    port: 6000,
    origin: 'http://[2001:db8::1]:6000',
    serviceManaged: false,
  });
  expect(output).toContain('http://[2001:db8::1]:6000');
  expect(output).toContain('[::]:6000');
  expect(output).toContain('系统双栈');
  expect(output).toContain('dooknow serve');
  expect(output).not.toContain('start / stop');
});
