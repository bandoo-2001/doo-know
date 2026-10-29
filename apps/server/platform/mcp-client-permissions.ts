import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { PermissionPolicy } from '../../../shared/permissions.js';
import type { createAuth } from '../auth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { platformPolicy } from '../../../packages/core/auth/grants.js';
import {
  intersectPermissionPolicies,
  normalizePermissionPolicy,
  permissionPolicyForPrincipal,
  resourceContains,
} from '../../../packages/core/auth/permissions.js';
import { oauthGrantStore } from './oauth-grants.js';
import { initializeTunnelIdentity } from './tunnel-identity.js';

function canonical(policy: PermissionPolicy) {
  return JSON.stringify(
    Object.entries(policy.domains)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, g]) => [
        domain,
        g.enabled,
        g.ownerId,
        g.instanceId,
        [...g.actions].sort(),
        g.resources.mode === 'all'
          ? 'all'
          : [...g.resources.resources].sort((a, b) =>
              `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
            ),
      ]),
  );
}
function subset(db: AppDatabase, candidate: unknown, ceiling: PermissionPolicy) {
  const policy = normalizePermissionPolicy(candidate);
  if (
    canonical(intersectPermissionPolicies(policy, ceiling, resourceContains(db))) !==
    canonical(policy)
  )
    fail(403, 'PERMISSION_WIDENING_NOT_ALLOWED');
  return policy;
}
function owner(db: AppDatabase, ownerId: string) {
  if (typeof ownerId !== 'string' || !db.prepare('SELECT id FROM user WHERE id=?').get(ownerId))
    fail(401, 'UNAUTHORIZED');
}
function expectedVersion(expected: unknown, actual: number) {
  if (expected != null && (!Number.isInteger(expected) || expected !== actual))
    fail(409, 'GRANT_VERSION_CONFLICT');
}
/** An owner may only reduce this client's current effective rights. Reconsent is separate. */
export function narrowMcpClientGrant(db: AppDatabase, ownerId: string, input: any) {
  owner(db, ownerId);
  if (
    !input ||
    typeof input.clientId !== 'string' ||
    !input.clientId ||
    input.clientId.length > 512
  )
    fail(400, 'INVALID_OAUTH_GRANT');
  return db
    .transaction(() => {
      const grants = oauthGrantStore(db),
        old = grants.list(ownerId).find((g) => g.clientId === input.clientId && g.active);
      if (!old) fail(404, 'OAUTH_GRANT_NOT_FOUND');
      expectedVersion(input.expectedGrantVersion, old.version);
      const principal = platformPolicy(db, {
        id: ownerId,
        ownerId,
        clientId: old.clientId,
        scopes: old.scopes,
        allowedPrefixes: old.allowedPrefixes,
        grantId: old.id,
        grantVersion: old.version,
        tokenIssuedAt: Math.floor(Date.now() / 1000),
        pluginId: 'mcp',
      });
      if (!principal) fail(403, 'FORBIDDEN');
      const policy = subset(
        db,
        input.permissionPolicy,
        permissionPolicyForPrincipal(db, principal),
      );
      const next = grants.approveV2(ownerId, old.clientId, policy, old.notBefore);
      return {
        status: 'updated' as const,
        clientId: next.clientId,
        version: next.version,
        grantVersion: next.version,
        permissionPolicy: next.permissionPolicy,
      };
    })
    .immediate();
}
/** Explicit settings action; ordinary requests and key rotation never enlarge a grant. */
export function authorizeMcpTunnel(db: AppDatabase, ownerId: string, input: any = {}) {
  owner(db, ownerId);
  initializeTunnelIdentity(db);
  return db
    .transaction(() => {
      const identity = db
        .prepare('SELECT client_id,revoked,issued_at FROM mcp_tunnel_identity WHERE owner_id=?')
        .get(ownerId) as any;
      if (!identity || identity.revoked) fail(404, 'TUNNEL_CLIENT_NOT_FOUND');
      const plugin = db
        .prepare(
          "SELECT config_json FROM platform_plugins WHERE id='mcp' AND installed=1 AND state='enabled'",
        )
        .get() as any;
      if (!plugin) fail(403, 'FORBIDDEN');
      const config = JSON.parse(plugin.config_json);
      if (!config.permissionPolicy) fail(400, 'V2_PERMISSION_POLICY_REQUIRED');
      const ceiling = normalizePermissionPolicy(config.permissionPolicy);
      const policy = subset(db, input?.permissionPolicy ?? ceiling, ceiling);
      const grants = oauthGrantStore(db),
        old = grants.list(ownerId).find((g) => g.clientId === identity.client_id);
      if (!old) fail(403, 'OAUTH_GRANT_REVOKED');
      expectedVersion(input?.expectedGrantVersion, old.version);
      const next = grants.approveV2(ownerId, identity.client_id, policy, identity.issued_at);
      return {
        status: 'authorized' as const,
        clientId: next.clientId,
        version: next.version,
        grantVersion: next.version,
        permissionPolicy: next.permissionPolicy,
      };
    })
    .immediate();
}
export function registerMcpClientPermissionRoutes(
  app: FastifyInstance,
  _auth: Awaited<ReturnType<typeof createAuth>>,
  _config: HostConfig,
  db: AppDatabase,
) {
  app.post('/api/platform/mcp/clients/narrow', (request) =>
    narrowMcpClientGrant(db, (request as any).ownerId, request.body),
  );
  app.post('/api/platform/mcp/tunnel/authorize', (request) =>
    authorizeMcpTunnel(db, (request as any).ownerId, request.body),
  );
}
