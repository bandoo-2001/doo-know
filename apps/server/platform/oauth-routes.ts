import type { FastifyInstance, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import type { createAuth } from '../auth.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { oauthConsentRequest, approveOAuthConsent, serializeOAuth } from './oauth.js';
import { oauthScopes } from './oauth-options.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
type OwnerAuth = Awaited<ReturnType<typeof createAuth>>;
export async function forwardAuthResponse(response: Response, reply: FastifyReply) {
  reply.code(response.status);
  response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
  const cookies = response.headers.getSetCookie(); if (cookies.length) reply.header('set-cookie', cookies);
  return reply.send(await response.text());
}
export function registerOAuthRoutes(app: FastifyInstance, auth: OwnerAuth, config: HostConfig, db: AppDatabase) {
  const metadata = oauthProviderAuthServerMetadata(auth);
  for (const path of ['/.well-known/oauth-authorization-server/api/auth', '/.well-known/oauth-authorization-server'])
    app.get(path, async (req, reply) => forwardAuthResponse(await metadata(new Request(new URL(req.url, config.origin), { headers: fromNodeHeaders(req.headers) })), reply));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: config.origin + '/mcp', authorization_servers: [config.origin + '/api/auth'],
    scopes_supported: oauthScopes, bearer_methods_supported: ['header'],
  }));
  app.post('/api/platform/mcp/oauth/request', async req => oauthConsentRequest(auth, config, db, fromNodeHeaders(req.headers), (req.body as any)?.oauth_query));
  app.post('/api/platform/mcp/oauth/consent', async req => approveOAuthConsent(auth, config, db, fromNodeHeaders(req.headers), req.body));
  app.post('/api/platform/mcp/oauth/continue', async req => serializeOAuth(db, async () => {
    const headers = fromNodeHeaders(req.headers), query = (req.body as any)?.oauth_query;
    await oauthConsentRequest(auth, config, db, headers, query);
    headers.set('accept', 'application/json');
    let result: any = await auth.api.oauth2Continue({ headers,
      request: new Request(config.origin + '/api/auth/oauth2/continue', { method: 'POST', headers }),
      body: { postLogin: true, oauth_query: query } });
    if (result instanceof Response) { if (!result.ok) fail(400, 'OAUTH_AUTHORIZATION_FAILED'); result = await result.json(); }
    if (result?.redirect !== true || typeof result.url !== 'string') fail(400, 'OAUTH_AUTHORIZATION_FAILED'); return result;
  }));
}
