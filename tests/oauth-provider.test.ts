import { it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { approveOAuthConsent, verifyMcpBearer, revokeOAuthClient } from '../server/platform/oauth.js';
it('runs real DCR, PKCE, owner consent, signed JWT, refresh and immediate grant revocation', async () => {
  const f = await createFixture(); const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f); const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    const auth = await createAuth(f.config, db);
    const registered = await (auth.api as any).registerOAuthClient({ body: {
      client_name: 'DooKnow OAuth fixture', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: 'knowledge:read offline_access',
    } });
    const clientId = registered.client_id;
    expect(typeof clientId).toBe('string');
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://client.example/callback',
      response_type: 'code', scope: 'knowledge:read offline_access', state: 'fixture-state',
      resource: f.config.origin + '/mcp', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const authorize = await auth.handler(new Request(f.config.origin + '/api/auth/oauth2/authorize?' + query,
      { headers: { cookie: headers.cookie, accept: 'text/html' } }));
    expect(authorize.status).toBe(302);
    const consent = new URL(authorize.headers.get('location')!, f.config.origin);
    expect(consent.pathname).toBe('/oauth/consent');
    const oauthQuery = consent.searchParams.get('oauth_query') || consent.search.slice(1);
    expect(oauthQuery).toBeTruthy();
    const result = await approveOAuthConsent(auth, f.config, db, new Headers({ cookie: headers.cookie }),
      { accept: true, oauth_query: oauthQuery, scopes: ['knowledge:read', 'offline_access'], allowedPrefixes: ['00-Inbox'] });
    const target = new URL(result.url, f.config.origin);
    expect(target.origin).toBe('https://client.example');
    const code = target.searchParams.get('code')!;
    expect(code).toBeTruthy();
    const exchange = async (body: Record<string, string>) => auth.handler(new Request(f.config.origin + '/api/auth/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }));
    const tokenResponse = await exchange({ grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource: f.config.origin + '/mcp' });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json();
    const principal = await verifyMcpBearer(auth, f.config, db, 'Bearer ' + token.access_token);
    expect(principal.id).toBe(owner); expect(principal.scopes).toContain('knowledge:read');
    expect(principal.allowedPrefixes).toEqual(['00-Inbox']);
    expect(typeof token.refresh_token).toBe('string');
    const refresh = await exchange({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refresh_token, resource: f.config.origin + '/mcp' });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json();
    await revokeOAuthClient(auth, db, owner, clientId);
    await expect(verifyMcpBearer(auth, f.config, db, 'Bearer ' + refreshed.access_token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const revoked = await exchange({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshed.refresh_token, resource: f.config.origin + '/mcp' });
    expect(revoked.status).toBe(400);
  } finally { db.close(); await f.close(); }
});
