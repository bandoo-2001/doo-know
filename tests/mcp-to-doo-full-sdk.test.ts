import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { pluginHost } from '../apps/server/plugins/host';
import { pluginServices } from '../apps/server/plugins/services';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants';
import { policyScopes, currentToDooInstanceId } from '../packages/core/auth/permissions';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';
import type { PermissionPolicy } from '../shared/permissions';

it('discovers exact To Doo schemas and invokes scoped typed writes/exports through the actual SDK and live host grants', async () => {
  const f = await pluginRuntimeFixture();
  let client: Client | undefined, server: McpServer | undefined;
  try {
    pluginHost(f.config, f.db);
    const policy: PermissionPolicy = {
      version: 2,
      domains: {
        'to-doo': {
          enabled: true,
          ownerId: f.principal.id,
          instanceId: currentToDooInstanceId(f.db),
          actions: ['read', 'write', 'share', 'integrations'],
          resources: { mode: 'selected', resources: [{ kind: 'list', id: 'allowed-list' }] },
        },
      },
    };
    const manifest = JSON.parse(
      await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'),
    );
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state) VALUES('mcp',?,?,'[]',?,'enabled')",
      )
      .run(
        manifest.version,
        JSON.stringify(manifest),
        JSON.stringify({ mode: 'oauth', permissionPolicy: policy, toDooDomains: ['tasks'] }),
      );
    const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'to-doo-full-sdk', policy);
    const p = {
      id: f.principal.id,
      ownerId: f.principal.id,
      clientId: grant.clientId,
      grantId: grant.id,
      grantVersion: grant.version,
      tokenIssuedAt: Math.floor(Date.now() / 1000),
      pluginId: 'mcp',
      scopes: policyScopes(policy),
      allowedPrefixes: [],
      permissionPolicy: policy,
      policyVersion: 2 as const,
    };
    const services = () =>
      pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, {
        ownerId: p.id,
        principal: p,
        channel: 'mcp',
      });
    const registry = createOperations(
      { objectIdSecret: 'to-doo-full-sdk-object-secret-thirty-two-chars' },
      hostClient(services, () => ({})),
    );
    server = new McpServer({ name: 'full-to-doo', version: '1.0.0' });
    registerOperations(server, registry, p, {});
    client = new Client({ name: 'full-to-doo-client', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
      cursor = page.nextCursor;
    } while (cursor);
    expect(tools.map((tool) => tool.name)).toContain('describe_to_doo_schema');
    expect(tools.map((tool) => tool.name)).toContain('save_to_doo_entity');
    const schema: any = await client.callTool({
      name: 'describe_to_doo_schema',
      arguments: { category: 'patch', name: 'list' },
    });
    expect(schema.isError).not.toBe(true);
    expect(schema.structuredContent.data.schema.properties.color).toBeDefined();
    expect(schema.structuredContent.data.schema.required ?? []).not.toContain('color');
    const create: any = await client.callTool({
      name: 'save_to_doo_entity',
      arguments: {
        requestId: 'sdk-list-create',
        kind: 'list',
        mode: 'create',
        id: 'allowed-list',
        fields: { name: 'SDK goal', kind: 'goal', criteria: 'Preserve me' },
      },
    });
    expect(create.isError, JSON.stringify(create)).not.toBe(true);
    const current = f.platform.get().toDoo.getEntity('list', 'allowed-list')!;
    const patch: any = await client.callTool({
      name: 'save_to_doo_entity',
      arguments: {
        requestId: 'sdk-list-patch',
        kind: 'list',
        mode: 'patch',
        id: 'allowed-list',
        expectedRevision: current.revision,
        fields: { description: 'A later edit' },
      },
    });
    expect(patch.isError).not.toBe(true);
    expect(f.platform.get().toDoo.getEntity('list', 'allowed-list')).toMatchObject({
      kind: 'goal',
      criteria: 'Preserve me',
      description: 'A later edit',
    });
    const denied: any = await client.callTool({
      name: 'save_to_doo_entity',
      arguments: {
        requestId: 'sdk-private-task',
        kind: 'task',
        mode: 'create',
        fields: { title: 'Denied private task', listId: 'private-list' },
      },
    });
    expect(denied.isError).toBe(true);
    const exported: any = await client.callTool({
      name: 'export_to_doo_data',
      arguments: { requestId: 'sdk-export', format: 'json' },
    });
    expect(exported.isError).not.toBe(true);
    expect(exported.structuredContent.data).toMatchObject({
      direction: 'download',
      binding: { domain: 'to-doo', kind: 'export' },
    });
    const ceiling = {
      ...policy,
      domains: { 'to-doo': { ...policy.domains['to-doo'], actions: ['read', 'write'] } },
    };
    f.db
      .prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'")
      .run(JSON.stringify({ mode: 'oauth', permissionPolicy: ceiling, toDooDomains: ['tasks'] }));
    const noShare: any = await client.callTool({
      name: 'export_to_doo_data',
      arguments: { requestId: 'sdk-export-after-revoke', format: 'json' },
    });
    expect(noShare.isError).toBe(true);
    const noAdmin: any = await client.callTool({
      name: 'manage_to_doo_notifications',
      arguments: { requestId: 'sdk-devices-after-revoke', action: 'status' },
    });
    expect(noAdmin.isError).toBe(true);
  } finally {
    await client?.close();
    await server?.close();
    await f.close();
  }
});

