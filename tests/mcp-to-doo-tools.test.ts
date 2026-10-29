import { expect, it } from 'vitest';
import { createOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';
import { resourceScopes } from '../shared/authorization-scopes';

const principal = {
  id: 'owner',
  clientId: 'todo-client',
  scopes: ['to-doo:read', 'to-doo:write'],
  allowedPrefixes: ['00-Inbox'],
};
function registry() {
  const services: any = {
    knowledge: {},
    toDoo: {
      query: async () => ({
        items: [
          { kind: 'task', entity: { id: 'task-1', revision: 'rev-1', title: 'Prepare review' } },
        ],
        total: 1,
        hasMore: false,
      }),
      context: async () => ({
        goal: { id: 'goal-1', name: 'Learning' },
        tasks: [],
        records: [],
        warnings: [],
      }),
      command: async (command: any) => ({
        transactionId: 'transaction-1',
        replayed: false,
        ids: [command.action === 'create_task' ? 'task-2' : 'task-1'],
        changed: [{ kind: 'task', id: 'task-1', revision: 'rev-2' }],
      }),
    },
  };
  return createOperations(
    { objectIdSecret: 'fixture-todo-tool-secret-at-least-thirty-two-characters' },
    hostClient(
      () => services,
      () => ({}),
    ),
  );
}

it('declares separate read/write scopes without granting them to existing knowledge clients', () => {
  expect(resourceScopes).toContain('to-doo:read');
  expect(resourceScopes).toContain('to-doo:write');
});

it('exposes bounded task querying and explicit command tools with real host receipts', async () => {
  const r = registry();
  expect(r.operations.map((op) => op.name)).toContain('query_to_doos');
  expect(await r.execute('query_to_doos', principal, { kind: 'task', limit: 10 })).toMatchObject({
    data: { items: [{ kind: 'task', entity: { id: 'task-1' } }], total: 1 },
  });
  expect(
    await r.execute('create_to_doo_task', principal, {
      requestId: 'create-todo-1',
      title: 'Prepare review',
    }),
  ).toMatchObject({ data: { transactionId: 'transaction-1', ids: ['task-2'] } });
});

it('keeps previewing a plan separate from applying it and denies legacy scopes', async () => {
  const r = registry();
  expect(r.operations.find((op) => op.name === 'preview_to_doo_plan')?.readOnly).toBe(true);
  expect(r.operations.find((op) => op.name === 'apply_to_doo_plan')?.readOnly).toBe(false);
  await expect(
    r.execute(
      'query_to_doos',
      { ...principal, scopes: ['knowledge:read', 'knowledge:write'] },
      { kind: 'task' },
    ),
  ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  await expect(
    r.execute(
      'create_to_doo_task',
      { ...principal, scopes: ['to-doo:read'] },
      { requestId: 'denied-todo-1', title: 'Denied' },
    ),
  ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
});
