import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
it('stops an authenticated bounded-buffer download after its browser session is revoked', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f),
      size = 20 * 1024 * 1024;
    await writeFile(join(f.knowledgeRoot, '00-Inbox/download.md'), Buffer.alloc(size, 120));
    const tree = (await f.app.inject({ url: '/api/tree', headers: h })).json(),
      id = tree[0].children[0].id;
    let page: any;
    for (let i = 0; i < 100; i++) {
      const r = await f.app.inject({
        method: 'POST',
        url: `/api/notes/${id}/read`,
        headers: h,
        payload: { maxBytes: 16384 },
      });
      if (r.json().kind === 'ready') {
        page = r.json().data;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(page.snapshotId).toBeTruthy();
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 }),
      response = await fetch(`${base}/api/notes/${id}/download?snapshotId=${page.snapshotId}`, {
        headers: { cookie: h.cookie },
      });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.length).toBeGreaterThan(0);
    const db = openDatabase(f.dataRoot);
    try {
      db.prepare('DELETE FROM session').run();
    } finally {
      db.close();
    }
    let bytes = first.value!.length,
      failed = false;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(bytes).toBeLessThan(size);
  } finally {
    await f.close();
  }
});
