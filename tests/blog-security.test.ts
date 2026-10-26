import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../apps/server/app.js';
import { initializeOwner } from '../apps/server/auth.js';
import type { BlogPost, BlogPostDetail, BlogSettings } from '../shared/blog-contracts.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'blog-security-'));
  const config = { dataRoot: join(root, 'data'), knowledgeRoot: join(root, 'knowledge'),
    origin: 'http://127.0.0.1:34197', secret: 'blog-security-fixture-secret-at-least-thirty-two-characters',
    indexing: { enabled: false, watch: false } };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  await initializeOwner(config, 'blog_fixture', 'blog-fixture-only-password-20261026');
  const app = await createApp(config);
  cleanup.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/username',
    headers: { origin: config.origin }, payload: { username: 'blog_fixture', password: 'blog-fixture-only-password-20261026' } });
  expect(login.statusCode).toBe(200);
  let cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const csrf = await app.inject({ url: '/api/security/csrf', headers: { cookie } });
  cookie += '; ' + csrf.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie, origin: config.origin, 'x-csrf-token': csrf.json().token };
  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  }
  async function note(content: string, name = `${randomUUID()}.md`) {
    const r = await call('POST', '/api/notes', { folderPath: '00-Inbox', fileName: name, content, requestId: randomUUID() });
    expect(r.statusCode, r.body).toBe(201); return r.json();
  }
  async function enable(enabled = true) {
    const r = await call('GET', '/api/blog/settings'); expect(r.statusCode, r.body).toBe(200);
    const settings = r.json<BlogSettings>();
    const saved = await call('PATCH', '/api/blog/settings', { settings: { ...settings, enabled, title: 'Public fixture', author: 'Fixture', description: 'Public summary' }, requestId: randomUUID() });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  async function select(id: string, slug = 'public-fixture') {
    const r = await call('POST', '/api/blog/posts', { sourceNoteId: id,
      metadata: { slug, title: 'Published title', summary: 'Public summary', category: 'Development', tags: ['markdown'], pinned: false, cover: null }, requestId: randomUUID() });
    expect([200, 201], r.body).toContain(r.statusCode); return r.json<BlogPost>();
  }
  async function detail(id: string) {
    const r = await call('GET', '/api/blog/posts/' + id); expect(r.statusCode, r.body).toBe(200);
    return r.json<BlogPostDetail>();
  }
  async function publish(id: string) {
    const d = await detail(id);
    const input = { noteId: d.post.sourceNoteId, expectedModifiedAt: d.post.sourceModifiedAt,
      expectedContentHash: d.post.sourceHash, expectedPublicationVersion: d.post.version, requestId: randomUUID() };
    const r = await call('POST', '/api/blog/publish', input); expect(r.statusCode, r.body).toBe(200);
    return { post: r.json<BlogPost>(), input };
  }
  return { app, config, call, note, enable, select, detail, publish };
}

it('publishes only reviewed content and metadata, excluding frontmatter and private destinations', async () => {
  const f = await fixture(); await f.enable();
  const privateNote = await f.note('# Private body\nprivate-content-never-published', 'private.md');
  const raw = '---\nprivate_key: secret-value-not-public\ntitle: Internal title\n---\n# Original public body\n\n## [Internal reference](private.md)\n\n## [Owner API](/api/notes/' + privateNote.id + ')\n\n## Visible section';
  const source = await f.note(raw, 'source.md');
  const selected = await f.select(source.id); const d = await f.detail(selected.id);
  expect(d.post.sourceHash).toBe(hash(raw));
  const first = await f.publish(selected.id);
  let response = await f.app.inject({ url: '/blog/public-fixture' });
  expect(response.statusCode).toBe(200); expect(response.body).toContain('Original public body');
  for (const value of ['private_key', 'secret-value-not-public', 'Internal title', privateNote.id, source.id, 'private.md', 'private-content-never-published', '/api/notes/'])
    expect(response.body).not.toContain(value);
  const changed = await f.call('PUT', '/api/notes/' + source.id, { content: '# New unpublished body', expectedModifiedAt: source.modifiedAt, requestId: randomUUID() });
  expect(changed.statusCode, changed.body).toBe(200);
  const edit = await f.call('PATCH', '/api/blog/posts/' + selected.id, { expectedVersion: first.post.version,
    metadata: { slug: first.post.slug, title: 'New unpublished title', summary: 'Unpublished summary', category: 'Private draft category', tags: ['unpublished-tag'], pinned: true, cover: null }, requestId: randomUUID() });
  expect(edit.statusCode, edit.body).toBe(200);
  for (const url of ['/blog/public-fixture', '/blog', '/blog/rss.xml', '/blog/sitemap.xml']) {
    response = await f.app.inject({ url }); expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('New unpublished'); expect(response.body).not.toContain('unpublished-tag');
  }
  await f.publish(selected.id);
  response = await f.app.inject({ url: '/blog/public-fixture' });
  expect(response.body).toContain('New unpublished body'); expect(response.body).toContain('New unpublished title');
});

