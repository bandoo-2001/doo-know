import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';

it('limits task lists, strips unauthorized note provenance and rejects an entire mixed batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-agent-port-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-port-secret-thirty-two-characters',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot);
  const service = createToDooService(config, db, noteService(config, db));
  try {
    const command = (action: string, payload: unknown) =>
      service.command({ requestId: randomUUID(), action, payload });
    command('save_entity', { kind: 'list', entity: { id: 'allowed-list', name: 'Allowed' } });
    command('save_entity', { kind: 'list', entity: { id: 'private-list', name: 'Private' } });
    command('create_task', {
      id: 'allowed-task',
      title: 'Allowed task',
      listId: 'allowed-list',
      description: 'User-written content',
      noteRefs: [{ noteId: 'private-note', role: 'material', title: 'Private note title' }],
      source: { noteId: 'private-note', quote: 'Private source quote' },
    });
    command('create_task', { id: 'private-task', title: 'Private task', listId: 'private-list' });
    const p = {
      id: 'owner',
      clientId: 'client',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    };
    let access = { listIds: ['allowed-list'], domains: ['tasks'] };
    let revokeDuringRead = false;
    const port = createToDooAgentPort(service, {
      authorize: () => p,
      access: () => access,
      canReadNote: async () => {
        if (revokeDuringRead) access = { listIds: ['private-list'], domains: ['tasks'] };
        return false;
      },
    });
    const result = await port.query({ kind: 'task', limit: 50 });
    expect(result.items.map((item) => item.entity.id)).toEqual(['allowed-task']);
    expect(JSON.stringify(result)).not.toContain('Private note title');
    expect(JSON.stringify(result)).not.toContain('Private source quote');
    expect(result.items[0].entity.description).toBe('User-written content');
    const allowed = service.getEntity('task', 'allowed-task')!;
    const privateTask = service.getEntity('task', 'private-task')!;
    await expect(
      port.command({
        requestId: randomUUID(),
        action: 'batch_tasks',
        payload: {
          ids: [allowed.id, privateTask.id],
          expectedRevisions: {
            [allowed.id]: allowed.revision,
            [privateTask.id]: privateTask.revision,
          },
          operation: 'delete',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(service.getEntity('task', allowed.id)?.deletedAt).toBeNull();
    await expect(
      port.command({
        requestId: randomUUID(),
        action: 'create_task',
        payload: { title: 'Forbidden', listId: 'private-list' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      port.command({
        requestId: randomUUID(),
        action: 'update_task',
        payload: {
          id: allowed.id,
          expectedRevision: allowed.revision,
          patch: { noteRefs: [{ noteId: 'private-note', role: 'output' }] },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const longDescription = '知识🙂'.repeat(100);
    command('update_task', {
      id: allowed.id,
      expectedRevision: allowed.revision,
      patch: { description: longDescription },
    });
    const revision = service.getEntity('task', allowed.id)!.revision;
    let offset = 0,
      joined = '';
    for (let page = 0; page < 20; page++) {
      const result = await port.query({
        kind: 'task',
        ids: [allowed.id],
        field: 'description',
        offset,
        maxBytes: 127,
        expectedRevision: revision,
      });
      const entity = result.items[0].entity;
      joined += entity.description as string;
      const range = entity.fieldRange as { nextByte: number | null };
      if (range.nextByte === null) break;
      offset = range.nextByte;
    }
    expect(joined).toBe(longDescription);
    access = { listIds: ['allowed-list'], domains: ['tasks', 'statistics'] };
    const statistics = await port.query({ kind: 'statistics' });
    expect(statistics.items[0].entity).toMatchObject({ pending: 1, completed: 0 });
    expect(JSON.stringify(statistics)).not.toContain('private-list');
    access = { listIds: ['allowed-list'], domains: ['tasks'] };
    revokeDuringRead = true;
    await expect(port.query({ kind: 'task' })).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps dependent-plan expansion inside the authorized task graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-plan-policy-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-plan-policy-secret-thirty-two',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  try {
    for (const id of ['allowed-list', 'private-list'])
      service.command({
        requestId: randomUUID(),
        action: 'save_entity',
        payload: { kind: 'list', entity: { id, name: id } },
      });
    const a = service.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'Allowed predecessor', listId: 'allowed-list' },
    }).ids[0];
    const b = service.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: {
        title: 'Private dependent',
        listId: 'private-list',
        dependencies: [{ taskId: a, lagMinutes: 0 }],
      },
    }).ids[0];
    const occurrences = service.snapshot({ all: true }).occurrences;
    const first = occurrences.find((item) => item.taskId === a)!,
      second = occurrences.find((item) => item.taskId === b)!;
    service.command({
      requestId: randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'timeBlock',
        entity: {
          occurrenceId: second.id,
          start: { date: '2026-10-30', time: '10:00', timeZone: 'UTC' },
          durationMinutes: 60,
        },
      },
    });
    const p = {
      id: 'owner',
      clientId: 'client',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    };
    const port = createToDooAgentPort(service, {
      authorize: () => p,
      access: () => ({ listIds: ['allowed-list'], domains: ['tasks'] }),
      canReadNote: async () => false,
    });
    const preview = await port.command({
      requestId: randomUUID(),
      action: 'preview_plan',
      payload: {
        name: 'Move the allowed task',
        includeDependents: true,
        changes: [
          {
            occurrenceId: first.id,
            expectedRevision: first.revision,
            start: { date: '2026-10-30', time: '11:00', timeZone: 'UTC' },
            durationMinutes: 60,
          },
        ],
      },
    });
    expect(JSON.stringify(preview)).not.toContain(second.id);
    expect(JSON.stringify(preview)).not.toContain(b);
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks task ownership after asynchronous evidence authorization before completing an occurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-owner-race-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-owner-race-secret-thirty-two',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  try {
    for (const id of ['allowed-list', 'private-list'])
      service.command({
        requestId: randomUUID(),
        action: 'save_entity',
        payload: { kind: 'list', entity: { id, name: id } },
      });
    const id = service.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'A transferred task', listId: 'allowed-list' },
    }).ids[0];
    const occurrence = service.snapshot().occurrences.find((item) => item.taskId === id)!;
    const p = {
      id: 'owner',
      clientId: 'client',
      scopes: ['to-doo:read', 'to-doo:write', 'knowledge:read'],
      allowedPrefixes: ['00-Inbox'],
    };
    const port = createToDooAgentPort(service, {
      authorize: () => p,
      access: () => ({ listIds: ['allowed-list'], domains: ['tasks', 'records'] }),
      canReadNote: async () => {
        const task = service.getEntity('task', id)!;
        service.command({
          requestId: randomUUID(),
          action: 'update_task',
          payload: { id, expectedRevision: task.revision, patch: { listId: 'private-list' } },
        });
        return true;
      },
    });
    await expect(
      port.command({
        requestId: randomUUID(),
        action: 'save_outcome',
        payload: {
          occurrenceId: occurrence.id,
          expectedRevision: occurrence.revision,
          outcome: {
            summary: 'Evidence',
            evidenceRefs: [{ noteId: 'allowed-note', role: 'output' }],
          },
          complete: true,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(service.getEntity('occurrence', occurrence.id)).toMatchObject({ status: 'todo' });
    expect(service.snapshot({ all: true }).outcomes).toHaveLength(0);
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks goal context permission after its final asynchronous note authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-context-policy-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-context-policy-secret-thirty-two',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  try {
    service.command({
      requestId: randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'list',
        entity: {
          id: 'allowed-list',
          name: 'Goal that was revoked',
          noteRefs: [{ noteId: 'note-with-delayed-check', role: 'material' }],
        },
      },
    });
    let active = true;
    const p = { id: 'owner', clientId: 'client', scopes: ['to-doo:read'], allowedPrefixes: [] };
    const port = createToDooAgentPort(service, {
      authorize: () => p,
      access: () =>
        active ? { listIds: ['allowed-list'], domains: ['tasks'] } : { listIds: [], domains: [] },
      canReadNote: async () => {
        active = false;
        return false;
      },
    });
    await expect(port.context({ listId: 'allowed-list' })).rejects.toMatchObject({
      statusCode: 403,
    });
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
