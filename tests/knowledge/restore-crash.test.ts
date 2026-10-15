import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { createApp } from '../../apps/server/app.js';
for (const stage of ['intent', 'copy', 'publish', 'db-update', 'unlink', 'commit'])
  it(`W03 replays restore after process exit at ${stage}`, async () => {
    const f = await createFixture();
    try {
      const h = await loginFixtureOwner(f);
      let n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'crash.md', content: '# A' },
        })
      ).json();
      n = (
        await f.app.inject({
          method: 'PUT',
          url: `/api/notes/${n.id}`,
          headers: h,
          payload: { content: '# B', expectedModifiedAt: n.modifiedAt },
        })
      ).json();
      const share = (
        await f.app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/share`,
          headers: h,
          payload: {},
        })
      ).json();
      expect(
        (
          await f.app.inject({
            method: 'DELETE',
            url: `/api/notes/${n.id}`,
            headers: h,
            payload: { expectedModifiedAt: n.modifiedAt, requestId: 'crash-archive' },
          })
        ).statusCode,
      ).toBe(200);
      await f.app.close();
      const cfg = join(f.root, 'config.json');
      await writeFile(cfg, JSON.stringify(f.config));
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', resolve('tests/support/restore-crash-child.ts'), cfg, n.id, stage],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (b) => (stderr += b));
      const code = await new Promise((res, rej) => {
        child.on('error', rej);
        child.on('exit', res);
      });
      expect(code, stderr).toBe(73);
      const app = await createApp({
          ...f.config,
          indexing: { enabled: true, watch: false, embedded: false },
        }),
        db = openDatabase(f.dataRoot);
      try {
        const tree = await app.inject({ url: '/api/tree', headers: h });
        expect(tree.statusCode).toBe(200);
        expect(
          db
            .prepare('SELECT id,active,trash_path FROM notes WHERE path=? AND active=1')
            .all(n.relativePath),
        ).toEqual([{ id: n.id, active: 1, trash_path: null }]);
        expect(
          (db.prepare('SELECT count(*) n FROM revisions WHERE note_id=?').get(n.id) as any).n,
        ).toBe(1);
        expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# B');
        expect(existsSync(join(f.knowledgeRoot, '90-Archive/.trash', n.id, 'crash.md'))).toBe(
          false,
        );
        expect((await app.inject({ url: '/api/trash', headers: h })).json()).toEqual([]);
        expect((await app.inject({ url: `/api/public/shares/${share.token}` })).statusCode).toBe(
          404,
        );
        expect(
          (db.prepare('SELECT active FROM document_state WHERE note_id=?').get(n.id) as any).active,
        ).toBe(1);
        const op = (
          await app.inject({ url: '/api/operations?requestId=crash-restore', headers: h })
        ).json();
        expect(op).toMatchObject({ status: 'succeeded', result: { id: n.id, restored: true } });
        const retry = await app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/restore`,
          headers: h,
          payload: { requestId: 'crash-restore' },
        });
        expect(retry.statusCode).toBe(200);
        expect(retry.json().receipt).toEqual(op.result);
      } finally {
        db.close();
        await app.close();
      }
    } finally {
      await f.close();
    }
  }, 30000);
