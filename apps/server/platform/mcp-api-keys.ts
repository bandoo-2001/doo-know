import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { McpApiClientView } from '../../../shared/mcp-api-contracts.js';
import type { PermissionPolicy } from '../../../shared/permissions.js';
import { initializeMcpApiCredentials, mcpApiCredentialValid } from '../../../packages/core/auth/mcp-api-credentials.js';
import { remoteAuthGeneration } from '../../../packages/core/auth/remote-auth.js';
import { platformPolicy, mcpPermissionCeiling } from '../../../packages/core/auth/grants.js';
import { normalizePermissionPolicy, intersectPermissionPolicies, policyScopes, resourceContains } from '../../../packages/core/auth/permissions.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { oauthGrantStore } from './oauth-grants.js';
import { mcpPolicy } from './oauth.js';

type Client = {
  owner_id: string;
  client_id: string;
  principal_id: string;
  name: string;
  status: McpApiClientView['status'];
  version: number;
  created_at: number;
};
type KeyRow = {
  id: string;
  owner_id: string;
  client_id: string;
  digest: string;
  suffix: string;
  version: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  auth_generation: number;
  last_used_at: number | null;
};
type Grant = ReturnType<ReturnType<typeof oauthGrantStore>['list']>[number];
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const iso = (time: number | null) => (time == null ? null : new Date(time).toISOString());
function owner(db: AppDatabase, id: string) {
  if (typeof id !== 'string' || !db.prepare('SELECT id FROM user WHERE id=?').get(id))
    fail(401, 'UNAUTHORIZED');
  initializeMcpApiCredentials(db);
}
function named(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    fail(400, 'INVALID_CLIENT_NAME');
  return value.trim();
}
function expiry(value: unknown) {
  if (value === null) return null;
  if (value === undefined) return Date.now() + 90 * 86400000;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
    fail(400, 'INVALID_KEY_EXPIRATION');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= Date.now()) fail(400, 'INVALID_KEY_EXPIRATION');
  return at;
}
function version(expected: unknown, actual: number) {
  if (!Number.isInteger(expected) || expected !== actual) fail(409, 'CLIENT_VERSION_CONFLICT');
}
function getClient(db: AppDatabase, ownerId: string, clientId: string): Client {
  owner(db, ownerId);
  const row = db
    .prepare('SELECT * FROM mcp_api_clients WHERE owner_id=? AND client_id=?')
    .get(ownerId, clientId) as Client | undefined;
  if (!row) fail(404, 'MCP_CLIENT_NOT_FOUND');
  return row;
}
function getGrant(db: AppDatabase, c: Client) {
  const grant = oauthGrantStore(db)
    .list(c.owner_id)
    .find((g) => g.clientId === c.client_id);
  if (!grant) fail(403, 'MCP_GRANT_UNAVAILABLE');
  return grant;
}
function newestKey(db: AppDatabase, c: Client): KeyRow | undefined {
  return db
    .prepare(
      'SELECT * FROM mcp_api_keys WHERE owner_id=? AND client_id=? ORDER BY version DESC LIMIT 1',
    )
    .get(c.owner_id, c.client_id) as KeyRow | undefined;
}
/** Maps the existing legacy ceiling for newly issued clients; no old credential or identity is imported. */
function ceiling(db: AppDatabase, ownerId: string): PermissionPolicy {
  const configured = mcpPolicy(db);
  if (!configured.enabled) fail(409, 'MCP_SERVICE_DISABLED');
  const row = db.prepare("SELECT config_json FROM platform_plugins WHERE id='mcp'").get() as {
    config_json: string;
  };
  if (JSON.parse(row.config_json).apiKeyEnabled === false) fail(409, 'API_KEY_DISABLED');
  return mcpPermissionCeiling(db, ownerId, JSON.parse(row.config_json));
}
function canonical(p: PermissionPolicy) {
  return JSON.stringify(
    Object.entries(p.domains)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, g]) => [
        id,
        g.enabled,
        g.ownerId,
        g.instanceId,
        [...g.actions].sort(),
        g.resources.mode === 'all'
          ? 'all'
          : [...g.resources.resources].map((r) => r.kind + ':' + r.id).sort(),
      ]),
  );
}
function selected(db: AppDatabase, ownerId: string, value: unknown) {
  const policy = normalizePermissionPolicy(value);
  const max = ceiling(db, ownerId);
  if (
    !policyScopes(policy).length ||
    Object.values(policy.domains).some((g) => g.ownerId !== ownerId) ||
    canonical(policy) !== canonical(intersectPermissionPolicies(policy, max, resourceContains(db)))
  )
    fail(403, 'PERMISSION_WIDENING_NOT_ALLOWED');
  return policy;
}
function principal(c: Client, k: KeyRow, g: Grant): Principal {
  return {
    id: c.principal_id,
    ownerId: c.owner_id,
    clientId: c.client_id,
    pluginId: 'mcp',
    credentialKind: 'api-key',
    credentialRef: k.id,
    credentialVersion: k.version,
    authGeneration: k.auth_generation,
    tokenIssuedAt: Math.floor(k.created_at / 1000),
    ...(k.expires_at == null ? {} : { tokenExpiresAt: Math.ceil(k.expires_at / 1000) }),
    grantId: g.id,
    grantVersion: g.version,
    scopes: g.scopes,
    allowedPrefixes: g.allowedPrefixes,
    policyVersion: g.policyVersion,
    permissionPolicy: g.permissionPolicy,
  };
}
function view(db: AppDatabase, c: Client): McpApiClientView {
  const g = getGrant(db, c),
    k = newestKey(db, c);
  const effective = k ? platformPolicy(db, principal(c, k, g)) : undefined;
  return {
    clientId: c.client_id,
    name: c.name,
    status: c.status,
    version: c.version,
    grantVersion: g.version,
    permissionPolicy: g.permissionPolicy || { version: 2, domains: {} },
    effectivePolicy: effective?.permissionPolicy,
    key: k
      ? {
          id: k.id,
          suffix: k.suffix,
          version: k.version,
          createdAt: iso(k.created_at)!,
          expiresAt: iso(k.expires_at),
          revokedAt: iso(k.revoked_at),
          lastUsedAt: iso(k.last_used_at),
        }
      : null,
  };
}
function issue(db: AppDatabase, c: Client, expiresAt: unknown) {
  const at = expiry(expiresAt),
    id = randomUUID(),
    token = 'dk_mcp_' + id + '.' + randomBytes(32).toString('base64url');
  const next = (newestKey(db, c)?.version || 0) + 1;
  db.prepare(
    'UPDATE mcp_api_keys SET revoked_at=? WHERE owner_id=? AND client_id=? AND revoked_at IS NULL',
  ).run(Date.now(), c.owner_id, c.client_id);
  db.prepare(
    'INSERT INTO mcp_api_keys(id,owner_id,client_id,digest,suffix,version,created_at,expires_at,auth_generation) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    c.owner_id,
    c.client_id,
    digest(token),
    token.slice(-4),
    next,
    Date.now(),
    at,
    remoteAuthGeneration(db),
  );
  return token;
}
function audit(db: AppDatabase, c: Client, action: string) {
  db.prepare(
    'INSERT INTO mcp_api_events(id,owner_id,client_id,action,key_id,created_at) VALUES(?,?,?,?,?,?)',
  ).run(randomUUID(), c.owner_id, c.client_id, action, newestKey(db, c)?.id || null, Date.now());
  db.prepare(
    'DELETE FROM mcp_api_events WHERE owner_id=? AND id NOT IN (SELECT id FROM mcp_api_events WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500)',
  ).run(c.owner_id, c.owner_id);
}
export function listMcpApiClients(db: AppDatabase, ownerId: string): McpApiClientView[] {
  owner(db, ownerId);
  return (
    db
      .prepare('SELECT * FROM mcp_api_clients WHERE owner_id=? ORDER BY created_at DESC,client_id')
      .all(ownerId) as Client[]
  ).map((c) => view(db, c));
}
export function createMcpApiClient(
  db: AppDatabase,
  ownerId: string,
  input: { name: unknown; permissionPolicy: unknown; expiresAt?: unknown },
) {
  owner(db, ownerId);
  return db
    .transaction(() => {
      const name = named(input?.name),
        policy = selected(db, ownerId, input?.permissionPolicy);
      expiry(input?.expiresAt);
      const id = 'api-key:' + randomUUID();
      db.prepare(
        'INSERT INTO mcp_api_clients(owner_id,client_id,principal_id,name,created_at) VALUES(?,?,?,?,?)',
      ).run(ownerId, id, ownerId, name, Date.now());
      oauthGrantStore(db).approveV2(ownerId, id, policy);
      const c = getClient(db, ownerId, id),
        key = issue(db, c, input?.expiresAt);
      audit(db, c, 'created');
      return { client: view(db, c), key };
    })
    .immediate();
}
export function authenticateMcpApiKey(db: AppDatabase, authorization: unknown): Principal {
  initializeMcpApiCredentials(db);
  if (typeof authorization !== 'string' || authorization.length > 256) fail(401, 'UNAUTHORIZED');
  const matched = /^Bearer (dk_mcp_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!matched) fail(401, 'UNAUTHORIZED');
  const k = db.prepare('SELECT * FROM mcp_api_keys WHERE id=?').get(matched[2]) as
    | KeyRow
    | undefined;
  if (!k || !timingSafeEqual(Buffer.from(digest(matched[1]), 'hex'), Buffer.from(k.digest, 'hex')))
    fail(401, 'UNAUTHORIZED');
  const c = db
    .prepare('SELECT * FROM mcp_api_clients WHERE owner_id=? AND client_id=?')
    .get(k.owner_id, k.client_id) as Client | undefined;
  const g =
    c &&
    oauthGrantStore(db)
      .list(c.owner_id)
      .find((x) => x.clientId === c.client_id && x.active);
  if (!c || !g) fail(401, 'UNAUTHORIZED');
  const p = principal(c, k, g);
  if (!mcpApiCredentialValid(db, p)) fail(401, 'UNAUTHORIZED');
  const effective = platformPolicy(db, p);
  if (!effective) fail(401, 'UNAUTHORIZED');
  if (k.last_used_at == null || k.last_used_at < Date.now() - 60000) {
    // Usage telemetry must never turn an otherwise valid read into a failed authentication.
    // This synchronous section cannot interleave other work on this connection.
    const timeout = db.pragma('busy_timeout', { simple: true }) as number;
    try {
      db.pragma('busy_timeout = 0');
      db.prepare('UPDATE mcp_api_keys SET last_used_at=? WHERE id=?').run(Date.now(), k.id);
    } catch (error) {
      if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code: string }).code)) throw error;
    } finally {
      db.pragma('busy_timeout = ' + timeout);
    }
  }
  return effective;
}
export function updateMcpApiClient(
  db: AppDatabase,
  ownerId: string,
  clientId: string,
  input: { name: unknown; expectedVersion: unknown },
) {
  return db
    .transaction(() => {
      const c = getClient(db, ownerId, clientId);
      version(input?.expectedVersion, c.version);
      db.prepare(
        'UPDATE mcp_api_clients SET name=?,version=version+1 WHERE owner_id=? AND client_id=?',
      ).run(named(input?.name), ownerId, clientId);
      audit(db, c, 'renamed');
      return view(db, getClient(db, ownerId, clientId));
    })
    .immediate();
}
export function setMcpApiClientPermissions(
  db: AppDatabase,
  ownerId: string,
  clientId: string,
  input: { permissionPolicy: unknown; expectedGrantVersion: unknown },
) {
  return db
    .transaction(() => {
      const c = getClient(db, ownerId, clientId),
        g = getGrant(db, c);
      if (c.status !== 'active' || !g.active) fail(409, 'MCP_REAUTHORIZATION_REQUIRED');
      version(input?.expectedGrantVersion, g.version);
      const p = selected(db, ownerId, input?.permissionPolicy);
      oauthGrantStore(db).approveV2(ownerId, clientId, p, g.notBefore);
      db.prepare(
        'UPDATE mcp_api_clients SET version=version+1 WHERE owner_id=? AND client_id=?',
      ).run(ownerId, clientId);
      audit(db, c, 'permissions_updated');
      return view(db, getClient(db, ownerId, clientId));
    })
    .immediate();
}
export function rotateMcpApiKey(
  db: AppDatabase,
  ownerId: string,
  clientId: string,
  input: { expiresAt?: unknown; expectedVersion: unknown },
) {
  return db
    .transaction(() => {
      const c = getClient(db, ownerId, clientId),
        g = getGrant(db, c);
      version(input?.expectedVersion, c.version);
      if (c.status !== 'active' || !g.active) fail(409, 'MCP_REAUTHORIZATION_REQUIRED');
      ceiling(db, ownerId);
      const key = issue(db, c, input?.expiresAt);
      db.prepare(
        'UPDATE mcp_api_clients SET version=version+1 WHERE owner_id=? AND client_id=?',
      ).run(ownerId, clientId);
      audit(db, c, 'rotated');
      return { client: view(db, getClient(db, ownerId, clientId)), key };
    })
    .immediate();
}
export function reauthorizeMcpApiClient(
  db: AppDatabase,
  ownerId: string,
  clientId: string,
  input: {
    permissionPolicy: unknown;
    expiresAt?: unknown;
    expectedVersion: unknown;
    expectedGrantVersion: unknown;
  },
) {
  return db
    .transaction(() => {
      const c = getClient(db, ownerId, clientId),
        g = getGrant(db, c);
      version(input?.expectedVersion, c.version);
      version(input?.expectedGrantVersion, g.version);
      if (c.status !== 'requires_reauthorization') fail(409, 'MCP_REAUTHORIZATION_NOT_ALLOWED');
      const p = selected(db, ownerId, input?.permissionPolicy);
      oauthGrantStore(db).approveV2(ownerId, clientId, p);
      const key = issue(db, c, input?.expiresAt);
      db.prepare(
        "UPDATE mcp_api_clients SET status='active',version=version+1 WHERE owner_id=? AND client_id=?",
      ).run(ownerId, clientId);
      audit(db, c, 'reauthorized');
      return { client: view(db, getClient(db, ownerId, clientId)), key };
    })
    .immediate();
}
export function revokeMcpApiClient(
  db: AppDatabase,
  ownerId: string,
  clientId: string,
): { revoked: true } {
  return db
    .transaction(() => {
      const c = getClient(db, ownerId, clientId);
      if (c.status !== 'revoked') {
        db.prepare(
          "UPDATE mcp_api_clients SET status='revoked',version=version+1 WHERE owner_id=? AND client_id=?",
        ).run(ownerId, clientId);
        db.prepare(
          'UPDATE mcp_api_keys SET revoked_at=? WHERE owner_id=? AND client_id=? AND revoked_at IS NULL',
        ).run(Date.now(), ownerId, clientId);
        oauthGrantStore(db).revoke(ownerId, clientId);
        audit(db, c, 'revoked');
      }
      return { revoked: true as const };
    })
    .immediate();
}
export function registerMcpApiKeyRoutes(app: FastifyInstance, db: AppDatabase) {
  initializeMcpApiCredentials(db);
  const root = '/api/platform/mcp/api-clients';
  app.get(root, async (req) => ({ items: listMcpApiClients(db, (req as any).ownerId) }));
  app.post(root, async (req) => createMcpApiClient(db, (req as any).ownerId, req.body as any));
  const bind = (fn: Function) => (req: any) => fn(db, req.ownerId, req.params.id, req.body);
  app.patch(root + '/:id', bind(updateMcpApiClient));
  app.put(root + '/:id/permissions', bind(setMcpApiClientPermissions));
  app.post(root + '/:id/rotate-key', bind(rotateMcpApiKey));
  app.post(root + '/:id/reauthorize', bind(reauthorizeMcpApiClient));
  app.post(root + '/:id/revoke', bind(revokeMcpApiClient));
}
