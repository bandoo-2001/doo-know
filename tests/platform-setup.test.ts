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
  const config = { dataRoot: join(root, 'data'), secret: 'platform-fixture-secret-at-least-thirty-two-characters',
    origin: 'http://localhost:3010', allowedKnowledgeBases: [join(root, 'libraries')],
    indexing: { enabled: false, watch: false }, fileTasks: { embedded: false } };
  await mkdir(join(root, 'libraries', 'personal'), { recursive: true });
  const app = await createApp(config as any);
  await initializeOwner(config as any, 'owner', testPassword);
  const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/username',
    headers: { origin: config.origin }, payload: { username: 'owner', password: testPassword } });
  const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const csrf = await app.inject({ url: '/api/security/csrf', headers: { cookie } });
  const headers = { cookie: cookie + '; ' + csrf.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    origin: config.origin, 'x-csrf-token': csrf.json().token };
  return { root, config, app, headers, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

it('serves login before binding, authenticates setup, commits root and receipt, and replays after restart', async () => {
  const f = await fresh();
  try {
    expect((await f.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(503);
    expect((await f.app.inject({ url: '/api/platform/status' })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/tree', headers: f.headers })).statusCode).toBe(503);
    expect((await f.app.inject({ url: '/api/public/shares/missing' })).statusCode).toBe(404);
    expect((await f.app.inject({ url: '/api/platform/status', headers: f.headers })).json().phase).toBe('setup_required');
    const knowledgeRoot = join(f.root, 'libraries', 'personal');
    const validate = await f.app.inject({ method: 'POST', url: '/api/platform/setup/validate', headers: f.headers, payload: { knowledgeRoot } });
    expect(validate.statusCode).toBe(200);
    const payload = { knowledgeRoot, timeZone: 'Asia/Shanghai', validationId: validate.json().validationId, requestId: 'setup-one' };
    const saved = await f.app.inject({ method: 'POST', url: '/api/platform/setup/complete', headers: f.headers, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().configSaved).toBe(true);
    const again = await f.app.inject({ method: 'POST', url: '/api/platform/setup/complete', headers: f.headers, payload });
    expect(again.json()).toEqual(saved.json());
    await f.app.close();
    f.app = await createApp(f.config as any);
    const replay = await f.app.inject({ method: 'POST', url: '/api/platform/setup/complete', headers: f.headers, payload });
    expect(replay.json()).toEqual(saved.json());
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(200);
    const db = openDatabase(f.config.dataRoot);
    expect((db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any).value).toContain(knowledgeRoot);
    expect((db.prepare('SELECT count(*) n FROM platform_settings').get() as any).n).toBe(1);
    db.close();
  } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
});

it('rejects symlinks, forbidden paths, missing csrf and directory replacement between validation and bind', async () => {
  const f = await fresh();
  try {
    const validate = (knowledgeRoot: string, headers = f.headers) => f.app.inject({ method: 'POST', url: '/api/platform/setup/validate', headers, payload: { knowledgeRoot } });
    expect((await validate(f.config.dataRoot)).statusCode).toBe(403);
    const link = join(f.root, 'libraries', 'link');
    await symlink(join(f.root, 'libraries', 'personal'), link);
    expect((await validate(link)).statusCode).toBe(400);
    expect((await validate(join(f.root, 'libraries', 'personal'), { ...f.headers, 'x-csrf-token': 'invalid' })).statusCode).toBe(403);
    const knowledgeRoot = join(f.root, 'libraries', 'personal');
    const checked = (await validate(knowledgeRoot)).json();
    await rename(knowledgeRoot, knowledgeRoot + '-old'); await mkdir(knowledgeRoot);
    const replaced = await f.app.inject({ method: 'POST', url: '/api/platform/setup/complete', headers: f.headers,
      payload: { knowledgeRoot, timeZone: 'Asia/Shanghai', validationId: checked.validationId, requestId: 'replaced' } });
    expect(replaced.statusCode).toBe(409);
    expect((await f.app.inject({ url: '/api/platform/status', headers: f.headers })).json().phase).toBe('setup_required');
  } finally { await f.close(); }
});
