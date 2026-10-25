import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner, origin } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { mutationCore } from '../packages/core/knowledge/core.js';
import type { Principal } from '../shared/knowledge-contracts.js';

// These cases catch missing migration defaults, ignored options, ambient owner
// authority, stale share grants at commit, and resource expansion through edits.
it('migrates an existing permanent read link without changing its token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doo-know-share-migration-'));
  const prior = new Database(join(root, 'app.sqlite'));
  prior.exec(
    'CREATE TABLE notes(id TEXT PRIMARY KEY,path TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,trash_path TEXT); CREATE TABLE shares(note_id TEXT PRIMARY KEY REFERENCES notes(id),token TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1)',
  );
  prior.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('existing', '00-Inbox/existing.md');
  prior.prepare('INSERT INTO shares VALUES(?,?,1)').run('existing', 'A'.repeat(43));
  prior.close();
  const db = openDatabase(root);
  try {
    expect(db.prepare('SELECT token,permission,expires_at FROM shares').get()).toEqual({
      token: 'A'.repeat(43),
      permission: 'view',
      expires_at: null,
    });
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('legacy-writer', '00-Inbox/legacy.md');
    db.prepare('INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1)').run(
      'legacy-writer',
      'B'.repeat(43),
    );
    expect(
      db.prepare('SELECT permission,expires_at FROM shares WHERE note_id=?').get('legacy-writer'),
    ).toEqual({ permission: 'view', expires_at: null });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('saves owner options on the current token and reports document support independently of permission', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'share.md', content: '# Shared' },
      })
    ).json();
    const url = `/api/notes/${n.id}/share`;
    expect((await f.app.inject({ url, headers })).json()).toMatchObject({
      enabled: false,
      state: 'private',
      permission: 'view',
      expiresAt: null,
      editSupported: true,
    });
    const view = (await f.app.inject({ method: 'POST', url, headers, payload: {} })).json();
    expect(view).toMatchObject({
      enabled: true,
      state: 'active',
      permission: 'view',
      expiresAt: null,
      editSupported: true,
    });
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const edit = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { permission: 'edit', expiresAt },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({
      token: view.token,
      permission: 'edit',
      expiresAt,
      editSupported: true,
    });
    expect(
      (await f.app.inject({ url: `/api/public/shares/${view.token}/meta` })).json(),
    ).toMatchObject({ permission: 'edit', expiresAt, canEdit: true });
    const db = openDatabase(f.dataRoot);
    db.prepare('UPDATE shares SET expires_at=? WHERE note_id=?').run(Date.now() - 1, n.id);
    db.close();
    expect((await f.app.inject({ url, headers })).json()).toMatchObject({
      enabled: false,
      state: 'expired',
      permission: 'edit',
      editSupported: true,
    });
    expect((await f.app.inject({ url: `/api/public/shares/${view.token}` })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/notes/${n.id}`, headers })).json().shared).toBe(false);
  } finally {
    await f.close();
  }
});

it('rejects malformed sharing permissions and impossible calendar dates without changing the active grant', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'validation.md', content: '# Validation' },
      })
    ).json();
    const url = `/api/notes/${n.id}/share`;
    const current = (
      await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { permission: 'edit', expiresAt: null },
      })
    ).json();
    for (const payload of [
      { permission: null },
      { permission: 'owner' },
      { permission: false },
      { expiresAt: '2099-02-30T12:00:00.000Z' },
      { expiresAt: 123 },
      { expiresAt: '2020-01-01T00:00:00.000Z' },
      { enabled: true },
    ]) {
      const invalid = await f.app.inject({ method: 'POST', url, headers, payload });
      expect(invalid.statusCode, JSON.stringify(payload) + ': ' + invalid.body).toBe(400);
      expect((await f.app.inject({ url, headers })).json()).toMatchObject({
        token: current.token,
        permission: 'edit',
        expiresAt: null,
      });
    }
  } finally {
    await f.close();
  }
});

it.each([
  { permission: 'view', timed: false, canEdit: false, sourceStatus: 403 },
  { permission: 'view', timed: true, canEdit: false, sourceStatus: 403 },
  { permission: 'edit', timed: false, canEdit: true, sourceStatus: 200 },
  { permission: 'edit', timed: true, canEdit: true, sourceStatus: 200 },
] as const)(
  'keeps $permission access and timed=$timed independent',
  async ({ permission, timed, canEdit, sourceStatus }) => {
    const f = await createFixture();
    try {
      const headers = await loginFixtureOwner(f);
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers,
          payload: { folderPath: '00-Inbox', fileName: 'combination.md', content: '# Combination' },
        })
      ).json();
      const expiresAt = timed ? new Date(Date.now() + 60000).toISOString() : null;
      const result = await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers,
        payload: { permission, expiresAt },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        enabled: true,
        state: 'active',
        permission,
        expiresAt,
        editSupported: true,
      });
      const base = `/api/public/shares/${result.json().token}`;
      const publicRead = await f.app.inject({ url: base });
      expect(publicRead.statusCode).toBe(200);
      expect(publicRead.json()).toMatchObject({ permission, expiresAt, canEdit });
      expect((await f.app.inject({ url: `${base}/source` })).statusCode).toBe(sourceStatus);
      if (timed) {
        const db = openDatabase(f.dataRoot);
        db.prepare('UPDATE shares SET expires_at=? WHERE note_id=?').run(Date.now() - 1, n.id);
        db.close();
        const expired = await f.app.inject({ url: '/api/manage/shares?enabled=false', headers });
        expect(expired.json().items).toEqual([
          expect.objectContaining({
            id: n.id,
            enabled: false,
            state: 'expired',
            permission,
            url: null,
          }),
        ]);
        expect(
          (await f.app.inject({ url: '/api/manage/shares?enabled=true', headers })).json().items,
        ).toHaveLength(0);
        expect(
          (await f.app.inject({ url: '/api/manage/diagnostics', headers })).json().counts
            .enabledShares,
        ).toBe(0);
      }
    } finally {
      await f.close();
    }
  },
);

it('saves anonymous edits with a share CSRF token, version conflicts and idempotent receipts', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'editable.md', content: '# Original' },
      })
    ).json();
    const s = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers,
        payload: { permission: 'edit', expiresAt: null },
      })
    ).json();
    const base = `/api/public/shares/${s.token}`;
    const source = await f.app.inject({ url: `${base}/source` });
    expect(source.statusCode, source.body).toBe(200);
    expect(source.body).not.toContain(n.id);
    expect(source.body).not.toContain('00-Inbox');
    const csrf = await f.app.inject({ url: `${base}/csrf` });
    expect(csrf.statusCode, csrf.body).toBe(200);
    const publicHeaders = {
      origin,
      cookie: csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      'x-csrf-token': csrf.json().token,
    };
    const payload = {
      content: '# Saved anonymously',
      expectedModifiedAt: source.json().modifiedAt,
      requestId: randomUUID(),
    };
    expect(
      (await f.app.inject({ method: 'PUT', url: `${base}/source`, headers: { origin }, payload }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${base}/source`,
          headers: { ...publicHeaders, origin: 'https://another.invalid' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const saved = await f.app.inject({
      method: 'PUT',
      url: `${base}/source`,
      headers: publicHeaders,
      payload,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true });
    expect(saved.body).not.toContain('00-Inbox');
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${base}/source`,
          headers: publicHeaders,
          payload,
        })
      ).json(),
    ).toEqual(saved.json());
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${base}/source`,
          headers: publicHeaders,
          payload: { ...payload, requestId: randomUUID(), content: '# Stale' },
        })
      ).statusCode,
    ).toBe(409);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(
      '# Saved anonymously',
    );
  } finally {
    await f.close();
  }
});

