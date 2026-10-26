import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, unlink, rename } from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { blogService } from '../packages/core/blog/service';
import { assetService } from '../packages/core/assets';
import { blogHash } from '../packages/core/blog/resources';
import { backup, restore } from '../apps/server/backup';
import { beginOperation } from '../packages/core/knowledge/operations';
import type { Principal } from '../shared/knowledge-contracts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const p: Principal = {
  id: 'test-actor',
  clientId: 'test-client',
  scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string,
  config: any,
  db: ReturnType<typeof openDatabase>,
  notes: ReturnType<typeof noteService>,
  blog: ReturnType<typeof blogService>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-blog-core-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'test-secret',
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
const input = (n: any, extra: Record<string, unknown> = {}) => ({
  noteId: n.id,
  expectedModifiedAt: n.modifiedAt,
  expectedContentHash: blogHash(n.content),
  expectedPublicationVersion: 0,
  requestId: randomUUID(),
  ...extra,
});
const enable = () => {
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: true },
    requestId: randomUUID(),
  });
};

it('keeps published URLs fixed after withdrawal and authorizes operation receipts by current source prefix', () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Article');
  const request = input(n),
    published = blog.publishNote(p, request);
  enable();
  const operation = blog.operationStatus(p, { requestId: request.requestId });
  expect(operation).toMatchObject({
    kind: 'blog.publish',
    status: 'succeeded',
    result: { id: published.id },
  });
  expect(() =>
    blog.operationStatus(
      { ...p, allowedPrefixes: ['10-Projects'] },
      { operationId: operation.operationId },
    ),
  ).toThrow();
  const withdrawn = blog.unpublishNote(p, {
    noteId: n.id,
    expectedPublicationVersion: published.version,
    requestId: randomUUID(),
  });
  const { title, summary, category, tags, pinned, cover } = withdrawn;
  expect(() =>
    blog.updatePost(p, withdrawn.id, {
      metadata: { title, summary, category, tags, pinned, cover, slug: 'new-url' },
      expectedVersion: withdrawn.version,
      requestId: randomUUID(),
    }),
  ).toThrow();
});

it('copies only referenced resources and keeps bytes immutable while revoking obsolete version URLs', async () => {
  let n = notes.createNote('00-Inbox', 'article.md', '# Image');
  const a = assetService(config, db, notes).upload(n.id, 'image.png', 'image/png', png);
  n = notes.saveNote(
    n.id,
    '# Image\n\n![Public image](' + a.markdownPath + ')',
    n.modifiedAt,
  ) as any;
  const first = blog.publishNote(p, input(n));
  enable();
  const html = blog.publicPost(first.slug).html,
    match = html.match(/\/blog\/assets\/([^/]+)\/([^/]+)\/([a-f0-9]{64})/)!;
  expect(blog.publicResource(match[1], match[2], match[3]).bytes.equals(png)).toBe(true);
  await writeFile(
    join(config.knowledgeRoot, a.relativePath),
    Buffer.concat([png, Buffer.from('changed')]),
  );
  expect(blog.publicResource(match[1], match[2], match[3]).bytes.equals(png)).toBe(true);
  await writeFile(join(config.knowledgeRoot, a.relativePath), png);
  const second = blog.publishNote(p, input(n, { expectedPublicationVersion: first.version }));
  expect(second.version).toBe(first.version + 1);
  expect(() => blog.publicResource(match[1], match[2], match[3])).toThrow();
});

it('rechecks every resource prefix and rolls back an association when fresh publication rights disappear', () => {
  let n = notes.createNote('00-Inbox', 'article.md', '# Image');
  const a = assetService(config, db, notes).upload(n.id, 'image.png', 'image/png', png);
  n = notes.saveNote(n.id, '# Image\n\n![Image](' + a.markdownPath + ')', n.modifiedAt) as any;
  const allowed = { ...p, allowedPrefixes: [n.relativePath, a.relativePath] };
  expect(() =>
    blog.publishNote(allowed, input(n), () => ({ ...allowed, allowedPrefixes: [n.relativePath] })),
  ).toThrow();
  expect(blog.noteStatus(p, n.id).post).toBe(null);
  expect((db.prepare('SELECT count(*) AS n FROM blog_blobs').get() as any).n).toBe(0);
  expect(() =>
    blog.publishNote(p, input(n), () => ({ ...p, scopes: ['knowledge:read', 'knowledge:write'] })),
  ).toThrow();
  expect(blog.noteStatus(p, n.id).post).toBe(null);
});

