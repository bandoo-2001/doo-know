import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import { initializeGrants } from '../../../packages/core/auth/grants.js';
import { validateRelative } from '../../../packages/core/files.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export function oauthGrantStore(db: AppDatabase) {
  initializeGrants(db);
  function grant(row: any) {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      clientId: row.client_id as string,
      active: !!row.active,
      version: row.version as number,
      scopes: JSON.parse(row.scopes_json) as string[],
      allowedPrefixes: JSON.parse(row.prefixes_json) as string[],
      notBefore: row.not_before as number,
      reference: `${row.id}:${row.version}`,
    };
  }
  function approve(
    owner: string,
    client: string,
    scopes: string[],
    prefixes: string[],
    notBefore = Math.floor(Date.now() / 1000),
  ) {
    if (
      !Number.isInteger(notBefore) ||
      notBefore < 0 ||
      notBefore > Math.floor(Date.now() / 1000) + 5
    )
      fail(400, 'INVALID_OAUTH_GRANT');
    if (
      !db.prepare('SELECT id FROM user WHERE id=?').get(owner) ||
      typeof client !== 'string' ||
      !client ||
      client.length > 512
    )
      fail(403, 'INVALID_OAUTH_GRANT');
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !['knowledge:read', 'knowledge:write', 'knowledge:index'].includes(s)) ||
      !Array.isArray(prefixes) ||
      !prefixes.length ||
      prefixes.length > 64
    )
      fail(400, 'INVALID_OAUTH_GRANT');
    for (const prefix of prefixes) {
      try {
        validateRelative(prefix, prefix.toLowerCase().endsWith('.md') ? 'note' : 'folder');
      } catch {
        fail(400, 'INVALID_OAUTH_GRANT');
      }
    }
    return db
      .transaction(() => {
        db.prepare(
          `INSERT INTO platform_grants(id,owner_id,client_id,scopes_json,prefixes_json,not_before,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,client_id) DO UPDATE SET active=1,version=version+1,
        scopes_json=excluded.scopes_json,prefixes_json=excluded.prefixes_json,not_before=excluded.not_before`,
        ).run(
          randomUUID(),
          owner,
          client,
          JSON.stringify([...new Set(scopes)]),
          JSON.stringify([...new Set(prefixes)]),
          notBefore,
          Date.now(),
        );
        return grant(
          db
            .prepare('SELECT * FROM platform_grants WHERE owner_id=? AND client_id=?')
            .get(owner, client),
        );
      })
      .immediate();
  }
  function requireExact(reference: string, owner: string, client: string, scopes: string[]) {
    const parsed =
      typeof reference === 'string' && reference.match(/^([a-f0-9-]{36}):([1-9]\d{0,9})$/);
    if (!parsed) fail(403, 'OAUTH_GRANT_REVOKED');
    const row = db
      .prepare(
        'SELECT * FROM platform_grants WHERE id=? AND version=? AND owner_id=? AND client_id=? AND active=1',
      )
      .get(parsed[1], Number(parsed[2]), owner, client) as any;
    if (!row) fail(403, 'OAUTH_GRANT_REVOKED');
    const found = grant(row);
    if (scopes.some((s) => !found.scopes.includes(s))) fail(403, 'OAUTH_GRANT_REVOKED');
    return found;
  }
  return {
    approve,
    requireExact,
    activeReference: (owner: string, client: string) => {
      const row = db
        .prepare(
          'SELECT id,version FROM platform_grants WHERE owner_id=? AND client_id=? AND active=1',
        )
        .get(owner, client) as any;
      return row ? `${row.id}:${row.version}` : undefined;
    },
    revoke: (owner: string, client?: string) => {
      db.prepare(
        `UPDATE platform_grants SET active=0,version=version+1,not_before=? WHERE owner_id=? AND active=1${client ? ' AND client_id=?' : ''}`,
      ).run(Math.floor(Date.now() / 1000), owner, ...(client ? [client] : []));
    },
    list: (owner: string) =>
      (
        db
          .prepare('SELECT * FROM platform_grants WHERE owner_id=? ORDER BY created_at DESC')
          .all(owner) as any[]
      ).map(grant),
  };
}
