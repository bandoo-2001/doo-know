import { expect, it, vi } from 'vitest';
import { verifyMcpToDooWorkflow } from '../scripts/support/verify-mcp-to-doo-workflow';

it.each(['running', 'paused'])(
  'refuses an existing %s focus session before creating any fixture entity',
  async (status) => {
    const call = vi.fn(async () => ({
      items: [{ entity: { active: { id: 'preexisting', status } } }],
    }));
    await expect(
      verifyMcpToDooWorkflow(call, 'readiness-idle-guard', { cleanup: true }),
    ).rejects.toMatchObject({
      message: 'MCP_WORKFLOW_REQUIRES_IDLE_DATASET',
      writes: 0,
      created: 0,
      cleaned: 0,
      cleanupErrors: [],
    });
    expect(call).toHaveBeenCalledExactlyOnceWith('query_to_doos', {
      kind: 'focusOverview',
      limit: 1,
    });
  },
);

it('rejects an incomplete focus overview without assuming that the dataset is idle', async () => {
  const call = vi.fn(async () => ({ items: [] }));
  await expect(
    verifyMcpToDooWorkflow(call, 'readiness-empty-guard', { cleanup: true }),
  ).rejects.toMatchObject({
    message: 'MCP_WORKFLOW_FOCUS_STATE_INVALID',
    writes: 0,
    created: 0,
    cleaned: 0,
  });
  expect(call).toHaveBeenCalledTimes(1);
});

it('requires idle state at the atomic start and cleans only its created entities after a racing session wins', async () => {
  const prefix = 'readiness-race',
    created = new Map<string, { kind: string; id: string; revision: string }>();
  const deleted: string[] = [];
  const call = vi.fn(
    async (name: string, args: Record<string, any>): Promise<Record<string, any>> => {
      if (name === 'query_to_doos' && args.kind === 'focusOverview')
        return { items: [{ entity: { active: null } }] };
      if (name === 'save_to_doo_entity') {
        const entity = { kind: args.kind, id: args.id, revision: 'revision-' + args.id };
        created.set(args.id, entity);
        return { ids: [args.id], changed: [entity] };
      }
      if (name === 'read_to_doo_entity')
        return {
          range: { nextOffset: null },
          content: JSON.stringify({
            parentId: prefix + '-goal',
            icon: 'dot',
            color: '#23aa88',
          }),
        };
      if (name === 'execute_to_doo_command' && args.action === 'start_focus') {
        expect(args.payload.requireIdle).toBe(true);
        throw Error('ANOTHER_SESSION_STARTED');
      }
      if (name === 'query_to_doos') {
        const entity = created.get(args.ids[0]);
        expect(entity?.kind).toBe(args.kind);
        return { items: [{ entity }] };
      }
      if (name === 'execute_to_doo_command' && args.action === 'delete_entity') {
        const entity = created.get(args.payload.id);
        expect(entity).toBeDefined();
        expect(entity?.id.startsWith(prefix)).toBe(true);
        expect(args.payload.expectedRevision).toBe(entity?.revision);
        deleted.push(args.payload.id);
        return { ids: [args.payload.id], changed: [] };
      }
      throw Error('UNEXPECTED_OPERATION');
    },
  );
  await expect(verifyMcpToDooWorkflow(call, prefix, { cleanup: true })).rejects.toMatchObject({
    message: 'MCP_WORKFLOW_FAILED',
    created: 4,
    cleaned: 4,
    cleanupErrors: [],
    cause: { message: 'ANOTHER_SESSION_STARTED' },
  });
  expect(deleted.sort()).toEqual([...created.keys()].sort());
  expect(
    call.mock.calls.some(
      ([name, args]) => name === 'execute_to_doo_command' && args.action === 'control_focus',
    ),
  ).toBe(false);
});
