import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
it('lists history summaries and explicitly pages immutable revision bodies', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f),
      old = '# History\n' + 'old line\n'.repeat(50000);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'history.md', content: old },
      })
    ).json();
    expect(n.id).toBeTruthy();
    await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content: 'new', expectedModifiedAt: n.modifiedAt },
    });
    const list = await f.app.inject({ url: `/api/notes/${n.id}/revisions`, headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).not.toHaveProperty('content');
    expect(list.body.length).toBeLessThan(2048);
    const revision = list.json().items[0].id;
    let r: any;
    for (let i = 0; i < 100; i++) {
      r = await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/revisions/${revision}/read`,
        headers: h,
        payload: { maxBytes: 128 * 1024 },
      });
      if (r.statusCode !== 200 || r.json().kind === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(r.statusCode).toBe(200);
    expect(r.json().data.content).toBe(old.slice(0, r.json().data.bytesReturned));
    expect(r.json().data.bytesReturned).toBeLessThanOrEqual(128 * 1024);
    expect(r.json().data.sourceHash).not.toBeUndefined();
  } finally {
    await f.close();
  }
});
