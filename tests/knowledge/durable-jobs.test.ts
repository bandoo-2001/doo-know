import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/db.js';
it.each(['restart', 'cancel', 'deadline'])(
  'retains queued patch evidence across %s without duplicate writes',
  async (action) => {
    const f = await createFixture({ agent: agentConfig });
    let paused: Awaited<ReturnType<typeof createApp>> | undefined,
      restarted: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const file = join(f.knowledgeRoot, '00-Inbox/durable.md'),
        old = '# Original\n' + 'x'.repeat(2 * 1024 * 1024);
      await writeFile(file, old);
      const headers = agentHeaders(),
        n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0],
        page = (await readyRead(f, n.id)).json().data.data;
      await f.app.close();
      paused = await createApp({
        ...f.config,
        agent: agentConfig,
        fileTasks: { embedded: false },
      } as any);
      const r = await paused.inject({
        method: 'POST',
        url: `/api/agent/v1/notes/${n.id}/patch`,
        headers,
        payload: {
          snapshotId: page.snapshotId,
          expectedModifiedAt: page.modifiedAt,
          expectedContentHash: page.sourceHash,
          requestId: 'durable-patch',
          edits: [{ type: 'replace_text', before: '# Original', after: '# Updated' }],
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.operation.status).toBe('queued');
      const id = r.json().data.operation.operationId;
      if (action === 'cancel') {
        const cancelled = await paused.inject({
          method: 'POST',
          url: `/api/agent/v1/operations/${id}/cancel`,
          headers,
          payload: {},
        });
        expect(cancelled.json().data.status).toBe('cancelled');
      }
      if (action === 'deadline') {
        const db = openDatabase(f.dataRoot);
        db.prepare('UPDATE file_operations SET deadline=? WHERE id=?').run(Date.now() - 1, id);
        db.close();
      }
      await paused.close();
      expect((await readFile(file, 'utf8')).startsWith('# Original')).toBe(true);
      restarted = await createApp({ ...f.config, agent: agentConfig });
      let op: any;
      for (let i = 0; i < 100; i++) {
        op = (
          await restarted.inject({ url: `/api/agent/v1/operations/${id}`, headers: agentHeaders() })
        ).json().data;
        if (['succeeded', 'failed', 'cancelled'].includes(op.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(op.status).toBe(
        action === 'restart' ? 'succeeded' : action === 'cancel' ? 'cancelled' : 'failed',
      );
      if (action === 'deadline') expect(op.error.code).toBe('TASK_DEADLINE');
      expect(await readFile(file, 'utf8')).toBe(
        action === 'restart' ? old.replace('# Original', '# Updated') : old,
      );
      const db = openDatabase(f.dataRoot);
      expect((db.prepare('SELECT count(*) n FROM revisions').get() as any).n).toBe(
        action === 'restart' ? 1 : 0,
      );
      expect(
        (db.prepare('SELECT refs FROM read_snapshots WHERE id=?').get(page.snapshotId) as any).refs,
      ).toBe(0);
      db.close();
    } finally {
      await restarted?.close();
      await paused?.close();
      await f.close();
    }
  },
);
