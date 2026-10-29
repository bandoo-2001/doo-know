import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { oauthGrantStore } from './oauth-grants.js';
import { mcpPolicy } from './oauth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { platformPolicy } from '../../../packages/core/auth/grants.js';
export function initializeTunnelIdentity(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_tunnel_identity(owner_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,client_id TEXT NOT NULL,
    credential_reference TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0,source_migrated INTEGER NOT NULL DEFAULT 0)`);
}
// Identity is separate from credential: rotating a key must preserve write receipt ownership.
export function tunnelPrincipal(
  db: AppDatabase,
  owner: string,
  info: { reference: string; createdAt: number; authGeneration: number },
): Principal {
  initializeTunnelIdentity(db);
  return db
    .transaction(() => {
      let identity = db
        .prepare('SELECT * FROM mcp_tunnel_identity WHERE owner_id=?')
        .get(owner) as any;
      const rotated = identity && identity.credential_reference !== info.reference;
      if (!identity) {
        db.prepare(
          'INSERT INTO mcp_tunnel_identity(owner_id,principal_id,client_id,credential_reference,issued_at) VALUES(?,?,?,?,?)',
        ).run(
          owner,
          owner,
          'tunnel:' + randomUUID(),
          info.reference,
          Math.floor(info.createdAt / 1000),
        );
      } else if (rotated) {
        db.prepare(
          'UPDATE mcp_tunnel_identity SET credential_reference=?,issued_at=?,expires_at=NULL,revoked=0,source_migrated=0 WHERE owner_id=?',
        ).run(info.reference, Math.floor(info.createdAt / 1000), owner);
      }
      identity = db.prepare('SELECT * FROM mcp_tunnel_identity WHERE owner_id=?').get(owner) as any;
      const cutoff = Number(
        (db.prepare("SELECT value FROM index_meta WHERE key='remote_auth_not_before'").get() as any)
          ?.value || 0,
      );
      if (
        identity.revoked ||
        (identity.expires_at != null && identity.expires_at <= Math.floor(Date.now() / 1000)) ||
        (identity.source_migrated && identity.issued_at <= cutoff)
      )
        fail(401, 'UNAUTHORIZED');
      const grants = oauthGrantStore(db),
        policy = mcpPolicy(db);
      const scopes = [
        'knowledge:read',
        ...(!policy.readOnly ? ['knowledge:write'] : []),
        ...(policy.allowIndex ? ['knowledge:index'] : []),
        ...(policy.allowPublish && !policy.readOnly ? ['blog:publish'] : []),
        ...(policy.allowToDoo ? ['to-doo:read'] : []),
        ...(policy.allowToDoo && policy.allowToDooWrite && !policy.readOnly ? ['to-doo:write'] : []),
      ];
      let reference = grants.activeReference(owner, identity.client_id);
      const previous = db
        .prepare('SELECT * FROM platform_grants WHERE owner_id=? AND client_id=?')
        .get(owner, identity.client_id) as any;
      if (previous && !reference) fail(401, 'UNAUTHORIZED');
      // Credential rotation changes credential evidence, never the approved grant
      // or its stable selection bindings. Revoked grants require an owner action.
      if (!reference)
        reference = policy.permissionPolicy
          ? grants.approveV2(owner, identity.client_id, policy.permissionPolicy, identity.issued_at)
              .reference
          : grants.approve(
              owner,
              identity.client_id,
              scopes,
              policy.allowedPrefixes,
              identity.issued_at,
            ).reference;
      const grant = grants.requireExact(reference!, owner, identity.client_id, []);
      const principal: Principal = {
        id: identity.principal_id,
        ownerId: owner,
        clientId: identity.client_id,
        scopes: grant.scopes,
        policyVersion: grant.policyVersion,
        permissionPolicy: grant.permissionPolicy,
        allowedPrefixes: grant.allowedPrefixes,
        tokenIssuedAt: identity.issued_at,
        ...(identity.expires_at != null ? { tokenExpiresAt: identity.expires_at } : {}),
        grantId: grant.id,
        grantVersion: grant.version,
        pluginId: 'mcp',
        authGeneration: info.authGeneration,
        credentialRef: info.reference,
      };
      // The transport already checked the credential itself; config may not yet
      // contain its secret reference in migrated fixtures. Preserve that check
      // on subsequent queued calls, while computing the same live ceiling here.
      const effective = platformPolicy(db, { ...principal, authGeneration: undefined });
      if (!effective) fail(401, 'UNAUTHORIZED');
      return { ...effective, authGeneration: principal.authGeneration };
    })
    .immediate();
}