it('replays a publication receipt without republishing later drafts and rejects changed input', async () => {
  const f = await fixture(); await f.enable(); const source = await f.note('# First publication');
  const selected = await f.select(source.id); const first = await f.publish(selected.id);
  const saved = await f.call('PUT', '/api/notes/' + source.id, { content: '# Private later draft', expectedModifiedAt: source.modifiedAt, requestId: randomUUID() });
  expect(saved.statusCode).toBe(200);
  const replay = await f.call('POST', '/api/blog/publish', first.input);
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(first.post);
  const conflict = await f.call('POST', '/api/blog/publish', { ...first.input, expectedContentHash: 'f'.repeat(64) });
  expect(conflict.statusCode).toBe(409);
  const publicPage = await f.app.inject({ url: '/blog/public-fixture' });
  expect(publicPage.body).toContain('First publication'); expect(publicPage.body).not.toContain('Private later draft');
});

it('keeps captured resources immutable and rejects old resource URLs after unpublish', async () => {
  const f = await fixture(); await f.enable(); const source = await f.note('# Image publication');
  // Use ordinary, directly referenced knowledge assets; publication owns its copy.
  const original = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>';
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox', 'figure.svg'), original);
  const next = await f.call('PUT', '/api/notes/' + source.id, { content: '# Image publication\n\n![Published image](figure.svg)', expectedModifiedAt: source.modifiedAt, requestId: randomUUID() });
  expect(next.statusCode).toBe(200); const selected = await f.select(source.id); const published = await f.publish(selected.id);
  const page = await f.app.inject({ url: '/blog/public-fixture' });
  const path = /(?:src|href)="([^"\s]*\/blog\/assets\/[^"\s]+)"/.exec(page.body)?.[1];
  expect(path).toBeTruthy(); const url = new URL(path!, f.config.origin).pathname;
  const before = await f.app.inject({ url }); expect(before.statusCode, before.body).toBe(200);
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox', 'figure.svg'), original.replace('blue', 'red'));
  const after = await f.app.inject({ url }); expect(after.statusCode).toBe(200); expect(after.rawPayload).toEqual(before.rawPayload);
  const withdrawn = await f.call('POST', '/api/blog/unpublish', { noteId: source.id, expectedPublicationVersion: published.post.version, requestId: randomUUID() });
  expect(withdrawn.statusCode, withdrawn.body).toBe(200); expect((await f.app.inject({ url })).statusCode).toBe(404);
});

it('keeps all blog state private until enabled and rejects anonymous mutations', async () => {
  const f = await fixture(); const source = await f.note('# Initially private'); const selected = await f.select(source.id);
  await f.publish(selected.id);
  for (const url of ['/blog', '/blog/public-fixture', '/blog/rss.xml', '/blog/sitemap.xml']) expect((await f.app.inject({ url })).statusCode).toBe(404);
  expect((await f.app.inject({ url: '/api/blog' })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/blog/publish', payload: {} })).statusCode).not.toBe(200);
  await f.enable(); expect((await f.app.inject({ url: '/blog/public-fixture' })).statusCode).toBe(200);
  await f.enable(false); expect((await f.app.inject({ url: '/blog/public-fixture' })).statusCode).toBe(404);
});

it('rejects unterminated frontmatter and missing diagram previews without a partial public article', async () => {
  const f = await fixture(); await f.enable();
  for (const [name, content] of [['yaml', '---\nprivate_key: never-public\n# No closing delimiter'], ['diagram', '# Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```']]) {
    const source = await f.note(content); const post = await f.select(source.id, name); const detail = await f.detail(post.id);
    const r = await f.call('POST', '/api/blog/publish', { noteId: source.id, expectedModifiedAt: detail.post.sourceModifiedAt, expectedContentHash: detail.post.sourceHash, expectedPublicationVersion: detail.post.version, requestId: randomUUID() });
    expect([400, 409], r.body).toContain(r.statusCode); expect((await f.app.inject({ url: '/blog/' + name })).statusCode).toBe(404);
  }
});

it.skipIf(process.getuid?.() === 0)('preserves a publication across a temporary source permission failure', async () => {
  const f = await fixture(); await f.enable(); const source = await f.note('# Keep publication');
  const selected = await f.select(source.id); await f.publish(selected.id);
  const directory = join(f.config.knowledgeRoot, '00-Inbox');
  await chmod(directory, 0o000);
  try {
    const inaccessible = await f.app.inject({ url: '/blog/public-fixture' });
    expect(inaccessible.statusCode).toBe(503);
  } finally { await chmod(directory, 0o700); }
  const recovered = await f.app.inject({ url: '/blog/public-fixture' });
  expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.body).toContain('Keep publication');
});
