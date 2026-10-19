import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';

it('shows honest preparation state before enabling MCP and keeps authorization management available while disabled', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  const url = '/api/platform/mcp/connection';
  try {
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const response = await f.app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    const state = response.json();
    expect(state.plugin).toMatchObject({ installed: false, enabled: false });
    expect(state.connection.oauth.ready).toBe(false);
    expect(state.externalVerification).toBe('unknown');
    expect(state.latestSuccessfulCall).toBeNull();
    expect(state.origin).toBe(f.config.origin);
    await f.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer fixture-sensitive-value' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const attempted = await f.app.inject({ url, headers });
    expect(attempted.json().latestConnectionAttempt).toMatchObject({
      mode: 'oauth',
      outcome: 'rejected',
      code: 'PLUGIN_PROTOCOL_UNAVAILABLE',
    });
    expect(JSON.stringify(attempted.json())).not.toContain('fixture-sensitive-value');

    const db = openDatabase(f.dataRoot);
    try {
      const owner = (db.prepare('SELECT id FROM user').get() as any).id;
      const grant = oauthGrantStore(db).approve(
        owner,
        'tutorial-client',
        ['knowledge:read', 'knowledge:write'],
        ['00-Inbox'],
      );
      const connection = await f.app.inject({ url, headers });
      const client = connection.json().clients.find((c: any) => c.clientId === 'tutorial-client');
      expect(client.active).toBe(true);
      expect(client.effectiveScopes).toEqual([]);
      expect(JSON.stringify(connection.json())).not.toContain(grant.reference);
      const revoked = await f.app.inject({
        method: 'POST',
        url: '/api/platform/mcp/clients/revoke',
        headers,
        payload: { clientId: 'tutorial-client' },
      });
      expect(revoked.statusCode).toBe(200);
      expect(oauthGrantStore(db).list(owner)[0].active).toBe(false);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/platform/mcp/clients/revoke',
            headers: { ...headers, origin: 'https://untrusted.invalid' },
            payload: { clientId: 'tutorial-client' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it('reports effective permissions only for the selected channel and recognizes successful calls from the owner migrated identity', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    const headers = await loginFixtureOwner(f);
    const db = openDatabase(f.dataRoot);
    try {
      const owner = (db.prepare('SELECT id FROM user').get() as any).id;
      db.prepare(
        `INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state)
        VALUES('mcp','1.0.1',?,?,?,'enabled')`,
      ).run(
        JSON.stringify({
          id: 'mcp',
          title: 'MCP 服务',
          version: '1.0.1',
          configSchema: { properties: {} },
          capabilities: [],
          contributions: [],
        }),
        '{}',
        JSON.stringify({ mode: 'tunnel', readOnly: true, allowedPrefixes: ['00-Inbox'] }),
      );
      oauthGrantStore(db).approve(owner, 'oauth-client', ['knowledge:read'], ['00-Inbox']);
      const response = await f.app.inject({ url: '/api/platform/mcp/connection', headers });
      expect
        .soft(
          response.json().clients.find((c: any) => c.clientId === 'oauth-client').effectiveScopes,
        )
        .toEqual([]);

      db.exec(`CREATE TABLE IF NOT EXISTS mcp_tunnel_identity(owner_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,client_id TEXT NOT NULL,
        credential_reference TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0,source_migrated INTEGER NOT NULL DEFAULT 0)`);
      db.prepare(
        'INSERT INTO mcp_tunnel_identity(owner_id,principal_id,client_id,credential_reference,issued_at,source_migrated) VALUES(?,?,?,?,?,1)',
      ).run(owner, 'legacy-owner', 'legacy-client', 'private-reference', 0);
      db.prepare('INSERT INTO plugin_data(plugin_id,key,value) VALUES(?,?,?)').run(
        'mcp',
        'calls',
        JSON.stringify([
          {
            principal: 'legacy-owner',
            client: 'legacy-client',
            code: 'OK',
            tool: 'list_notes',
            at: '2026-10-19T01:00:00Z',
          },
        ]),
      );
      const migrated = await f.app.inject({ url: '/api/platform/mcp/connection', headers });
      expect(migrated.json().latestSuccessfulCall).toMatchObject({
        tool: 'list_notes',
        client: 'legacy-client',
      });
      expect(JSON.stringify(migrated.json())).not.toContain('private-reference');
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
