import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rename, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/app.js';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';

it('rechecks a saved library after offline startup without recreating the folder or requiring a service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-storage-retry-'));
  const knowledgeRoot = join(root, 'libraries', 'personal');
  await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
  const originalNote = '# Existing library\n\nKeep this original.\n';
  await writeFile(join(knowledgeRoot, '00-Inbox', 'original.md'), originalNote);
  const config = {
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'isolated-recovery-test-secret-at-least-32-characters',
    allowedKnowledgeBases: [join(root, 'libraries')],
    indexing: { enabled: false, watch: false },
    fileTasks: { embedded: false },
  };
  let app = await createApp(config);
  try {
    await initializeOwner(config, 'owner', testPassword);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: config.origin },
      payload: { username: 'owner', password: testPassword },
    });
    let cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = await app.inject({ url: '/api/security/csrf', headers: { cookie } });
    cookie += '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const headers = { cookie, origin: config.origin, 'x-csrf-token': csrf.json().token };
    const proof = (
      await app.inject({
        method: 'POST',
        url: '/api/platform/setup/validate',
        headers,
        payload: { knowledgeRoot },
      })
    ).json();
    const saved = await app.inject({
      method: 'POST',
      url: '/api/platform/setup/complete',
      headers,
      payload: { ...proof, requestId: 'storage-retry-bind', timeZone: 'Asia/Shanghai' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await app.close();
    await rename(knowledgeRoot, knowledgeRoot + '-offline');
    app = await createApp(config);
    expect((await app.inject({ url: '/healthz' })).json().phase).toBe('source_unavailable');
    const missing = await app.inject({ url: '/api/platform/status', headers });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().phase).toBe('source_unavailable');
    await expect(access(knowledgeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(knowledgeRoot + '-offline', knowledgeRoot);
    const recovered = await Promise.all(
      Array.from({ length: 3 }, () => app.inject({ url: '/api/platform/status', headers })),
    );
    for (const response of recovered) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ phase: 'ready', knowledgeRoot, bindingVersion: 1 });
    }
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/tree', headers })).statusCode).toBe(200);
    expect(await readFile(join(knowledgeRoot, '00-Inbox', 'original.md'), 'utf8')).toBe(
      originalNote,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
