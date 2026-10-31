import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort, type ToDooAgentAccess } from '../apps/server/to-doo/agent-port';

it('reads saved views, plans and activity through their authorized task graph with no mixed-resource counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-linked-resources-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'linked-resources-fixture-only',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  const command = (action: string, payload: unknown) =>
    service.command({ requestId: randomUUID(), action, payload });
  try {
    const occurrences = new Map<string, any>();
    for (const id of ['allowed', 'private']) {
      command('save_entity', { kind: 'list', entity: { id, name: id } });
      command('create_task', { id: id + '-task', title: id, listId: id });
      const occurrence = service
        .snapshot({ all: true })
        .occurrences.find((row) => row.taskId === id + '-task')!;
      command('set_occurrence_status', {
        id: occurrence.id,
        expectedRevision: occurrence.revision,
        status: 'doing',
      });
      command('save_entity', {
        kind: 'timeBlock',
        entity: {
          id: id + '-block',
          occurrenceId: occurrence.id,
          start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
          durationMinutes: 30,
        },
      });
      occurrences.set(id, service.getEntity('occurrence', occurrence.id));
    }
    const change = (list: string) => ({
      occurrenceId: occurrences.get(list).id,
      expectedRevision: occurrences.get(list).revision,
      start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      durationMinutes: 30,
      blockId: list + '-block',
      expectedBlockRevision: service.getEntity('timeBlock', list + '-block')!.revision,
    });
    for (const [id, lists] of [
      ['own', ['allowed']],
      ['hidden', ['private']],
      ['mixed', ['allowed', 'private']],
      ['unbound', []],
    ] as const) {
      command('save_entity', {
        kind: 'view',
        entity: { id: id + '-view', name: id, filter: { listIds: [...lists] } },
      });
      command('save_entity', {
        kind: 'plan',
        entity: {
          id: id + '-plan',
          name: id,
          changes: lists.map(change),
          expectedRevisions: Object.fromEntries(
            lists.flatMap((list) => [
              ['task:' + list + '-task', service.getEntity('task', list + '-task')!.revision],
              [
                'timeBlock:' + list + '-block',
                service.getEntity('timeBlock', list + '-block')!.revision,
              ],
            ]),
          ),
        },
      });
    }
    command('save_entity', {
      kind: 'plan',
      entity: {
        id: 'foreign-revisions-plan',
        name: 'private association',
        changes: [change('allowed')],
        expectedRevisions: {
          'task:private-task': service.getEntity('task', 'private-task')!.revision,
        },
      },
    });
    command('save_entity', {
      kind: 'plan',
      entity: {
        id: 'foreign-block-plan',
        name: 'private block',
        changes: [
          {
            ...change('allowed'),
            blockId: 'private-block',
            expectedBlockRevision: service.getEntity('timeBlock', 'private-block')!.revision,
          },
        ],
      },
    });
    let access: ToDooAgentAccess = {
      listIds: [],
      resourceListIds: ['allowed'],
      domains: ['tasks', 'records'],
    };
    const port = createToDooAgentPort(service, {
      authorize: () => ({
        id: 'owner',
        clientId: 'linked-fixture',
        scopes: ['to-doo:read', 'to-doo:write'],
        allowedPrefixes: [],
      }),
      access: () => access,
      canReadNote: () => false,
    });
    const ownActivity = service
      .snapshot({ all: true })
      .activities.filter((item) => item.entityId === 'allowed-task');
    expect(ownActivity).toHaveLength(1);
    for (const scoped of [false, true]) {
      access = {
        listIds: scoped ? ['allowed'] : [],
        ...(scoped ? {} : { resourceListIds: ['allowed'] }),
        domains: ['tasks', 'records'],
      };
      for (const kind of ['view', 'plan', 'activity'] as const) {
        const result = await port.query({ kind });
        expect(result.total, kind).toBe(1);
        expect(result.items.map((item) => item.entity.id)).toEqual(
          kind === 'activity' ? ownActivity.map((item) => item.id) : ['own-' + kind],
        );
        expect(JSON.stringify(result)).not.toContain('private');
        const entity = service.getEntity(kind, String(result.items[0].entity.id))!;
        expect(await port.readEntity(kind, entity.id, entity.revision)).toHaveProperty(
          'id',
          entity.id,
        );
      }
      for (const kind of ['view', 'plan'] as const) {
        for (const id of ['hidden', 'mixed', 'unbound']) {
          const entity = service.getEntity(kind, id + '-' + kind)!;
          await expect(port.readEntity(kind, entity.id, entity.revision)).rejects.toMatchObject({
            statusCode: 403,
          });
        }
      }
      const ownView = service.getEntity('view', 'own-view')!;
      await expect(
        port.command({
          requestId: randomUUID(),
          action: 'save_entity',
          payload: {
            kind: 'view',
            entity: { id: ownView.id, name: 'Renamed within grant' },
            expectedRevision: ownView.revision,
          },
        }),
      ).resolves.toMatchObject({ ids: [ownView.id] });
      const current = service.getEntity('view', ownView.id)!;
      await expect(
        port.command({
          requestId: randomUUID(),
          action: 'save_entity',
          payload: {
            kind: 'view',
            entity: { id: current.id, filter: { listIds: ['private'] } },
            expectedRevision: current.revision,
          },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(service.getEntity('view', current.id)).toHaveProperty('filter.listIds', ['allowed']);
      const foreign = service.getEntity('plan', 'foreign-revisions-plan')!;
      await expect(port.readEntity('plan', foreign.id, foreign.revision)).rejects.toMatchObject({
        statusCode: 403,
      });
      const foreignBlock = service.getEntity('plan', 'foreign-block-plan')!;
      await expect(
        port.readEntity('plan', foreignBlock.id, foreignBlock.revision),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    access = { listIds: [], resourceListIds: [], domains: ['tasks', 'records'] };
    for (const kind of ['view', 'plan', 'activity'] as const)
      expect(await port.query({ kind })).toMatchObject({ total: 0, items: [] });
    const own = service.getEntity('view', 'own-view')!;
    await expect(port.readEntity('view', own.id, own.revision)).rejects.toMatchObject({
      statusCode: 403,
    });
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
