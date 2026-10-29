import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { defaultBlogDesign, type BlogDesign } from '../shared/blog-design';
import {
  documentHtml,
  homeHtml,
  readerHtml,
  type ReaderPost,
  type RenderContext,
  type PublicPageSource,
} from '../apps/server/blog/render';

const renderContext: RenderContext = {
  settings: {
    version: 1,
    enabled: true,
    title: 'Notebook',
    description: 'Ideas in progress',
    author: 'Writer',
    baseUrl: '',
    about: '',
    theme: 'light',
  },
  design: defaultBlogDesign(),
  origin: 'https://example.org',
};
const emptySource: PublicPageSource = () => ({
  posts: [],
  total: 0,
  page: 1,
  pageSize: 12,
  totalPages: 0,
});
const readerPost: ReaderPost = {
  id: 'reader',
  slug: 'reader',
  title: 'A public note',
  summary: 'A useful summary',
  category: 'Writing',
  tags: ['notes'],
  pinned: false,
  cover: null,
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  url: '/blog/reader',
  html: '<h1 id="original">Source title</h1><h2 id="a&amp;b">A &amp; B</h2><p>Original text.</p>',
  headings: [
    { id: 'original', text: 'Source title' },
    { id: 'a&b', text: 'A & B' },
  ],
};

it('provides native article navigation and author context while preserving snapshot HTML exactly', () => {
  const html = readerHtml(renderContext, readerPost, emptySource);
  expect(html).toContain('aria-label="面包屑"');
  expect(html).toContain('href="/blog/-/articles"');
  expect(html).toContain('id="article-top"');
  expect(html).toContain('href="#article-top"');
  expect(html).toContain('href="#a&amp;b"');
  expect(html).toContain('<details>');
  expect(html).not.toContain('<details open');
  expect(html).toContain('class="reader-author">Writer</span>');
  expect(html).toContain('<div class="article-body">' + readerPost.html + '</div>');
  expect(html).toMatch(/<progress[^>]*data-reading-progress[^>]*hidden/);
  // Share controls need scripting; native links remain useful with scripting disabled.
  expect(html).toMatch(/<button[^>]*data-copy-link[^>]*hidden/);
});

it('omits an empty table of contents without removing the native return link', () => {
  const html = readerHtml(
    renderContext,
    { ...readerPost, html: '<p>A short note.</p>', headings: [] },
    emptySource,
  );
  expect(html).not.toContain('<aside class="toc"');
  expect(html).toContain('href="#article-top"');
  expect(html).toContain('1 分钟阅读');
});

it('keeps previews script free while public readers retain their self hosted enhancement', () => {
  const publicHtml = documentHtml(
    renderContext,
    readerPost.title,
    '<p>Body</p>',
    readerPost.url,
    readerPost,
  );
  const preview = documentHtml(
    { ...renderContext, preview: true },
    readerPost.title,
    '<p>Body</p>',
    readerPost.url,
    readerPost,
  );
  expect(publicHtml).toContain('src="/blog/reader.js"');
  expect(preview).not.toContain('<script');
  expect(preview).toContain('href="/blog/-/articles"');
  expect(preview).toContain('<p>Body</p>');
});

it('keeps a profile homepage usable when its intro is disabled', () => {
  const design = defaultBlogDesign();
  design.template = 'profile';
  design.modules = [
    { id: 'latest', kind: 'latest', title: 'Recent writing', enabled: true, limit: 2 },
  ];
  const html = homeHtml({ ...renderContext, design }, emptySource);
  expect(html).toContain('class="home-profile no-intro"');
  expect(html).toContain('Recent writing');
  expect(html).toContain('href="/blog/-/articles"');
  expect(html).not.toContain('profile-sidebar');
});

let f: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeAll(async () => {
  f = await createFixture();
  headers = await loginFixtureOwner(f);
});
afterAll(async () => {
  await f?.close();
});
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) {
  return f.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}
