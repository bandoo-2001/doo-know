import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/app.js';
import { initializeOwner } from '../apps/server/auth.js';
import { openDatabase } from '../packages/core/db.js';
import { testPassword } from './support/credentials.js';

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-platform-'));
  const config = {
    dataRoot: join(root, 'data'),
    secret: 'platform-fixture-secret-at-least-thirty-two-characters',
    origin: 'http://localhost:3010',
    allowedKnowledgeBases: [join(root, 'libraries')],
    indexing: { enabled: false, watch: false },
    fileTasks: { embedded: false },
  };
  await mkdir(join(root, 'libraries', 'personal'), { recursive: true });
  const app = await createApp(config as any);
  await initializeOwner(config as any, 'owner', testPassword);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: testPassword },
  });
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = await app.inject({ url: '/api/security/csrf', headers: { cookie } });
  const headers = {
    cookie: cookie + '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    origin: config.origin,
    'x-csrf-token': csrf.json().token,
  };
  return {
    root,
    config,
    app,
    headers,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('serves login before binding, authenticates setup, commits root and receipt, and replays after restart', async () => {
  const f = await fresh();
  try {
    expect((await f.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(503);
    expect((await f.app.inject({ url: '/api/platform/status' })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/tree', headers: f.headers })).statusCode).toBe(503);
    expect((await f.app.inject({ url: '/api/public/shares/missing' })).statusCode).toBe(404);
    expect(
      (await f.app.inject({ url: '/api/platform/status', headers: f.headers })).json().phase,
    ).toBe('setup_required');
    const knowledgeRoot = join(f.root, 'libraries', 'personal');
    const validate = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/validate',
      headers: f.headers,
      payload: { knowledgeRoot },
    });
    expect(validate.statusCode).toBe(200);
    const payload = {
      knowledgeRoot,
      timeZone: 'Asia/Shanghai',
      validationId: validate.json().validationId,
      requestId: 'setup-one',
    };
    const saved = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/complete',
      headers: f.headers,
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().configSaved).toBe(true);
    const again = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/complete',
      headers: f.headers,
      payload,
    });
    expect(again.json()).toEqual(saved.json());
    await f.app.close();
    f.app = await createApp(f.config as any);
    const replay = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/complete',
      headers: f.headers,
      payload,
    });
    expect(replay.json()).toEqual(saved.json());
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(200);
    const db = openDatabase(f.config.dataRoot);
    expect(
      (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any).value,
    ).toContain(knowledgeRoot);
    expect((db.prepare('SELECT count(*) n FROM platform_settings').get() as any).n).toBe(1);
    db.close();
  } finally {
    await f.app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it('rejects symlinks, forbidden paths, missing csrf and directory replacement between validation and bind', async () => {
  const f = await fresh();
  try {
    const validate = (knowledgeRoot: string, headers = f.headers) =>
      f.app.inject({
        method: 'POST',
        url: '/api/platform/setup/validate',
        headers,
        payload: { knowledgeRoot },
      });
    expect((await validate(f.config.dataRoot)).statusCode).toBe(403);
    const link = join(f.root, 'libraries', 'link');
    await symlink(join(f.root, 'libraries', 'personal'), link);
    expect((await validate(link)).statusCode).toBe(400);
    expect(
      (
        await validate(join(f.root, 'libraries', 'personal'), {
          ...f.headers,
          'x-csrf-token': 'invalid',
        })
      ).statusCode,
    ).toBe(403);
    const knowledgeRoot = join(f.root, 'libraries', 'personal');
    const checked = (await validate(knowledgeRoot)).json();
    await rename(knowledgeRoot, knowledgeRoot + '-old');
    await mkdir(knowledgeRoot);
    const replaced = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/complete',
      headers: f.headers,
      payload: {
        knowledgeRoot,
        timeZone: 'Asia/Shanghai',
        validationId: checked.validationId,
        requestId: 'replaced',
      },
    });
    expect(replaced.statusCode).toBe(409);
    expect(
      (await f.app.inject({ url: '/api/platform/status', headers: f.headers })).json().phase,
    ).toBe('setup_required');
  } finally {
    await f.close();
  }
});

