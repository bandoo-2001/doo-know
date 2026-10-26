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

it('reflects the selected reader appearance and exposes keyboard landmarks without changing published content', async () => {
  const n = await note('# Reader heading\n\nA fixed public body.');
  const published = await publish(n);
  expect(published.statusCode, published.body).toBe(200);
  const post = published.json();
  const originalSettings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
  for (const theme of ['system', 'light']) {
    const settings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
    const updated = await f.app.inject({
      method: 'PATCH',
      url: '/api/blog/settings',
      headers,
      payload: { settings: { ...settings, enabled: true, theme }, requestId: randomUUID() },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const reader = await f.app.inject({ url: '/blog/' + post.slug });
    expect(reader.statusCode, reader.body).toBe(200);
    expect(reader.body).toMatch(new RegExp('<html[^>]+data-theme="' + theme + '"'));
    expect(reader.body).toContain('href="#blog-content"');
    expect(reader.body).toContain('aria-label="博客导航"');
    expect(reader.body).toContain('<main id="blog-content" tabindex="-1">');
    expect(reader.body).toContain('<h1 id="heading-0">Reader heading</h1>');
    expect(reader.body).toContain('A fixed public body.');
    expect(reader.headers['content-security-policy']).toContain("default-src 'none'");
    const current = (await f.app.inject({ url: '/api/blog', headers }))
      .json()
      .posts.find((p: any) => p.id === post.id);
    expect(current.version).toBe(post.version);
    expect(current.sourceHash).toBe(post.sourceHash);
  }
  const archive = await f.app.inject({ url: '/blog/archive' });
  expect(archive.body).toContain('href="/blog/archive" aria-current="page"');
  const settings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
  await f.app.inject({
    method: 'PATCH',
    url: '/api/blog/settings',
    headers,
    payload: { settings: { ...settings, theme: originalSettings.theme }, requestId: randomUUID() },
  });
});

it('explains active public filters and offers an exit when no article matches', async () => {
  const category = 'Reader category ' + randomUUID(),
    tag = 'Reader tag ' + randomUUID();
  const n = await note('# Filtered public post');
  const published = await publish(n, {
    metadata: { slug: 'filter-' + n.id.slice(0, 8), category, tags: [tag] },
  });
  expect(published.statusCode, published.body).toBe(200);
  const url = '/blog?category=' + encodeURIComponent(category);
  const categoryPage = await f.app.inject({ url });
  expect(categoryPage.statusCode, categoryPage.body).toBe(200);
  expect(categoryPage.body).toContain('href="' + url + '" aria-current="true"');
  expect(categoryPage.body).toContain('href="/blog">全部文章</a>');
  expect(categoryPage.body).toContain('当前分类');
  const tagPage = await f.app.inject({ url: '/blog?tag=' + encodeURIComponent(tag) });
  expect(tagPage.body).toContain('当前标签');
  expect(tagPage.body).toContain('aria-current="true">#' + tag + '</a>');
  const missing = await f.app.inject({ url: '/blog?tag=' + randomUUID() });
  expect(missing.statusCode, missing.body).toBe(200);
  expect(missing.body).toContain('没有匹配的文章');
  expect(missing.body).toContain('href="/blog">查看全部文章</a>');
  expect(missing.body).not.toContain('<h2><a href="/blog/' + published.json().slug + '"');
});