it('publishes a source-bound PNG instead of graph source and returns private actionable preview diagnostics', () => {
  const n = notes.createNote(
    '00-Inbox',
    'article.md',
    '# Graph\n\n```mermaid\nflowchart TD\nA-->B\n```\n',
  );
  const draft = blog.createPost(p, { sourceNoteId: n.id, requestId: randomUUID() });
  const detail = blog.postDetail(p, draft.id),
    need = detail.diagramNeeds[0];
  expect(need).toMatchObject({ kind: 'mermaid', code: 'flowchart TD\nA-->B\n' });
  const result = blog.publishNote(
    p,
    input(n, {
      expectedPublicationVersion: draft.version,
      diagrams: [{ ...need, pngBase64: png.toString('base64') }],
    }),
  );
  enable();
  const html = blog.publicPost(result.slug).html;
  expect(html).toContain('<img');
  expect(html).not.toContain('flowchart');
  expect(html).not.toContain('data-code');
  expect(html).not.toContain(n.id);
});

it('backs up publication blobs consistently and restores with public access withdrawn', async () => {
  let n = notes.createNote('00-Inbox', 'article.md', '# Backup image');
  const a = assetService(config, db, notes).upload(n.id, 'image.png', 'image/png', png);
  n = notes.saveNote(
    n.id,
    '# Backup image\n\n![Image](' + a.markdownPath + ')',
    n.modifiedAt,
  ) as any;
  const first = blog.publishNote(p, input(n));
  enable();
  const before = blog.publicPost(first.slug).html;
  db.close();
  const destination = join(root, 'backup'),
    restored = {
      ...config,
      knowledgeRoot: join(root, 'restored-knowledge'),
      dataRoot: join(root, 'restored-data'),
    };
  await backup(config, destination);
  await restore(destination, restored);
  db = openDatabase(restored.dataRoot);
  notes = noteService(restored, db);
  blog = blogService(restored, db, notes);
  expect(blog.settings().enabled).toBe(false);
  expect(blog.noteStatus(p, n.id).post?.state).toBe('withdrawn');
  expect(() => blog.publicPost(first.slug)).toThrow();
  expect(
    (db.prepare('SELECT bytes FROM blog_blobs').get() as { bytes: Buffer }).bytes.equals(png),
  ).toBe(true);
  expect((db.prepare('SELECT html FROM blog_versions').get() as { html: string }).html).toBe(
    before,
  );
  enable();
  expect(() => blog.publicPost(first.slug)).toThrow();
});

it('does not replace a public version on source changes or a failed resource commit', async () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Stable original');
  const published = blog.publishNote(p, input(n));
  enable();
  db.exec(
    "CREATE TRIGGER blog_test_failure BEFORE INSERT ON blog_versions BEGIN SELECT RAISE(FAIL,'fixture publication failure'); END",
  );
  expect(() =>
    blog.publishNote(p, input(n, { expectedPublicationVersion: published.version })),
  ).toThrow();
  expect(blog.publicPost(published.slug).html).toContain('Stable original');
  expect(blog.noteStatus(p, n.id).post?.version).toBe(published.version);
  db.exec('DROP TRIGGER blog_test_failure');
  expect(() =>
    blog.publishNote(p, input(n, { expectedPublicationVersion: published.version }), () => {
      // An external writer is not governed by the application note lease.
      writeFileSync(join(config.knowledgeRoot, n.relativePath), '# Concurrent new source');
      return p;
    }),
  ).toThrow();
  expect(blog.publicPost(published.slug).html).toContain('Stable original');
  expect(blog.noteStatus(p, n.id).post?.version).toBe(published.version);
});