async function settings(patch: Record<string, unknown>) {
  const old = (await call('GET', '/api/blog/settings')).json();
  const r = await call('PATCH', '/api/blog/settings', {
    settings: { ...old, ...patch },
    requestId: randomUUID(),
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function post(title: string, extra: Record<string, unknown> = {}) {
  const content =
    '# ' +
    title +
    '\n\nPublic snapshot.\n\n## One\n\n```js\nconsole.log("safe");\n```\n\n## Two\n\n## Three';
  const n = await call('POST', '/api/notes', {
    folderPath: '00-Inbox',
    fileName: randomUUID() + '.md',
    content,
  });
  expect(n.statusCode, n.body).toBe(201);
  const note = n.json();
  const r = await call('POST', '/api/blog/publish', {
    noteId: note.id,
    expectedModifiedAt: note.modifiedAt,
    expectedContentHash: createHash('sha256').update(content).digest('hex'),
    expectedPublicationVersion: 0,
    requestId: randomUUID(),
    metadata: {
      slug: 'reader-' + note.id.slice(0, 8),
      title,
      category: 'Reader',
      tags: ['garden'],
      ...extra,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function save(design: BlogDesign, publish = true) {
  const state = (await call('GET', '/api/blog/design')).json();
  const saved = await call('PATCH', '/api/blog/design', {
    design,
    expectedVersion: state.version,
    requestId: randomUUID(),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  if (publish) {
    const r = await call('POST', '/api/blog/design/publish', {
      expectedVersion: saved.json().version,
      requestId: randomUUID(),
    });
    expect(r.statusCode, r.body).toBe(200);
  }
}

it('serves a searchable paginated article index from published snapshots only', async () => {
  await settings({ enabled: true });
  await post('Pagination Needle A');
  await post('Pagination Needle B');
  await post('Different result');
  await call('POST', '/api/notes', {
    folderPath: '00-Inbox',
    fileName: randomUUID() + '.md',
    content: '# Pagination Needle PRIVATE',
  });
  const page1 = await f.app.inject({ url: '/blog/articles?q=Pagination%20Needle&pageSize=1' });
  expect(page1.statusCode, page1.body).toBe(200);
  expect(page1.body).toContain('name="q"');
  expect(page1.body).toContain('共 2 篇文章');
  expect(page1.body.match(/class="post-card/g)).toHaveLength(1);
  expect(page1.body).toContain('rel="next"');
  const next = page1.body.match(/href="([^"]+)" rel="next"/)![1].replaceAll('&amp;', '&');
  const page2 = await f.app.inject({ url: next });
  expect(page2.statusCode).toBe(200);
  expect(page2.body.match(/class="post-card/g)).toHaveLength(1);
  expect(page2.body).toContain('rel="prev"');
  expect(page1.body + page2.body).not.toContain('Pagination Needle PRIVATE');
  expect(page1.headers['cache-control']).toBe('no-store');
});

it('renders three distinct template structures and configured home modules while isolating drafts', async () => {
  const design = defaultBlogDesign();
  design.profile = {
    name: 'Public Identity',
    tagline: 'A small garden',
    bio: 'Profile bio',
    avatar: '',
    cover: '',
  };
  design.projects = [
    {
      id: 'project',
      title: 'My project',
      description: 'Project details',
      href: 'https://example.org/project',
    },
  ];
  design.friendLinks = [
    { id: 'friend', label: 'Garden friend', href: 'https://example.org/friend' },
  ];
  const layouts: string[] = [];
  for (const template of ['journal', 'magazine', 'profile'] as const) {
    design.template = template;
    await save(design);
    const page = await f.app.inject({ url: '/blog' });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain(`class="home-${template}"`);
    for (const kind of ['intro', 'featured', 'latest', 'collections', 'projects', 'links'])
      expect(page.body).toContain(`data-module="${kind}"`);
    expect(page.body).toContain('My project');
    expect(page.body).toContain('Garden friend');
    layouts.push(page.body.match(/<main[\s\S]*<\/main>/)![0]);
  }
  expect(new Set(layouts).size).toBe(3);
  design.profile.name = 'PRIVATE DRAFT IDENTITY';
  design.modules = [
    { id: 'draft-only', kind: 'intro', title: 'PRIVATE DRAFT MODULE', enabled: true, limit: 1 },
  ];
  await save(design, false);
  const publicPage = await f.app.inject({ url: '/blog' });
  expect(publicPage.body).toContain('Public Identity');
  expect(publicPage.body).not.toContain('PRIVATE DRAFT');
  const preview = await call('GET', '/api/blog/design/preview');
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.body).toContain('PRIVATE DRAFT IDENTITY');
  expect(preview.body).toContain('PRIVATE DRAFT MODULE');
  const anonymous = await f.app.inject({ url: '/api/blog/design/preview' });
  expect(anonymous.statusCode).toBe(401);
});

it('previews unsaved designs when closed without opening any public endpoint', async () => {
  await settings({ enabled: false });
  const design = defaultBlogDesign();
  design.profile.name = 'Unsaved Preview';
  const r = await call('POST', '/api/blog/design/preview', { design });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().html).toContain('Unsaved Preview');
  for (const url of [
    '/blog',
    '/blog/',
    '/blog/articles',
    '/blog/collections',
    '/blog/-/articles',
    '/blog/-/collections',
    '/blog/-/collections/example',
    '/blog/about',
    '/blog/archive',
    '/blog/rss.xml',
    '/blog/sitemap.xml',
    '/blog/reader.js',
  ]) {
    expect((await f.app.inject({ url })).statusCode, url).toBe(404);
  }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/blog/design/preview',
        headers: { cookie: headers.cookie },
        payload: { design },
      })
    ).statusCode,
  ).toBe(403);
  await settings({ enabled: true });
});

it('orders collection members by configuration and immediately removes withdrawn articles from discovery', async () => {
  const a = await post('Collection Alpha'),
    b = await post('Collection Beta');
  const design = defaultBlogDesign();
  design.collections = [
    {
      id: 'garden',
      slug: 'garden',
      title: 'Garden Collection',
      description: 'A guided path',
      postIds: [a.id, 'missing-post', b.id],
    },
  ];
  await save(design);
  const page = await f.app.inject({ url: '/blog/collections/garden' });
  expect(page.statusCode, page.body).toBe(200);
  expect(page.body.indexOf('Collection Alpha')).toBeLessThan(page.body.indexOf('Collection Beta'));
  expect(page.body).not.toContain('missing-post');
  const reader = await f.app.inject({ url: '/blog/' + a.slug });
  expect(reader.body).toContain('Garden Collection');
  expect(reader.body).toContain('Collection Beta');
  const withdrawal = await call('POST', '/api/blog/unpublish', {
    noteId: a.sourceNoteId,
    expectedPublicationVersion: a.version,
    requestId: randomUUID(),
  });
  expect(withdrawal.statusCode, withdrawal.body).toBe(200);
  const after = await f.app.inject({ url: '/blog/collections/garden' });
  expect(after.body).not.toContain('Collection Alpha');
  expect(after.body).toContain('Collection Beta');
  expect((await f.app.inject({ url: '/blog/' + a.slug })).statusCode).toBe(404);
});

it('renders safe Markdown about and reader share metadata with a self hosted script', async () => {
  await settings({
    enabled: true,
    about:
      '## About garden\n\n**Strong text**\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
  });
  const about = await f.app.inject({ url: '/blog/about' });
  expect(about.body).toContain('<h2>About garden</h2>');
  expect(about.body).toContain('<strong>Strong text</strong>');
  expect(about.body).not.toContain('<script>alert(1)</script>');
  expect(about.body).not.toContain('href="javascript:');
  const p = await post('Escaped </script><script>bad</script> title');
  const reader = await f.app.inject({ url: '/blog/' + p.slug });
  expect(reader.statusCode, reader.body).toBe(200);
  expect(reader.body).toContain('type="application/ld+json"');
  expect(reader.body).toContain('\\u003c/script\\u003e');
  expect(reader.body).toContain('data-copy-link');
  expect(reader.body).toContain('data-share');
  expect(reader.body).toContain('分钟阅读');
  expect(reader.body).toContain('aria-label="目录"');
  expect(reader.body).toContain('src="/blog/reader.js"');
  expect(reader.body).not.toMatch(/\son(?:click|load|error)=/i);
  expect(reader.headers['content-security-policy']).toContain("script-src 'self'");
  const script = await f.app.inject({ url: '/blog/reader.js' });
  expect(script.statusCode).toBe(200);
  expect(script.headers['content-type']).toContain('javascript');
});

it('honors module order, visibility and limits in both live and unsaved previews', async () => {
  const design = defaultBlogDesign();
  design.modules = [
    { id: 'projects-first', kind: 'projects', title: 'Projects First', enabled: true, limit: 1 },
    { id: 'links-hidden', kind: 'links', title: 'HIDDEN LINKS MODULE', enabled: false, limit: 10 },
    { id: 'intro-last', kind: 'intro', title: 'Intro Last', enabled: true, limit: 1 },
  ];
  design.projects = [
    {
      id: 'first-project',
      title: 'Visible Project',
      description: '',
      href: 'https://example.org/first',
    },
    {
      id: 'second-project',
      title: 'LIMITED OUT PROJECT',
      description: '',
      href: 'https://example.org/second',
    },
  ];
  await save(design);
  const live = await f.app.inject({ url: '/blog' });
  const preview = await call('POST', '/api/blog/design/preview', { design });
  for (const html of [live.body, preview.json().html]) {
    expect(html).toContain('Visible Project');
    expect(html).not.toContain('LIMITED OUT PROJECT');
    expect(html).not.toContain('HIDDEN LINKS MODULE');
    expect(html.indexOf('Projects First')).toBeLessThan(html.indexOf('Intro Last'));
    expect(html).not.toContain('data-module="latest"');
  }
});

it('rewrites unpublished design images to authenticated preview resources without exposing them publicly', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
  const upload = await call('POST', '/api/blog/design/media', {
    name: 'avatar.png',
    mime: 'image/png',
    base64: png,
    requestId: randomUUID(),
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const media = upload.json(),
    design = defaultBlogDesign();
  design.profile.avatar = media.url;
  await save(design, false);
  const preview = await call('GET', '/api/blog/design/preview');
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.body).toContain(`src="/api/blog/design/media/${media.hash}"`);
  expect((await f.app.inject({ url: media.url })).statusCode).toBe(404);
  expect((await f.app.inject({ url: '/api/blog/design/media/' + media.hash })).statusCode).toBe(
    401,
  );
  expect((await call('GET', '/api/blog/design/media/' + media.hash)).statusCode).toBe(200);
  await save(design);
  expect((await f.app.inject({ url: media.url })).statusCode).toBe(200);
  expect((await f.app.inject({ url: '/blog' })).body).toContain(`src="${media.url}"`);
});

it('keeps the latest module chronological when an older article is pinned', async () => {
  const pinned = await post('Older Pinned Reader Article', { pinned: true });
  const latest = await post('Newest Reader Article');
  const design = defaultBlogDesign();
  design.modules = [
    { id: 'latest', kind: 'latest', title: 'Latest chronological', enabled: true, limit: 1 },
  ];
  await save(design);
  const html = (await f.app.inject({ url: '/blog' })).body;
  expect(html).toContain('href="/blog/' + latest.slug + '"');
  expect(html).not.toContain('href="/blog/' + pinned.slug + '"');
});

it('labels chronological article neighbors independently from pinning and collection order', async () => {
  const older = await post('Chronological Older'),
    middle = await post('Chronological Middle'),
    newer = await post('Chronological Newer');
  const page = await f.app.inject({ url: '/blog/' + middle.slug });
  expect(page.body).toContain(`href="/blog/${older.slug}" rel="prev">上一篇：Chronological Older`);
  expect(page.body).toContain(`href="/blog/${newer.slug}" rel="next">下一篇：Chronological Newer`);
});

it('preserves legacy discovery-name article URLs alongside collision-free discovery pages', async () => {
  await settings({ enabled: true });
  for (const name of ['articles', 'collections']) {
    const alias = await f.app.inject({ url: '/blog/' + name });
    expect(alias.statusCode, alias.body).toBe(200);
    expect(alias.body).toContain('href="http://localhost:3010/blog/-/' + name + '"');
  }
  for (const slug of ['articles', 'collections']) {
    const published = await post('Legacy ' + slug + ' article');
    // Reproduce a database from before these names became new discovery routes.
    const db = new Database(join(f.dataRoot, 'app.sqlite'));
    try {
      db.prepare(
        "UPDATE blog_posts SET slug=?,metadata_json=json_set(metadata_json,'$.slug',?) WHERE id=?",
      ).run(slug, slug, published.id);
      db.prepare(
        "UPDATE blog_versions SET metadata_json=json_set(metadata_json,'$.slug',?) WHERE post_id=?",
      ).run(slug, published.id);
    } finally {
      db.close();
    }
    const legacy = await f.app.inject({ url: '/blog/' + slug });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.body).toContain('<h1>Legacy ' + slug + ' article</h1>');
    expect(legacy.body).toContain('class="article-body"');
    expect(legacy.body).toContain('href="http://localhost:3010/blog/' + slug + '"');
  }
  const design = defaultBlogDesign();
  design.collections = [
    {
      id: 'canonical',
      slug: 'canonical',
      title: 'Collision Free Collection',
      description: '',
      postIds: [],
    },
  ];
  await save(design);
  for (const path of ['/blog/-/articles', '/blog/-/collections', '/blog/-/collections/canonical']) {
    const page = await f.app.inject({ url: path });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('href="http://localhost:3010' + path + '"');
  }
  const home = await f.app.inject({ url: '/blog' });
  expect(home.body).toContain('href="/blog/-/articles"');
  expect(home.body).toContain('href="/blog/-/collections/canonical"');
});

it('uses authenticated immutable published cover bytes in closed-site previews after source edits', async () => {
  await settings({ enabled: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    'base64',
  );
  const created = await call('POST', '/api/notes', {
    folderPath: '00-Inbox',
    fileName: randomUUID() + '.md',
    content: '# Snapshot cover',
  });
  expect(created.statusCode, created.body).toBe(201);
  const n = created.json(),
    boundary = 'fixture-boundary-' + randomUUID();
  const uploaded = await f.app.inject({
    method: 'POST',
    url: '/api/notes/' + n.id + '/assets',
    headers: { ...headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload: Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      png,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const a = uploaded.json(),
    content = '# Snapshot cover\n\n![Cover](' + a.markdownPath + ')';
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/notes/' + n.id,
    headers,
    payload: { content, expectedModifiedAt: n.modifiedAt },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const publication = await call('POST', '/api/blog/publish', {
    noteId: n.id,
    expectedModifiedAt: saved.json().modifiedAt,
    expectedContentHash: createHash('sha256').update(content).digest('hex'),
    expectedPublicationVersion: 0,
    requestId: randomUUID(),
    metadata: {
      slug: 'snapshot-' + n.id.slice(0, 8),
      title: 'Immutable Cover Article',
      cover: a.markdownPath,
    },
  });
  expect(publication.statusCode, publication.body).toBe(200);
  const p = publication.json(),
    original = await f.app.inject({ url: '/blog/' + p.slug });
  const publicAsset = original.body.match(/src="(\/blog\/assets\/[^" ]+)"/)![1];
  const [, postId, versionId, hash] = publicAsset.match(
    /^\/blog\/assets\/([^/]+)\/([^/]+)\/([^/]+)$/,
  )!;
  const privateAsset = '/api/blog/posts/' + postId + '/versions/' + versionId + '/assets/' + hash;
  await writeFile(join(f.knowledgeRoot, n.relativePath), '# Edited source without its old cover');
  await writeFile(
    join(f.knowledgeRoot, a.relativePath),
    Buffer.concat([png, Buffer.from('source attachment changed')]),
  );
  const design = defaultBlogDesign();
  design.modules = [
    { id: 'latest', kind: 'latest', title: 'Latest preview', enabled: true, limit: 1 },
  ];
  await save(design);
  await settings({ enabled: false });
  const preview = await call('GET', '/api/blog/design/preview');
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.body).toContain('src="' + privateAsset + '"');
  const unsaved = await call('POST', '/api/blog/design/preview', { design });
  expect(unsaved.json().html).toContain('src="' + privateAsset + '"');
  expect((await f.app.inject({ url: publicAsset })).statusCode).toBe(404);
  expect((await f.app.inject({ url: privateAsset })).statusCode).toBe(401);
  const image = await call('GET', privateAsset);
  expect(image.statusCode, image.body).toBe(200);
  expect(image.rawPayload.equals(png)).toBe(true);
  expect(image.headers['cache-control']).toBe('no-store');
  expect(image.headers['x-content-type-options']).toBe('nosniff');
  expect((await call('GET', privateAsset.replace(versionId, 'unknown-version'))).statusCode).toBe(
    404,
  );
  await settings({ enabled: true });
  const withdrawn = await call('POST', '/api/blog/unpublish', {
    noteId: n.id,
    expectedPublicationVersion: p.version,
    requestId: randomUUID(),
  });
  expect(withdrawn.statusCode, withdrawn.body).toBe(200);
  expect((await f.app.inject({ url: publicAsset })).statusCode).toBe(404);
  expect((await call('GET', privateAsset)).rawPayload.equals(png)).toBe(true);
});
