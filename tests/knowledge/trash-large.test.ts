import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
it('restores a large archived note as metadata and never reports failure after applying the copy', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f),
      content = '# Large trash\n' + 'x'.repeat(2 * 1024 * 1024);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/trash-large.md'), content);
    const n = (await f.app.inject({ url: '/api/notes', headers: h }))
      .json()
      .find((n: any) => n.relativePath.endsWith('trash-large.md'));
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/notes/${n.id}`,
          headers: h,
          payload: {
            expectedModifiedAt: (
              await f.app.inject({ url: `/api/notes/${n.id}/meta`, headers: h })
            ).json().modifiedAt,
            requestId: 'delete-note',
          },
        })
      ).statusCode,
    ).toBe(200);
    const db = openDatabase(f.dataRoot);
    try {
      db.prepare(
        "INSERT INTO sync_runs(id,owner,status,lease_until,started_at) VALUES('restore-sync','test','running',?,?)",
      ).run(Date.now() + 60000, Date.now());
      const busy = await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/restore`,
        headers: h,
        payload: {},
      });
      expect(busy.statusCode).toBe(503);
      db.prepare('DELETE FROM sync_runs').run();
    } finally {
      db.close();
    }
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/restore`,
      headers: h,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: n.id, editorMode: 'large' });
    expect(r.json()).not.toHaveProperty('content');
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(content);
  } finally {
    await f.close();
  }
});
