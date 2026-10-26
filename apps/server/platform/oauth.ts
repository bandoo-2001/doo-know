import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { createAuth } from '../auth.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { oauthGrantStore } from './oauth-grants.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { checkTokenCutoff, underPrefix } from '../../../packages/core/agent/auth.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { isResourceScope, oauthScopes } from '../../../shared/authorization-scopes.js';

type OwnerAuth = Awaited<ReturnType<typeof createAuth>>;
const queues = new WeakMap<AppDatabase, Promise<unknown>>();
export function serializeOAuth<T>(db: AppDatabase, work: () => Promise<T>): Promise<T> {
  const task = (queues.get(db) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(db, task);
  const release = () => { if (queues.get(db) === task) queues.delete(db); };
  void task.then(release, release); return task;
}
export function mcpPolicy(db: AppDatabase) {
  const hasPlugins = db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_plugins'").get();
  const row = hasPlugins && db.prepare("SELECT config_json,state FROM platform_plugins WHERE id='mcp' AND installed=1").get() as any;
  const config = row ? JSON.parse(row.config_json) : {};
  return { readOnly: config.readOnly !== false, allowIndex: config.allowIndex === true, allowPublish: config.allowPublish === true,
    allowedPrefixes: Array.isArray(config.allowedPrefixes) ? config.allowedPrefixes as string[] : webPrincipal.allowedPrefixes,
    enabled: row?.state === 'enabled' };
}
export async function oauthConsentRequest(auth: OwnerAuth, config: HostConfig, db: AppDatabase, headers: Headers, raw: unknown) {
  const session = await auth.api.getSession({ headers });
  if (!session?.user || !db.prepare('SELECT id FROM user WHERE id=?').get(session.user.id)) fail(401, 'UNAUTHORIZED');
  if (typeof raw !== 'string' || raw.length > 16384) fail(400, 'INVALID_OAUTH_QUERY');
  const context = await auth.$context;
  if (!(await verifyOAuthQueryParams(raw, context.secret))) fail(400, 'INVALID_OAUTH_QUERY');
  const query = new URLSearchParams(raw), clientId = query.get('client_id');
  if (!clientId || query.getAll('client_id').length !== 1) fail(400, 'INVALID_OAUTH_QUERY');
  const resources = query.getAll('resource');
  if (!resources.length || resources.some(r => r !== config.origin + '/mcp')) fail(400, 'INVALID_OAUTH_RESOURCE');
  const client = await context.adapter.findOne<any>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
  if (!client || client.disabled) fail(400, 'INVALID_OAUTH_CLIENT');
  const requestedScopes = [...new Set((query.get('scope') || '').split(/\s+/).filter(Boolean))];
  if (requestedScopes.some(s => !oauthScopes.includes(s))) fail(400, 'INVALID_OAUTH_SCOPE');
  const policy = mcpPolicy(db);
  return { ownerId: session.user.id, clientId, clientName: String(client.name || client.clientName || clientId),
    requestedScopes, resource: config.origin + '/mcp', allowedPrefixes: policy.allowedPrefixes,
    allowedScopes: requestedScopes.filter(s => s !== 'knowledge:write' || !policy.readOnly).filter(s => s !== 'knowledge:index' || policy.allowIndex).filter(s => s !== 'blog:publish' || (policy.allowPublish && !policy.readOnly)) };
}
export async function approveOAuthConsent(auth: OwnerAuth, config: HostConfig, db: AppDatabase, headers: Headers, input: any) {
  return serializeOAuth(db, async () => {
    const request = await oauthConsentRequest(auth, config, db, headers, input?.oauth_query);
    if (typeof input?.accept !== 'boolean') fail(400, 'INVALID_OAUTH_QUERY');
    const endpointHeaders = new Headers(headers); endpointHeaders.set('accept', 'application/json');
    const endpointRequest = new Request(config.origin + '/api/auth/oauth2/consent', { method: 'POST', headers: endpointHeaders });
    const redirectResult = async (value: any): Promise<{ redirect: true; url: string }> => {
      if (value instanceof Response) {
        if (!value.ok) fail(400, 'OAUTH_AUTHORIZATION_FAILED');
        value = await value.json();
      }
      if (value?.redirect !== true || typeof value.url !== 'string') fail(400, 'OAUTH_AUTHORIZATION_FAILED');
      return value;
    };
    if (!input.accept) return redirectResult(await auth.api.oauth2Consent({ headers: endpointHeaders, request: endpointRequest, body: { accept: false, oauth_query: input.oauth_query } }));
    const scopes: string[] = input.scopes;
    const prefixes: string[] = input.allowedPrefixes;
    if (!Array.isArray(scopes) || scopes.some(s => !request.allowedScopes.includes(s))
      || !Array.isArray(prefixes) || prefixes.some(p => typeof p !== 'string' || !request.allowedPrefixes.some(a => underPrefix(p, a)))) fail(403, 'INVALID_OAUTH_GRANT');
    const grants = oauthGrantStore(db);
    if (scopes.includes('blog:publish') && (!scopes.includes('knowledge:read') || !scopes.includes('knowledge:write'))) fail(403, 'INVALID_OAUTH_GRANT');
    grants.approve(request.ownerId, request.clientId, scopes.filter(isResourceScope), prefixes);
    try { return await redirectResult(await auth.api.oauth2Consent({ headers: endpointHeaders, request: endpointRequest, body: { accept: true, scope: scopes.join(' '), oauth_query: input.oauth_query } })); }
    catch (e) { grants.revoke(request.ownerId, request.clientId); throw e; }
  });
}
export async function verifyMcpBearer(auth: OwnerAuth, config: HostConfig, db: AppDatabase, authorization: unknown): Promise<Principal> {
  try {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 16384) throw new Error();
    const keys = await auth.api.getJwks();
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(keys), { issuer: config.origin + '/api/auth', audience: config.origin + '/mcp', algorithms: ['EdDSA','RS256','ES256'] });
    if (typeof payload.sub !== 'string' || typeof payload.client_id !== 'string' || typeof payload.dk_grant_id !== 'string'
      || !Number.isInteger(payload.dk_grant_version) || !Number.isInteger(payload.iat)) throw new Error();
    const scopes = String(payload.scope || '').split(' ').filter(isResourceScope);
    const grant = oauthGrantStore(db).requireExact(`${payload.dk_grant_id}:${payload.dk_grant_version}`, payload.sub, payload.client_id, scopes);
    const p: Principal = { id: grant.ownerId, clientId: grant.clientId, scopes, allowedPrefixes: grant.allowedPrefixes,
      tokenIssuedAt: payload.iat, ...(typeof payload.exp === 'number' ? { tokenExpiresAt: payload.exp } : {}), grantId: grant.id, grantVersion: grant.version };
    checkTokenCutoff(db, p); return p;
  } catch { fail(401, 'UNAUTHORIZED', '需要有效且未撤销的访问令牌'); }
}
export async function revokeOAuthClient(auth: OwnerAuth, db: AppDatabase, ownerId: string, clientId?: string) {
  return serializeOAuth(db, async () => {
    oauthGrantStore(db).revoke(ownerId, clientId);
    const { adapter } = await auth.$context;
    const where = [{ field: 'userId', value: ownerId }, ...(clientId ? [{ field: 'clientId', value: clientId }] : [])];
    let cleanupPending = false;
    for (const model of ['oauthAccessToken','oauthRefreshToken','oauthConsent']) {
      try { await adapter.deleteMany({ model, where }); } catch { cleanupPending = true; }
    }
    return { revoked: true, cleanupPending };
  });
}
