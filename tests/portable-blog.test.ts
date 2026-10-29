import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { blogService } from '../packages/core/blog/service';
import { assetService } from '../packages/core/assets';
import { blogHash } from '../packages/core/blog/resources';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const principal: Principal = {
  id: 'original-owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string, config: AppConfig, db: ReturnType<typeof openDatabase>;
const connections: ReturnType<typeof openDatabase>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-portable-blog-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-secret',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
  connections.push(db);
});
afterEach(async () => {
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  await rm(root, { recursive: true, force: true });
});
function publishImage() {
  const notes = noteService(config, db),
    blog = blogService(config, db, notes);
  let note = notes.createNote('00-Inbox', 'article.md', '# Original source');
  const asset = assetService(config, db, notes).upload(note.id, 'image.png', 'image/png', png);
  note = notes.saveNote(
    note.id,
    '# Original source\n\n![Picture](' + asset.markdownPath + ')',
    note.modifiedAt,
  ) as typeof note;
  const published = blog.publishNote(principal, {
    noteId: note.id,
    expectedModifiedAt: note.modifiedAt,
    expectedContentHash: blogHash(note.content),
    expectedPublicationVersion: 0,
    metadata: { slug: 'portable-article', title: 'Portable article', tags: ['knowledge'] },
    requestId: randomUUID(),
  });
  blog.updateSettings(principal, {
    settings: { ...blog.settings(), enabled: true, title: 'Portable journal', author: 'Writer' },
    requestId: randomUUID(),
  });
  return { notes, blog, note, published };
}
async function freshMachine() {
  const destination = {
    ...config,
    knowledgeRoot: join(root, randomUUID(), 'knowledge'),
    dataRoot: join(root, randomUUID(), 'data'),
  };
  await cp(config.knowledgeRoot, destination.knowledgeRoot, { recursive: true });
  const database = openDatabase(destination.dataRoot);
  connections.push(database);
  const notes = noteService(destination, database);
  return {
    config: destination,
    db: database,
    notes,
    blog: blogService(destination, database, notes),
  };
}

it('rebuilds publications, snapshots, settings and binary assets from the knowledge directory alone', async () => {
  const { blog, note, published } = publishImage();
  const before = blog.publicPost(published.slug);
  const machine = await freshMachine();
  const newOwner = { ...principal, id: 'new-machine-owner' };
  expect(machine.notes.getNote(note.id).content).toContain('Original source');
  expect(machine.blog.noteStatus(newOwner, note.id).post).toMatchObject({
    id: published.id,
    state: 'published',
  });
  expect(machine.blog.settings()).toMatchObject({
    title: 'Portable journal',
    author: 'Writer',
    enabled: true,
  });
  expect(machine.blog.publicPost(published.slug)).toEqual(before);
  const resource = before.html.match(/\/blog\/assets\/([^/]+)\/([^/]+)\/([a-f0-9]{64})/)!;
  expect(machine.blog.publicResource(resource[1], resource[2], resource[3]).bytes.equals(png)).toBe(
    true,
  );
  expect(
    (await readFile(join(config.knowledgeRoot, '_data/apps/blog/assets', resource[3]))).equals(png),
  ).toBe(true);
  expect(await readFile(join(config.dataRoot, 'app.sqlite'))).toBeTruthy();
});

it('imports synchronized metadata edits, withdrawals and removals into an existing projection', async () => {
  const { blog, published, note } = publishImage();
  const machine = await freshMachine();
  const { slug, title, category, tags, pinned, cover } = published;
  const edited = blog.updatePost(principal, published.id, {
    metadata: { slug, title, summary: 'Updated durable metadata', category, tags, pinned, cover },
    expectedVersion: published.version,
    requestId: randomUUID(),
  });
  const syncState = () =>
    cp(join(config.knowledgeRoot, '_data'), join(machine.config.knowledgeRoot, '_data'), {
      recursive: true,
    });
  await syncState();
  expect(machine.blog.noteStatus(principal, note.id).post?.summary).toBe(
    'Updated durable metadata',
  );
  const withdrawn = blog.unpublishNote(principal, {
    noteId: note.id,
    expectedPublicationVersion: edited.version,
    requestId: randomUUID(),
  });
  await syncState();
  expect(machine.blog.noteStatus(principal, note.id).post?.state).toBe('withdrawn');
  expect(() => machine.blog.publicPost(published.slug)).toThrow();
  blog.deletePost(principal, published.id, {
    expectedVersion: withdrawn.version,
    requestId: randomUUID(),
  });
  await syncState();
  expect(machine.blog.noteStatus(principal, note.id).post).toBe(null);
});

