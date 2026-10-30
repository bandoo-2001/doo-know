import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createToDooToolPort } from '../apps/server/to-doo/mcp-tools';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { requireScope } from '../packages/core/agent/auth';
import { KnowledgeError } from '../packages/core/knowledge/errors';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../shared/mcp-frame';
import type { McpDomainContext } from '../apps/server/plugins/mcp-domain-context';
const rights = ['to-doo:read', 'to-doo:write', 'to-doo:share', 'to-doo:integrations'];

it('requires tasks content for selected-list feed URLs and managed feed writes', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, scopes: [...f.principal.scopes, ...rights] },
      todo = f.platform.get().toDoo;
    let domains = ['calendar'];
    const port = createToDooToolPort({
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        scopes.forEach((scope) => requireScope(p, scope));
        return p;
      },
      toDooAccess: () => ({ listIds: ['allowed-list'], domains }),
      transfers: createMcpTransferStore(f.config, f.db),
    });
    todo.command({
      requestId: 'feed-list',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'allowed-list', name: 'Allowed' } },
    });
    todo.command({
      requestId: 'feed-task',
      action: 'create_task',
      payload: {
        title: 'TASK-DOMAIN-SECRET',
        description: 'TASK-DESCRIPTION-SECRET',
        listId: 'allowed-list',
        due: { date: new Date().toISOString().slice(0, 10), time: '12:00', timeZone: 'UTC' },
      },
    });
    const input = {
      requestId: 'calendar-only-feed',
      action: 'create',
      name: 'Feed',
      listIds: ['allowed-list'],
      includeDescription: true,
    };
    await expect(port.call('manage_to_doo_feed', input)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      port.call('save_to_doo_entity', {
        requestId: 'calendar-only-managed',
        kind: 'calendarFeed',
        mode: 'create',
        id: 'managed-feed',
        fields: { name: 'Managed', listIds: ['allowed-list'], enabled: true },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(todo.snapshot({ all: true }).calendarFeeds).toHaveLength(0);
    domains = ['calendar', 'tasks'];
    const created: any = await port.call('manage_to_doo_feed', input);
    expect(f.platform.get().toDooInterop.readFeed(created.token)).toContain('TASK-DOMAIN-SECRET');
    domains = ['calendar'];
    await expect(port.call('manage_to_doo_feed', input)).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await f.close();
  }
});

it('includes Inbox tasks in Inbox-only and mixed feeds and excludes unselected named lists', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, scopes: [...f.principal.scopes, ...rights] },
      todo = f.platform.get().toDoo;
    const port = createToDooToolPort({
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        scopes.forEach((scope) => requireScope(p, scope));
        return p;
      },
      toDooAccess: () => ({ listIds: ['inbox', 'named-list'], domains: ['calendar', 'tasks'] }),
      transfers: createMcpTransferStore(f.config, f.db),
    });
    for (const id of ['named-list', 'private-list'])
      todo.command({
        requestId: 'seed-' + id,
        action: 'save_entity',
        payload: { kind: 'list', entity: { id, name: id } },
      });
    for (const [title, listId] of [
      ['INBOX-DUE-TASK', null],
      ['NAMED-DUE-TASK', 'named-list'],
      ['PRIVATE-DUE-TASK', 'private-list'],
    ] as const)
      todo.command({
        requestId: 'seed-' + title,
        action: 'create_task',
        payload: {
          title,
          listId,
          due: { date: new Date().toISOString().slice(0, 10), time: '12:00', timeZone: 'UTC' },
        },
      });
    const inbox: any = await port.call('manage_to_doo_feed', {
      requestId: 'inbox-feed',
      action: 'create',
      name: 'Inbox',
      listIds: ['inbox'],
    });
    const one = f.platform.get().toDooInterop.readFeed(inbox.token);
    expect(one).toContain('INBOX-DUE-TASK');
    expect(one).not.toContain('NAMED-DUE-TASK');
    expect(one).not.toContain('PRIVATE-DUE-TASK');
    const mixed: any = await port.call('manage_to_doo_feed', {
      requestId: 'mixed-feed',
      action: 'create',
      name: 'Mixed',
      listIds: ['inbox', 'named-list'],
    });
    const both = f.platform.get().toDooInterop.readFeed(mixed.token);
    expect(both).toContain('INBOX-DUE-TASK');
    expect(both).toContain('NAMED-DUE-TASK');
    expect(both).not.toContain('PRIVATE-DUE-TASK');
  } finally {
    await f.close();
  }
});

