import { afterEach, expect, it } from 'vitest';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { policyScopes, projectPermissionPrincipal } from '../packages/core/auth/permissions.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
import { currentBlogInstanceId } from '../packages/core/auth/permissions.js';
import type { PermissionPolicy } from '../shared/permissions.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function integrated(actions = ['read', 'write', 'organize']) {
  const f = await pluginRuntimeFixture();
  cleanups.push(f.close);
  pluginHost(f.config, f.db);
  const identity = f.platform.get().knowledge.organization.context(f.principal);
  const policy: PermissionPolicy = {
    version: 2,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: identity.libraryId,
        actions,
        resources: { mode: 'all' },
      },
    },
  };
  const manifest = JSON.parse(
    await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'),
  );
  f.db
    .prepare(
      `INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state)
    VALUES('mcp',?,?, '[]',?, 'enabled')`,
    )
    .run(
      manifest.version,
      JSON.stringify(manifest),
      JSON.stringify({ mode: 'oauth', permissionPolicy: policy }),
    );
  const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'organization-integration', policy);
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
    { objectIdSecret: 'organization-integration-object-secret-32-characters' },
    hostClient(services, () => ({})),
  );
  const server = new McpServer({ name: 'integration', version: '1.0.0' });
  registerOperations(server, registry, p, {});
  const client = new Client({ name: 'organization-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: any = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return (response.structuredContent as any).data;
  };
  const finish = async (accepted: any) => {
    await f.platform.get().knowledge.organization.drain();
    const op = await call('operation_status', { operationId: accepted.operation.operationId });
    expect(op.status, JSON.stringify(op)).toBe('succeeded');
    return op.result;
  };
  return { ...f, client, call, finish, services, policy, grant, principal: p };
}

it('organizes the entire library through real SDK calls and preserves identity, backlinks and undo', async () => {
  const f = await integrated();
  const rootNote = await f.call('create_note', {
    directoryId: null,
    fileName: 'root.md',
    content: '# Root',
    requestId: 'explicit-root-create',
  });
  expect((await f.call('get_note_info', { noteId: rootNote.id })).relativePath).toBe('root.md');
  await mkdir(join(f.config.knowledgeRoot, 'Fresh Empty'));
  let context = await f.call('get_mcp_context');
  expect(context.policy.domains.knowledge.resources).toEqual({ mode: 'all' });
  expect(context.policy.domains.blog).toBeUndefined();
  expect(context.policy.domains.todo).toBeUndefined();
  let dirs = await f.call('list_directories', {});
  const fresh = dirs.items.find((d: any) => d.path === 'Fresh Empty');
  expect(fresh).toBeDefined();
  const source = await f.call('create_note', {
    directoryId: fresh.id,
    fileName: 'source.md',
    content: '# Source',
    requestId: 'source-create',
  });
  const backlink = await f.call('create_note', {
    directory: '00-Inbox',
    fileName: 'backlink.md',
    content: '[Source](../Fresh%20Empty/source.md#part)',
    requestId: 'backlink-create',
  });
  context = await f.call('get_mcp_context');
  await f.finish(
    await f.call('organize_library', {
      libraryId: context.organization.libraryId,
      expectedStructureRevision: context.organization.structureRevision,
      requestId: 'make-target',
      actions: [{ type: 'create_directory', parentId: null, name: 'New Topic' }],
    }),
  );
  dirs = await f.call('list_directories', {});
  const target = dirs.items.find((d: any) => d.path === 'New Topic');
  const info = await f.call('get_note_info', { noteId: source.id });
  context = await f.call('get_mcp_context');
  const accepted = await f.call('organize_library', {
    libraryId: context.organization.libraryId,
    expectedStructureRevision: context.organization.structureRevision,
    requestId: 'move-source',
    actions: [
      {
        type: 'move_note',
        noteId: source.id,
        toDirectoryId: target.id,
        fileName: 'renamed.md',
        expectedModifiedAt: info.modifiedAt,
        expectedContentHash: info.contentHash,
      },
    ],
  });
  await f.finish(accepted);
  expect((await f.call('get_note_info', { noteId: source.id })).relativePath).toBe(
    'New Topic/renamed.md',
  );
  expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/backlink.md'), 'utf8')).toBe(
    '[Source](../New%20Topic/renamed.md#part)',
  );
  expect((await f.call('get_note_info', { noteId: backlink.id })).id).toBe(backlink.id);
  const history = await f.call('list_organization_history', {});
  expect(history.items.some((o: any) => o.operationId === accepted.operation.operationId)).toBe(
    true,
  );
  await f.finish(
    await f.call('undo_organization', {
      operationId: accepted.operation.operationId,
      requestId: 'undo-move',
    }),
  );
  expect((await f.call('get_note_info', { noteId: source.id })).relativePath).toBe(
    'Fresh Empty/source.md',
  );
  expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/backlink.md'), 'utf8')).toBe(
    '[Source](../Fresh%20Empty/source.md#part)',
  );
});

