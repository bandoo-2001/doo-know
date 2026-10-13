import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
it('uses authenticated Web pages while full-note, share and history entry points stay bounded', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/web-large.md'),
      '# Large\n' + 'x'.repeat(2 * 1024 * 1024),
    );
    const tree = (await f.app.inject({ url: '/api/tree', headers: h })).json();
    const id = tree.find((x: any) => x.path === '00-Inbox').children[0].id;
    expect((await f.app.inject({ url: `/api/notes/${id}/meta` })).statusCode).toBe(401);
    const info = await f.app.inject({ url: `/api/notes/${id}/meta`, headers: h });
    expect(info.statusCode).toBe(200);
    expect(info.json().editorMode).toBe('large');
    expect(info.json()).not.toHaveProperty('content');
    expect((await f.app.inject({ url: `/api/notes/${id}`, headers: h })).statusCode).toBe(409);
    const url = `/api/notes/${id}/read`;
    expect(
      (await f.app.inject({ method: 'POST', url, headers: { cookie: h.cookie }, payload: {} }))
        .statusCode,
    ).toBe(403);
    let r: any;
    for (let i = 0; i < 100; i++) {
      r = await f.app.inject({
        method: 'POST',
        url,
        headers: h,
        payload: { maxBytes: 128 * 1024 },
      });
      if (r.statusCode !== 200 || r.json().kind === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(r.statusCode).toBe(200);
    expect(r.json().kind).toBe('ready');
    expect(Buffer.byteLength(r.json().data.content)).toBeLessThanOrEqual(128 * 1024);
    const share = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${id}/share`,
      headers: h,
      payload: {},
    });
    expect(share.statusCode).toBe(200);
    const token = share.json().token;
    expect((await f.app.inject({ url: `/api/public/shares/${token}` })).statusCode).toBe(409);
    let publicPage: any;
    for (let i = 0; i < 100; i++) {
      publicPage = await f.app.inject({
        method: 'POST',
        url: `/api/public/shares/${token}/read`,
        payload: {},
      });
      if (publicPage.statusCode !== 200 || publicPage.json().kind === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(publicPage.statusCode).toBe(200);
    expect(publicPage.body).not.toContain('relativePath');
    expect(publicPage.body).not.toContain('00-Inbox');
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${id}/share`, headers: h });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/public/shares/${token}/read`,
          payload: { cursor: publicPage.json().data.nextCursor },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
