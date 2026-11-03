import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { remoteAuthGeneration } from './remote-auth.js';

export function initializeMcpApiCredentials(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_api_clients (
    owner_id TEXT NOT NULL, client_id TEXT NOT NULL, principal_id TEXT NOT NULL,
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,client_id));
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_id TEXT NOT NULL,
    digest TEXT NOT NULL, suffix TEXT NOT NULL, version INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
    auth_generation INTEGER NOT NULL, last_used_at INTEGER,
    FOREIGN KEY(owner_id,client_id) REFERENCES mcp_api_clients(owner_id,client_id));
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_api_keys_active ON mcp_api_keys(owner_id,client_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS mcp_api_keys_client ON mcp_api_keys(owner_id,client_id,created_at);
    CREATE TABLE IF NOT EXISTS mcp_api_events (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_id TEXT NOT NULL,
    action TEXT NOT NULL, key_id TEXT, created_at INTEGER NOT NULL);`);
}

/** Rechecked at execution boundaries, including when a previously authenticated actor was queued. */
export function mcpApiCredentialValid(db: AppDatabase, p: Principal): boolean {
  if (
    p.credentialKind !== 'api-key' ||
    !p.credentialRef ||
    !p.credentialVersion ||
    p.authGeneration !== remoteAuthGeneration(db)
  )
    return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_api_keys'").get())
    return false;
  const row = db
    .prepare(
      `SELECT k.expires_at,k.revoked_at,k.auth_generation,k.version,c.status,c.principal_id
    FROM mcp_api_keys k JOIN mcp_api_clients c USING(owner_id,client_id)
    WHERE k.id=? AND k.owner_id=? AND k.client_id=?`,
    )
    .get(p.credentialRef, p.ownerId || p.id, p.clientId) as any;
  return (
    !!row &&
    row.principal_id === p.id &&
    row.status === 'active' &&
    row.revoked_at == null &&
    row.version === p.credentialVersion &&
    row.auth_generation === p.authGeneration &&
    (row.expires_at == null || row.expires_at > Date.now())
  );
}
