import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
const requestId = () => randomUUID();
it('protects management, paginates shares, safely lists/revokes sessions and redacts diagnostics', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    expect((await f.app.inject({ url: '/api/manage/overview' })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/shares/revoke',
          headers: { cookie: h.cookie },
          payload: { ids: [], requestId: requestId() },
        })
      ).statusCode,
    ).toBe(403);
    const overview = await f.app.inject({ url: '/api/manage/overview', headers: h });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      username: 'owner',
      library: { path: f.knowledgeRoot },
      release: { environment: 'unspecified' },
    });
    const ids: string[] = [];
    for (const fileName of ['alpha.md', 'beta.md']) {
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName, content: '# Private test content' },
        })
      ).json();
      ids.push(n.id);
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      });
    }
    const first = (await f.app.inject({ url: '/api/manage/shares?limit=1', headers: h })).json();
    expect(first.items).toHaveLength(1);
    const second = (
      await f.app.inject({
        url: `/api/manage/shares?limit=1&cursor=${first.nextCursor}`,
        headers: h,
      })
    ).json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(
      (await f.app.inject({ url: '/api/manage/shares?q=alpha', headers: h })).json().items,
    ).toHaveLength(1);
    const revoked = await f.app.inject({
      method: 'POST',
      url: '/api/manage/shares/revoke',
      headers: h,
      payload: { ids, requestId: requestId() },
    });
    expect(revoked.json().results.every((r: any) => r.ok)).toBe(true);
    expect(
      (await f.app.inject({ url: '/api/manage/shares?enabled=true', headers: h })).json().items,
    ).toHaveLength(0);
    const sessions = await f.app.inject({ url: '/api/manage/sessions', headers: h });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().items[0]).toMatchObject({ current: true });
    expect(sessions.body).not.toMatch(/token|password|ipAddress/);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/manage/sessions/${sessions.json().items[0].id}`,
          headers: h,
        })
      ).statusCode,
    ).toBe(409);
    const diagnostics = await f.app.inject({ url: '/api/manage/diagnostics', headers: h });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.body).not.toContain(f.root);
    expect(diagnostics.body).not.toContain('Private test content');
    expect(diagnostics.body).not.toContain(f.config.secret);
  } finally {
    await f.close();
  }
});
it('truthfully classifies bounded storage without following links', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, '00-Inbox', 'plain.md'), 'hello');
    await mkdir(join(f.knowledgeRoot, 'assets'), { recursive: true });
    await writeFile(join(f.knowledgeRoot, 'assets', 'image.png'), 'asset');
    await symlink(f.dataRoot, join(f.knowledgeRoot, 'linked'));
    const r = await f.app.inject({ url: '/api/manage/storage', headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.json().categories.notes.bytes).toBe(5);
    expect(r.json().categories.assets.bytes).toBe(5);
    expect(r.json().warnings.length).toBeGreaterThan(0);
    expect(r.body).not.toContain(f.root);
  } finally {
    await f.close();
  }
});
it('restores trash collisions with new names and requires an explicit scoped purge snapshot', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const create = async (fileName: string) =>
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName, content: '# Fixture' },
        })
      ).json();
    const n = await create('same.md');
    await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { expectedModifiedAt: n.modifiedAt, requestId: requestId() },
    });
    const current = await create('same.md');
    const page = (await f.app.inject({ url: '/api/manage/trash', headers: h })).json();
    expect(page.items[0]).toMatchObject({ id: n.id, available: true, sizeBytes: 9 });
    const bad = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/restore',
      headers: h,
      payload: { ids: [n.id], requestId: requestId() },
    });
    expect(bad.json().results[0]).toMatchObject({ ok: false, code: 'NAME_CONFLICT' });
    const restored = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/restore',
      headers: h,
      payload: {
        ids: [n.id, current.id],
        fileNames: { [n.id]: 'renamed.md' },
        requestId: requestId(),
      },
    });
    expect(restored.json().results[0]).toMatchObject({
      id: n.id,
      ok: true,
      relativePath: '00-Inbox/renamed.md',
    });
    expect(restored.json().results[1]).toMatchObject({
      id: current.id,
      ok: false,
      code: 'NOT_FOUND',
    });
    const activePurge = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/purge',
      headers: h,
      payload: {
        ids: [n.id],
        snapshotId: page.snapshotId,
        confirm: 'PERMANENTLY_DELETE',
        requestId: requestId(),
      },
    });
    expect(activePurge.json().results[0]).toMatchObject({
      id: n.id,
      ok: false,
      code: 'TRASH_CHANGED',
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/trash/purge',
          headers: h,
          payload: { ids: [n.id], snapshotId: page.snapshotId, requestId: requestId() },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/trash/purge',
          headers: h,
          payload: {
            ids: [current.id],
            snapshotId: page.snapshotId,
            confirm: 'PERMANENTLY_DELETE',
            requestId: requestId(),
          },
        })
      ).statusCode,
    ).toBe(409);
    await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: {
        expectedModifiedAt: (await f.app.inject({ url: `/api/notes/${n.id}`, headers: h })).json()
          .modifiedAt,
        requestId: requestId(),
      },
    });
    const fresh = (await f.app.inject({ url: '/api/manage/trash', headers: h })).json();
    const body = {
      ids: [n.id],
      snapshotId: fresh.snapshotId,
      confirm: 'PERMANENTLY_DELETE',
      requestId: requestId(),
    };
    const purged = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/purge',
      headers: h,
      payload: body,
    });
    expect(purged.json().results[0]).toMatchObject({ id: n.id, ok: true });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/trash/purge',
          headers: h,
          payload: body,
        })
      ).json(),
    ).toEqual(purged.json());
    expect(
      (await f.app.inject({ url: '/api/manage/trash', headers: h })).json().items,
    ).toHaveLength(0);
    expect((await f.app.inject({ url: `/api/notes/${current.id}`, headers: h })).statusCode).toBe(
      200,
    );
  } finally {
    await f.close();
  }
});
it('revokes only the selected other device and never returns authentication tokens', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const otherLogin = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: h.origin, 'user-agent': 'Fixture Other Device' },
      payload: { username: 'owner', password: (await import('./support/fixture.js')).testPassword },
    });
    expect(otherLogin.statusCode).toBe(200);
    const otherCookie = otherLogin.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const listing = await f.app.inject({ url: '/api/manage/sessions', headers: h });
    expect(listing.json().items).toHaveLength(2);
    const other = listing.json().items.find((s: any) => !s.current);
    expect(other).toMatchObject({ device: 'Fixture Other Device' });
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/manage/sessions/${other.id}`,
          headers: h,
        })
      ).json(),
    ).toEqual({ revoked: true });
    expect(
      (await f.app.inject({ url: '/api/manage/overview', headers: { cookie: otherCookie } }))
        .statusCode,
    ).toBe(401);
    expect((await f.app.inject({ url: '/api/manage/overview', headers: h })).statusCode).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/sessions/revoke-others',
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/manage/sessions?limit=101', headers: h })).statusCode,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
it('keeps account diagnostics available without a bound library', async () => {
  const f = await createFixture({ knowledgeRoot: undefined });
  try {
    const h = await loginFixtureOwner(f);
    const overview = await f.app.inject({ url: '/api/manage/overview', headers: h });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().library).toMatchObject({ path: null, ready: false });
    expect((await f.app.inject({ url: '/api/manage/sessions', headers: h })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/api/manage/diagnostics', headers: h })).statusCode).toBe(
      200,
    );
    const usage = await f.app.inject({ url: '/api/manage/storage', headers: h });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().warnings.join(' ')).toContain('尚未统计');
    expect((await f.app.inject({ url: '/api/manage/trash', headers: h })).statusCode).toBe(503);
  } finally {
    await f.close();
  }
});
it('refuses stale trash snapshots and symlinked trash ancestors while retaining active notes', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'scope.md', content: '# Test' },
      })
    ).json();
    await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${note.id}`,
      headers: h,
      payload: { expectedModifiedAt: note.modifiedAt, requestId: requestId() },
    });
    const snapshot = (await f.app.inject({ url: '/api/manage/trash', headers: h })).json();
    const trashFile = join(f.knowledgeRoot, '90-Archive', '.trash', note.id, 'scope.md');
    await writeFile(trashFile, '# Externally changed fixture');
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/purge',
      headers: h,
      payload: {
        ids: [note.id],
        snapshotId: snapshot.snapshotId,
        confirm: 'PERMANENTLY_DELETE',
        requestId: requestId(),
      },
    });
    expect(stale.json().results[0]).toMatchObject({ ok: false, code: 'TRASH_CHANGED' });
    const fresh = (await f.app.inject({ url: '/api/manage/trash', headers: h })).json();
    const { rename, readFile } = await import('node:fs/promises');
    const archive = join(f.knowledgeRoot, '90-Archive');
    await rename(join(archive, '.trash'), join(archive, 'moved-trash'));
    await symlink(join(archive, 'moved-trash'), join(archive, '.trash'));
    const linked = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/purge',
      headers: h,
      payload: {
        ids: [note.id],
        snapshotId: fresh.snapshotId,
        confirm: 'PERMANENTLY_DELETE',
        requestId: requestId(),
      },
    });
    expect(linked.json().results[0].ok).toBe(false);
    expect(await readFile(join(archive, 'moved-trash', note.id, 'scope.md'), 'utf8')).toBe(
      '# Externally changed fixture',
    );
    const unsafe = (await f.app.inject({ url: '/api/manage/trash', headers: h })).json();
    expect(unsafe.items[0]).toMatchObject({ available: false, sizeBytes: null });
  } finally {
    await f.close();
  }
});
it('marks deep storage scans incomplete and rejects malformed cursors and scoped batch mismatches', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
    await writeFile(join(f.knowledgeRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.md'), 'deep');
    const storage = (await f.app.inject({ url: '/api/manage/storage', headers: h })).json();
    expect(storage.categories.notes.truncated).toBe(true);
    expect(storage.categories.notes.bytes).toBe(0);
    expect(
      (await f.app.inject({ url: '/api/manage/shares?cursor=malformed', headers: h })).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/trash/restore',
          headers: h,
          payload: { ids: ['../escape'], requestId: requestId() },
        })
      ).statusCode,
    ).toBe(400);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/manage/shares/revoke',
      headers: h,
      payload: { ids: ['missing-note'], requestId: 'same-request' },
    });
    expect(r.json().results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/manage/shares/revoke',
          headers: h,
          payload: { ids: ['other-note'], requestId: 'same-request' },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
