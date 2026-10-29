import { expect, it } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { pluginHost } from '../apps/server/plugins/host';
import { pluginServices } from '../apps/server/plugins/services';
import { createOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';

it('creates, reads and completes real portable task instances through the authorized SDK', async () => {
  const f = await pluginRuntimeFixture();
  try {
    pluginHost(f.config, f.db);
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled',?)",
      )
      .run(
        JSON.stringify({
          readOnly: false,
          allowToDoo: true,
          allowToDooWrite: true,
          toDooListIds: ['allowed-list'],
          toDooDomains: ['tasks'],
          allowedPrefixes: ['00-Inbox'],
        }),
      );
    const p = { ...f.principal, scopes: [...f.principal.scopes, 'to-doo:read', 'to-doo:write'] };
    f.config.agent!.policies = [p];
    const services = pluginServices(f.platform, f.db, 'mcp', p.scopes, {
      ownerId: p.id,
      principal: p,
      channel: 'mcp',
    });
    const r = createOperations(
      { objectIdSecret: 'fixture-real-todo-secret-at-least-thirty-two-characters' },
      hostClient(
        () => services,
        () => ({}),
      ),
    );
    await r.execute('manage_to_doo', p, {
      requestId: 'create-list',
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: 'allowed-list', name: 'Allowed goal' } },
    });
    const input = { requestId: 'create-task', title: 'Real task', listId: 'allowed-list' };
    const first: any = await r.execute('create_to_doo_task', p, input);
    expect(first.data.transactionId).toEqual(expect.any(String));
    const replay: any = await r.execute('create_to_doo_task', p, input);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.ids).toEqual(first.data.ids);
    await expect(r.execute('update_to_doo_task', p, { requestId: 'stale-task-change', id: first.data.ids[0], expectedRevision: 'stale-revision', patch: { title: 'Should be rejected' } })).rejects.toMatchObject({code:'TO_DOO_CONFLICT',status:409});
    const occurrences: any = await r.execute('query_to_doos', p, { kind: 'occurrence', limit: 5 });
    expect(occurrences.data.items).toHaveLength(1);
    const occurrence = occurrences.data.items[0].entity;
    await r.execute('set_to_doo_status', p, {
      requestId: 'complete-task',
      id: occurrence.id,
      expectedRevision: occurrence.revision,
      status: 'done',
    });
    expect(f.platform.get().toDoo.getEntity('occurrence', occurrence.id)).toMatchObject({
      status: 'done',
    });
    expect(
      f.platform
        .get()
        .toDoo.exportCheckpoint()
        .entities.some(
          (entity) => entity.kind === 'task' && entity.entity.id === first.data.ids[0],
        ),
    ).toBe(true);
    f.db
      .prepare(
        "UPDATE platform_plugins SET config_json=json_set(config_json,'$.allowToDoo',json('false')) WHERE id='mcp'",
      )
      .run();
    await expect(r.execute('query_to_doos', p, { kind: 'task' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  } finally {
    await f.close();
  }
});
