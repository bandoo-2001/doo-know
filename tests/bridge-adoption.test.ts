import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { legacyTunnelAuthorization } from '../apps/server/platform/bridge-adoption.js';
const bearer = 'legacy-fixture-bearer-at-least-thirty-two-characters';
const principal = {
  id: 'legacy-owner',
  clientId: 'legacy-client',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
  allowedPrefixes: ['00-Inbox', '30-Knowledge'],
};
it('keeps the old identity/issuance, intersects both policies and refuses revoked or stale legacy credentials', () => {
  const issuedAt = Math.floor(Date.now() / 1000) - 100,
    record = {
      id: principal.id,
      clientId: principal.clientId,
      sha256: createHash('sha256').update(bearer).digest('hex'),
      issuedAt,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
  const backend = {
    ...principal,
    scopes: ['knowledge:read', 'knowledge:write'],
    allowedPrefixes: ['00-Inbox/private'],
  };
  const options = {
    bearer,
    tokens: { tokens: [record] },
    bridgePolicies: [principal],
    backendPolicies: [backend],
    notBefore: issuedAt - 1,
  };
  expect(legacyTunnelAuthorization(options)).toMatchObject({
    principalId: principal.id,
    clientId: principal.clientId,
    issuedAt,
    scopes: ['knowledge:read', 'knowledge:write'],
    allowedPrefixes: ['00-Inbox/private'],
  });
  expect(() => legacyTunnelAuthorization({ ...options, notBefore: issuedAt })).toThrow();
  expect(() =>
    legacyTunnelAuthorization({ ...options, tokens: { tokens: [{ ...record, revoked: true }] } }),
  ).toThrow();
  expect(() =>
    legacyTunnelAuthorization({
      ...options,
      tokens: { tokens: [{ ...record, issuedAt: undefined }] },
    }),
  ).toThrow();
  expect(() => legacyTunnelAuthorization({ ...options, bearer: bearer + 'wrong' })).toThrow();
});
it('adopts the prebuilt MCP offline and replays an original legacy write receipt without creating a second note', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { pathToFileURL } = await import('node:url');
  // @ts-expect-error build tool is ESM JavaScript
  const { buildPlugins } = await import('../scripts/build-plugins.mjs');
  const { createFixture, loginFixtureOwner } = await import('./support/fixture.js'),
    { openDatabase } = await import('../packages/core/db.js'),
    { mutationCore } = await import('../packages/core/knowledge/core.js'),
    { adoptLegacyTunnel } = await import('../apps/server/platform/bridge-adoption.js'),
    { pluginHost } = await import('../apps/server/plugins/host.js'),
    { tunnelPrincipal } = await import('../apps/server/platform/tunnel-identity.js'),
    { createApp } = await import('../apps/server/app.js'),
    { platformPolicy } = await import('../packages/core/auth/grants.js');
  const output = await mkdtemp(join(tmpdir(), 'adopt-package-')),
    catalog = await buildPlugins({
      output,
      ids: ['mcp'],
      baseURL: pathToFileURL(output + '/').href,
    }),
    f = await createFixture({ pluginCatalog: catalog });
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const db = openDatabase(f.dataRoot);
  try {
    await loginFixtureOwner(f);
    const issuedAt = Math.floor(Date.now() / 1000) - 100,
      legacy = { ...principal, allowedPrefixes: ['00-Inbox'], tokenIssuedAt: issuedAt },
      core = mutationCore(f.config, db);
    const original = core.create(
      legacy,
      '00-Inbox',
      'original.md',
      '# Keep original receipt',
      'original-legacy-request',
    );
    await f.app.close();
    const record = {
      id: legacy.id,
      clientId: legacy.clientId,
      sha256: createHash('sha256').update(bearer).digest('hex'),
      issuedAt,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    await adoptLegacyTunnel(db, f.config, {
      bearer,
      tokens: { tokens: [record] },
      bridgePolicies: [legacy],
      backendPolicies: [legacy],
      compatPort: 15333,
    });
    app = await createApp(f.config);
    const owner = (db.prepare('SELECT id FROM user').get() as any).id,
      info = pluginHost(f.config, db).secretInfo('mcp', 'tunnelToken')!;
    const actor = tunnelPrincipal(db, owner, info);
    expect(platformPolicy(db, actor)?.scopes).toContain('knowledge:write');
    expect(
      core.create(
        actor,
        '00-Inbox',
        'original.md',
        '# Keep original receipt',
        'original-legacy-request',
      ),
    ).toEqual(original);
    const replay = await fetch('http://127.0.0.1:15333/api/v1/tools/create_note', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        directory: '00-Inbox',
        fileName: 'original.md',
        content: '# Keep original receipt',
        requestId: 'original-legacy-request',
      }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(original);
    expect((db.prepare('SELECT COUNT(*) AS n FROM notes').get() as any).n).toBe(1);
  } finally {
    await app?.close();
    db.close();
    await f.close();
    await rm(output, { recursive: true, force: true });
  }
}, 60000);
