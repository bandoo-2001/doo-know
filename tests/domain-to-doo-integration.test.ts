import { expect, it } from 'vitest';
import { normalizePermissionPolicy, policyScopes } from '../packages/core/auth/permissions.js';
import { isLegacyResourceScope } from '../shared/authorization-scopes.js';

it('admits explicit independent To Doo grants using the existing task scope names', () => {
  const policy = normalizePermissionPolicy({
    version: 2,
    domains: {
      'to-doo': {
        enabled: true,
        ownerId: 'owner',
        instanceId: 'tasks',
        actions: ['read', 'write'],
        resources: { mode: 'selected', resources: [{ kind: 'list', id: 'selected-list' }] },
      },
    },
  });
  expect(policyScopes(policy)).toEqual(['to-doo:read', 'to-doo:write']);
  expect(Object.keys(policy.domains)).toEqual(['to-doo']);
});

it('accepts previously explicit To Doo scopes in legacy grants', () => {
  expect(isLegacyResourceScope('to-doo:read')).toBe(true);
  expect(isLegacyResourceScope('to-doo:write')).toBe(true);
});

it('enforces live independent To Doo owner, instance, list restrictions and revocation through the SDK', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const { pluginHost } = await import('../apps/server/plugins/host.js');
  const { oauthGrantStore } = await import('../apps/server/platform/oauth-grants.js');
  const { pluginServices } = await import('../apps/server/plugins/services.js');
  const { createOperations } = await import('../plugins/mcp/server/operations.js');
  const { hostClient } = await import('../plugins/mcp/server/service.js');
  const f = await pluginRuntimeFixture();
  try {
    pluginHost(f.config, f.db);
    const datasetId = f.platform.get().toDoo.exportCheckpoint().datasetId;
    const domain = {
      enabled: true,
      ownerId: f.principal.id,
      instanceId: datasetId,
      actions: ['read', 'write'],
      resources: { mode: 'selected' as const, resources: [{ kind: 'list', id: 'allowed-list' }] },
    };
    const ceiling = { version: 2 as const, domains: { 'to-doo': domain } };
    const save = () =>
      f.db
        .prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'")
        .run(
          JSON.stringify({
            permissionPolicy: ceiling,
            toDooDomains: ['tasks'],
            toDooListIds: ['allowed-list', 'blocked-list'],
          }),
        );
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled','{}')",
      )
      .run();
    save();
    const grants = oauthGrantStore(f.db);
    const grant = grants.approveV2(f.principal.id, 'v2-tasks', ceiling);
    const p = {
      id: f.principal.id,
      clientId: grant.clientId,
      scopes: grant.scopes,
      allowedPrefixes: [],
      grantId: grant.id,
      grantVersion: grant.version,
      tokenIssuedAt: grant.notBefore,
      pluginId: 'mcp',
    };
    const services = pluginServices(f.platform, f.db, 'mcp', p.scopes, {
      ownerId: p.id,
      principal: p,
      channel: 'mcp',
    });
    const registry = createOperations(
      { objectIdSecret: 'task-domain-integration-secret-at-least-thirty-two-characters' },
      hostClient(
        () => services,
        () => ({}),
      ),
    );
    await registry.execute('manage_to_doo', p, {
      requestId: 'v2-list',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'allowed-list', name: 'Allowed' } },
    });
    const created: any = await registry.execute('create_to_doo_task', p, {
      requestId: 'v2-create',
      title: 'Allowed task',
      listId: 'allowed-list',
    });
    expect(created.data.ids).toHaveLength(1);
    await expect(
      registry.execute('create_to_doo_task', p, {
        requestId: 'v2-blocked',
        title: 'Blocked task',
        listId: 'blocked-list',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const query: any = await registry.execute('query_to_doos', p, { kind: 'task' });
    expect(query.data.items.map((item: any) => item.entity.title)).toEqual(['Allowed task']);
    expect(grant.scopes).not.toContain('knowledge:read');
    for (const mismatch of ['owner', 'instance']) {
      domain.ownerId = mismatch === 'owner' ? 'other-owner' : p.id;
      domain.instanceId = mismatch === 'instance' ? 'other-dataset' : datasetId;
      save();
      await expect(registry.execute('query_to_doos', p, { kind: 'task' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    domain.ownerId = p.id;
    domain.instanceId = datasetId;
    domain.actions = ['read'];
    save();
    await expect(
      registry.execute('create_to_doo_task', p, {
        requestId: 'v2-downgraded',
        title: 'Denied',
        listId: 'allowed-list',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(registry.execute('query_to_doos', p, { kind: 'task' })).resolves.toBeDefined();
    grants.revoke(p.id, p.clientId);
    await expect(registry.execute('query_to_doos', p, { kind: 'task' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      f.platform
        .get()
        .toDoo.exportCheckpoint()
        .entities.filter((item) => item.kind === 'task'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('rejects a To Doo grant when the portable task dataset identity changes', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const { currentToDooInstanceId, projectPermissionPrincipal } =
    await import('../packages/core/auth/permissions.js');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await pluginRuntimeFixture();
  try {
    const datasetId = f.platform.get().toDoo.exportCheckpoint().datasetId;
    const initial = currentToDooInstanceId(f.db);
    expect(initial).toBe(datasetId);
    const policy = {
      version: 2 as const,
      domains: {
        'to-doo': {
          enabled: true,
          ownerId: f.principal.id,
          instanceId: initial,
          actions: ['read'],
          resources: { mode: 'all' as const },
        },
      },
    };
    const p = { ...f.principal, scopes: ['to-doo:read'] };
    const path = join(f.config.knowledgeRoot, '_data/apps/to-doo/manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.datasetId = 'different-task-dataset';
    await writeFile(path, JSON.stringify(manifest));
    expect(projectPermissionPrincipal(f.db, p, policy).scopes).toEqual([]);
  } finally {
    await f.close();
  }
});
