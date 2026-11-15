import { expect, it } from 'vitest';
import { createFixture, origin, testPassword } from './support/fixture.js';
import { initializeOwner } from '../apps/server/auth.js';
import { normalizeAllowedOrigins } from '../packages/core/auth/allowed-origins.js';

it('logs in, saves and logs out through LAN and Tailscale while retaining CSRF and origin checks', async () => {
  const aliases = ['http://192.168.1.233:5173', 'http://100.93.35.65:5173'];
  const f = await createFixture({ allowedOrigins: aliases });
  try {
    await initializeOwner(f.config, 'owner', testPassword);
    for (const [index, address] of aliases.entries()) {
      const login = await f.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin: address, host: new URL(address).host },
        payload: { username: 'owner', password: testPassword },
      });
      expect(login.statusCode, login.body).toBe(200);
      let cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const csrf = await f.app.inject({ url: '/api/security/csrf', headers: { cookie } });
      cookie += '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const headers = { cookie, origin: address, 'x-csrf-token': csrf.json().token };
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/folders',
            headers: { cookie, origin: address },
            payload: { parent: '00-Inbox', name: `missing-csrf-${index}` },
          })
        ).statusCode,
      ).toBe(403);
      const write = await f.app.inject({
        method: 'POST',
        url: '/api/folders',
        headers,
        payload: { parent: '00-Inbox', name: `alias-${index}` },
      });
      expect(write.statusCode, write.body).toBe(201);
      for (const foreign of [
        'http://evil.invalid',
        'http://192.168.1.234:5173',
        'http://100.93.35.65:6000',
      ]) {
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: '/api/folders',
              headers: { ...headers, origin: foreign },
              payload: { parent: '00-Inbox', name: 'forbidden' },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers, payload: {} }))
          .statusCode,
      ).toBe(200);
      expect((await f.app.inject({ url: '/api/tree', headers: { cookie } })).statusCode).toBe(401);
    }
    for (const address of ['http://evil.invalid', 'http://100.93.35.65:6000', undefined]) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/username',
            headers: address ? { origin: address } : {},
            payload: { username: 'owner', password: testPassword },
          })
        ).statusCode,
      ).toBe(403);
    }
  } finally {
    await f.close();
  }
});

it('normalizes exact allowlists and rejects wildcards, credentials and paths', () => {
  expect(normalizeAllowedOrigins(origin, [origin])).toEqual([origin]);
  for (const invalid of [
    ['*'],
    ['http://*.example.com'],
    ['http://user:pass@example.com'],
    ['http://example.com/path'],
    ['null'],
    'http://example.com',
  ]) {
    expect(() => normalizeAllowedOrigins(origin, invalid)).toThrow();
  }
});