it('browses only allowed visible directories and creates a new library with a replayable receipt', async () => {
  const f = await fresh();
  try {
    const base = join(f.root, 'libraries');
    await mkdir(join(base, '.private'));
    await symlink(join(base, 'personal'), join(base, 'shortcut'));
    const browse = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/directories',
      headers: f.headers,
      payload: {},
    });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().directories.map((d: any) => d.name)).toEqual(['personal']);
    expect(browse.json().suggestedParent).toBe(base);
    const payload = { name: '我的资料', requestId: 'create-library-one' };
    const made = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/create',
      headers: f.headers,
      payload,
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().knowledgeRoot).toBe(join(base, '我的资料'));
    await f.app.close();
    f.app = await createApp(f.config as any);
    const replay = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/create',
      headers: f.headers,
      payload,
    });
    expect(replay.json()).toEqual(made.json());
    const duplicate = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/create',
      headers: f.headers,
      payload: { ...payload, requestId: 'another-create' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('DIRECTORY_EXISTS');
    const checked = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/validate',
      headers: f.headers,
      payload: made.json(),
    });
    expect(checked.statusCode).toBe(200);
  } finally {
    await f.close();
  }
});

it('protects directory browsing and creation from anonymous requests, csrf, traversal and symlinks', async () => {
  const f = await fresh();
  try {
    const post = (action: string, payload: any, headers: any = f.headers) =>
      f.app.inject({ method: 'POST', url: '/api/platform/setup/' + action, headers, payload });
    expect((await post('directories', {}, {})).statusCode).toBe(401);
    expect(
      (
        await post(
          'create',
          { name: 'new', requestId: 'no-csrf' },
          { ...f.headers, 'x-csrf-token': 'bad' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await post('directories', { path: f.config.dataRoot })).statusCode).toBe(403);
    expect((await post('directories', { path: '/etc' })).statusCode).toBe(403);
    for (const name of ['../escape', '.secret', 'nested/name', '', 'x'.repeat(256)])
      expect((await post('create', { name, requestId: 'invalid-name' })).statusCode).toBe(400);
    const link = join(f.root, 'libraries', 'link');
    await symlink(join(f.root, 'libraries', 'personal'), link);
    expect((await post('directories', { path: link })).statusCode).toBe(400);
    expect(
      (await post('create', { name: 'new', parentPath: link, requestId: 'symlink-create' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post('create', {
          name: 'new',
          parentPath: f.config.dataRoot,
          requestId: 'forbidden-create',
        })
      ).statusCode,
    ).toBe(403);
    expect((await post('create', { name: 'personal', requestId: 'existing' })).json().code).toBe(
      'DIRECTORY_EXISTS',
    );
  } finally {
    await f.close();
  }
});

it('keeps protected storage out of the browser and rejects overlapping new libraries', async () => {
  const f = await fresh();
  try {
    const base = join(f.root, 'libraries');
    await f.app.close();
    f.config.dataRoot = join(base, 'protected-data');
    await initializeOwner(f.config as any, 'owner', testPassword);
    f.app = await createApp(f.config as any);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: f.config.origin },
      payload: { username: 'owner', password: testPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = await f.app.inject({ url: '/api/security/csrf', headers: { cookie } });
    const headers = {
      cookie: cookie + '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      origin: f.config.origin,
      'x-csrf-token': csrf.json().token,
    };
    const browse = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/directories',
      headers,
      payload: { path: base },
    });
    expect(browse.json().directories.map((d: any) => d.name)).not.toContain('protected-data');
    const made = await f.app.inject({
      method: 'POST',
      url: '/api/platform/setup/create',
      headers,
      payload: { parentPath: f.config.dataRoot, name: 'notes', requestId: 'protected-overlap' },
    });
    expect(made.statusCode).toBe(403);
  } finally {
    await f.close();
  }
});
