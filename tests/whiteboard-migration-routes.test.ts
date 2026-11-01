import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { emptyWhiteboard } from '../shared/whiteboard';
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
it('migrates through the real owner API with server-fixed source bytes, resumable progress and session protection', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const headers = await loginFixtureOwner(f);
  expect((await f.app.inject({ url: '/api/whiteboard-migrations' })).statusCode).toBe(401);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers,
    payload: {
      folderPath: '00-Inbox',
      fileName: 'HTTP.excalidraw',
      content: JSON.stringify(emptyWhiteboard()),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const note = created.json();
  const plan = await f.app.inject({
    method: 'POST',
    url: '/api/whiteboard-migrations/plan',
    headers,
    payload: { noteId: note.id, requestId: randomUUID() },
  });
  expect(plan.statusCode, plan.body).toBe(200);
  const job = plan.json();
  expect(
    (await f.app.inject({ url: '/api/whiteboard-migrations/' + job.id, headers })).json(),
  ).toMatchObject({ id: job.id, status: 'planned', sourceHash: job.sourceHash });
  const prepared = await f.app.inject({
    method: 'POST',
    url: '/api/whiteboard-migrations/prepare',
    headers,
    payload: {
      migrationId: job.id,
      sourceHash: job.sourceHash,
      pngBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
      requestId: randomUUID(),
    },
  });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const commit = await f.app.inject({
    method: 'POST',
    url: '/api/whiteboard-migrations/commit',
    headers,
    payload: { migrationId: job.id, requestId: randomUUID() },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  expect(commit.json()).toMatchObject({ noteId: note.id, status: 'committed' });
  const main = await f.app.inject({ url: '/api/notes/' + note.id, headers });
  expect(main.json()).toMatchObject({
    id: note.id,
    relativePath: '00-Inbox/HTTP.md',
    documentType: 'whiteboard',
  });
  const stale = await f.app.inject({
    method: 'PUT',
    url: '/api/notes/' + note.id,
    headers,
    payload: { content: note.content, expectedModifiedAt: note.modifiedAt },
  });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.json().code).toBe('VERSION_CONFLICT');
  const { ['x-csrf-token']: _token, ...noToken } = headers;
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/whiteboard-migrations/rollback',
        headers: noToken,
        payload: { migrationId: job.id, requestId: randomUUID() },
      })
    ).statusCode,
  ).toBe(403);
});