it('replays a committed publication and permits withdrawal when the source becomes too large to read', async () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Initial published version');
  const request = input(n),
    published = blog.publishNote(p, request);
  enable();
  await writeFile(join(config.knowledgeRoot, n.relativePath), 'x'.repeat(1024 * 1024 + 1));
  expect(blog.publishNote(p, request)).toEqual(published);
  const withdrawn = blog.unpublishNote(p, {
    noteId: n.id,
    expectedPublicationVersion: published.version,
    requestId: randomUUID(),
  });
  expect(withdrawn.state).toBe('withdrawn');
  expect(() => blog.publicPost(published.slug)).toThrow();
  db.prepare('UPDATE notes SET active=0 WHERE id=?').run(n.id);
  expect(blog.dashboard(p).posts[0]).toMatchObject({
    id: published.id,
    state: 'withdrawn',
    hasUnpublishedChanges: true,
  });
});

it('bounds source titles without changing the captured source hash', () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# ' + '长'.repeat(300));
  const status = blog.noteStatus(p, n.id);
  expect([...status.source.title]).toHaveLength(256);
  expect(status.source.contentHash).toBe(blogHash(n.content));
  const published = blog.publishNote(p, input(n));
  expect([...published.sourceTitle]).toHaveLength(256);
  const emoji = notes.createNote('00-Inbox', 'emoji.md', '# ' + '😀'.repeat(300));
  const emojiPost = blog.publishNote(p, input(emoji));
  expect([...emojiPost.sourceTitle]).toHaveLength(256);
  expect(emojiPost.title).toBe('😀'.repeat(256));
});

it('preserves explicit titles within 256 codepoints and rejects longer titles before publication', () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Source title');
  expect(() => blog.publishNote(p, input(n, { metadata: { title: '🌈'.repeat(257) } }))).toThrow();
  expect(blog.noteStatus(p, n.id).post).toBe(null);
  const title = '🌈'.repeat(200);
  expect(blog.publishNote(p, input(n, { metadata: { title } })).title).toBe(title);
});

it('returns an absolute owner URL only when an explicit public base URL is configured', () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Canonical address');
  const published = blog.publishNote(p, input(n));
  expect(published.url).toBe(null);
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: true, baseUrl: 'https://example.test' },
    requestId: randomUUID(),
  });
  expect(blog.noteStatus(p, n.id).post?.url).toBe('https://example.test/blog/' + published.slug);
});

it('replays semantically identical publication input when JSON property order changes', () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Ordered input');
  const request = input(n),
    published = blog.publishNote(p, request);
  const reordered = {
    requestId: request.requestId,
    expectedPublicationVersion: 0,
    expectedContentHash: request.expectedContentHash,
    expectedModifiedAt: request.expectedModifiedAt,
    noteId: request.noteId,
  };
  expect(blog.publishNote(p, reordered)).toEqual(published);
});

it('projects heading labels from visible text without private destinations or raw Markdown', () => {
  const n = notes.createNote(
    '00-Inbox',
    'headings.md',
    [
      '# Public heading',
      '## [Private label](secret-plan.md)',
      '## [API label](/api/notes/00000000-1111-2222-3333-444444444444)',
      '## **Styled** `code` and $x+1$ [^private-ref]',
      '## Math $\\href{secret-math.md}{Visible}$',
      '',
      '[^private-ref]: [Footnote label](secret-footnote.md)',
    ].join('\n'),
  );
  const published = blog.publishNote(p, input(n, { metadata: { title: 'Visible headings' } }));
  enable();
  const projected = blog.publicPost(published.slug);
  expect(projected.headings.map((h) => h.text)).toEqual([
    'Public heading',
    'Private label',
    'API label',
    'Styled code and x+1 [1]',
    'Math \\href',
  ]);
  for (const value of [
    'secret-plan.md',
    '00000000-1111-2222-3333-444444444444',
    'secret-footnote.md',
    'secret-math.md',
    'private-ref',
  ])
    expect(JSON.stringify(projected)).not.toContain(value);
});

it('does not withdraw publication during a missing-source move gap', async () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Stable publication');
  const published = blog.publishNote(p, input(n));
  enable();
  const operation = beginOperation(db, p, 'move', randomUUID(), {}).operation;
  db.prepare(
    "INSERT INTO write_intents(id,note_id,path,kind,status) VALUES(?,?,?,'move','prepared')",
  ).run(operation.id, n.id, n.relativePath);
  const destination = '00-Inbox/renamed.md';
  await rename(join(config.knowledgeRoot, n.relativePath), join(config.knowledgeRoot, destination));
  let status: number | undefined;
  try {
    blog.publicPost(published.slug);
  } catch (error) {
    status = (error as any).statusCode;
  }
  expect(status).toBe(503);
  expect(db.prepare('SELECT state,version FROM blog_posts WHERE id=?').get(published.id)).toEqual({
    state: 'published',
    version: published.version,
  });
  db.prepare('UPDATE notes SET path=? WHERE id=?').run(destination, n.id);
  db.prepare('DELETE FROM write_intents WHERE id=?').run(operation.id);
  expect(blog.publicPost(published.slug).html).toContain('Stable publication');
});

