import { it, expect } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createFixture, loginFixtureOwner, origin, testPassword } from './support/fixture.js';
import { createApp } from '../server/app.js';
it('consistent backup restores note bytes/history/account but revokes sessions and shares', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '备份.md', content: 'BACKUP_ORIGINAL\r\n' },
      })
    ).json();
    const saved = (
      await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: { content: 'BACKUP_LATEST\r\n', expectedModifiedAt: n.modifiedAt },
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
    await f.app.close();
    const { backup, restore } = await import('../server/backup.js');
    const destination = join(f.root, 'backup'),
      targetKnowledge = join(f.root, 'restored-knowledge'),
      targetData = join(f.root, 'restored-data');
    await backup(f.config, destination);
    await restore(destination, {
      ...f.config,
      knowledgeRoot: targetKnowledge,
      dataRoot: targetData,
    });
    const app = await createApp({
      ...f.config,
      knowledgeRoot: targetKnowledge,
      dataRoot: targetData,
    });
    try {
      expect(await readFile(join(targetKnowledge, n.relativePath), 'utf8')).toBe(
        'BACKUP_LATEST\r\n',
      );
      expect((await app.inject({ url: '/api/tree', headers: h })).statusCode).toBe(401);
      expect((await app.inject({ url: `/api/public/shares/${share.token}` })).statusCode).toBe(404);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'owner', password: testPassword },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const r = await app.inject({ url: `/api/notes/${n.id}/revisions`, headers: { cookie } });
      expect(r.json().items[0]).not.toHaveProperty('content');
      const csrf = await app.inject({ url: '/api/security/csrf', headers: { cookie } });
      const readHeaders = {
        cookie: cookie + '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        origin,
        'x-csrf-token': csrf.json().token,
      };
      let historyPage: any;
      for (let i = 0; i < 100; i++) {
        historyPage = await app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/revisions/${r.json().items[0].id}/read`,
          headers: readHeaders,
          payload: {},
        });
        if (historyPage.json().kind === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(historyPage.json().data.content).toBe('BACKUP_ORIGINAL\r\n');
      expect(
        (await app.inject({ url: `/api/notes/${n.id}`, headers: { cookie } })).json().content,
      ).toBe('BACKUP_LATEST\r\n');
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});
