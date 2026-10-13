import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
it('exposes authenticated Web index status and scoped refresh without coupling saves to vector readiness', async () => {
  const f = await createFixture();
  try {
    expect((await f.app.inject({ url: '/api/index/status' })).statusCode).toBe(401);
    const h = await loginFixtureOwner(f),
      n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'status.md', content: '# 保存完成' },
        })
      ).json();
    const status = await f.app.inject({ url: `/api/index/status?noteId=${n.id}`, headers: h });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      pending: 1,
      activeSpaceId: null,
      document: { noteId: n.id, textIndexedHash: null, vectorIndexedHash: null },
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/index/refresh',
          headers: { cookie: h.cookie },
          payload: { requestId: 'status-denied', scope: '00-Inbox' },
        })
      ).statusCode,
    ).toBe(403);
    const input = { requestId: 'status-refresh', scope: '00-Inbox' },
      a = await f.app.inject({
        method: 'POST',
        url: '/api/index/refresh',
        headers: h,
        payload: input,
      }),
      b = await f.app.inject({
        method: 'POST',
        url: '/api/index/refresh',
        headers: h,
        payload: input,
      });
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
  } finally {
    await f.close();
  }
});