it.each(['truncated', 'missing-asset', 'tampered-asset', 'unsupported'])(
  'rejects %s synchronized data without replacing the existing projection',
  async (failure) => {
    const { blog, published } = publishImage();
    const file = join(config.knowledgeRoot, '_data/apps/blog/state.json');
    const original = await readFile(file, 'utf8');
    const state = JSON.parse(original);
    if (failure === 'truncated') await writeFile(file, original.slice(0, 30));
    else if (failure === 'unsupported') {
      state.data.version = 999;
      await writeFile(file, JSON.stringify(state));
    } else {
      const asset = join(config.knowledgeRoot, '_data/apps/blog/assets', state.data.blobs[0].hash);
      if (failure === 'missing-asset') await rm(asset);
      else await writeFile(asset, 'corrupted image');
      // Changed envelope revision forces validation of the synchronized state.
      state.revision = randomUUID();
      await writeFile(file, JSON.stringify(state));
    }
    expect(() => blog.settings()).toThrow();
    expect(db.prepare('SELECT state FROM blog_posts WHERE id=?').get(published.id)).toEqual({
      state: 'published',
    });
    expect(db.prepare('SELECT bytes FROM blog_blobs').get()).toEqual({ bytes: png });
    expect(await readFile(file, 'utf8')).not.toBe(original);
  },
);

it('sanitizes untrusted synchronized snapshot HTML before returning it publicly', async () => {
  const { published } = publishImage();
  const machine = await freshMachine();
  const file = join(config.knowledgeRoot, '_data/apps/blog/state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.data.versions[0].html +=
    '<script>alert(1)</script><img src="/api/private" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="/blog/../api/private">Traversal</a>';
  state.revision = randomUUID();
  await writeFile(
    join(machine.config.knowledgeRoot, '_data/apps/blog/state.json'),
    JSON.stringify(state),
  );
  const html = machine.blog.publicPost(published.slug).html;
  expect(html).toContain('Original source');
  expect(html).not.toMatch(/script|onerror|javascript:|\/api\/private/);
});

it('migrates legacy database publications on first use without changing their identity or bytes', async () => {
  const notes = noteService(config, db);
  const note = notes.createNote('00-Inbox', 'legacy.md', '# Legacy source');
  const postId = randomUUID(),
    versionId = randomUUID(),
    hash = blogHash(png);
  const metadata = {
    slug: 'legacy-article',
    title: 'Legacy article',
    summary: '',
    category: '',
    tags: [],
    pinned: false,
    cover: null,
  };
  const now = '2026-10-29T00:00:00.000Z';
  const html = `<p>Legacy snapshot</p><img src="/blog/assets/${postId}/${versionId}/${hash}" alt="Legacy" />`;
  db.prepare('INSERT INTO blog_posts VALUES(?,?,?,?,?,?,?,?,?)').run(
    postId,
    note.id,
    metadata.slug,
    JSON.stringify(metadata),
    4,
    'published',
    versionId,
    now,
    now,
  );
  db.prepare('INSERT INTO blog_versions VALUES(?,?,?,?,?,?,?,?,?)').run(
    versionId,
    postId,
    note.modifiedAt,
    blogHash(note.content),
    JSON.stringify(metadata),
    html,
    '[]',
    null,
    now,
  );
  db.prepare('INSERT INTO blog_blobs VALUES(?,?,?)').run(hash, 'image/png', png);
  db.prepare('INSERT INTO blog_version_resources VALUES(?,?)').run(versionId, hash);
  db.prepare(
    "UPDATE blog_settings SET settings_json=json_set(settings_json,'$.enabled',json('true'))",
  ).run();
  const blog = blogService(config, db, notes);
  expect(blog.publicPost('legacy-article').html).toBe(html);
  const machine = await freshMachine();
  expect(machine.blog.noteStatus(principal, note.id).post).toMatchObject({
    id: postId,
    version: 4,
    publishedVersionId: versionId,
  });
  expect(machine.blog.publicResource(postId, versionId, hash).bytes.equals(png)).toBe(true);
  expect(db.prepare('SELECT version,state FROM blog_posts WHERE id=?').get(postId)).toEqual({
    version: 4,
    state: 'published',
  });
});

it('keeps a local pending edit and the synchronized file when both sides change settings', async () => {
  const { blog } = publishImage();
  const file = join(config.knowledgeRoot, '_data/apps/blog/state.json');
  const remote = JSON.parse(await readFile(file, 'utf8'));
  db.prepare(
    "UPDATE blog_settings SET settings_json=json_set(settings_json,'$.title','Local pending journal')",
  ).run();
  remote.data.settings.title = 'Remote journal';
  remote.revision = randomUUID();
  const bytes = JSON.stringify(remote);
  await writeFile(file, bytes);
  expect(() => blog.settings()).toThrow();
  expect(
    JSON.parse(
      (
        db.prepare('SELECT settings_json FROM blog_settings WHERE id=1').get() as {
          settings_json: string;
        }
      ).settings_json,
    ).title,
  ).toBe('Local pending journal');
  expect(await readFile(file, 'utf8')).toBe(bytes);
});

it('imports source removal and its publication withdrawal together without creating a false conflict', async () => {
  const { notes, blog, note, published } = publishImage();
  const machine = await freshMachine();
  await rm(join(config.knowledgeRoot, note.relativePath));
  notes.scan();
  expect(blog.settings().enabled).toBe(true);
  await cp(join(config.knowledgeRoot, '_data'), join(machine.config.knowledgeRoot, '_data'), {
    recursive: true,
  });
  expect(() => machine.blog.settings()).not.toThrow();
  expect(machine.db.prepare('SELECT state FROM blog_posts WHERE id=?').get(published.id)).toEqual({
    state: 'withdrawn',
  });
  expect(() => machine.blog.publicPost(published.slug)).toThrow();
});
