import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';

it.each([
  ['legacy', false],
  ['legacy', true],
  ['v2', false],
  ['v2', true],
] as const)(
  'reads inbox tasks and their related rows through %s %s list selections',
  async (mode, mixed) => {
    const root = await mkdtemp(join(tmpdir(), 'to-doo-inbox-permissions-'));
    const config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'http://localhost:3010',
      secret: 'fixture-inbox-permission-secret',
    };
    await mkdir(config.knowledgeRoot);
    const db = openDatabase(config.dataRoot);
    const service = createToDooService(config, db, noteService(config, db));
    try {
      const command = (action: string, payload: unknown) =>
        service.command({ requestId: randomUUID(), action, payload });
      for (const id of ['named-list', 'private-list'])
        command('save_entity', { kind: 'list', entity: { id, name: id } });
      for (const [id, listId] of [
        ['inbox-one', null],
        ['inbox-two', null],
        ['named-task', 'named-list'],
        ['private-task', 'private-list'],
      ] as const)
        command('create_task', { id, title: id, listId });
      const occurrences = service.snapshot({ all: true }).occurrences;
      for (const taskId of ['inbox-one', 'named-task', 'private-task']) {
        const occurrence = occurrences.find((row) => row.taskId === taskId)!;
        command('save_outcome', {
          occurrenceId: occurrence.id,
          expectedRevision: occurrence.revision,
          outcome: { id: taskId + '-outcome', summary: taskId },
        });
      }
      const listIds = mixed ? ['inbox', 'named-list'] : ['inbox'];
      const expectedTasks = mixed
        ? ['inbox-one', 'inbox-two', 'named-task']
        : ['inbox-one', 'inbox-two'];
      const port = createToDooAgentPort(service, {
        authorize: () => ({
          id: 'owner',
          clientId: 'client',
          scopes: ['to-doo:read', 'to-doo:write'],
          allowedPrefixes: [],
        }),
        access: () => ({
          listIds: mode === 'legacy' ? listIds : [],
          ...(mode === 'v2' ? { resourceListIds: listIds } : {}),
          domains: ['tasks', 'records', 'statistics'],
        }),
        canReadNote: async () => false,
      });
      const tasks = await port.query({ kind: 'task', limit: 1 });
      expect(tasks.total).toBe(expectedTasks.length);
      const discovered = tasks.items.map((row) => row.entity.id);
      let cursor = tasks.nextCursor;
      while (cursor) {
        const page = await port.query({ kind: 'task', limit: 1, cursor });
        expect(page.total).toBe(expectedTasks.length);
        expect(page.items).toHaveLength(1);
        discovered.push(...page.items.map((row) => row.entity.id));
        cursor = page.nextCursor;
      }
      expect(discovered.sort()).toEqual(expectedTasks);
      const identified = await port.query({ kind: 'task', ids: ['inbox-one', 'private-task'] });
      expect(identified).toMatchObject({ total: 1, hasMore: false });
      expect(identified.items.map((row) => row.entity.id)).toEqual(['inbox-one']);
      const explicitlyInbox = await port.query({ kind: 'task', listIds: ['inbox'] });
      expect(explicitlyInbox.total).toBe(2);
      expect(explicitlyInbox.items.map((row) => row.entity.id).sort()).toEqual([
        'inbox-one',
        'inbox-two',
      ]);
      const periods = await port.query({ kind: 'occurrence' });
      expect(periods.total).toBe(expectedTasks.length);
      expect(periods.items.map((row) => row.entity.taskId).sort()).toEqual(expectedTasks);
      const outcomes = await port.query({ kind: 'outcome' });
      expect(outcomes.total).toBe(mixed ? 2 : 1);
      expect(outcomes.items.map((row) => row.entity.id).sort()).toEqual(
        mixed ? ['inbox-one-outcome', 'named-task-outcome'] : ['inbox-one-outcome'],
      );
      const counts = (await port.query({ kind: 'statistics' })).items[0].entity;
      expect(Number(counts.pending) + Number(counts.completed)).toBe(expectedTasks.length);
      const snapshot = service.snapshot({ kind: 'task', listIds, limit: 100 });
      expect(snapshot.tasks.map((task) => task.id).sort()).toEqual(expectedTasks);
      expect(snapshot.statistics.byList.inbox.total).toBe(2);
      expect(snapshot.statistics.pending + snapshot.statistics.completed).toBe(
        expectedTasks.length,
      );
      expect(snapshot.statistics.outcomes).toBe(mixed ? 2 : 1);
    } finally {
      service.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
