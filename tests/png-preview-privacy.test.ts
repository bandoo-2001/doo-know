import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePng } from '../packages/core/knowledge/diagram-artifacts';
import { publicationPng } from '../packages/core/blog/resources';
import { capturePublication } from '../packages/core/blog/publication';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { webPrincipal } from '../packages/core/knowledge/core';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { cleanPng, pngWithText } from './support/png-source-metadata';
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const metadata = {
  slug: 'safe',
  title: 'Public',
  summary: '',
  category: 'Test',
  tags: [],
  pinned: false,
  cover: null,
};
it.each(['tEXt', 'zTXt', 'iTXt'] as const)(
  'refuses %s embedded scene source in diagram and blog PNG previews',
  (type) => {
    expect(() => validatePng(pngWithText(type))).toThrow();
    expect(() => publicationPng(pngWithText(type).toString('base64'))).toThrow();
    expect(() => validatePng(pngWithText(type, 'Comment'))).not.toThrow();
  },
);
it('rejects source-bearing PNG at artifact ingress before creating files', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const headers = await loginFixtureOwner(f);
  const n = (
    await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: 'private-png.md', content: '# Public' },
    })
  ).json();
  const source = 'flowchart TD\nA-->B\n';
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/notes/${n.id}/diagram-artifacts`,
    headers,
    payload: {
      kind: 'mermaid',
      source,
      sourceHash: hash(source),
      pngBase64: pngWithText('tEXt').toString('base64'),
      requestId: randomUUID(),
    },
  });
  expect(r.statusCode, r.body).toBe(400);
  expect((await f.app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json()).toHaveLength(
    0,
  );
});
it('fails closed for already published, hash-bound PNG source through all public primary routes and blog capture', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const headers = await loginFixtureOwner(f),
    source = 'flowchart TD\nA-->B\n';
  const intent = (
    await f.app.inject({
      method: 'POST',
      url: '/api/diagram-documents/intents',
      headers,
      payload: { path: '00-Inbox/leaky-primary.md', type: 'flowchart', requestId: randomUUID() },
    })
  ).json();
  const prep = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/prepare',
    headers,
    payload: {
      target: { kind: 'creation', intentId: intent.id },
      type: 'flowchart',
      source,
      sourceHash: hash(source),
      title: 'Safe',
      renderer: diagramRendererVersions.flowchart,
      config: {},
      pngBase64: cleanPng.toString('base64'),
      requestId: randomUUID(),
    },
  });
  expect(prep.statusCode, prep.body).toBe(201);
  const prepared = prep.json();
  const markdown = renderPreparedDiagramDocument({ prepared, title: 'Safe', source });
  const commit = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/commit',
    headers,
    payload: { preparedId: prepared.id, markdown, requestId: randomUUID() },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const note = commit.json();
  const shared = await f.app.inject({
    method: 'POST',
    url: `/api/notes/${note.id}/share`,
    headers,
    payload: {},
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const url = `/api/public/shares/${shared.json().token}`;
  // Model a pre-fix valid publication: both PNG and its authoritative marker agree.
  const leaky = pngWithText('tEXt');
  await writeFile(join(f.knowledgeRoot, prepared.preview.relativePath), leaky);
  await writeFile(
    join(f.knowledgeRoot, note.relativePath),
    markdown.replace(prepared.previewHash, hash(leaky)),
  );
  for (const request of [
    { url },
    { url: url + '/diagram' },
    { url: url + `/assets/${prepared.preview.id}` },
    { url: url + '/asset?source=' + encodeURIComponent(prepared.preview.markdownPath) },
    { url: url + '/source' },
    { method: 'POST' as const, url: url + '/read', payload: { maxBytes: 64 } },
  ]) {
    const r = await f.app.inject(request);
    expect(r.statusCode, request.url + ': ' + r.body).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toContain('PRIVATE_NATIVE_SCENE');
  }
  const db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db);
  try {
    expect(() =>
      capturePublication(
        f.config,
        db,
        notes,
        webPrincipal,
        notes.getNote(note.id),
        metadata,
        (h) => '/blog/assets/' + h,
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});
it('blocks embedded scene PNG disguised as an ordinary shared image while preserving owner original bytes', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const headers = await loginFixtureOwner(f),
    leaky = pngWithText('iTXt');
  const n = (
    await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: 'ordinary-png.md', content: '# Public' },
    })
  ).json();
  const db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db);
  try {
    const { assetService } = await import('../packages/core/assets');
    const assets = assetService(f.config, db, notes),
      a = assets.upload(n.id, 'ordinary.png', 'image/png', leaky);
    const saved = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers,
      payload: {
        content: `![image](${a.markdownPath})`,
        expectedModifiedAt: n.modifiedAt,
        requestId: randomUUID(),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const share = (
      await f.app.inject({ method: 'POST', url: `/api/notes/${n.id}/share`, headers, payload: {} })
    ).json();
    for (const suffix of [
      `/assets/${a.id}`,
      '/asset?source=' + encodeURIComponent(a.markdownPath),
    ]) {
      const r = await f.app.inject({ url: `/api/public/shares/${share.token}` + suffix });
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain('PRIVATE_NATIVE_SCENE');
    }
    const original = await f.app.inject({ url: `/api/assets/${a.id}?download=1`, headers });
    expect(original.statusCode, original.body).toBe(200);
    expect(original.rawPayload).toEqual(leaky);
    expect(() =>
      capturePublication(
        f.config,
        db,
        notes,
        webPrincipal,
        notes.getNote(n.id),
        metadata,
        (h) => '/blog/assets/' + h,
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});
it('denies an existing immutable blog PNG blob carrying source even when its stored hash is correct', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const headers = await loginFixtureOwner(f);
  const n = (
    await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: 'old-blog-png.md', content: '# Published' },
    })
  ).json();
  const publish = await f.app.inject({
    method: 'POST',
    url: '/api/blog/publish',
    headers,
    payload: {
      noteId: n.id,
      expectedModifiedAt: n.modifiedAt,
      expectedContentHash: hash(n.content),
      expectedPublicationVersion: 0,
      requestId: randomUUID(),
      metadata: { slug: 'old-blog-png' },
    },
  });
  expect(publish.statusCode, publish.body).toBe(200);
  const post = publish.json();
  const settings = (await f.app.inject({ url: '/api/blog/settings', headers })).json();
  const enabled = await f.app.inject({
    method: 'PATCH',
    url: '/api/blog/settings',
    headers,
    payload: { settings: { ...settings, enabled: true }, requestId: randomUUID() },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const db = openDatabase(f.dataRoot),
    bytes = pngWithText('zTXt'),
    blobHash = hash(bytes);
  let versionId: string;
  try {
    versionId = (
      db.prepare('SELECT current_version_id AS id FROM blog_posts WHERE id=?').get(post.id) as {
        id: string;
      }
    ).id;
    db.prepare('INSERT INTO blog_blobs VALUES(?,?,?)').run(blobHash, 'image/png', bytes);
    db.prepare('INSERT INTO blog_version_resources VALUES(?,?)').run(versionId, blobHash);
  } finally {
    db.close();
  }
  const r = await f.app.inject({ url: `/blog/assets/${post.id}/${versionId!}/${blobHash}` });
  expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
  expect(r.rawPayload).not.toEqual(bytes);
});
it.each(['tEXt', 'zTXt', 'iTXt'] as const)(
  'refuses source-bearing %s PNG in self-contained reading HTML and print input',
  async (type) => {
    const { buildReadingHtml } = await import('../apps/web/reading-export');
    const bytes = pngWithText(type);
    for (const image of [
      new Blob([bytes], { type: 'image/png' }),
      'data:image/png;base64,' + bytes.toString('base64'),
    ]) {
      await expect(
        buildReadingHtml({
          title: 'Public',
          markdown: '![preview](assets/view.png)',
          resolveImage: async () => image,
        }),
      ).rejects.toThrow();
    }
    const safe = pngWithText(type, 'Comment');
    expect(
      await buildReadingHtml({
        title: 'Public',
        markdown: '![preview](assets/view.png)',
        resolveImage: async () => new Blob([safe], { type: 'image/png' }),
      }),
    ).toContain(safe.toString('base64'));
  },
);
it('denies source-bearing published blog design media while preserving its private original bytes', async () => {
  const f = await createFixture();
  fixtures.push(f);
  const { blogService } = await import('../packages/core/blog/service');
  const { defaultBlogDesign } = await import('../shared/blog-design');
  const db = openDatabase(f.dataRoot),
    blog = blogService(f.config, db, noteService(f.config, db));
  const principal = { ...webPrincipal, scopes: [...webPrincipal.scopes, 'blog:publish'] };
  const bytes = pngWithText('zTXt');
  try {
    const media = blog.uploadDesignMedia(principal, {
      name: 'native.png',
      mime: 'image/png',
      base64: bytes.toString('base64'),
      requestId: randomUUID(),
    });
    blog.updateSettings(principal, {
      settings: { ...blog.settings(), enabled: true },
      requestId: randomUUID(),
    });
    const design = defaultBlogDesign();
    design.profile.avatar = media.url;
    blog.saveDesign(principal, {
      design,
      expectedVersion: blog.designState(principal).version,
      requestId: randomUUID(),
    });
    blog.publishDesign(principal, {
      expectedVersion: blog.designState(principal).version,
      requestId: randomUUID(),
    });
    expect(blog.designMedia(principal, media.hash).bytes).toEqual(bytes);
    const r = await f.app.inject({ url: media.url });
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    expect(r.rawPayload).not.toEqual(bytes);
  } finally {
    db.close();
  }
});
