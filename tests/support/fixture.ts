import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
export const origin = 'http://localhost:3010';
import { testPassword } from './credentials.js';
export { testPassword };
export async function createFixture(overrides: Record<string, unknown> = {}, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'doo-know-test-'));
  const knowledgeRoot = join(root, 'knowledge'),
    dataRoot = join(root, 'data');
  await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const config = {
    knowledgeRoot,
    dataRoot,
    origin,
    secret: 'fixture-only-secret-at-least-thirty-two-characters',
    indexing: { enabled: false, watch: false },
    ...overrides,
  };
  const app = await createApp(config);
  return {
    app,
    config,
    root,
    knowledgeRoot: config.knowledgeRoot,
    dataRoot: config.dataRoot,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof createFixture>>;
export async function loginFixtureOwner(f: Fixture) {
  const { initializeOwner } = await import('../../server/auth.js');
  await initializeOwner(f.config, 'owner', testPassword);
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin },
    payload: { username: 'owner', password: testPassword },
  });
  if (login.statusCode !== 200) throw new Error(`fixture login failed: ${login.statusCode}`);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = await f.app.inject({ url: '/api/security/csrf', headers: { cookie } });
  const csrfCookie = csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    cookie: cookie + '; ' + csrfCookie,
    origin,
    'x-csrf-token': csrf.json().token as string,
  };
}
