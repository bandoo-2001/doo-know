import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { policyScopes } from '../packages/core/auth/permissions.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { knowledgeToolDefinitions } from '../shared/mcp-knowledge-tools.js';
import type { PermissionPolicy } from '../shared/permissions.js';
import { resultSize } from '../plugins/mcp/server/budgets.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it('discovers every knowledge capability in bounded SDK pages and invokes lifecycle, shares, collections and transfer tools', async () => {
  const f = await pluginRuntimeFixture();
  cleanups.push(f.close);
  pluginHost(f.config, f.db);
  const policy: PermissionPolicy = {
    version: 2,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: f.platform.get().knowledge.organization.context(f.principal).libraryId,
        actions: ['read', 'write', 'organize', 'archive', 'share', 'manage', 'index'],
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
      JSON.stringify({ mode: 'oauth', permissionPolicy: policy }),
    );
  const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'knowledge-sdk', policy);
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
  const registry = createOperations(
    { objectIdSecret: 'knowledge-sdk-object-secret-at-least-thirty-two-characters' },
    hostClient(
      () =>
        pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, {
          ownerId: p.id,
          principal: p,
          channel: 'mcp',
        }),
      () => ({}),
    ),
  );
  const server = new McpServer({ name: 'knowledge-sdk', version: '1.0.0' });
  registerOperations(server, registry, p, {});
  const client = new Client({ name: 'knowledge-sdk', version: '1.0.0' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const discovered = new Map<string, any>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '\\'.repeat(128), result: page })),
    ).toBeLessThanOrEqual(65536);
    for (const tool of page.tools) discovered.set(tool.name, tool);
    cursor = page.nextCursor;
  } while (cursor);
  for (const definition of knowledgeToolDefinitions) {
    expect(discovered.has(definition.name), definition.name).toBe(true);
    expect(discovered.get(definition.name).inputSchema.additionalProperties).toBe(false);
    expect(discovered.get(definition.name).outputSchema).toHaveProperty('anyOf');
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(
      resultSize(result.structuredContent as Record<string, unknown>, '\\'.repeat(128)),
    ).toBeLessThanOrEqual(65536);
    return (result.structuredContent as any).data;
  };
  const created = await call('create_note', {
    directory: '00-Inbox',
    fileName: 'sdk.md',
    content: '# SDK',
    requestId: 'sdk-create',
  });
  await call('update_note', {
    noteId: created.id,
    content: '# SDK updated',
    expectedModifiedAt: created.modifiedAt,
    requestId: 'sdk-update',
  });
  const history = await call('list_note_revisions', { noteId: created.id, limit: 1 });
  expect(history.items).toHaveLength(1);
  await call('set_note_favorite', {
    noteId: created.id,
    favorite: true,
    requestId: 'sdk-favorite',
  });
  expect(await call('list_note_collection', { kind: 'favorites' })).toMatchObject({
    items: [{ id: created.id }],
  });
  const info = await call('get_note_info', { noteId: created.id });
  const share = await call('create_note_share', {
    noteId: created.id,
    expectedModifiedAt: info.modifiedAt,
    permission: 'view',
    requestId: 'sdk-share',
  });
  expect(await call('get_knowledge_operation', { requestId: 'sdk-share' })).toMatchObject({
    status: 'succeeded',
    result: { token: share.token },
  });
  const bytes = Buffer.from('%PDF-1.7\nSDK');
  const upload = await call('begin_note_asset_upload', {
    noteId: created.id,
    expectedModifiedAt: info.modifiedAt,
    name: 'sdk.pdf',
    mime: 'application/pdf',
    totalBytes: bytes.length,
    requestId: 'sdk-asset-begin',
  });
  await call('append_mcp_upload', {
    transferId: upload.transferId,
    offset: 0,
    base64: bytes.toString('base64'),
  });
  const asset = await call('complete_note_asset_upload', {
    transferId: upload.transferId,
    requestId: 'sdk-asset-complete',
  });
  expect(asset.mime).toBe('application/pdf');
});
