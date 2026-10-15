import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { createApp } from '../../apps/server/app.js';
const faults = vi.hoisted(() => ({ point: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (a: any, b: any) => {
      if (faults.point === 'before') throw new Error('simulated interruption');
      fs.renameSync(a, b);
      if (faults.point === 'after') {
        faults.point = '';
        throw new Error('simulated interruption');
      }
    },
  };
});
it.each(['before', 'after'])(
  'recovers %s atomic replacement without replaying writes or revisions',
  async (point) => {
    const f = await createFixture({ agent: agentConfig });
    let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const headers = agentHeaders();
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers,
          payload: {
            directory: '00-Inbox',
            fileName: 'recover.md',
            content: 'old',
            requestId: 'new',
          },
        })
      ).json().data;
      expect(n?.id).toBeTruthy();
      faults.point = point;
      await f.app.inject({
        method: 'PUT',
        url: `/api/agent/v1/notes/${n.id}`,
        headers,
        payload: { content: 'new', expectedModifiedAt: n.modifiedAt, requestId: 'save' },
      });
      faults.point = '';
      await f.app.close();
      restarted = await createApp({ ...f.config, agent: agentConfig });
      expect(readFileSync(join(f.knowledgeRoot, '00-Inbox/recover.md'), 'utf8')).toBe(
        point === 'after' ? 'new' : 'old',
      );
      const r = await restarted.inject({
        url: '/api/agent/v1/operations?requestId=save',
        headers: agentHeaders(),
      });
      expect(r.json().data.status).toBe(point === 'after' ? 'succeeded' : 'failed');
      const db = openDatabase(f.dataRoot);
      expect((db.prepare('SELECT count(*) AS n FROM revisions').get() as any).n).toBe(
        point === 'after' ? 1 : 0,
      );
      db.close();
    } finally {
      faults.point = '';
      await restarted?.close();
      await f.close();
    }
  },
);
