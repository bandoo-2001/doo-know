import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
it('preserves client request IDs for ordinary Web create/save retries and their durable status', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f),
      payload = {
        folderPath: '00-Inbox',
        fileName: 'web-idem.md',
        content: '# 第一版',
        requestId: 'web-create-same',
      };
    const a = await f.app.inject({ method: 'POST', url: '/api/notes', headers: h, payload }),
      b = await f.app.inject({ method: 'POST', url: '/api/notes', headers: h, payload });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    const save = {
        content: '# 第二版',
        expectedModifiedAt: a.json().modifiedAt,
        requestId: 'web-save-same',
      },
      url = `/api/notes/${a.json().id}`;
    const first = await f.app.inject({ method: 'PUT', url, headers: h, payload: save }),
      second = await f.app.inject({ method: 'PUT', url, headers: h, payload: save });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const db = openDatabase(f.dataRoot);
    try {
      expect((db.prepare('SELECT count(*) n FROM revisions').get() as any).n).toBe(1);
    } finally {
      db.close();
    }
    expect(
      (await f.app.inject({ url: '/api/operations?requestId=web-save-same', headers: h })).json()
        .status,
    ).toBe('succeeded');
  } finally {
    await f.close();
  }
});

it('replays save B after save C with the original content and version', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const created = (await f.app.inject({ method: 'POST', url: '/api/notes', headers,
      payload: { folderPath: '00-Inbox', fileName: 'replay.md', content: '# A', requestId: 'create-A' } })).json();
    const url = `/api/notes/${created.id}`;
    const payload = { content: '# B', expectedModifiedAt: created.modifiedAt, requestId: 'save-B' };
    const first = await f.app.inject({ method: 'PUT', url, headers, payload });
    const later = await f.app.inject({ method: 'PUT', url, headers,
      payload: { content: '# C', expectedModifiedAt: first.json().modifiedAt, requestId: 'save-C' } });
    expect(later.statusCode).toBe(200);
    const replay = await f.app.inject({ method: 'PUT', url, headers, payload });
    expect(replay.json()).toEqual(first.json());
    expect((await f.app.inject({ url, headers })).json().content).toBe('# C');
  } finally { await f.close(); }
});
