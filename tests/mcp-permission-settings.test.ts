import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('offers owner-only identity-bound domain settings without granting full access by default', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    const url = '/api/platform/mcp/permissions';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const result = await f.app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.policy.version).toBe(2);
    expect(body.policy.domains.knowledge.resources.mode).toBe('selected');
    expect(body.policy.domains.knowledge.actions).toEqual(['read']);
    expect(body.policy.domains.blog.actions).not.toContain('publish');
    expect(body.policy.domains).not.toHaveProperty('todo');
    expect(
      body.resources.knowledge.some(
        (x: any) => x.kind === 'directory' && x.id && x.label === '00-Inbox',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it('persists bounded organization retention as an owner maintenance setting', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    const url = '/api/maintenance/organization-settings';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 30 });
    expect(
      (await f.app.inject({ method: 'PUT', url, headers, payload: { retentionDays: 14 } })).json(),
    ).toEqual({ retentionDays: 14 });
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 14 });
    for (const days of [0, 1.5, 3651, '30'])
      expect(
        (await f.app.inject({ method: 'PUT', url, headers, payload: { retentionDays: days } }))
          .statusCode,
      ).toBe(400);
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 14 });
  } finally {
    await f.close();
  }
});

it('offers the new task domain disabled for existing v2 settings without changing stored grants', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const { pluginHost } = await import('../apps/server/plugins/host.js');
  const { registerMcpPermissionRoutes } = await import('../apps/server/platform/mcp-permissions.js');
  const { default: Fastify } = await import('fastify');
  const f = await pluginRuntimeFixture();
  const app = Fastify();
  try {
    pluginHost(f.config, f.db);
    f.db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled',?)").run(JSON.stringify({ permissionPolicy: { version: 2, domains: {} } }));
    app.addHook('onRequest', async request => { (request as any).ownerId = f.principal.id; });
    registerMcpPermissionRoutes(app, f.db, f.platform);
    const response = await app.inject({ url: '/api/platform/mcp/permissions' });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy.domains['to-doo']).toMatchObject({ enabled: false, ownerId: f.principal.id, actions: [] });
    expect(response.json().policy.domains['to-doo'].instanceId).toBe(f.platform.get().toDoo.exportCheckpoint().datasetId);
    expect(JSON.parse((f.db.prepare("SELECT config_json FROM platform_plugins WHERE id='mcp'").get() as any).config_json).permissionPolicy.domains).toEqual({});
  } finally { await app.close(); await f.close(); }
});
