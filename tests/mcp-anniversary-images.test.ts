import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToDooToolPort } from '../apps/server/to-doo/mcp-tools';
import { createToDooAssets } from '../packages/core/to-doo/assets';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { requireScope } from '../packages/core/agent/auth';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';
import type { McpDomainContext } from '../apps/server/plugins/mcp-domain-context';
import type { PluginServices } from '../packages/plugin-sdk';
import { toDooFullToolSchemas } from '../shared/mcp-to-doo-tools';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
  'base64',
);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const f = await pluginRuntimeFixture();
  let actor = { ...f.principal, scopes: ['to-doo:read', 'to-doo:write'] };
  let access: ReturnType<McpDomainContext['toDooAccess']> = {
    listIds: [],
    domains: ['anniversaries'],
  };
  const transfers = createMcpTransferStore(f.config, f.db);
  const context: McpDomainContext = {
    config: f.config,
    db: f.db,
    runtime: f.platform.get(),
    transfers,
    authorize(scopes) {
      for (const scope of scopes) requireScope(actor, scope);
      return actor;
    },
    toDooAccess: () => access,
  };
  const port = createToDooToolPort(context);
  return {
    ...f,
    port,
    transfers,
    actor: () => actor,
    access: () => access,
    setActor: (value: typeof actor) => {
      actor = value;
    },
    setAccess: (value: typeof access) => {
      access = value;
    },
  };
}
async function begin(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  bound?: { anniversaryId: string; expectedRevision: string },
  bytes = png,
) {
  const transfer = await f.port.call('begin_to_doo_anniversary_image', {
    requestId: id,
    bytes: bytes.length,
    sha256: sha(bytes),
    ...bound,
  });
  f.port.authorizeTransfer(transfer.binding as any, true, undefined, 'uploading');
  f.transfers.append(f.actor(), {
    transferId: transfer.transferId as string,
    offset: 0,
    base64: bytes.toString('base64'),
  });
  return transfer;
}
it('uploads, frames, reads and discovers a private anniversary image through the real SDK using ordinary write access', async () => {
  const f = await setup();
  let client: Client | undefined, server: McpServer | undefined;
  try {
    const services = { toDooTools: f.port } as unknown as PluginServices;
    const registry = createOperations(
      { objectIdSecret: 'anniversary-sdk-fixture-object-secret' },
      hostClient(
        () => services,
        () => ({}),
      ),
    );
    server = new McpServer({ name: 'anniversary-sdk', version: '1' });
    registerOperations(server, registry, f.actor(), {});
    client = new Client({ name: 'anniversary-client', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return (result.structuredContent as any).data;
    };
    const started = await call('begin_to_doo_anniversary_image', {
      requestId: 'sdk-image-start',
      bytes: png.length,
      sha256: sha(png),
    });
    f.transfers.append(f.actor(), {
      transferId: started.transferId,
      offset: 0,
      base64: png.toString('base64'),
    });
    const image = await call('finish_to_doo_anniversary_image', {
      requestId: 'sdk-image-finish',
      transferId: started.transferId,
      name: '自己的图片.png',
      mime: 'image/png',
    });
    expect(image).toEqual({
      hash: sha(png),
      name: '自己的图片.png',
      mime: 'image/png',
      size: png.length,
    });
    await call('save_to_doo_entity', {
      requestId: 'sdk-anniversary-create',
      mode: 'create',
      kind: 'anniversary',
      id: 'anniversary',
      fields: {
        name: '记住这一天',
        date: '2026-11-17',
        appearance: {
          style: 'photo',
          palette: 'ocean',
          image: { ...image, x: 17, y: 81, zoom: 1.8 },
        },
      },
    });
    const anniversary = f.platform.get().toDoo.getEntity('anniversary', 'anniversary')!;
    const download = await call('read_to_doo_anniversary_image', {
      requestId: 'sdk-image-read',
      anniversaryId: anniversary.id,
      expectedRevision: anniversary.revision,
    });
    f.port.authorizeTransfer(download.binding, false);
    expect(
      Buffer.from(
        f.transfers.read(f.actor(), { transferId: download.transferId, offset: 0 }).base64,
        'base64',
      ),
    ).toEqual(png);
    const discovered = await call('describe_to_doo_schema', {
      category: 'entity',
      name: 'anniversary',
    });
    expect(JSON.stringify(discovered.schema)).toContain('pixel');
    expect(JSON.stringify(discovered.schema)).toContain('zoom');
    expect(JSON.stringify(image)).not.toContain(f.config.knowledgeRoot);
    const invalidBytes = Buffer.from('<svg>not a PNG</svg>');
    const invalid = await call('begin_to_doo_anniversary_image', {
      requestId: 'sdk-invalid-start',
      bytes: invalidBytes.length,
      sha256: sha(invalidBytes),
    });
    f.transfers.append(f.actor(), {
      transferId: invalid.transferId,
      offset: 0,
      base64: invalidBytes.toString('base64'),
    });
    const rejected = await client.callTool({
      name: 'finish_to_doo_anniversary_image',
      arguments: {
        requestId: 'sdk-invalid-finish',
        transferId: invalid.transferId,
        name: 'fake.png',
        mime: 'image/png',
      },
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
  } finally {
    await client?.close();
    await server?.close();
    await f.close();
  }
});
it('rejects guessed blob associations through every save adapter and only admits uploaded or already authorized images', async () => {
  const f = await setup();
  try {
    const todo = f.platform.get().toDoo;
    // The same blob store can contain a private task attachment. Possession of its hash is insufficient.
    const image = createToDooAssets(todo, {
      knowledgeRoot: f.config.knowledgeRoot,
      db: f.db,
    }).uploadAnniversaryImage({ name: 'private.png', mime: 'image/png', bytes: png });
    const appearance = {
      style: 'photo',
      palette: 'ocean',
      image: { ...image, x: 50, y: 50, zoom: 1 },
    };
    const entity = { id: 'guess', name: 'Guessed image', date: '2026-11-17', appearance };
    const compact = createToDooAgentPort(todo, {
      authorize: () => f.actor(),
      access: () => f.access(),
      canReadNote: () => false,
    });
    await expect(compact.validateEntity('anniversary', entity)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      compact.command({
        requestId: 'compact-guess',
        action: 'save_entity',
        payload: { kind: 'anniversary', entity },
      } as any),
    ).rejects.toMatchObject({ statusCode: 403 });
    for (const name of ['save_to_doo_entity', 'execute_to_doo_command']) {
      await expect(
        f.port.call(
          name,
          name === 'save_to_doo_entity'
            ? {
                requestId: 'full-guess',
                mode: 'create',
                kind: 'anniversary',
                id: entity.id,
                fields: { name: entity.name, date: entity.date, appearance },
              }
            : {
                requestId: 'execute-guess',
                action: 'save_entity',
                payload: { kind: 'anniversary', entity },
              },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    const transfer = await begin(f, 'proof-start');
    const uploaded = await f.port.call('finish_to_doo_anniversary_image', {
      requestId: 'proof-finish',
      transferId: transfer.transferId,
      name: 'mine.png',
      mime: 'image/png',
    });
    const actor = f.actor();
    f.setActor({ ...actor, clientId: 'other-client' });
    await expect(
      f.port.call('save_to_doo_entity', {
        requestId: 'stolen-proof',
        mode: 'create',
        kind: 'anniversary',
        id: 'other',
        fields: { name: 'Other', date: entity.date, appearance },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    f.setActor(actor);
    await f.port.call('save_to_doo_entity', {
      requestId: 'proof-save',
      mode: 'create',
      kind: 'anniversary',
      id: entity.id,
      fields: {
        name: entity.name,
        date: entity.date,
        appearance: { ...appearance, image: { ...uploaded, x: 50, y: 50, zoom: 1 } },
      },
    });
    f.setActor({ ...actor, clientId: 'other-client' });
    // An explicitly readable nondeleted anniversary is a valid existing source for image reuse/cropping.
    await expect(
      compact.validateEntity('anniversary', { ...entity, id: 'copy' }),
    ).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});
it('binds replacements to entity revision, preserves acknowledged replays, and denies deleted or newly restricted resources', async () => {
  const f = await setup();
  try {
    const todo = f.platform.get().toDoo;
    todo.command({
      requestId: 'anniv-create',
      action: 'save_entity',
      payload: {
        kind: 'anniversary',
        entity: { id: 'anniversary', name: 'Before', date: '2026-11-17' },
      },
    });
    const first = todo.getEntity('anniversary', 'anniversary')!;
    const bound = { anniversaryId: first.id, expectedRevision: first.revision };
    const transfer = await begin(f, 'image-bound-start', bound);
    const input = {
      requestId: 'image-bound-finish',
      transferId: transfer.transferId,
      ...bound,
      name: 'image.png',
      mime: 'image/png',
    };
    const image = await f.port.call('finish_to_doo_anniversary_image', input);
    await expect(
      f.port.call('save_to_doo_entity', {
        requestId: 'bound-proof-wrong-target',
        kind: 'anniversary',
        mode: 'create',
        id: 'wrong-target',
        fields: {
          name: 'Wrong target',
          date: '2026-11-17',
          appearance: {
            style: 'photo',
            palette: 'sage',
            image: { ...image, x: 50, y: 50, zoom: 1 },
          },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    todo.command({
      requestId: 'anniv-apply',
      action: 'save_entity',
      payload: {
        kind: 'anniversary',
        expectedRevision: first.revision,
        entity: {
          ...first,
          appearance: {
            style: 'photo',
            palette: 'sage',
            image: { ...image, x: 15, y: 80, zoom: 1.5 },
          },
        },
      },
    });
    expect(await f.port.call('finish_to_doo_anniversary_image', input)).toEqual(image);
    const current = todo.getEntity('anniversary', first.id)!;
    const nextBound = { anniversaryId: current.id, expectedRevision: current.revision };
    const next = await begin(f, 'next-image-start', nextBound);
    const download = await f.port.call('read_to_doo_anniversary_image', {
      requestId: 'image-read-before-update',
      ...nextBound,
    });
    todo.command({
      requestId: 'anniv-renamed',
      action: 'save_entity',
      payload: {
        kind: 'anniversary',
        expectedRevision: current.revision,
        entity: { ...current, name: 'Changed elsewhere' },
      },
    });
    await expect(
      f.port.call('finish_to_doo_anniversary_image', {
        ...input,
        ...nextBound,
        requestId: 'next-image-finish',
        transferId: next.transferId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(() => f.port.authorizeTransfer(download.binding as any, false)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    f.setAccess({ listIds: ['not-global'], domains: ['anniversaries'] });
    await expect(f.port.call('finish_to_doo_anniversary_image', input)).rejects.toMatchObject({
      statusCode: 403,
    });
    f.setAccess({ listIds: [], domains: ['anniversaries'] });
    const updated = todo.getEntity('anniversary', first.id)!;
    todo.command({
      requestId: 'anniv-delete',
      action: 'delete_entity',
      payload: { kind: 'anniversary', id: updated.id, expectedRevision: updated.revision },
    });
    await expect(f.port.call('finish_to_doo_anniversary_image', input)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(() => f.port.authorizeTransfer(download.binding as any, false)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  } finally {
    await f.close();
  }
});
it('rejects changed policy, other clients, unsupported bytes and unbound hash reads', async () => {
  const f = await setup();
  try {
    const started = await begin(f, 'image-policy-start');
    const input = {
      requestId: 'image-policy-finish',
      transferId: started.transferId,
      name: 'image.png',
      mime: 'image/png',
    };
    const actor = f.actor();
    f.setActor({ ...actor, clientId: 'another-client' });
    await expect(f.port.call('finish_to_doo_anniversary_image', input)).rejects.toThrow();
    f.setActor(actor);
    f.setAccess({ listIds: [], domains: ['anniversaries', 'habits'] });
    await expect(f.port.call('finish_to_doo_anniversary_image', input)).rejects.toMatchObject({
      statusCode: 403,
    });
    f.setAccess({ listIds: [], domains: ['anniversaries'] });
    f.setActor({ ...actor, scopes: ['to-doo:read'] });
    expect(() => f.port.authorizeTransfer(started.binding as any, true)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    f.setActor(actor);
    const bad = await begin(
      f,
      'invalid-image-start',
      undefined,
      Buffer.from('<svg>not a PNG</svg>'),
    );
    await expect(
      f.port.call('finish_to_doo_anniversary_image', {
        ...input,
        requestId: 'invalid-image-finish',
        transferId: bad.transferId,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      toDooFullToolSchemas.begin_to_doo_anniversary_image.safeParse({
        requestId: 'large',
        bytes: 10 * 1024 * 1024 + 1,
        sha256: sha(png),
      }).success,
    ).toBe(false);
    expect(
      toDooFullToolSchemas.begin_to_doo_anniversary_image.safeParse({
        requestId: 'no-cas',
        bytes: png.length,
        sha256: sha(png),
        anniversaryId: 'some',
      }).success,
    ).toBe(false);
    await expect(
      f.port.call('read_to_doo_anniversary_image', { requestId: 'raw-hash', hash: sha(png) }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      f.platform.get().toDoo.snapshot({ kind: 'anniversary', all: true }).anniversaries,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
