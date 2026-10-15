import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('protects plugin management and rejects arbitrary catalog identifiers', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    expect((await f.app.inject({ url: '/api/platform/plugins' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const list = await f.app.inject({ url: '/api/platform/plugins', headers });
    expect(list.statusCode).toBe(200); expect(list.json().catalog).toEqual([]);
    expect((await f.app.inject({ method: 'POST', url: '/api/platform/plugins/unknown/install', headers, payload: {} })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: '/api/platform/plugins/unknown/install', headers: { ...headers, origin: 'https://untrusted.invalid' }, payload: {} })).statusCode).toBe(403);
  } finally { await f.close(); }
});