it('allows repeated bounded saves of a supported document without spending the public read byte budget', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f),
      content = '# Supported\n\n' + ('x'.repeat(1024) + '\n\n').repeat(700);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'bounded.md', content },
      })
    ).json();
    const sharing = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers,
        payload: { permission: 'edit' },
      })
    ).json();
    const base = `/api/public/shares/${sharing.token}`;
    const source = (await f.app.inject({ url: `${base}/source` })).json();
    const csrf = await f.app.inject({ url: `${base}/csrf` });
    const visitor = {
      origin,
      cookie: csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      'x-csrf-token': csrf.json().token,
    };
    let modifiedAt = source.modifiedAt;
    for (const ending of ['First save', 'Second save']) {
      const result = await f.app.inject({
        method: 'PUT',
        url: `${base}/source`,
        headers: visitor,
        payload: {
          content: content + ending,
          expectedModifiedAt: modifiedAt,
          requestId: randomUUID(),
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      modifiedAt = result.json().modifiedAt;
    }
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(
      content + 'Second save',
    );
  } finally {
    await f.close();
  }
});

it('rejects edit settings for large Markdown and whiteboards while still sharing them for viewing', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/large.md'), '# Large\n' + 'x'.repeat(32769));
    const tree = (await f.app.inject({ url: '/api/tree', headers })).json();
    const large = tree
      .find((r: any) => r.path === '00-Inbox')
      .children.find((r: any) => r.path.endsWith('large.md'));
    const board = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'board.excalidraw',
          content: JSON.stringify({
            type: 'excalidraw',
            version: 2,
            elements: [],
            appState: {},
            files: {},
          }),
        },
      })
    ).json();
    for (const n of [large, board]) {
      const url = `/api/notes/${n.id}/share`;
      const unsupported = await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { permission: 'edit' },
      });
      expect(unsupported.statusCode, unsupported.body).toBe(400);
      expect(unsupported.json().error).toMatch(/编辑/);
      const viewing = await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { permission: 'view' },
      });
      expect(viewing.statusCode, viewing.body).toBe(200);
      expect(viewing.json()).toMatchObject({ permission: 'view', editSupported: false });
      expect(viewing.json().editUnavailableReason).toMatch(/编辑/);
    }
  } finally {
    await f.close();
  }
});

