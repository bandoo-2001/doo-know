import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { blogService } from '../packages/core/blog/service';
import { defaultBlogDesign } from '../shared/blog-design';
import { blogHash } from '../packages/core/blog/resources';
import type { Principal } from '../shared/knowledge-contracts';
const p: Principal = {
  id: 'owner',
  clientId: 'studio',
  scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
  allowedPrefixes: ['00-Inbox'],
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
let root: string,
  db: ReturnType<typeof openDatabase>,
  notes: ReturnType<typeof noteService>,
  blog: ReturnType<typeof blogService>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blog-studio-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-secret',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
  notes = noteService(config, db);
  blog = blogService(config, db, notes);
});
afterEach(async () => {
  db?.close();
  await rm(root, { recursive: true, force: true });
});
const enable = () =>
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: true },
    requestId: randomUUID(),
  });
const save = (design = defaultBlogDesign()) =>
  blog.saveDesign(p, {
    design,
    expectedVersion: blog.designState(p).version,
    requestId: randomUUID(),
  });
const publish = () =>
  blog.publishDesign(p, { expectedVersion: blog.designState(p).version, requestId: randomUUID() });
it('isolates drafts, restores history only into draft, and rejects stale or altered retries', () => {
  const design = defaultBlogDesign();
  design.profile.name = 'Original public';
  const request = { design, expectedVersion: 1, requestId: randomUUID() };
  const saved = blog.saveDesign(p, request);
  expect(saved.hasUnpublishedChanges).toBe(true);
  enable();
  expect(blog.publicDesign().profile.name).toBe('');
  expect(blog.saveDesign(p, request)).toEqual(saved);
  expect(() =>
    blog.saveDesign(p, { ...request, design: { ...design, accent: '#000000' } }),
  ).toThrow();
  const first = publish();
  expect(blog.publicDesign().profile.name).toBe('Original public');
  design.profile.name = 'Second public';
  save(design);
  publish();
  const restored = blog.restoreDesign(p, {
    revision: first.publishedRevision,
    expectedVersion: blog.designState(p).version,
    requestId: randomUUID(),
  });
  expect(restored.draft.profile.name).toBe('Original public');
  expect(blog.publicDesign().profile.name).toBe('Second public');
  expect(() =>
    blog.saveDesign(p, { design, expectedVersion: 1, requestId: randomUUID() }),
  ).toThrow();
});
it('keeps draft images private, validates bytes, and revokes public images after replacement or disable', () => {
  const media = blog.uploadDesignMedia(p, {
    name: 'avatar.png',
    mime: 'image/png',
    base64: png,
    requestId: randomUUID(),
  });
  expect(blog.designMedia(p, media.hash).bytes.toString('base64')).toBe(png);
  enable();
  expect(() => blog.publicDesignMedia(media.hash)).toThrow();
  const design = defaultBlogDesign();
  design.profile.avatar = media.url;
  save(design);
  publish();
  expect(blog.publicDesignMedia(media.hash).mime).toBe('image/png');
  save();
  publish();
  expect(() => blog.publicDesignMedia(media.hash)).toThrow();
  expect(() =>
    blog.uploadDesignMedia(p, {
      name: 'bad.png',
      mime: 'image/png',
      base64: Buffer.from('<svg/>').toString('base64'),
      requestId: randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    blog.uploadDesignMedia(p, {
      name: 'bad.svg',
      mime: 'image/svg+xml',
      base64: png,
      requestId: randomUUID(),
    }),
  ).toThrow();
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: false },
    requestId: randomUUID(),
  });
  expect(() => blog.publicDesign()).toThrow();
});
it.each([
  'javascript:alert(1)',
  '//evil.test/a',
  '/api/notes/private',
  '/blog/../api/private',
  '/blog/%2e%2e/api/private',
  'https://user:password@evil.test',
  'mailto:owner@example.test%0aBcc:evil@example.test',
  'https://evil.test/%0aattack',
  'https://evil.test/\nattack',
])('rejects unsafe design link %s', (href) => {
  const d = defaultBlogDesign();
  d.navigation = [{ id: 'bad', label: 'bad', href }];
  expect(() => save(d)).toThrow();
});
it('enforces read/manage/publish capabilities and strict bounded schemas', () => {
  const reader = { ...p, pluginId: 'mcp', scopes: ['knowledge:read', 'blog:read'] };
  expect(blog.designState(reader).draft.template).toBe('journal');
  expect(() => save({ ...defaultBlogDesign(), extra: true } as any)).toThrow();
  expect(() =>
    blog.saveDesign(reader, {
      design: defaultBlogDesign(),
      expectedVersion: 1,
      requestId: randomUUID(),
    }),
  ).toThrow();
  const manager = { ...reader, scopes: ['knowledge:read', 'blog:read', 'blog:manage'] };
  blog.saveDesign(manager, {
    design: defaultBlogDesign(),
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  expect(() =>
    blog.publishDesign(manager, { expectedVersion: 2, requestId: randomUUID() }),
  ).toThrow();
  const large = defaultBlogDesign();
  large.profile.bio = 'x'.repeat(50001);
  expect(() => save(large)).toThrow();
});
it('queries only snapshot metadata with real pagination and excludes withdrawn collection posts', () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const n = notes.createNote('00-Inbox', `article-${i}.md`, '# Private body token');
    const post = blog.publishNote(p, {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      expectedContentHash: blogHash(n.content),
      expectedPublicationVersion: 0,
      metadata: { title: `Public ${i}`, category: 'Public category', tags: ['public-tag'] },
      requestId: randomUUID(),
    });
    ids.push(post.id);
  }
  expect(() => blog.publicPostPage({})).toThrow();
  expect(blog.previewPostPage(p, { pageSize: 2 }).total).toBe(3);
  enable();
  const page = blog.publicPostPage({ query: 'public', page: 2, pageSize: 2 });
  expect(page.total).toBe(3);
  expect(page.posts).toHaveLength(1);
  expect(page.totalPages).toBe(2);
  expect(page.posts[0]).not.toHaveProperty('html');
  expect(page.posts[0]).not.toHaveProperty('sourceNoteId');
  expect(blog.publicPostPage({ query: 'Private body token' }).total).toBe(0);
  expect(blog.publicTaxonomy().tags).toEqual([{ name: 'public-tag', count: 3 }]);
  const first = blog.postDetail(p, ids[0]).post;
  blog.updatePost(p, first.id, {
    metadata: { title: 'Secret draft' },
    expectedVersion: first.version,
    requestId: randomUUID(),
  } as any);
  expect(blog.publicPostPage({ query: 'Secret draft' }).total).toBe(0);
  db.prepare("UPDATE blog_posts SET state='withdrawn' WHERE id=?").run(ids[1]);
  expect(blog.publicPostPage({ postIds: ids }).posts.map((x) => x.id)).toEqual([ids[0], ids[2]]);
});
it('retains ten published revisions and rolls failed publication back atomically', () => {
  enable();
  for (let i = 0; i < 12; i++) {
    const d = defaultBlogDesign();
    d.profile.name = `Revision ${i}`;
    save(d);
    publish();
  }
  expect(blog.designState(p).history).toHaveLength(10);
  expect(() =>
    blog.restoreDesign(p, {
      revision: 1,
      expectedVersion: blog.designState(p).version,
      requestId: randomUUID(),
    }),
  ).toThrow();
  const before = blog.designState(p);
  const d = defaultBlogDesign();
  d.profile.name = 'Failing publish';
  save(d);
  db.exec(
    "CREATE TRIGGER fail_studio_history BEFORE INSERT ON blog_design_history BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  expect(() => publish()).toThrow();
  expect(blog.publicDesign().profile.name).toBe('Revision 11');
  expect(blog.designState(p).publishedRevision).toBe(before.publishedRevision);
});
it('rejects inline, missing and foreign media paths and oversized image uploads', () => {
  for (const avatar of [
    'data:image/png;base64,xxx',
    'https://evil.test/p.png',
    '/api/blog/design/media/' + 'a'.repeat(64),
    '/blog/media/' + 'a'.repeat(64),
  ]) {
    const d = defaultBlogDesign();
    d.profile.avatar = avatar;
    expect(() => save(d)).toThrow();
  }
  const bytes = Buffer.alloc(5 * 1024 ** 2 + 1);
  Buffer.from(png, 'base64').copy(bytes);
  expect(() =>
    blog.uploadDesignMedia(p, {
      name: 'too-large.png',
      mime: 'image/png',
      base64: bytes.toString('base64'),
      requestId: randomUUID(),
    }),
  ).toThrow();
});
it('rejects ambiguous encoded internal links and GIF uploads', () => {
  for (const href of [
    '/blog/%252e%252e/api/private',
    '/blog/%252f%252fevil.test',
    '/blog//evil.test',
    '/blog/%2fapi/private',
    '/blog/%2F%2Fevil.test',
  ]) {
    const d = defaultBlogDesign();
    d.navigation = [{ id: 'unsafe', label: 'Unsafe', href }];
    expect(() => save(d), href).toThrow();
  }
  expect(() =>
    blog.uploadDesignMedia(p, {
      name: 'old.gif',
      mime: 'image/gif',
      base64: Buffer.from('GIF89a').toString('base64'),
      requestId: randomUUID(),
    }),
  ).toThrow();
});
it('keeps design read access during maintenance and blocks studio mutations', () => {
  db.prepare('UPDATE maintenance SET active=1').run();
  expect(blog.designState(p).draft.template).toBe('journal');
  expect(() => save()).toThrow();
  expect(() =>
    blog.uploadDesignMedia(p, {
      name: 'avatar.png',
      mime: 'image/png',
      base64: png,
      requestId: randomUUID(),
    }),
  ).toThrow();
});
