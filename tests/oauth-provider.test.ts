import { it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { createAuth } from '../apps/server/auth.js';
import { approveOAuthConsent, oauthConsentRequest, verifyMcpBearer, revokeOAuthClient } from '../apps/server/platform/oauth.js';
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

it.each([false, true])('keeps blog publication separate in OAuth consent and token claims (allowPublish=%s)', async (allowPublish) => {
  const f = await createFixture(), db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f), auth = await createAuth(f.config, db);
    db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.1.0',1,'{}','{}','enabled',?)").run(JSON.stringify({ readOnly: false, allowPublish, allowedPrefixes: ['00-Inbox'] }));
    const scope = 'knowledge:read knowledge:write blog:publish offline_access';
    const registered = await (auth.api as any).registerOAuthClient({ body: { client_name: 'Blog OAuth fixture', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope } });
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', scope, state: 'blog-fixture-state', resource: f.config.origin + '/mcp', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const authorize = await auth.handler(new Request(f.config.origin + '/api/auth/oauth2/authorize?' + query, { headers: { cookie: headers.cookie, accept: 'text/html' } }));
    const consent = new URL(authorize.headers.get('location')!, f.config.origin), oauthQuery = consent.searchParams.get('oauth_query') || consent.search.slice(1);
    const request = await oauthConsentRequest(auth, f.config, db, new Headers({ cookie: headers.cookie }), oauthQuery);
    expect(request.allowedScopes.includes('blog:publish')).toBe(allowPublish);
    const input = { accept: true, oauth_query: oauthQuery, scopes: scope.split(' '), allowedPrefixes: ['00-Inbox'] };
    if (!allowPublish) {
      await expect(approveOAuthConsent(auth, f.config, db, new Headers({ cookie: headers.cookie }), input)).rejects.toMatchObject({ code: 'INVALID_OAUTH_GRANT' });
      return;
    }
    const result = await approveOAuthConsent(auth, f.config, db, new Headers({ cookie: headers.cookie }), input), target = new URL(result.url);
    const tokenResponse = await auth.handler(new Request(f.config.origin + '/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, code: target.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource: f.config.origin + '/mcp' }) }));
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json(), principal = await verifyMcpBearer(auth, f.config, db, 'Bearer ' + token.access_token);
    expect(principal.scopes).toContain('blog:publish'); expect(principal.tokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await revokeOAuthClient(auth, db, principal.id, principal.clientId);
    await expect(verifyMcpBearer(auth, f.config, db, 'Bearer ' + token.access_token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally { db.close(); await f.close(); }
});
