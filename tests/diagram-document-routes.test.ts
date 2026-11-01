import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
const close: Fixture[] = [];
afterEach(async () => {
  for (const f of close.splice(0)) await f.close();
});
const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  sha = (text: string) => createHash('sha256').update(text).digest('hex');
it('reserves, prepares, publishes and reads a primary through authenticated HTTP without a JSON main-file response', async () => {
  const f = await createFixture();
  close.push(f);
  const headers = await loginFixtureOwner(f),
    source = JSON.stringify(emptyWhiteboard());
  const reserve = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/intents',
    headers,
    payload: { path: '00-Inbox/HTTP.md', type: 'whiteboard', requestId: randomUUID() },
  });
  expect(reserve.statusCode, reserve.body).toBe(201);
  const intent = reserve.json();
  const missing = await f.app.inject({ url: '/api/notes/' + intent.noteId, headers });
  expect(missing.statusCode).toBe(404);
  const preparation = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/prepare',
    headers,
    payload: {
      target: { kind: 'creation', intentId: intent.id },
      type: 'whiteboard',
      source,
      sourceHash: sha(source),
      title: 'HTTP 白板',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    },
  });
  expect(preparation.statusCode, preparation.body).toBe(201);
  const prepared = preparation.json(),
    markdown = renderPreparedDiagramDocument({ prepared, title: prepared.title, source });
  const commit = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/commit',
    headers,
    payload: { preparedId: prepared.id, markdown, requestId: randomUUID() },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  expect(commit.json()).toMatchObject({
    id: intent.noteId,
    content: markdown,
    documentType: 'whiteboard',
  });
  const main = await f.app.inject({ url: '/api/notes/' + intent.noteId, headers });
  expect(main.json().content).toBe(markdown);
  const resource = await f.app.inject({ url: '/api/notes/' + intent.noteId + '/diagram', headers });
  expect(resource.statusCode, resource.body).toBe(200);
  expect(resource.json()).toMatchObject({
    role: 'primary',
    source: { format: 'excalidraw', content: source },
    preview: { state: 'ready' },
  });
  const sourceRead = await f.app.inject({
    url: `/api/notes/${intent.noteId}/diagram/source?documentHash=${sha(markdown)}&sourceHash=${sha(source)}`,
    headers,
  });
  expect(sourceRead.statusCode, sourceRead.body).toBe(200);
  expect(sourceRead.rawPayload.toString()).toBe(source);
  expect(sourceRead.headers['content-disposition']).toContain('attachment');
});
it('requires the normal owner session and CSRF protection on new creation endpoints', async () => {
  const f = await createFixture();
  close.push(f);
  expect(
    (await f.app.inject({ method: 'POST', url: '/api/diagram-documents/intents', payload: {} }))
      .statusCode,
  ).toBe(401);
  const headers = await loginFixtureOwner(f);
  const { ['x-csrf-token']: _token, ...noToken } = headers;
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/diagram-documents/intents',
        headers: noToken,
        payload: { path: '00-Inbox/no.md', type: 'whiteboard', requestId: randomUUID() },
      })
    ).statusCode,
  ).toBe(403);
});