it('recovers every large template item with read-only version/hash-bound JSON pages and filters note/internal access', async () => {
  const f = await pluginRuntimeFixture();
  try {
    let p = { ...f.principal, scopes: ['to-doo:read'] },
      access = { listIds: [] as string[], domains: ['tasks'] };
    const context: McpDomainContext = {
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        scopes.forEach((scope) => requireScope(p, scope));
        return p;
      },
      toDooAccess: () => access,
      transfers: createMcpTransferStore(f.config, f.db),
    };
    const port = createToDooToolPort(context),
      todo = f.platform.get().toDoo,
      note = f.platform.get().notes.createNote('00-Inbox', 'page-note.md', '# Evidence');
    todo.command({
      requestId: 'large-template',
      action: 'save_entity',
      payload: {
        kind: 'template',
        entity: {
          id: 'template-many',
          name: 'Many',
          tasks: Array.from({ length: 40 }, (_, i) => ({
            key: 'step' + i,
            title: 'Step ' + i,
            description: '🙂"\\\t'.repeat(150),
            noteRefs: [{ noteId: note.id, role: 'material' }],
          })),
        },
      },
    });
    const query = createToDooAgentPort(todo, {
      authorize: () => p,
      access: () => access,
      canReadNote: async () => false,
    });
    const summary = await query.query({ kind: 'template', ids: ['template-many'] });
    expect(summary.items[0].truncatedFields).toContain('*');
    const revision = todo.getEntity('template', 'template-many')!.revision;
    let offset = 0,
      sha256: string | undefined,
      json = '';
    for (let page = 0; page < 100; page++) {
      const result: any = await port.call('read_to_doo_entity', {
        kind: 'template',
        id: 'template-many',
        expectedRevision: revision,
        offset,
        maxBytes: 8192,
        ...(sha256 ? { expectedContentHash: sha256 } : {}),
      });
      expect(mcpResultFrameSize({ data: result })).toBeLessThanOrEqual(mcpMaximumFrameBytes);
      json += result.content;
      sha256 = result.sha256;
      if (result.range.nextOffset === null) break;
      offset = result.range.nextOffset;
    }
    const body = JSON.parse(json);
    expect(body.tasks).toHaveLength(40);
    expect(body.tasks.map((item: any) => item.key)).toEqual(
      Array.from({ length: 40 }, (_, i) => 'step' + i),
    );
    expect(json).not.toContain(note.id);
    expect(p.scopes).toEqual(['to-doo:read']);
    await expect(
      port.call('read_to_doo_entity', {
        kind: 'operation',
        id: 'unknown',
        expectedRevision: 'unknown',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    access = { listIds: ['some-list'], domains: ['tasks'] };
    await expect(
      port.call('read_to_doo_entity', {
        kind: 'template',
        id: 'template-many',
        expectedRevision: revision,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    access = { listIds: [], domains: ['tasks'] };
    p = { ...p, scopes: ['to-doo:read', 'knowledge:read'] };
    const before: any = await port.call('read_to_doo_entity', {
      kind: 'template',
      id: 'template-many',
      expectedRevision: revision,
      maxBytes: 200,
    });
    p = { ...p, scopes: ['to-doo:read'] };
    await expect(
      port.call('read_to_doo_entity', {
        kind: 'template',
        id: 'template-many',
        expectedRevision: revision,
        offset: before.range.nextOffset,
        expectedContentHash: before.sha256,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    todo.command({
      requestId: 'newer-template',
      action: 'save_entity',
      payload: {
        kind: 'template',
        expectedRevision: revision,
        entity: { id: 'template-many', name: 'Later' },
      },
    });
    await expect(
      port.call('read_to_doo_entity', {
        kind: 'template',
        id: 'template-many',
        expectedRevision: revision,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  } finally {
    await f.close();
  }
});

it('claims an attachment upload before mutation and blocks another finalization identity even after a precommit conflict', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, scopes: [...f.principal.scopes, ...rights] },
      todo = f.platform.get().toDoo,
      transfers = createMcpTransferStore(f.config, f.db);
    const port = createToDooToolPort({
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        scopes.forEach((scope) => requireScope(p, scope));
        return p;
      },
      toDooAccess: () => ({ listIds: [], domains: ['tasks'] }),
      transfers,
    });
    const taskId = todo.command({
        requestId: 'claim-task',
        action: 'create_task',
        payload: { title: 'Claim' },
      }).ids[0],
      revision = todo.getEntity('task', taskId)!.revision,
      bytes = Buffer.from('one immutable attachment');
    const upload: any = await port.call('begin_to_doo_attachment', {
      requestId: 'claim-upload',
      taskId,
      expectedRevision: revision,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    transfers.append(p, {
      transferId: upload.transferId,
      offset: 0,
      base64: bytes.toString('base64'),
    });
    const finish = {
        requestId: 'claimed-finalizer',
        transferId: upload.transferId,
        taskId,
        expectedRevision: revision,
        name: 'claim.txt',
        mime: 'text/plain',
      },
      command = todo.command;
    let mutations = 0,
      conflict = true;
    todo.command = (input, options) => {
      if ((input as any).action === 'attach_asset') {
        mutations++;
        if (conflict)
          throw new KnowledgeError(409, 'TO_DOO_CONFLICT', 'Injected precommit conflict');
      }
      return command(input, options);
    };
    await expect(port.call('finish_to_doo_attachment', finish)).rejects.toMatchObject({
      statusCode: 409,
    });
    conflict = false;
    await expect(
      port.call('finish_to_doo_attachment', { ...finish, requestId: 'alternate-finalizer' }),
    ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
    expect(mutations).toBe(1);
    expect((todo.getEntity('task', taskId) as any).attachments).toHaveLength(0);
    const result = await port.call('finish_to_doo_attachment', finish);
    expect(mutations).toBe(2);
    expect((todo.getEntity('task', taskId) as any).attachments).toHaveLength(1);
    expect(await port.call('finish_to_doo_attachment', finish)).toEqual(result);
    expect(mutations).toBe(2);
  } finally {
    await f.close();
  }
});

it('claims import upload identity before persisting a preview', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, scopes: [...f.principal.scopes, ...rights] },
      todo = f.platform.get().toDoo,
      transfers = createMcpTransferStore(f.config, f.db);
    const port = createToDooToolPort({
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        scopes.forEach((scope) => requireScope(p, scope));
        return p;
      },
      toDooAccess: () => ({ listIds: ['import-list'], domains: ['tasks'] }),
      transfers,
    });
    todo.command({
      requestId: 'import-list',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'import-list', name: 'Import' } },
    });
    const bytes = Buffer.from('Task ID,Title\n1,Import once'),
      upload: any = await port.call('begin_to_doo_import', {
        requestId: 'import-claim-upload',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        listId: 'import-list',
      });
    transfers.append(p, {
      transferId: upload.transferId,
      offset: 0,
      base64: bytes.toString('base64'),
    });
    const input = {
      requestId: 'import-preview-claim',
      transferId: upload.transferId,
      format: 'csv',
      timeZone: 'UTC',
      listId: 'import-list',
      target: 'tasks',
    };
    const preview = await port.call('preview_to_doo_import', input);
    await expect(
      port.call('preview_to_doo_import', { ...input, requestId: 'alternate-preview-claim' }),
    ).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM to_doo_import_previews').get() as any).n).toBe(
      1,
    );
    expect(await port.call('preview_to_doo_import', input)).toEqual(preview);
  } finally {
    await f.close();
  }
});
