import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('requires owner authentication and CSRF, never returns credentials, and rejects unsafe remote jobs before execution', async () => {
  const f = await createFixture();
  try {
    expect((await f.app.inject({ url: '/api/platform/git/credentials' })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/platform/git/jobs' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f),
      token = 'fixture-private-access-token-DO-NOT-RETURN';
    const unauthorized = await f.app.inject({
      method: 'POST',
      url: '/api/platform/git/credentials',
      headers: { ...headers, origin: 'https://other.invalid' },
      payload: { name: 'Unsafe', kind: 'https', host: 'github.com', token },
    });
    expect(unauthorized.statusCode).toBe(403);
    const saved = await f.app.inject({
      method: 'POST',
      url: '/api/platform/git/credentials',
      headers,
      payload: {
        name: 'My repository',
        kind: 'https',
        host: 'github.com',
        username: 'fixture',
        token,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(token);
    const listed = await f.app.inject({ url: '/api/platform/git/credentials', headers });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.body).not.toContain(token);
    for (const url of [
      'file:///etc/passwd',
      'https://fixture:password@github.com/owner/repo',
      'https://127.0.0.1/owner/repo',
    ]) {
      const rejected = await f.app.inject({
        method: 'POST',
        url: '/api/platform/git/jobs',
        headers,
        payload: { kind: 'test', requestId: crypto.randomUUID(), url },
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect((await f.app.inject({ url: '/api/platform/git/jobs', headers })).json().items).toEqual(
      [],
    );
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/api/platform/git/credentials/' + saved.json().id,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/platform/git/credentials', headers })).json().items,
    ).toEqual([]);
    const db = await readFile(join(f.dataRoot, 'app.sqlite'));
    expect(db.includes(Buffer.from(token))).toBe(false);
  } finally {
    await f.close();
  }
});

it('blocks plugin lifecycle changes while a remote task is pending', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const db = openDatabase(f.dataRoot);
    try {
      db.prepare('INSERT INTO git_remote_jobs(id,owner,request_id,kind,params,root,binding,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run('pending-fixture', 'owner', 'pending-fixture', 'push', '{}', f.knowledgeRoot, 0, 'running', 'pushing', Date.now(), Date.now());
    } finally { db.close(); }
    for (const url of ['/api/platform/plugins/git/disable', '/api/platform/plugins/git/uninstall', '/api/platform/plugins/git/upgrade', '/api/platform/plugin-installations']) {
      const response = await f.app.inject({ method: 'POST', url, headers, payload: { id: 'git', requestId: 'pending-plugin-install' } });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('GIT_TASK_BUSY');
    }
  } finally { await f.close(); }
});
