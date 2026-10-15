import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
it('rejects a queued Tunnel actor as soon as its configured credential reference changes', async () => {
  const f = await createFixture(),
    db = openDatabase(f.dataRoot);
  try {
    await loginFixtureOwner(f);
    const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    db.prepare(
      "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.0.0',1,'{}','{}','enabled',?)",
    ).run(
      JSON.stringify({
        readOnly: false,
        allowedPrefixes: ['00-Inbox'],
        tunnelToken: { $secretRef: 'old-ref' },
      }),
    );
    const grant = oauthGrantStore(db).approve(
      owner,
      'stable-tunnel-client',
      ['knowledge:read', 'knowledge:write'],
      ['00-Inbox'],
    );
    const p = {
      id: owner,
      clientId: 'stable-tunnel-client',
      scopes: grant.scopes,
      allowedPrefixes: grant.allowedPrefixes,
      grantId: grant.id,
      grantVersion: grant.version,
      tokenIssuedAt: grant.notBefore,
      pluginId: 'mcp',
      authGeneration: 0,
      credentialRef: 'old-ref',
    };
    expect(platformPolicy(db, p)?.scopes).toContain('knowledge:write');
    db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
      JSON.stringify({
        readOnly: false,
        allowedPrefixes: ['00-Inbox'],
        tunnelToken: { $secretRef: 'new-ref' },
      }),
    );
    expect(platformPolicy(db, p)).toBeUndefined();
  } finally {
    db.close();
    await f.close();
  }
});

it('keeps migrated receipt identity and original issuance while rotating credentials and changing explicit scope', async () => {
  const { tunnelPrincipal, initializeTunnelIdentity } =
    await import('../apps/server/platform/tunnel-identity.js');
  const f = await createFixture(),
    db = openDatabase(f.dataRoot);
  try {
    await loginFixtureOwner(f);
    const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    db.prepare(
      "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.0.0',1,'{}','{}','enabled',?)",
    ).run(
      JSON.stringify({
        readOnly: true,
        allowedPrefixes: ['00-Inbox'],
        tunnelToken: { $secretRef: 'old' },
      }),
    );
    initializeTunnelIdentity(db);
    const issued = Math.floor(Date.now() / 1000) - 100;
    db.prepare('INSERT INTO mcp_tunnel_identity VALUES(?,?,?,?,?,NULL,0,1)').run(
      owner,
      'legacy-principal',
      'legacy-client',
      'old',
      issued,
    );
    const first = tunnelPrincipal(db, owner, {
      reference: 'old',
      createdAt: Date.now(),
      authGeneration: 0,
    });
    expect(first).toMatchObject({
      id: 'legacy-principal',
      ownerId: owner,
      clientId: 'legacy-client',
      tokenIssuedAt: issued,
      scopes: ['knowledge:read'],
    });
    db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
      JSON.stringify({
        readOnly: false,
        allowedPrefixes: ['00-Inbox'],
        tunnelToken: { $secretRef: 'old' },
      }),
    );
    expect(
      tunnelPrincipal(db, owner, { reference: 'old', createdAt: Date.now(), authGeneration: 0 })
        .scopes,
    ).toContain('knowledge:write');
    oauthGrantStore(db).revoke(owner, 'legacy-client');
    expect(() =>
      tunnelPrincipal(db, owner, { reference: 'old', createdAt: Date.now(), authGeneration: 0 }),
    ).toThrow();
    const rotated = tunnelPrincipal(db, owner, {
      reference: 'new',
      createdAt: Date.now(),
      authGeneration: 0,
    });
    expect(rotated).toMatchObject({
      id: 'legacy-principal',
      clientId: 'legacy-client',
      credentialRef: 'new',
    });
    expect(rotated.tokenIssuedAt).toBeGreaterThan(issued);
  } finally {
    db.close();
    await f.close();
  }
});