it('does not withdraw publication during a missing-source synchronization gap', async () => {
  const n = notes.createNote('00-Inbox', 'article.md', '# Stable publication');
  const published = blog.publishNote(p, input(n));
  enable();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO sync_runs(id,owner,status,lease_until,started_at) VALUES(?,?,'running',?,?)",
  ).run(id, 'fixture', Date.now() + 60000, Date.now());
  await unlink(join(config.knowledgeRoot, n.relativePath));
  let status: number | undefined;
  try {
    blog.publicPost(published.slug);
  } catch (error) {
    status = (error as any).statusCode;
  }
  expect(status).toBe(503);
  expect(db.prepare('SELECT state,version FROM blog_posts WHERE id=?').get(published.id)).toEqual({
    state: 'published',
    version: published.version,
  });
  await writeFile(join(config.knowledgeRoot, n.relativePath), n.content);
  db.prepare('DELETE FROM sync_runs WHERE id=?').run(id);
  expect(blog.publicPost(published.slug).html).toContain('Stable publication');
});

it.each([
  '# OLD REVIEWED BODY',
  '# OLD REVIEWED BODY\n\n![Unavailable preview](https://example.invalid/private.png)',
])(
  'binds detail identity to the exact reviewed body during an external file edit: %s',
  (content) => {
    const n = notes.createNote('00-Inbox', 'review-race.md', content);
    const post = blog.createPost(p, { sourceNoteId: n.id, requestId: randomUUID() });
    let inject = true;
    const raced = blogService(config, db, {
      ...notes,
      getNote(id: string) {
        const current = notes.getNote(id);
        if (inject) {
          inject = false;
          writeFileSync(join(config.knowledgeRoot, n.relativePath), '# NEW UNREVIEWED BODY');
        }
        return current;
      },
    });
    const detail = raced.postDetail(p, post.id);
    expect(detail.sourceContent).toBe(content);
    expect(detail.post.sourceHash).toBe(blogHash(content));
    expect(detail.post.sourceModifiedAt).toBe(n.modifiedAt);
    expect(() =>
      raced.publishNote(p, {
        noteId: n.id,
        expectedModifiedAt: detail.post.sourceModifiedAt,
        expectedContentHash: detail.post.sourceHash,
        expectedPublicationVersion: detail.post.version,
        requestId: randomUUID(),
      }),
    ).toThrow();
    expect(blog.noteStatus(p, n.id).post?.state).toBe('draft');
  },
);

it('does not attach newly readable source identity to an unavailable detail body', () => {
  const n = notes.createNote('00-Inbox', 'unavailable-review.md', '# UNREVIEWED BODY');
  const post = blog.createPost(p, { sourceNoteId: n.id, requestId: randomUUID() });
  let inject = true;
  const raced = blogService(config, db, {
    ...notes,
    getNote(id: string) {
      if (!inject) return notes.getNote(id);
      inject = false;
      const folder = join(config.knowledgeRoot, '00-Inbox');
      chmodSync(folder, 0o000);
      try {
        return notes.getNote(id);
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  });
  const detail = raced.postDetail(p, post.id);
  expect(detail.sourceContent).toBe('');
  expect(detail.post.sourceHash).toBe(blogHash(''));
  expect(detail.post.sourceModifiedAt).toBe('0');
  expect(() =>
    raced.publishNote(p, {
      noteId: n.id,
      expectedModifiedAt: detail.post.sourceModifiedAt,
      expectedContentHash: detail.post.sourceHash,
      expectedPublicationVersion: detail.post.version,
      requestId: randomUUID(),
    }),
  ).toThrow();
  expect(blog.noteStatus(p, n.id).post?.state).toBe('draft');
});
