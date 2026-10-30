import { expect, it } from 'vitest';
import { createToDooToolPort } from '../apps/server/to-doo/mcp-tools';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { requireScope } from '../packages/core/agent/auth';
import type { McpDomainContext } from '../apps/server/plugins/mcp-domain-context';
import type { McpTransferStore } from '../shared/mcp-domain-tools';

it('uses real To Doo entities with discoverable schemas, preserves omitted patch fields and denies private lists and reserved administration', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, scopes: [...f.principal.scopes, 'to-doo:read', 'to-doo:write'] };
    let access = {
      listIds: ['allowed-list'],
      domains: ['tasks', 'records', 'habits', 'anniversaries'],
    };
    const context: McpDomainContext = {
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        for (const scope of scopes) requireScope(p, scope);
        return p;
      },
      toDooAccess: () => access,
      transfers: {} as McpTransferStore,
    };
    const port = createToDooToolPort(context);
    const list = await port.call('save_to_doo_entity', {
      requestId: 'list-create',
      kind: 'list',
      mode: 'create',
      id: 'allowed-list',
      fields: { name: 'Goal', kind: 'goal', color: '#abcdef', criteria: 'Keep criteria' },
    });
    const entity = f.platform.get().toDoo.getEntity('list', 'allowed-list')!;
    await port.call('save_to_doo_entity', {
      requestId: 'list-patch',
      kind: 'list',
      mode: 'patch',
      id: 'allowed-list',
      expectedRevision: entity.revision,
      fields: { description: 'Changed only description' },
    });
    expect(f.platform.get().toDoo.getEntity('list', 'allowed-list')).toMatchObject({
      kind: 'goal',
      color: '#abcdef',
      criteria: 'Keep criteria',
      description: 'Changed only description',
    });
    await expect(
      port.call('save_to_doo_entity', {
        requestId: 'private-create',
        kind: 'task',
        mode: 'create',
        fields: { title: 'private', listId: 'private-list' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      port.call('manage_to_doo_feed', {
        requestId: 'feed-create',
        action: 'create',
        name: 'leak',
        listIds: ['allowed-list'],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      port.call('execute_to_doo_command', {
        requestId: 'legacy-feed-escalation',
        action: 'save_entity',
        payload: { kind: 'calendarFeed', entity: { name: 'leak', enabled: true } },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const catalog: any = await port.call('describe_to_doo_schema', { limit: 15 });
    expect(catalog.items).toContainEqual(
      expect.objectContaining({ name: 'attach_asset', tool: 'finish_to_doo_attachment' }),
    );
    const task = await port.call('save_to_doo_entity', {
      requestId: 'task-create',
      kind: 'task',
      mode: 'create',
      fields: { title: 'Allowed task', listId: 'allowed-list' },
    });
    expect(
      await port.call('save_to_doo_entity', {
        requestId: 'task-create',
        kind: 'task',
        mode: 'create',
        fields: { title: 'Allowed task', listId: 'allowed-list' },
      }),
    ).toMatchObject({ replayed: true, ids: task.ids });
    const current = f.platform.get().toDoo.getEntity('task', (task.ids as string[])[0])!;
    await expect(
      port.call('save_to_doo_entity', {
        requestId: 'stale-patch',
        kind: 'task',
        mode: 'patch',
        id: current.id,
        expectedRevision: 'stale',
        fields: { title: 'bad' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(list.ids).toContain('allowed-list');
  } finally {
    await f.close();
  }
});

it('requires live knowledge write and records permission before creating any outcome note or operation', async () => {
  const f = await pluginRuntimeFixture();
  try {
    let p = { ...f.principal, scopes: [...f.principal.scopes, 'to-doo:read', 'to-doo:write'] };
    const context: McpDomainContext = {
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        for (const scope of scopes) requireScope(p, scope);
        return p;
      },
      toDooAccess: () => ({ listIds: [], domains: ['tasks', 'records'] }),
      transfers: {} as McpTransferStore,
    };
    const todo = f.platform.get().toDoo,
      task = todo.command({
        requestId: 'outcome-task',
        action: 'create_task',
        payload: { title: 'Evidence task' },
      }).ids[0];
    const occurrence = todo.snapshot({ all: true }).occurrences.find((o) => o.taskId === task)!;
    const port = createToDooToolPort(context),
      input = {
        requestId: 'outcome-create',
        occurrenceId: occurrence.id,
        expectedRevision: occurrence.revision,
        title: 'Evidence',
        folderPath: '00-Inbox',
        content: '# Evidence',
        complete: true,
      };
    p = { ...p, scopes: p.scopes.filter((scope) => scope !== 'knowledge:write') };
    await expect(port.call('create_to_doo_outcome_note', input)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(todo.snapshot({ all: true }).operations).toHaveLength(0);
    p = { ...p, scopes: [...p.scopes, 'knowledge:write'], allowedPrefixes: ['Different-folder'] };
    await expect(port.call('create_to_doo_outcome_note', input)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(todo.snapshot({ all: true }).operations).toHaveLength(0);
    p = { ...p, allowedPrefixes: ['00-Inbox'] };
    const result = await port.call('create_to_doo_outcome_note', input);
    expect(f.platform.get().notes.getNote(result.noteId as string).content).toBe('# Evidence');
    expect(todo.getEntity('occurrence', occurrence.id)).toMatchObject({ status: 'done' });
    expect(await port.call('create_to_doo_outcome_note', input)).toMatchObject({
      noteId: result.noteId,
    });
    const operation = await port.call('get_to_doo_outcome_operation', {
      requestId: input.requestId,
    });
    expect(operation).toMatchObject({ state: 'completed', noteId: result.noteId });
    const draft = await port.call('get_to_doo_outcome_operation', {
      operationId: operation.operationId,
      expectedRevision: operation.revision,
      includeContent: true,
    });
    expect(draft.content).toBe(''); // completed operations discard the draft; note content remains readable by knowledge tools
    p = { ...p, clientId: 'another-client' };
    await expect(
      port.call('get_to_doo_outcome_operation', { operationId: operation.operationId }),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await f.close();
  }
});

it('exports only authorized lists and content domains through real opaque transfers and checks attachment upload hashes and revisions', async () => {
  const { createMcpTransferStore } = await import('../apps/server/plugins/mcp-transfers');
  const f = await pluginRuntimeFixture();
  try {
    const p = {
      ...f.principal,
      scopes: [
        ...f.principal.scopes,
        'to-doo:read',
        'to-doo:write',
        'to-doo:share',
        'to-doo:integrations',
      ],
    };
    const transfers = createMcpTransferStore(f.config, f.db);
    let access = { listIds: ['allowed-list'], domains: ['tasks'] };
    const context: McpDomainContext = {
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        for (const scope of scopes) requireScope(p, scope);
        return p;
      },
      toDooAccess: () => access,
      transfers,
    };
    const port = createToDooToolPort(context),
      todo = f.platform.get().toDoo;
    for (const id of ['allowed-list', 'private-list'])
      todo.command({
        requestId: 'seed-' + id,
        action: 'save_entity',
        payload: { kind: 'list', entity: { id, name: id } },
      });
    const evidence = f.platform
      .get()
      .notes.createNote('00-Inbox', 'export-evidence.md', '# Export evidence');
    const taskId = todo.command({
      requestId: 'seed-allowed-task',
      action: 'create_task',
      payload: {
        title: 'Allowed public data',
        listId: 'allowed-list',
        noteRefs: [{ noteId: evidence.id, role: 'material' }],
      },
    }).ids[0];
    todo.command({
      requestId: 'seed-private-task',
      action: 'create_task',
      payload: { title: 'TOP SECRET PRIVATE', listId: 'private-list' },
    });
    todo.command({
      requestId: 'seed-private-anniversary',
      action: 'save_entity',
      payload: {
        kind: 'anniversary',
        entity: { name: 'TOP SECRET ANNIVERSARY', date: '2026-10-29' },
      },
    });
    const output: any = await port.call('export_to_doo_data', {
      requestId: 'export-authorized',
      format: 'json',
    });
    expect(output.direction).toBe('download');
    const bytes = transfers.read(p, { transferId: output.transferId, offset: 0, maxBytes: 8192 });
    const json = Buffer.from(bytes.base64, 'base64').toString('utf8');
    expect(json).toContain('Allowed public data');
    expect(json).not.toContain('TOP SECRET');
    expect(json).not.toContain('private-list');
    expect(json).not.toContain('checkpoint');
    const { mkdir, rename } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(f.config.knowledgeRoot, 'Private'));
    await rename(
      join(f.config.knowledgeRoot, '00-Inbox', 'export-evidence.md'),
      join(f.config.knowledgeRoot, 'Private', 'export-evidence.md'),
    );
    f.platform.get().notes.scan();
    expect(() => port.authorizeTransfer(output.binding, false)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    const before = todo.getEntity('task', taskId)!;
    todo.command({
      requestId: 'export-resource-moved',
      action: 'update_task',
      payload: {
        id: taskId,
        expectedRevision: before.revision,
        patch: { title: 'Changed after export' },
      },
    });
    expect(() => port.authorizeTransfer(output.binding, false)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    await expect(
      port.call('export_to_doo_data', {
        requestId: 'export-unrestricted',
        format: 'json',
        fullDataset: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const { createHash } = await import('node:crypto'),
      content = Buffer.from('attachment body'),
      sha256 = createHash('sha256').update(content).digest('hex'),
      revision = todo.getEntity('task', taskId)!.revision;
    const start: any = await port.call('begin_to_doo_attachment', {
      requestId: 'attachment-start',
      taskId,
      expectedRevision: revision,
      bytes: content.length,
      sha256,
    });
    transfers.append(p, {
      transferId: start.transferId,
      offset: 0,
      base64: content.toString('base64'),
    });
    const finish = {
      requestId: 'attachment-finish',
      transferId: start.transferId,
      taskId,
      expectedRevision: revision,
      name: 'evidence.txt',
      mime: 'text/plain',
    };
    const receipt = await port.call('finish_to_doo_attachment', finish);
    expect(todo.getEntity('task', taskId)).toMatchObject({
      attachments: [{ hash: sha256, name: 'evidence.txt' }],
    });
    expect(await port.call('finish_to_doo_attachment', finish)).toEqual(receipt);
    expect(
      await port.call('get_to_doo_operation', { requestId: 'attachment-finish' }),
    ).toMatchObject({ state: 'completed', result: receipt });
    access = { listIds: ['private-list'], domains: ['tasks'] };
    await expect(port.call('finish_to_doo_attachment', finish)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(() => port.authorizeTransfer(output.binding, false)).toThrow();
  } finally {
    await f.close();
  }
});

it('rechecks bounded import scope before apply and every background batch, and supports cancel/resume/status without caching progress', async () => {
  const { createMcpTransferStore } = await import('../apps/server/plugins/mcp-transfers');
  const { createToDooInterop } = await import('../packages/core/to-doo/interop');
  const { createHash } = await import('node:crypto');
  const f = await pluginRuntimeFixture();
  const interop = createToDooInterop(f.platform.get().toDoo, {
    db: f.db,
    dataRoot: f.config.dataRoot,
    importBatchSize: 1,
  });
  try {
    const p = {
      ...f.principal,
      scopes: [...f.principal.scopes, 'to-doo:read', 'to-doo:write', 'to-doo:integrations'],
    };
    let access = { listIds: ['allowed-list'], domains: ['tasks'] };
    const transfers = createMcpTransferStore(f.config, f.db),
      context: McpDomainContext = {
        config: f.config,
        db: f.db,
        runtime: { ...f.platform.get(), toDooInterop: interop },
        authorize(scopes) {
          for (const scope of scopes) requireScope(p, scope);
          return p;
        },
        toDooAccess: () => access,
        transfers,
      };
    const port = createToDooToolPort(context),
      todo = f.platform.get().toDoo;
    todo.command({
      requestId: 'import-list-seed',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'allowed-list', name: 'Allowed' } },
    });
    const content = Buffer.from('Task ID,Title\n1,Imported one\n2,Imported two'),
      sha256 = createHash('sha256').update(content).digest('hex');
    const start: any = await port.call('begin_to_doo_import', {
      requestId: 'import-start',
      bytes: content.length,
      sha256,
      listId: 'allowed-list',
    });
    transfers.append(p, {
      transferId: start.transferId,
      offset: 0,
      base64: content.toString('base64'),
    });
    const preview: any = await port.call('preview_to_doo_import', {
      requestId: 'import-preview',
      transferId: start.transferId,
      format: 'csv',
      timeZone: 'UTC',
      target: 'tasks',
      listId: 'allowed-list',
    });
    expect(preview.total).toBeGreaterThan(2);
    const review: any = await port.call('read_to_doo_import_preview', {
      requestId: 'import-preview-download',
      previewId: preview.previewId,
    });
    const reviewBytes = transfers.read(p, {
      transferId: review.transferId,
      offset: 0,
      maxBytes: 8192,
    });
    expect(Buffer.from(reviewBytes.base64, 'base64').toString('utf8')).toContain('Imported one');
    const apply: any = await port.call('manage_to_doo_import', {
      requestId: 'import-apply',
      previewId: preview.previewId,
      action: 'apply',
    });
    expect(apply.status).toBe('queued');
    access = { listIds: ['private-list'], domains: ['tasks'] };
    await interop.processImportJobs();
    expect(interop.importStatus(preview.previewId).status).toBe('failed');
    expect(todo.snapshot({ all: true }).tasks).toHaveLength(0);
    await expect(
      port.call('manage_to_doo_import', {
        requestId: 'import-resume-denied',
        previewId: preview.previewId,
        action: 'resume',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    access = { listIds: ['allowed-list'], domains: ['tasks'] };
    await port.call('manage_to_doo_import', {
      requestId: 'import-cancel',
      previewId: preview.previewId,
      action: 'cancel',
    });
    await port.call('manage_to_doo_import', {
      requestId: 'import-resume',
      previewId: preview.previewId,
      action: 'resume',
    });
    await interop.processImportJobs();
    const status: any = await port.call('manage_to_doo_import', {
      requestId: 'import-status',
      previewId: preview.previewId,
      action: 'status',
    });
    expect(status.status).toBe('completed');
    expect(todo.snapshot({ all: true }).tasks.map((task) => task.title)).toEqual([
      'Imported one',
      'Imported two',
    ]);
    expect(todo.snapshot({ all: true }).tasks.every((task) => task.listId === 'allowed-list')).toBe(
      true,
    );
  } finally {
    await interop.close();
    await f.close();
  }
});

it('requires separate sharing/integration rights for feed/source/history field and lifecycle commands', async () => {
  const f = await pluginRuntimeFixture();
  try {
    let p = {
      ...f.principal,
      scopes: [
        ...f.principal.scopes,
        'to-doo:read',
        'to-doo:write',
        'to-doo:share',
        'to-doo:integrations',
      ],
    };
    const context: McpDomainContext = {
      config: f.config,
      db: f.db,
      runtime: f.platform.get(),
      authorize(scopes) {
        for (const scope of scopes) requireScope(p, scope);
        return p;
      },
      toDooAccess: () => ({ listIds: [], domains: ['tasks', 'calendar'] }),
      transfers: {} as McpTransferStore,
    };
    const port = createToDooToolPort(context),
      todo = f.platform.get().toDoo;
    todo.command({
      requestId: 'managed-list',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'managed-list', name: 'Managed' } },
    });
    const feed: any = await port.call('save_to_doo_entity', {
      requestId: 'managed-feed',
      kind: 'calendarFeed',
      mode: 'create',
      id: 'managed-feed',
      fields: { name: 'Private feed', listIds: ['managed-list'], includeCompleted: true },
    });
    expect(feed.ids).toContain('managed-feed');
    p = { ...p, scopes: p.scopes.filter((scope) => scope !== 'to-doo:share') };
    await expect(
      port.call('execute_to_doo_command', {
        requestId: 'managed-feed-denied',
        action: 'delete_entity',
        payload: {
          kind: 'calendarFeed',
          id: 'managed-feed',
          expectedRevision: todo.getEntity('calendarFeed', 'managed-feed')!.revision,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    p = { ...p, scopes: [...p.scopes, 'to-doo:share'] };
    const removed = await port.call('execute_to_doo_command', {
      requestId: 'managed-feed-delete',
      action: 'delete_entity',
      payload: {
        kind: 'calendarFeed',
        id: 'managed-feed',
        expectedRevision: todo.getEntity('calendarFeed', 'managed-feed')!.revision,
      },
    });
    expect(removed.ids).toContain('managed-feed');
    await port.call('save_to_doo_entity', {
      requestId: 'managed-source',
      kind: 'calendarSource',
      mode: 'create',
      id: 'managed-source',
      fields: { name: 'Calendar metadata', type: 'ics', color: '#aabbcc' },
    });
    expect(todo.getEntity('calendarSource', 'managed-source')).toMatchObject({ color: '#aabbcc' });
  } finally {
    await f.close();
  }
});

it('restores an explicitly authorized complete checkpoint atomically when the portable dataset identity changes', async () => {
  const { createMcpTransferStore } = await import('../apps/server/plugins/mcp-transfers');
  const { createToDooInterop } = await import('../packages/core/to-doo/interop');
  const { createHash } = await import('node:crypto');
  const source = await pluginRuntimeFixture(),
    target = await pluginRuntimeFixture();
  const todo = target.platform.get().toDoo,
    interop = createToDooInterop(todo, {
      db: target.db,
      dataRoot: target.config.dataRoot,
      importBatchSize: 1,
    });
  try {
    const original = source.platform.get().toDoo;
    original.command({
      requestId: 'checkpoint-task-one',
      action: 'create_task',
      payload: { title: 'Checkpoint one' },
    });
    original.command({
      requestId: 'checkpoint-task-two',
      action: 'create_task',
      payload: { title: 'Checkpoint two' },
    });
    const content = Buffer.from(JSON.stringify(original.exportCheckpoint())),
      p = {
        ...target.principal,
        scopes: [...target.principal.scopes, 'to-doo:read', 'to-doo:write', 'to-doo:integrations'],
      };
    const transfers = createMcpTransferStore(target.config, target.db),
      port = createToDooToolPort({
        config: target.config,
        db: target.db,
        runtime: { ...target.platform.get(), toDooInterop: interop },
        authorize(scopes) {
          for (const scope of scopes) requireScope(p, scope);
          return p;
        },
        toDooAccess: () => ({
          listIds: [],
          domains: [
            'tasks',
            'records',
            'focus',
            'habits',
            'anniversaries',
            'calendar',
            'statistics',
            'settings',
          ],
        }),
        transfers,
      });
    const upload: any = await port.call('begin_to_doo_import', {
      requestId: 'checkpoint-upload',
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      fullDataset: true,
    });
    for (let offset = 0; offset < content.length; offset += 16384)
      transfers.append(p, {
        transferId: upload.transferId,
        offset,
        base64: content.subarray(offset, offset + 16384).toString('base64'),
      });
    const preview: any = await port.call('preview_to_doo_import', {
      requestId: 'checkpoint-preview',
      transferId: upload.transferId,
      format: 'json',
      fullDataset: true,
    });
    const result = await port.call('manage_to_doo_import', {
      requestId: 'checkpoint-apply',
      previewId: preview.previewId,
      action: 'apply',
    });
    expect(result.transactionId).toEqual(expect.any(String));
    expect(
      todo
        .snapshot({ all: true })
        .tasks.map((task) => task.title)
        .sort(),
    ).toEqual(['Checkpoint one', 'Checkpoint two']);
    expect(todo.snapshot().datasetId).toBe(original.snapshot().datasetId);
    expect(
      target.db
        .prepare('SELECT 1 FROM to_doo_import_jobs WHERE preview_id=?')
        .get(preview.previewId),
    ).toBeUndefined();
  } finally {
    await interop.close();
    await target.close();
    await source.close();
  }
});
