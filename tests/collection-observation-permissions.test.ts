import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { collectionService } from '../packages/core/collections/service';
import { blogService } from '../packages/core/blog/service';
import { blogHash } from '../packages/core/blog/resources';
import { assertRoot } from '../packages/core/indexing/reconcile';
import { registerBlogRoutes } from '../apps/server/blog/routes';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('collection observation did not finish')), 5000);
    }),
  ]).finally(() => clearTimeout(timer!));
}
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'collection-permission-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'collection-permission-fixture-secret',
    indexing: { enabled: false, watch: false },
  };
  await fs.mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    collections = collectionService(config, db, notes),
    blog = blogService(config, db, notes),
    app = Fastify();
  registerBlogRoutes(app, config, () => {
    assertRoot(config, db);
    return blog;
  });
  cleanups.push(async () => {
    await fs.chmod(config.knowledgeRoot, 0o700);
    await app.close();
    await collections.close();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const p = {
    id: 'collection-permission-fixture',
    clientId: 'test',
    scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
    allowedPrefixes: ['00-Inbox'],
  };
  const n = notes.createNote('00-Inbox', 'source.md', '# Stable published body');
  const post = blog.publishNote(p, {
    noteId: n.id,
    expectedModifiedAt: n.modifiedAt,
    expectedContentHash: blogHash(n.content),
    expectedPublicationVersion: 0,
    requestId: randomUUID(),
  });
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: true },
    requestId: randomUUID(),
  });
  return { config, db, app, n, post };
}

it('preserves note identity and publication when permission fails after a collection drain checked the root', async () => {
  const f = await fixture(),
    arrived = deferred(),
    release = deferred(),
    observed = deferred();
  const original = fs.lstat;
  let armed = true;
  const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    if (!armed || String(args[0]) !== join(f.config.knowledgeRoot, f.n.relativePath))
      return original(...args);
    armed = false;
    arrived.resolve();
    await release.promise;
    try {
      return await original(...args);
    } finally {
      setImmediate(observed.resolve);
    }
  }) as typeof fs.lstat);
  // Delay only this actual filesystem operation, so chmod reliably falls
  // between drain's root check and its subsequent source observation.
  try {
    await fs.writeFile(join(f.config.knowledgeRoot, f.n.relativePath), f.n.content);
    await bounded(arrived.promise);
    await fs.chmod(f.config.knowledgeRoot, 0o000);
    expect((await f.app.inject({ url: '/blog/' + f.post.slug })).statusCode).toBe(503);
    release.resolve();
    await bounded(observed.promise);
  } finally {
    release.resolve();
    spy.mockRestore();
    await fs.chmod(f.config.knowledgeRoot, 0o700);
  }
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.n.id)).toEqual({ active: 1 });
  expect(f.db.prepare('SELECT state,version FROM blog_posts WHERE id=?').get(f.post.id)).toEqual({
    state: 'published',
    version: f.post.version,
  });
  expect((await f.app.inject({ url: '/blog/' + f.post.slug })).statusCode).toBe(200);
});

it('still deactivates a genuinely deleted source and withdraws its publication', async () => {
  const f = await fixture(),
    deactivated = deferred(),
    observed = deferred();
  const original = fs.lstat;
  let armed = true;
  const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    if (!armed || String(args[0]) !== join(f.config.knowledgeRoot, f.n.relativePath))
      return original(...args);
    armed = false;
    try {
      return await original(...args);
    } finally {
      setImmediate(observed.resolve);
    }
  }) as typeof fs.lstat);
  try {
    await fs.writeFile(join(f.config.knowledgeRoot, f.n.relativePath), f.n.content);
    await bounded(observed.promise);
  } finally {
    spy.mockRestore();
  }
  f.db.function('fixture_note_deactivated', () => {
    deactivated.resolve();
    return 0;
  });
  f.db.exec(
    'CREATE TRIGGER fixture_source_deactivated AFTER UPDATE OF active ON notes WHEN OLD.active=1 AND NEW.active=0 BEGIN SELECT fixture_note_deactivated(); END',
  );
  await fs.unlink(join(f.config.knowledgeRoot, f.n.relativePath));
  await bounded(deactivated.promise);
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.n.id)).toEqual({ active: 0 });
  expect(f.db.prepare('SELECT state FROM blog_posts WHERE id=?').get(f.post.id)).toEqual({
    state: 'withdrawn',
  });
  expect((await f.app.inject({ url: '/blog/' + f.post.slug })).statusCode).toBe(404);
});
