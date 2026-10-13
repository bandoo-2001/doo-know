import { it, expect } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('serves latest saved raw file, without private metadata or unsaved input', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '分享.md', content: '# Original' },
      })
    ).json();
    const base = `/api/notes/${note.id}/share`;
    const s = await f.app.inject({ method: 'POST', url: base, headers: h, payload: {} });
    expect(s.statusCode).toBe(200);
    const token = s.json().token;
    expect(
      (await f.app.inject({ method: 'POST', url: base, headers: h, payload: {} })).json().token,
    ).toBe(token);
    const read = () => f.app.inject({ url: `/api/public/shares/${token}` });
    expect((await read()).body).not.toContain('UNSAVED_INPUT');
    await writeFile(join(f.knowledgeRoot, note.relativePath), '# LATEST_SAVED_CONTENT');
    const publicRead = await read();
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json().html).toContain('LATEST_SAVED_CONTENT');
    expect(publicRead.headers['cache-control']).toBe('no-store');
    expect(publicRead.body).not.toContain('00-Inbox');
    expect(publicRead.body).not.toContain(note.id);
    expect((await f.app.inject({ url: '/api/notes' })).statusCode).toBe(401);
    await f.app.inject({ method: 'DELETE', url: base, headers: h });
    expect((await read()).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});
it('resets links and disables missing original shares', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'reset.md', content: '# Reset' },
      })
    ).json();
    const base = `/api/notes/${note.id}/share`;
    const a = (await f.app.inject({ method: 'POST', url: base, headers: h, payload: {} })).json();
    const b = await f.app.inject({ method: 'POST', url: base + '/reset', headers: h, payload: {} });
    expect(b.statusCode).toBe(200);
    expect(b.json().token).not.toBe(a.token);
    expect((await f.app.inject({ url: `/api/public/shares/${a.token}` })).statusCode).toBe(404);
    await unlink(join(f.knowledgeRoot, note.relativePath));
    expect((await f.app.inject({ url: `/api/public/shares/${b.json().token}` })).statusCode).toBe(
      404,
    );
  } finally {
    await f.close();
  }
});
