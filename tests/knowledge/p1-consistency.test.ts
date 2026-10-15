import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('W01 returns success and editor mode for a committed long-line save', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'long.md', content: '# original' },
      })
    ).json();
    const content = '# long\n' + 'x'.repeat(32769);
    const r = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content, expectedModifiedAt: n.modifiedAt, requestId: 'long-save' },
    });
    const op = (
      await f.app.inject({ url: '/api/operations?requestId=long-save', headers: h })
    ).json();
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(content);
    expect(op.status).toBe('succeeded');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: n.id, editorMode: 'large', receipt: op.result });
    expect(r.json()).not.toHaveProperty('content');
    const retry = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content, expectedModifiedAt: n.modifiedAt, requestId: 'long-save' },
    });
    expect(retry.json().receipt).toEqual(op.result);
  } finally {
    await f.close();
  }
});
for (const change of ['web', 'agent', 'local'])
  it(`W02 rejects stale ${change} deletion without revoking shares and replays a checked delete`, async () => {
    const f = await createFixture({ agent: agentConfig });
    try {
      const h = await loginFixtureOwner(f);
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'delete.md', content: '# A' },
        })
      ).json();
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      });
      if (change === 'local') await writeFile(join(f.knowledgeRoot, n.relativePath), '# B');
      else {
        const r = await f.app.inject({
          method: 'PUT',
          url: change === 'agent' ? `/api/agent/v1/notes/${n.id}` : `/api/notes/${n.id}`,
          headers: change === 'agent' ? agentHeaders() : h,
          payload: { content: '# B', expectedModifiedAt: n.modifiedAt, requestId: 'update-b' },
        });
        expect(r.statusCode).toBe(200);
      }
      const stale = await f.app.inject({
        method: 'DELETE',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: { expectedModifiedAt: n.modifiedAt, requestId: 'stale-delete' },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('VERSION_CONFLICT');
      expect(
        (await f.app.inject({ url: `/api/notes/${n.id}/share`, headers: h })).json().enabled,
      ).toBe(true);
      const latest = (await f.app.inject({ url: `/api/notes/${n.id}`, headers: h })).json();
      const payload = { expectedModifiedAt: latest.modifiedAt, requestId: 'checked-delete' };
      const deleted = await f.app.inject({
        method: 'DELETE',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload,
      });
      expect(deleted.statusCode).toBe(200);
      const op = (
        await f.app.inject({ url: '/api/operations?requestId=checked-delete', headers: h })
      ).json();
      expect(op).toMatchObject({ status: 'succeeded', result: { id: n.id, archived: true } });
      expect(
        (
          await f.app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: h, payload })
        ).json(),
      ).toEqual(deleted.json());
      expect((await f.app.inject({ url: '/api/trash', headers: h })).json()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
