import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { openDatabase } from '../../packages/core/db';
import { platformRuntime } from '../../apps/server/platform/runtime';
import { pluginHost } from '../../apps/server/plugins/host';
import { pluginServices } from '../../apps/server/plugins/services';
import { oauthGrantStore } from '../../apps/server/platform/oauth-grants';
import { currentToDooInstanceId, policyScopes } from '../../packages/core/auth/permissions';
import { createOperations, registerOperations } from '../../plugins/mcp/server/operations';
import { hostClient } from '../../plugins/mcp/server/service';
import type { AppConfig } from '../../shared/contracts';
import type { PermissionPolicy } from '../../shared/permissions';

const { allowed, privateTask, privateList, title, updatedTitle } = JSON.parse(process.argv[2]);
const config: AppConfig = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
const root = dirname(resolve(config.dataRoot));
if (
  dirname(root) !== resolve(tmpdir()) ||
  !basename(root).startsWith('dooknow-browser-') ||
  dirname(resolve(config.knowledgeRoot)) !== root
)
  throw Error('SDK acceptance must use the isolated browser fixture');
const db = openDatabase(config.dataRoot);
const ownerId = (db.prepare('SELECT id FROM user LIMIT 1').get() as { id: string }).id;
const runtimeConfig = {
  ...config,
  agentConfigFile: undefined,
  indexing: { enabled: false, watch: false },
  agent: {
    serviceToken: 'roundtrip-fixture-service-only',
    assertionSecret: 'roundtrip-fixture-assertion-only',
    issuer: 'fixture',
    audience: 'fixture',
    policies: [],
  },
};
const platform = platformRuntime(runtimeConfig, db);
let client: Client | undefined;
let server: McpServer | undefined;
const clientId = 'browser-sdk-' + crypto.randomUUID();
const priorPlugin = db.prepare("SELECT * FROM platform_plugins WHERE id='mcp'").get() as
  | { config_json: string; state: string }
  | undefined;
try {
  await platform.activate();
  pluginHost(runtimeConfig, db);
  const policy: PermissionPolicy = {
    version: 2,
    domains: {
      'to-doo': {
        enabled: true,
        ownerId,
        instanceId: currentToDooInstanceId(db),
        actions: ['read', 'write'],
        resources: { mode: 'selected', resources: [{ kind: 'list', id: allowed }] },
      },
    },
  };
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'plugins/mcp/manifest.json'), 'utf8'),
  );
  db.prepare(
    `INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state)
      VALUES('mcp',?,?,'[]',?,'enabled') ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,state='enabled'`,
  ).run(
    manifest.version,
    JSON.stringify(manifest),
    JSON.stringify({ oauthEnabled: true, apiKeyEnabled: false, permissionPolicy: policy, toDooDomains: ['tasks'] }),
  );
  const grants = oauthGrantStore(db);
  const grant = grants.approveV2(ownerId, clientId, policy);
  const principal = {
    id: ownerId,
    ownerId,
    clientId,
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
    pluginServices(platform, db, 'mcp', manifest.capabilities, {
      ownerId,
      principal,
      channel: 'mcp',
    });
  const registry = createOperations(
    { objectIdSecret: 'browser-sdk-fixture-object-secret-32-chars' },
    hostClient(services, () => ({})),
  );
  server = new McpServer({ name: 'browser-roundtrip', version: '1.0.0' });
  registerOperations(server, registry, principal, {});
  client = new Client({ name: 'browser-roundtrip-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  async function call(name: string, args: Record<string, unknown>) {
    return (await client!.callTool({ name, arguments: args })) as any;
  }
  const query = await call('query_to_doos', { kind: 'task', listIds: [allowed] });
  assert.notEqual(query.isError, true);
  assert.equal(JSON.stringify(query).includes('PRIVATE_RESOURCE_NOT_SHARED'), false);
  assert.equal(query.structuredContent.data.total, 1);
  const task = query.structuredContent.data.items[0].entity;
  assert.equal(task.title, title);
  assert.equal(task.listId, allowed);
  const patchArgs = {
    requestId: crypto.randomUUID(),
    kind: 'task',
    mode: 'patch',
    id: task.id,
    expectedRevision: task.revision,
    fields: { title: updatedTitle },
  };
  const patch = await call('save_to_doo_entity', patchArgs);
  assert.notEqual(patch.isError, true);
  const retry = await call('save_to_doo_entity', patchArgs);
  assert.notEqual(retry.isError, true);
  assert.equal(retry.structuredContent.data.replayed, true);
  const privateRead = await call('query_to_doos', { kind: 'task', ids: [privateTask] });
  assert.notEqual(privateRead.isError, true);
  assert.deepEqual(privateRead.structuredContent.data.items, []);
  const denied = await call('save_to_doo_entity', {
    requestId: crypto.randomUUID(),
    kind: 'task',
    mode: 'create',
    fields: { title: 'Denied SDK write', listId: privateList },
  });
  assert.equal(denied.isError, true);
  grants.revoke(ownerId, clientId);
  const revoked = await call('save_to_doo_entity', {
    requestId: crypto.randomUUID(),
    kind: 'task',
    mode: 'patch',
    id: task.id,
    expectedRevision: patch.structuredContent.data.changed[0].revision,
    fields: { title: 'Must not be written after revocation' },
  });
  assert.equal(revoked.isError, true);
  process.stdout.write(
    JSON.stringify({
      title: task.title,
      updatedTitle,
      scopedTotal: 1,
      replayed: true,
      privateDenied: true,
      revoked: true,
    }) + '\n',
  );
} finally {
  await client?.close();
  await server?.close();
  await platform.close();
  db.prepare('DELETE FROM platform_grants WHERE owner_id=? AND client_id=?').run(ownerId, clientId);
  if (priorPlugin)
    db.prepare("UPDATE platform_plugins SET config_json=?,state=? WHERE id='mcp'").run(
      priorPlugin.config_json,
      priorPlugin.state,
    );
  else db.prepare("DELETE FROM platform_plugins WHERE id='mcp'").run();
  db.close();
}
