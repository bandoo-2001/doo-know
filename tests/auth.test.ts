import { describe, it, expect } from 'vitest';
import { createFixture, loginFixtureOwner, origin, testPassword } from './support/fixture.js';
describe('single owner authentication', () => {
  it('rejects anonymous access to every private surface', async () => {
    const f = await createFixture();
    try {
      for (const url of [
        '/api/tree',
        '/api/notes',
        '/api/search?q=x',
        '/api/trash',
        '/api/notes/unknown/revisions',
        '/api/assets/unknown',
      ])
        expect((await f.app.inject({ url })).statusCode).toBe(401);
    } finally {
      await f.close();
    }
  });
  it('logs in and revokes the old session on logout', async () => {
    const f = await createFixture();
    try {
      const h = await loginFixtureOwner(f);
      expect((await f.app.inject({ url: '/api/tree', headers: h })).statusCode).toBe(200);
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: h, payload: {} }))
          .statusCode,
      ).toBe(200);
      expect((await f.app.inject({ url: '/api/tree', headers: h })).statusCode).toBe(401);
    } finally {
      await f.close();
    }
  });
  it('blocks sign up, wrong passwords and foreign origin', async () => {
    const f = await createFixture();
    try {
      await loginFixtureOwner(f);
      const bad = await f.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'owner', password: 'wrong-password' },
      });
      expect(bad.statusCode).toBe(401);
      for (const url of ['/api/auth/sign-up/email', '/api/auth/sign-in/email'])
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url,
              headers: { origin },
              payload: { email: 'other@example.invalid', password: testPassword, name: 'other' },
            })
          ).statusCode,
        ).toBe(404);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/username',
            headers: { origin: 'http://evil.invalid' },
            payload: { username: 'owner', password: testPassword },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
  it('requires both origin and csrf for writes', async () => {
    const f = await createFixture();
    try {
      const h = await loginFixtureOwner(f);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/folders',
            headers: { cookie: h.cookie, origin },
            payload: { parent: '00-Inbox', name: 'test' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
});

it('local password reset revokes sessions and prevents a second owner', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const { resetOwnerPassword, initializeOwner } = await import('../apps/server/auth.js');
    await expect(initializeOwner(f.config, 'second', testPassword)).rejects.toThrow('账号已存在');
    await resetOwnerPassword(f.config, 'New-Fixture-Password-123');
    expect((await f.app.inject({ url: '/api/tree', headers: h })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin },
          payload: { username: 'owner', password: testPassword },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin },
          payload: { username: 'owner', password: 'New-Fixture-Password-123' },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await f.close();
  }
});
