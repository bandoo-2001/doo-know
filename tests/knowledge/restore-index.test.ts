import { it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
import { backup, restore } from '../../server/backup.js';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/db.js';

it('restores original/history bytes and rebuilds derived state with a new source identity while rejecting old machine tokens', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'restore-index.md',
          content: '# 恢复演练\n第一版',
        },
      })
    ).json();
    const beforeToken = agentHeaders({ tokenIssuedAt: Math.floor(Date.now() / 1000) - 60 });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/search',
          headers: beforeToken,
          payload: { query: '恢复', mode: 'text', freshness: 'strict' },
        })
      ).json().data.results,
    ).toHaveLength(1);
    const page = (await readyRead(f, n.id)).json().data.data;
    await f.app.close();
    const destination = join(f.root, 'backup-index'),
      target = {
        ...f.config,
        knowledgeRoot: join(f.root, 'restore-knowledge'),
        dataRoot: join(f.root, 'restore-data'),
        indexing: { enabled: true, watch: false },
      };
    await backup(f.config, destination);
    await restore(destination, target);
    const db = openDatabase(target.dataRoot);
    try {
      expect((db.prepare('SELECT count(*) n FROM read_snapshots').get() as any).n).toBe(0);
      expect((db.prepare('SELECT count(*) n FROM chunks').get() as any).n).toBe(0);
      expect(
        db.prepare("SELECT value FROM index_meta WHERE key='remote_auth_not_before'").get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
    const app = await createApp(target);
    try {
      expect(await readFile(join(target.knowledgeRoot, n.relativePath), 'utf8')).toBe(
        '# 恢复演练\n第一版',
      );
      const old = await app.inject({ url: `/api/agent/v1/notes/${n.id}`, headers: beforeToken });
      expect(old.statusCode).toBe(401);
      const withoutIssueTime = await app.inject({
        url: `/api/agent/v1/notes/${n.id}`,
        headers: agentHeaders(),
      });
      expect(withoutIssueTime.statusCode).toBe(401);
      const fresh = agentHeaders({ tokenIssuedAt: Math.floor(Date.now() / 1000) + 1 });
      const indexed = await app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: fresh,
        payload: { query: '恢复', mode: 'text', freshness: 'strict' },
      });
      expect(indexed.statusCode).toBe(200);
      expect(indexed.json().data.results).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/agent/v1/notes/${n.id}/read`,
            headers: fresh,
            payload: { snapshotId: page.snapshotId },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});