it('reads complete template JSON through the actual SDK with only task read access', async () => {
  const f = await pluginRuntimeFixture();
  let client: Client | undefined, server: McpServer | undefined;
  try {
    pluginHost(f.config, f.db);
    const todo = f.platform.get().toDoo;
    todo.command({
      requestId: 'sdk-read-template-seed',
      action: 'save_entity',
      payload: {
        kind: 'template',
        entity: {
          id: 'sdk-template-many',
          name: 'SDK many',
          tasks: Array.from({ length: 40 }, (_, i) => ({
            key: 'step' + i,
            title: 'SDK step ' + i,
            description: 'Unicode🙂'.repeat(40),
          })),
        },
      },
    });
    const policy: PermissionPolicy = {
      version: 2,
      domains: {
        'to-doo': {
          enabled: true,
          ownerId: f.principal.id,
          instanceId: currentToDooInstanceId(f.db),
          actions: ['read'],
          resources: { mode: 'all' },
        },
      },
    };
    const manifest = JSON.parse(
      await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'),
    );
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state) VALUES('mcp',?,?,'[]',?,'enabled')",
      )
      .run(
        manifest.version,
        JSON.stringify(manifest),
        JSON.stringify({ mode: 'oauth', permissionPolicy: policy, toDooDomains: ['tasks'] }),
      );
    const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'to-doo-read-sdk', policy),
      p = {
        id: f.principal.id,
        ownerId: f.principal.id,
        clientId: grant.clientId,
        grantId: grant.id,
        grantVersion: grant.version,
        tokenIssuedAt: Math.floor(Date.now() / 1000),
        pluginId: 'mcp',
        scopes: policyScopes(policy),
        allowedPrefixes: [],
        permissionPolicy: policy,
        policyVersion: 2 as const,
      };
    expect(p.scopes).toEqual(['to-doo:read']);
    const services = () =>
      pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, {
        ownerId: p.id,
        principal: p,
        channel: 'mcp',
      });
    const registry = createOperations(
      { objectIdSecret: 'to-doo-read-sdk-object-secret-thirty-two-chars' },
      hostClient(services, () => ({})),
    );
    server = new McpServer({ name: 'read-to-doo', version: '1.0.0' });
    registerOperations(server, registry, p, {});
    client = new Client({ name: 'read-to-doo-client', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const revision = todo.getEntity('template', 'sdk-template-many')!.revision;
    let json = '',
      offset = 0,
      sha256: string | undefined;
    for (let page = 0; page < 30; page++) {
      const response: any = await client.callTool({
        name: 'read_to_doo_entity',
        arguments: {
          kind: 'template',
          id: 'sdk-template-many',
          expectedRevision: revision,
          offset,
          maxBytes: 8192,
          ...(sha256 ? { expectedContentHash: sha256 } : {}),
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const data = response.structuredContent.data;
      json += data.content;
      sha256 = data.sha256;
      if (data.range.nextOffset === null) break;
      offset = data.range.nextOffset;
    }
    expect(JSON.parse(json).tasks).toHaveLength(40);
    const noShare: any = await client.callTool({
      name: 'export_to_doo_data',
      arguments: { requestId: 'read-client-no-share', format: 'json' },
    });
    expect(noShare.isError).toBe(true);
  } finally {
    await client?.close();
    await server?.close();
    await f.close();
  }
});