it('revalidates the live share grant at the final durable update boundary', async () => {
  const f = await createFixture();
  const headers = await loginFixtureOwner(f);
  const n = (
    await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: 'race.md', content: '# Preserved' },
    })
  ).json();
  const share = (
    await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/share`,
      headers,
      payload: { permission: 'edit' },
    })
  ).json();
  await f.app.close();
  const db = openDatabase(f.dataRoot);
  const prepare = db.prepare.bind(db);
  let expired = false;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO write_intents')) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: any[]) => {
        const result = run(...args);
        prepare('UPDATE shares SET expires_at=? WHERE note_id=?').run(Date.now() - 1, n.id);
        expired = true;
        return result;
      }) as any;
    }
    return statement;
  }) as any;
  const principal: Principal = {
    id: `share:${createHash('sha256').update(share.token).digest('hex')}`,
    clientId: 'public-reader',
    scopes: ['knowledge:read', 'knowledge:write'],
    allowedPrefixes: [n.relativePath],
  };
  try {
    expect(() =>
      mutationCore(f.config, db).update(
        principal,
        n.id,
        '# Must not save',
        n.modifiedAt,
        randomUUID(),
      ),
    ).toThrow();
    expect(expired).toBe(true);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# Preserved');
  } finally {
    db.prepare = prepare;
    db.close();
    await f.close();
  }
});

it('acknowledges revocation even when the original document has become unavailable', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'missing.md', content: '# Missing later' },
      })
    ).json();
    const share = (
      await f.app.inject({ method: 'POST', url: `/api/notes/${n.id}/share`, headers })
    ).json();
    await unlink(join(f.knowledgeRoot, n.relativePath));
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}/share`,
      headers,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ enabled: false, state: 'revoked' });
    expect((await f.app.inject({ url: `/api/public/shares/${share.token}` })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});

it('keeps the active expiry when only the owner permission is changed', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'partial-permission.md',
          content: '# Partial',
        },
      })
    ).json();
    const url = `/api/notes/${n.id}/share`,
      expiresAt = new Date(Date.now() + 60000).toISOString();
    const initial = (
      await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { permission: 'edit', expiresAt },
      })
    ).json();
    const changed = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { permission: 'view' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ token: initial.token, permission: 'view', expiresAt });
  } finally {
    await f.close();
  }
});

it('keeps the active permission when only the owner expiry is changed', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'partial-expiry.md', content: '# Partial' },
      })
    ).json();
    const url = `/api/notes/${n.id}/share`;
    const initial = (
      await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { permission: 'edit', expiresAt: null },
      })
    ).json();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const timed = await f.app.inject({ method: 'POST', url, headers, payload: { expiresAt } });
    expect(timed.statusCode, timed.body).toBe(200);
    expect(timed.json()).toMatchObject({ token: initial.token, permission: 'edit', expiresAt });
    const permanent = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { expiresAt: null },
    });
    expect(permanent.statusCode, permanent.body).toBe(200);
    expect(permanent.json()).toMatchObject({
      token: initial.token,
      permission: 'edit',
      expiresAt: null,
    });
    await f.app.inject({ method: 'DELETE', url, headers });
    const fresh = (await f.app.inject({ method: 'POST', url, headers })).json();
    expect(fresh).toMatchObject({ permission: 'view', expiresAt: null });
    expect(fresh.token).not.toBe(initial.token);
  } finally {
    await f.close();
  }
});
