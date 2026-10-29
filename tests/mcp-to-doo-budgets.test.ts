import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createToDooAgentPort } from '../apps/server/to-doo/agent-port';
import { createOperations } from '../plugins/mcp/server/operations';
import { hostClient } from '../plugins/mcp/server/service';

it('returns a bounded committed receipt for a large template and pages its complete authorized change set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-mcp-budget-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-mcp-budget-secret-thirty-two',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db));
  try {
    const templateId = service.command({
      requestId: randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'template',
        entity: {
          name: 'Large template',
          tasks: Array.from({ length: 250 }, (_, i) => ({
            key: 'item-' + i,
            title: 'Template action ' + i,
          })),
        },
      },
    }).ids[0];
    const p = {
      id: 'owner',
      clientId: 'client',
      scopes: ['to-doo:read', 'to-doo:write'],
      allowedPrefixes: [],
    };
    const port = createToDooAgentPort(service, {
      authorize: () => p,
      access: () => ({ listIds: [], domains: ['tasks', 'records'] }),
      canReadNote: async () => false,
    });
    const registry = createOperations(
      { objectIdSecret: 'fixture-budget-object-secret-thirty-two-characters' },
      hostClient(
        () => ({ knowledge: {} as any, toDoo: port }) as any,
        () => ({}),
      ),
    );
    const requestId = randomUUID();
    const response: any = await registry.execute('manage_to_doo', p, {
      requestId,
      action: 'apply_template',
      payload: { templateId, listId: null },
    });
    expect(response.data.idsCount).toBe(250);
    expect(response.data.changedCount).toBeGreaterThanOrEqual(500);
    expect(response.data.receiptTruncated).toBe(true);
    expect(response.data.ids.length).toBeLessThanOrEqual(50);
    expect(service.snapshot({ all: true }).tasks).toHaveLength(250);
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page: any = await registry.execute('query_to_doos', p, {
        receiptRequestId: requestId,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.data.items) seen.add(item.kind + ':' + item.entity.id);
      cursor = page.data.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(response.data.changedCount);
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
