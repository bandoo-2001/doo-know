import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

let f: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(async () => {
  f = await createFixture();
  headers = await loginFixtureOwner(f);
});
afterAll(async () => {
  await f?.close();
});
async function note(content: string) {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers,
    payload: { folderPath: '00-Inbox', fileName: randomUUID() + '.md', content },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function publish(n: any, extra: Record<string, unknown> = {}) {
  return f.app.inject({
    method: 'POST',
    url: '/api/blog/publish',
    headers,
    payload: {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      expectedContentHash: hash(n.content),
      expectedPublicationVersion: 0,
      requestId: randomUUID(),
      metadata: { slug: 'post-' + n.id.slice(0, 8) },
      ...extra,
    },
  });
}

it('publishes a private snapshot, requires explicit site enablement and leaves edits private', async () => {
  const n = await note('---\nsecret: ORIGINAL_PRIVATE_YAML\n---\n# Public title\n\nPublic version');
  const first = await publish(n);
  expect(first.statusCode, first.body).toBe(200);
  const post = first.json();
  expect(post.id).not.toBe(n.id);
  expect((await f.app.inject({ url: '/blog/' + post.slug })).statusCode).toBe(404);
  expect((await f.app.inject({ url: '/blog/' })).statusCode).toBe(404);
  const settings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
  const enabled = await f.app.inject({
    method: 'PATCH',
    url: '/api/blog/settings',
    headers,
    payload: {
      settings: { ...settings, enabled: true, title: 'Example blog' },
      requestId: randomUUID(),
    },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const read = () => f.app.inject({ url: '/blog/' + post.slug });
  let response = await read();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).toContain('Public version');
  expect(response.body).not.toContain('ORIGINAL_PRIVATE_YAML');
  expect(response.body).not.toContain(n.id);
  await writeFile(join(f.knowledgeRoot, n.relativePath), '# Draft private changed');
  response = await read();
  expect(response.body).toContain('Public version');
  expect(response.body).not.toContain('Draft private changed');
  expect(response.headers['cache-control']).toBe('no-store');
  await unlink(join(f.knowledgeRoot, n.relativePath));
  expect((await read()).statusCode).toBe(404);
  await writeFile(join(f.knowledgeRoot, n.relativePath), n.content);
  expect((await read()).statusCode).toBe(404);
});

it('rejects anonymous and CSRF-free blog writes and stale source publication', async () => {
  expect(
    (await f.app.inject({ method: 'POST', url: '/api/blog/publish', payload: {} })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/blog/publish',
        headers: { cookie: headers.cookie },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const n = await note('# Initial');
  await writeFile(join(f.knowledgeRoot, n.relativePath), '# Changed');
  expect((await publish(n)).statusCode).toBe(409);
});

it('fails malformed frontmatter and requires fixed previews without publishing diagram sources', async () => {
  expect((await publish(await note('---\nprivate: NEVER_PUBLIC'))).statusCode).toBe(400);
  const n = await note('# Figure\n\n```mermaid\nflowchart TD\nA-->B\n```\n');
  const r = await publish(n);
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json().code).toBe('BLOG_PREVIEW_REQUIRED');
  expect(r.json().needs[0]).toMatchObject({ kind: 'mermaid' });
});

it('returns temporary unavailability without revoking when the knowledge root becomes unreadable', async () => {
  const settings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
  if (!settings.enabled)
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: '/api/blog/settings',
          headers,
          payload: { settings: { ...settings, enabled: true }, requestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
  const n = await note('# Root recovery');
  const response = await publish(n);
  expect(response.statusCode, response.body).toBe(200);
  const post = response.json();
  await chmod(f.knowledgeRoot, 0o000);
  try {
    expect((await f.app.inject({ url: '/blog/' + post.slug })).statusCode).toBe(503);
  } finally {
    await chmod(f.knowledgeRoot, 0o700);
  }
  expect((await f.app.inject({ url: '/blog/' + post.slug })).statusCode).toBe(200);
});
