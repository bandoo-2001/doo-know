import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

let f: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeAll(async () => {
  f = await createFixture();
  headers = await loginFixtureOwner(f);
});
afterAll(async () => f?.close());

it('provides an authenticated To Doo state independently of public note access', async () => {
  const response = await f.app.inject({ url: '/api/to-doo/state', headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toHaveProperty('settings');
  expect((await f.app.inject({ url: '/api/to-doo/state' })).statusCode).toBe(401);
});

it('rejects cross-origin and CSRF-free task mutations', async () => {
  const payload = {
    requestId: randomUUID(),
    action: 'create_task',
    payload: { title: 'Private task' },
  };
  const noCsrf = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers: { cookie: headers.cookie, origin: headers.origin },
    payload,
  });
  expect(noCsrf.statusCode).toBe(403);
  const crossOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers: { ...headers, origin: 'https://untrusted.example' },
    payload,
  });
  expect(crossOrigin.statusCode).toBe(403);
});

it('rejects invalid dates, collection names, malformed filters and trusted-only full export flags', async () => {
  for (const query of [
    'from=2026-02-31',
    'kinds=not-a-collection',
    'filter=%7Bbroken',
    'all=true',
  ]) {
    const response = await f.app.inject({ url: '/api/to-doo/state?' + query, headers });
    expect(response.statusCode, query + ': ' + response.body).toBe(400);
  }
});

it('does not expose a public application or raw portable task path', async () => {
  expect((await f.app.inject({ url: '/api/to-doo/state' })).statusCode).toBe(401);
  const file = join(f.knowledgeRoot, '_data/apps/to-doo/tasks/http-boundary-fixture.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ privateContent: 'TASK_CONTENT_MUST_REMAIN_PRIVATE' }));
  try {
    const response = await f.app.inject({
      url: '/_data/apps/to-doo/tasks/http-boundary-fixture.json',
    });
    expect(response.body).not.toContain('TASK_CONTENT_MUST_REMAIN_PRIVATE');
  } finally {
    await unlink(file);
  }
});
