import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDatabase } from '../packages/core/db.js';
import { invalidateRemoteAuth } from '../packages/core/auth/remote-auth.js';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture.js';

const deviceApi = '/api/to-doo/watch/v1';
const ownerApi = '/api/to-doo/watch/devices';
let f: Fixture;
let owner: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeAll(async () => {
  f = await createFixture();
  owner = await loginFixtureOwner(f);
});
afterAll(async () => f?.close());

it('limits anonymous pairing requests by address', async () => {
  const issue = () =>
    f.app.inject({
      method: 'POST',
      url: deviceApi + '/pair/start',
      remoteAddress: '192.0.2.5',
      payload: {},
    });
  for (let i = 0; i < 8; i++) expect((await issue()).statusCode).toBe(200);
  expect((await issue()).statusCode).toBe(429);
});

async function start() {
  const res = await f.app.inject({ method: 'POST', url: deviceApi + '/pair/start', payload: {} });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.json() as { userCode: string; deviceCode: string };
}
const approve = (userCode: string, headers = owner) =>
  f.app.inject({
    method: 'POST',
    url: ownerApi + '/approve',
    headers,
    payload: { userCode },
  });
const claim = (deviceCode: string) =>
  f.app.inject({
    method: 'POST',
    url: deviceApi + '/pair/claim',
    payload: { deviceCode },
  });

it('requires owner approval, exchanges the claim once and revokes only the selected device', async () => {
  const { userCode, deviceCode } = await start();
  expect(userCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  expect((await claim(deviceCode)).json()).toEqual({ status: 'pending' });
  expect(
    (await f.app.inject({ method: 'POST', url: ownerApi + '/approve', payload: { userCode } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: ownerApi + '/approve',
        headers: { cookie: owner.cookie, origin: owner.origin },
        payload: { userCode },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await approve(userCode, { ...owner, origin: 'https://another.example' })).statusCode,
  ).toBe(403);
  const approved = await approve(userCode.slice(0, 4).toLowerCase() + '-' + userCode.slice(4));
  expect(approved.statusCode).toBe(200);
  const { id } = approved.json();
  expect((await approve(userCode)).statusCode).toBe(404);
  const claims = await Promise.all([claim(deviceCode), claim(deviceCode)]);
  expect(claims.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  expect(claims.every((r) => r.headers['cache-control'] === 'no-store')).toBe(true);
  const { token } = claims.find((r) => r.statusCode === 200)!.json();
  const headers = { authorization: 'Bearer ' + token };
  expect((await f.app.inject({ url: deviceApi + '/state', headers })).statusCode).toBe(200);
  const forbidden = await f.app.inject({
    method: 'POST',
    url: deviceApi + '/command',
    headers,
    payload: { requestId: 'watch-scope', action: 'create_task', payload: { title: 'Sample' } },
  });
  expect(forbidden.statusCode).toBe(400);
  for (const url of [ownerApi, '/api/to-doo/state', '/api/tree']) {
    expect((await f.app.inject({ url, headers })).statusCode).toBe(401);
  }
  const devices = await f.app.inject({ url: ownerApi, headers: owner });
  expect(devices.headers['cache-control']).toBe('no-store');
  expect(devices.json()).toEqual({ devices: [{ id, createdAt: expect.any(String) }] });
  expect(
    (await f.app.inject({ method: 'DELETE', url: ownerApi + '/' + id, headers: owner })).statusCode,
  ).toBe(200);
  expect((await f.app.inject({ url: deviceApi + '/state', headers })).statusCode).toBe(401);
});

it('refuses cookies as device credentials and rejects missing, expired or invalidated device codes', async () => {
  for (const headers of [{}, owner]) {
    expect((await f.app.inject({ url: deviceApi + '/state', headers })).statusCode).toBe(401);
    expect(
      (await f.app.inject({ method: 'POST', url: deviceApi + '/command', headers, payload: {} }))
        .statusCode,
    ).toBe(401);
  }
  const expired = await start();
  const db = openDatabase(f.dataRoot);
  try {
    db.prepare('UPDATE to_doo_watch_devices SET expires_at=0 WHERE user_code=?').run(
      expired.userCode,
    );
    expect((await approve(expired.userCode)).statusCode).toBe(404);
    expect((await claim(expired.deviceCode)).statusCode).toBe(410);
    const stale = await start();
    const staleId = (await approve(stale.userCode)).json().id;
    db.prepare('UPDATE to_doo_watch_devices SET root_identity=? WHERE id=?').run(
      'different-library',
      staleId,
    );
    expect((await claim(stale.deviceCode)).statusCode).toBe(410);
    const pair = await start();
    const id = (await approve(pair.userCode)).json().id;
    const { token } = (await claim(pair.deviceCode)).json();
    const headers = { authorization: 'Bearer ' + token };
    const stored = db
      .prepare('SELECT token_hash, claim_hash, user_code FROM to_doo_watch_devices WHERE id=?')
      .get(id) as Record<string, unknown>;
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.claim_hash).toBeNull();
    expect(stored.user_code).toBeNull();
    db.prepare('UPDATE to_doo_watch_devices SET root_identity=? WHERE id=?').run(
      'different-library',
      id,
    );
    expect((await f.app.inject({ url: deviceApi + '/state', headers })).statusCode).toBe(401);
    db.prepare(
      "UPDATE to_doo_watch_devices SET root_identity=(SELECT value FROM index_meta WHERE key='root_identity') WHERE id=?",
    ).run(id);
    db.transaction(() => invalidateRemoteAuth(db)).immediate();
    expect((await f.app.inject({ url: deviceApi + '/state', headers })).statusCode).toBe(401);
  } finally {
    db.close();
  }
});