it('does not give a full-library organizer blog publication or todo authority', async () => {
  const f = await integrated();
  const result = await f.client.callTool({
    name: 'publish_blog_post',
    arguments: {
      noteId: 'unrelated',
      expectedModifiedAt: '1',
      expectedContentHash: 'a'.repeat(64),
      expectedPublishedVersion: 0,
      requestId: 'no-blog-grant',
    },
  });
  expect(result.isError).toBe(true);
  const context = await f.call('get_mcp_context');
  expect(context.policy.domains).not.toHaveProperty('blog');
  expect(context.policy.domains).not.toHaveProperty('todo');
});

it('enforces archive and structural permissions at direct core mutation boundaries', async () => {
  const f = await integrated(['read', 'write']);
  const note = await f.call('create_note', {
    directory: '00-Inbox',
    fileName: 'stay.md',
    content: '# Stay',
    requestId: 'direct-core-create',
  });
  const info = await f.call('get_note_info', { noteId: note.id });
  const p = projectPermissionPrincipal(f.db, f.principal, f.policy);
  expect(() =>
    f.platform.get().knowledge.core.archive(p, note.id, info.modifiedAt, 'direct-core-archive'),
  ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  expect(() =>
    f.platform
      .get()
      .knowledge.core.move(
        p,
        note.id,
        '00-Inbox',
        'renamed.md',
        info.modifiedAt,
        'direct-core-move',
      ),
  ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
});

it('applies an archive-disabled v2 ceiling to a legacy write connection', async () => {
  const f = await integrated(['read', 'write']);
  const created = await f.call('create_note', {
    directory: '00-Inbox',
    fileName: 'legacy.md',
    content: '# Kept',
    requestId: 'legacy-kept-create',
  });
  const grant = oauthGrantStore(f.db).approve(
    f.principal.id,
    'legacy-under-new-ceiling',
    ['knowledge:read', 'knowledge:write'],
    ['00-Inbox'],
  );
  const raw = {
    id: f.principal.id,
    clientId: grant.clientId,
    grantId: grant.id,
    grantVersion: grant.version,
    pluginId: 'mcp',
    tokenIssuedAt: grant.notBefore,
    scopes: grant.scopes,
    allowedPrefixes: grant.allowedPrefixes,
  };
  const p = platformPolicy(f.db, raw)!;
  expect(() =>
    f.platform
      .get()
      .knowledge.core.archive(p, created.id, created.modifiedAt, 'legacy-ceiling-core-deny'),
  ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  const service = pluginServices(
    f.platform,
    f.db,
    'mcp',
    ['knowledge:read', 'knowledge:write', 'knowledge:archive'],
    { ownerId: raw.id, principal: raw, channel: 'mcp' },
  );
  await expect(
    service.knowledge.archive({
      noteId: created.id,
      expectedModifiedAt: created.modifiedAt,
      requestId: 'legacy-ceiling-host-deny',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('publishes through a real v2 host grant with source read permission and no source write permission', async () => {
  const f = await integrated();
  const note = await f.call('create_note', {
    directory: '00-Inbox',
    fileName: 'public.md',
    content: '# Public snapshot',
    requestId: 'readonly-public-source',
  });
  const policy: PermissionPolicy = {
    version: 2,
    domains: {
      knowledge: { ...f.policy.domains.knowledge, actions: ['read'] },
      blog: {
        enabled: true,
        ownerId: f.principal.id,
        instanceId: currentBlogInstanceId(f.db),
        actions: ['read', 'publish'],
        resources: { mode: 'all' },
      },
    },
  };
  f.db
    .prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'")
    .run(JSON.stringify({ permissionPolicy: policy }));
  const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'source-reader-publisher', policy);
  const p = {
    ...f.principal,
    clientId: grant.clientId,
    grantId: grant.id,
    grantVersion: grant.version,
    scopes: grant.scopes,
    permissionPolicy: policy,
    tokenIssuedAt: grant.notBefore,
  };
  const manifest = JSON.parse(
    (f.db.prepare("SELECT manifest_json FROM platform_plugins WHERE id='mcp'").get() as any)
      .manifest_json,
  );
  const services = pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, {
    ownerId: p.id,
    principal: p,
    channel: 'mcp',
  });
  const published = await services.blog!.publish({
    noteId: note.id,
    expectedModifiedAt: note.modifiedAt,
    expectedContentHash: note.contentHash,
    expectedPublicationVersion: 0,
    requestId: 'source-reader-publish',
  });
  expect(published.state).toBe('published');
  await expect(
    services.knowledge.update({
      noteId: note.id,
      content: '# Forbidden',
      expectedModifiedAt: note.modifiedAt,
      requestId: 'reader-cannot-edit',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
