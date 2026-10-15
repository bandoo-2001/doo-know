import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('serves fixed OAuth discovery and public client registration while protecting cookie consent', async () => {
  const f = await createFixture();
  try {
    const metadata = await f.app.inject({ url: '/.well-known/oauth-authorization-server/api/auth' });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().issuer).toBe(f.config.origin + '/api/auth');
    const resource = await f.app.inject({ url: '/.well-known/oauth-protected-resource/mcp' });
    expect(resource.statusCode).toBe(200); expect(resource.json().resource).toBe(f.config.origin + '/mcp');
    const client = await f.app.inject({ method: 'POST', url: '/api/auth/oauth2/register',
      payload: { client_name: 'fixture', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', scope: 'knowledge:read offline_access' } });
    expect(client.statusCode).toBe(201);
    const headers = await loginFixtureOwner(f);
    expect((await f.app.inject({ method: 'POST', url: '/api/platform/mcp/oauth/consent',
      headers: { cookie: headers.cookie, origin: f.config.origin }, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/auth/sign-up/email', payload: {} })).statusCode).toBe(404);
  } finally { await f.close(); }
});
