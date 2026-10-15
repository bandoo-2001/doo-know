import { it, expect, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { createApp } from '../../apps/server/app.js';
import { openDatabase } from '../../packages/core/db.js';
const faults = vi.hoisted(() => ({ afterRename: false, largeSyncReads: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (a: any, b: any) => {
      await fs.rename(a, b);
      if (faults.afterRename) {
        faults.afterRename = false;
        throw new Error('lost process after rename');
      }
    },
  };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (a: any, ...args: any[]) => {
      if (String(a).endsWith('/recover-large.md')) faults.largeSyncReads++;
      return (fs.readFileSync as any)(a, ...args);
    },
  };
});
it.each([false, true])(
  'reconciles committed large patch without full synchronous reads or overriding external edits (%s)',
  async (external) => {
    const f = await createFixture({ agent: agentConfig });
    let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const file = join(f.knowledgeRoot, '00-Inbox/recover-large.md'),
        old = '# Before\n' + 'x'.repeat(2 * 1024 * 1024);
      await writeFile(file, old);
      const headers = agentHeaders();
      const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0],
        page = (await readyRead(f, n.id)).json().data.data;
      faults.afterRename = true;
      const payload = {
        snapshotId: page.snapshotId,
        expectedContentHash: page.sourceHash,
        expectedModifiedAt: page.modifiedAt,
        requestId: 'recover-patch',
        edits: [{ type: 'replace_text', before: '# Before', after: '# After' }],
      };
      const accepted = (
        await f.app.inject({
          method: 'POST',
          url: `/api/agent/v1/notes/${n.id}/patch`,
          headers,
          payload,
        })
      ).json().data;
      expect(accepted.operation.operationId).toBeTruthy();
      for (let i = 0; i < 100; i++) {
        const op = (
          await f.app.inject({
            url: `/api/agent/v1/operations/${accepted.operation.operationId}`,
            headers,
          })
        ).json().data;
        if (op.status === 'needs_reconciliation') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await f.app.close();
      if (external) await writeFile(file, 'EXTERNAL_NEW_VERSION');
      faults.largeSyncReads = 0;
      restarted = await createApp({ ...f.config, agent: agentConfig });
      const op = (
        await restarted.inject({
          url: '/api/agent/v1/operations?requestId=recover-patch',
          headers: agentHeaders(),
        })
      ).json().data;
      expect(op.status).toBe(external ? 'needs_reconciliation' : 'succeeded');
      expect(faults.largeSyncReads).toBe(0);
      expect(await readFile(file, 'utf8')).toBe(
        external ? 'EXTERNAL_NEW_VERSION' : old.replace('# Before', '# After'),
      );
      const db = openDatabase(f.dataRoot);
      expect((db.prepare('SELECT count(*) n FROM revisions').get() as any).n).toBe(
        external ? 0 : 1,
      );
      db.close();
    } finally {
      faults.afterRename = false;
      await restarted?.close();
      await f.close();
    }
  },
);
