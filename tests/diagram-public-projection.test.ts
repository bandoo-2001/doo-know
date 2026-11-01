import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { openDatabase } from '../packages/core/db';
import { snapshotService } from '../packages/core/knowledge/snapshots';
import { noteService } from '../packages/core/notes';
import { shareService } from '../packages/core/shares';
import { capturePublication } from '../packages/core/blog/publication';
import { webPrincipal } from '../packages/core/knowledge/core';
import { serializeDiagramBinding } from '../shared/diagram-binding';
import { assetService } from '../packages/core/assets';
import { publicDiagramProjectionService } from '../packages/core/public-diagram-projection';
import { resolvePrimaryDiagram } from '../packages/core/knowledge/diagram-resource-resolver';
import { prepareLegacyPreview } from './support/legacy-diagram-preview';
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup() {
  const f = await createFixture();
  fixtures.push(f);
  return { f, headers: await loginFixtureOwner(f) };
}
async function create(f: Fixture, headers: any, name: string, content: string) {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers,
    payload: { folderPath: '00-Inbox', fileName: name, content },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function primary(
  f: Fixture,
  headers: any,
  type: 'whiteboard' | 'mindmap' | 'flowchart',
  path = `00-Inbox/${type}.md`,
) {
  const source =
    type === 'whiteboard'
      ? JSON.stringify({
          ...emptyWhiteboard(),
          elements: [{ id: 'secret', type: 'text', text: 'PRIVATE_SCENE', opacity: 0 }],
        })
      : type === 'mindmap'
        ? '- PRIVATE_OUTLINE\n'
        : 'flowchart TD\n PRIVATE_MERMAID-->B\n';
  const intent = (
    await f.app.inject({
      method: 'POST',
      url: '/api/diagram-documents/intents',
      headers,
      payload: { path, type, requestId: randomUUID() },
    })
  ).json();
  const prep = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/prepare',
    headers,
    payload: {
      target: { kind: 'creation', intentId: intent.id },
      type,
      source,
      sourceHash: sha(source),
      title: '公开标题',
      renderer: diagramRendererVersions[type],
      config: {},
      pngBase64: png,
      requestId: randomUUID(),
    },
  });
  expect(prep.statusCode, prep.body).toBe(201);
  const prepared = prep.json();
  const markdown = renderPreparedDiagramDocument({
    prepared,
    title: prepared.title,
    source,
    description: '用户说明\n' + '公开文字\n'.repeat(8),
  });
  const commit = await f.app.inject({
    method: 'POST',
    url: '/api/diagram-documents/commit',
    headers,
    payload: { preparedId: prepared.id, markdown, requestId: randomUUID() },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  return { note: commit.json(), source, prepared, markdown };
}
async function share(f: Fixture, headers: any, id: string, input: any = {}) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/notes/${id}/share`,
    headers,
    payload: input,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

it.each(['missing-end', 'unsupported-version'] as const)(
  'rejects public reads of a declared diagram with %s while keeping private recovery',
  async (corruption) => {
    const { f, headers } = await setup(),
      { note } = await primary(f, headers, 'mindmap'),
      s = await share(f, headers, note.id),
      url = `/api/public/shares/${s.token}`;
    const first = await f.app.inject({
      method: 'POST',
      url: url + '/read',
      payload: { maxBytes: 64 },
    });
    expect(first.statusCode, first.body).toBe(200);
    const cursor = first.json().data.nextCursor;
    const broken =
      corruption === 'missing-end'
        ? note.content.replace('<!-- dooknow:primary:end -->', '')
        : note.content.replace('"version":1', '"version":2');
    expect(broken).not.toBe(note.content);
    await writeFile(join(f.knowledgeRoot, note.relativePath), broken);
    for (const request of [
      { url },
      { method: 'POST' as const, url: url + '/read', payload: { maxBytes: 64 } },
      { method: 'POST' as const, url: url + '/read', payload: { cursor } },
    ]) {
      const r = await f.app.inject(request);
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
      expect(r.json().code).toBe('INVALID_DIAGRAM_DOCUMENT');
      expect(r.body).not.toContain('PRIVATE_OUTLINE');
    }
    const recovery = await f.app.inject({ url: `/api/notes/${note.id}`, headers });
    expect(recovery.statusCode, recovery.body).toBe(200);
    expect(recovery.json().content).toBe(broken);
    const ordinary = await create(f, headers, 'editable-recovery.md', '# Ordinary'),
      editable = await share(f, headers, ordinary.id, { permission: 'edit' });
    await writeFile(join(f.knowledgeRoot, ordinary.relativePath), broken);
    expect(
      (await f.app.inject({ url: `/api/public/shares/${editable.token}/source` })).statusCode,
    ).toBe(403);
    const db = openDatabase(f.dataRoot),
      notes = noteService(f.config, db),
      snapshots = snapshotService(f.config, db, notes);
    try {
      await expect(
        snapshots.available(shareService(db, notes).principal(s.token).p, note.id, {}),
      ).rejects.toMatchObject({ code: 'DIAGRAM_SOURCE_FORBIDDEN' });
    } finally {
      await snapshots.close();
      db.close();
    }
    await writeFile(
      join(f.knowledgeRoot, note.relativePath),
      broken + '\n\nNormal paragraph.\n\n'.repeat(60000),
    );
    for (const payload of [{ cursor }, { maxBytes: 64 }]) {
      const large = await f.app.inject({ method: 'POST', url: url + '/read', payload });
      expect(large.statusCode, large.body).toBeGreaterThanOrEqual(400);
      expect(large.statusCode).toBeLessThan(500);
      expect(large.json().code).toEqual(expect.any(String));
      expect(large.body).not.toContain('PRIVATE_OUTLINE');
    }
  },
);

it.each(['bytes', 'long-line'] as const)(
  'streams PNG/PDF proofs for large ordinary %s parents through both asset entrances',
  async (mode) => {
    const { f, headers } = await setup(),
      note = await create(f, headers, 'large-assets.md', '# Large');
    await mkdir(join(f.knowledgeRoot, '00-Inbox', 'assets'), { recursive: true });
    const files = [
      { name: 'large.png', bytes: Buffer.from(png, 'base64'), mime: 'image/png' },
      {
        name: 'large.pdf',
        bytes: Buffer.from(
          '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
        ),
        mime: 'application/pdf',
      },
      {
        name: 'private.excalidraw',
        bytes: Buffer.from(JSON.stringify(emptyWhiteboard())),
        mime: 'application/vnd.excalidraw+json',
      },
    ];
    for (const file of files)
      await writeFile(join(f.knowledgeRoot, '00-Inbox', 'assets', file.name), file.bytes);
    const prefix =
      '# Large\n\n![Image](assets/large.png)\n\n[PDF](assets/large.pdf)\n\n[Original](assets/private.excalidraw)\n\n';
    await writeFile(join(f.knowledgeRoot, note.relativePath), prefix);
    const registered = (
      await f.app.inject({ url: `/api/notes/${note.id}/assets`, headers })
    ).json();
    const s = await share(f, headers, note.id),
      url = `/api/public/shares/${s.token}`;
    await writeFile(
      join(f.knowledgeRoot, note.relativePath),
      prefix + (mode === 'bytes' ? 'Normal paragraph.\n\n'.repeat(60000) : 'x'.repeat(32769)),
    );
    const owner = await f.app.inject({ url: `/api/notes/${note.id}`, headers });
    expect(owner.json().code).toBe('LARGE_FILE_MODE_REQUIRED');
    const paths = files.flatMap((file) => {
      const asset = registered.find((a: any) => a.relativePath.endsWith('/' + file.name));
      expect(asset).toBeTruthy();
      return [
        { file, path: '/assets/' + asset.id },
        { file, path: '/asset?source=' + encodeURIComponent('assets/' + file.name) },
      ];
    });
    for (const { file, path } of paths) {
      const r = await f.app.inject({ url: url + path });
      expect(r.statusCode, r.body).toBe(file.name.endsWith('.excalidraw') ? 403 : 200);
      if (r.statusCode === 200) {
        expect(r.rawPayload).toEqual(file.bytes);
        expect(r.headers['content-type']).toContain(file.mime);
      }
    }
    await share(f, headers, note.id, { allowDiagramSource: true });
    for (const { file, path } of paths.filter((p) => p.file.name.endsWith('.excalidraw')))
      expect((await f.app.inject({ url: url + path })).statusCode).toBe(403);
    if (mode === 'bytes') {
      const db = openDatabase(f.dataRoot),
        notes = noteService(f.config, db),
        assets = assetService(f.config, db, notes),
        racing = {
          ...assets,
          async publicSource(id: string, source: string) {
            const result = await assets.publicSource(id, source);
            db.prepare(
              'UPDATE shares SET allow_diagram_source=0,policy_revision=policy_revision+1 WHERE note_id=?',
            ).run(note.id);
            return result;
          },
        };
      try {
        await expect(
          publicDiagramProjectionService(
            f.config,
            db,
            notes,
            racing,
            shareService(db, notes),
          ).asset(s.token, { source: 'assets/large.png' }),
        ).rejects.toMatchObject({ code: 'SHARE_POLICY_CHANGED' });
      } finally {
        db.close();
      }
    }
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${note.id}/share`, headers });
    for (const { path } of paths)
      expect((await f.app.inject({ url: url + path })).statusCode).toBe(404);
  },
);

it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'publishes only the fixed PNG and explanation for %s through every public entrance',
  async (type) => {
    const { f, headers } = await setup(),
      { note, source, prepared } = await primary(f, headers, type),
      s = await share(f, headers, note.id),
      url = `/api/public/shares/${s.token}`;
    const body = await f.app.inject({ url });
    expect(body.statusCode, body.body).toBe(200);
    expect(body.json()).toMatchObject({ canEdit: false, allowDiagramSource: false });
    expect(body.json().html).toContain('用户说明');
    expect(body.body).toContain('img');
    for (const secret of [
      'PRIVATE_SCENE',
      'PRIVATE_OUTLINE',
      'PRIVATE_MERMAID',
      'dooknow:',
      'renderHash',
      'excalidraw@',
    ])
      expect(body.body).not.toContain(secret);
    const resource = await f.app.inject({ url: url + '/diagram' });
    expect(resource.statusCode, resource.body).toBe(200);
    expect(resource.json()).toMatchObject({
      documentType: type,
      source: { hash: sha(source) },
      preview: { state: 'ready' },
      capabilities: { canEdit: false, canDownloadSource: false },
    });
    expect(resource.json().source).not.toHaveProperty('content');
    expect(resource.json()).not.toHaveProperty('render');
    expect((await f.app.inject({ url: url + '/source' })).statusCode).toBe(403);
    let cursor: string | undefined,
      projected = '';
    do {
      const r = await f.app.inject({
        method: 'POST',
        url: url + '/read',
        payload: { ...(cursor ? { cursor } : {}), maxBytes: 64 },
      });
      expect(r.statusCode, r.body).toBe(200);
      const page = r.json().data;
      projected += page.content;
      cursor = page.nextCursor;
    } while (cursor);
    expect(projected).toContain('用户说明');
    expect(projected).not.toContain('PRIVATE_');
    expect(projected).not.toContain('dooknow:');
    const preview = await f.app.inject({
      url: url + '/asset?source=' + encodeURIComponent(prepared.preview.markdownPath),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['content-type']).toContain('image/png');
    if (prepared.source) {
      for (const path of [
        `/assets/${prepared.source.id}`,
        `/asset?source=${encodeURIComponent(prepared.source.markdownPath)}`,
      ])
        expect((await f.app.inject({ url: url + path })).statusCode).toBe(403);
    }
    const granted = await share(f, headers, note.id, { allowDiagramSource: true });
    expect(granted.allowDiagramSource).toBe(true);
    expect((await f.app.inject({ url: url + '/diagram' })).json().source.content).toBe(source);
    expect((await f.app.inject({ url: url + '/source' })).statusCode).toBe(403);
    if (prepared.source) {
      for (const path of [
        `/assets/${prepared.source.id}`,
        `/asset?source=${encodeURIComponent(prepared.source.markdownPath)}`,
      ]) {
        const download = await f.app.inject({ url: url + path });
        expect(download.statusCode, download.body).toBe(200);
        expect(download.rawPayload.toString()).toBe(source);
      }
    }
    const page = (
      await f.app.inject({ method: 'POST', url: url + '/read', payload: { maxBytes: 64 } })
    ).json().data;
    expect(page.nextCursor).toBeTruthy();
    await share(f, headers, note.id, { allowDiagramSource: false });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: url + '/read',
          payload: { cursor: page.nextCursor },
        })
      ).statusCode,
    ).toBe(409);
    await share(f, headers, note.id, { allowDiagramSource: true });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: url + '/read',
          payload: { cursor: page.nextCursor },
        })
      ).statusCode,
    ).toBe(409);
    await share(f, headers, note.id, { allowDiagramSource: false });
    if (prepared.source)
      expect((await f.app.inject({ url: url + '/assets/' + prepared.source.id })).statusCode).toBe(
        403,
      );
    const db = openDatabase(f.dataRoot),
      notes = noteService(f.config, db),
      snapshots = snapshotService(f.config, db, notes),
      p = shareService(db, notes).principal(s.token).p;
    try {
      await expect(snapshots.available(p, note.id, {})).rejects.toMatchObject({
        code: 'DIAGRAM_SOURCE_FORBIDDEN',
      });
      let ownerSnapshot = await snapshots.available(webPrincipal, note.id, {});
      if ('operation' in ownerSnapshot) {
        await snapshots.drain();
        ownerSnapshot = await snapshots.available(webPrincipal, note.id, {});
      }
      expect(ownerSnapshot).not.toHaveProperty('operation');
      if (!('operation' in ownerSnapshot))
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: url + '/read',
              payload: { snapshotId: ownerSnapshot.id },
            })
          ).statusCode,
        ).toBe(404);
    } finally {
      await snapshots.close();
      db.close();
    }
  },
);

it('keeps exact legacy JSON private, registers immutable preview receipts and invalidates changed source/PNG', async () => {
  const { f, headers } = await setup(),
    note = await create(
      f,
      headers,
      'legacy.excalidraw',
      JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'secret', type: 'text', text: 'PRIVATE_SCENE' }],
      }),
    ),
    url = `/api/notes/${note.id}/diagram`,
    before = await readFile(join(f.knowledgeRoot, note.relativePath), 'utf8');
  const owner = await f.app.inject({ url, headers });
  expect(owner.statusCode, owner.body).toBe(200);
  expect(owner.json()).toMatchObject({
    documentHash: sha(before),
    source: { hash: sha(before), content: before },
    capabilities: { canEdit: true, canDownloadSource: true },
  });
  const s = await share(f, headers, note.id),
    pub = `/api/public/shares/${s.token}`;
  const missing = await f.app.inject({ url: pub });
  expect(missing.statusCode, missing.body).toBe(409);
  expect(missing.json().code).toBe('DIAGRAM_PREVIEW_REQUIRED');
  expect(missing.body).not.toContain('PRIVATE_SCENE');
  const input = {
    expectedDocumentHash: sha(before),
    expectedSourceHash: sha(before),
    pngBase64: png,
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    requestId: randomUUID(),
  };
  const prepare = () =>
    f.app.inject({ method: 'POST', url: url + '/legacy-preview', headers, payload: input });
  const prepared = await prepare();
  expect(prepared.statusCode, prepared.body).toBe(200);
  expect((await prepare()).json()).toEqual(prepared.json());
  expect(await readFile(join(f.knowledgeRoot, note.relativePath), 'utf8')).toBe(before);
  expect(prepared.json().preview.state).toBe('ready');
  const changedPng = Buffer.from(png, 'base64');
  changedPng[changedPng.length - 1] ^= 1;
  const rebound = await f.app.inject({
    method: 'POST',
    url: url + '/legacy-preview',
    headers,
    payload: { ...input, pngBase64: changedPng.toString('base64'), requestId: randomUUID() },
  });
  expect(rebound.statusCode, rebound.body).toBe(409);
  expect((await prepare()).json().preview.hash).toBe(prepared.json().preview.hash);
  expect((await f.app.inject({ url: pub })).body).not.toContain('PRIVATE_SCENE');
  expect((await f.app.inject({ url: pub + '/diagram' })).json().source).not.toHaveProperty(
    'content',
  );
  const path = join(f.knowledgeRoot, '00-Inbox', prepared.json().preview.path);
  await unlink(path);
  expect((await f.app.inject({ url, headers })).json().preview.state).toBe('missing');
  expect((await f.app.inject({ url: pub })).statusCode).toBe(409);
  await writeFile(path, Buffer.from(png, 'base64'));
  await writeFile(
    join(f.knowledgeRoot, note.relativePath),
    before.replace('PRIVATE_SCENE', 'PRIVATE_CHANGED'),
  );
  expect((await f.app.inject({ url, headers })).json().preview.state).toBe('stale');
  expect((await f.app.inject({ url: pub })).statusCode).toBe(409);
  expect((await prepare()).statusCode).toBe(409);
});

it('uses semantic resources for UUID and Markdown path embeds without granting unrelated documents', async () => {
  const { f, headers } = await setup(),
    { note, source } = await primary(f, headers, 'whiteboard'),
    legacy = await create(f, headers, 'embedded.excalidraw', JSON.stringify(emptyWhiteboard())),
    other = await create(f, headers, 'other.excalidraw', JSON.stringify(emptyWhiteboard())),
    parent = await create(
      f,
      headers,
      'parent.md',
      `# Parent\n\n\`\`\`excalidraw\n${note.id}\n\`\`\`\n\n\`\`\`excalidraw\nwhiteboard.md\n\`\`\`\n\n\`\`\`excalidraw\n${legacy.id}\n\`\`\`\n\n\`\`\`excalidraw\nembedded.excalidraw\n\`\`\`\n`,
    ),
    s = await share(f, headers, parent.id),
    url = `/api/public/shares/${s.token}`;
  await prepareLegacyPreview(f, headers, legacy.id);
  const owner = await f.app.inject({
    url: `/api/notes/${parent.id}/whiteboards/resolve?source=whiteboard.md`,
    headers,
  });
  expect(owner.statusCode, owner.body).toBe(200);
  expect(owner.json().source.content).toBe(source);
  const legacyOwner = await f.app.inject({
    url: `/api/notes/${parent.id}/whiteboards/resolve?source=embedded.excalidraw`,
    headers,
  });
  expect(legacyOwner.statusCode, legacyOwner.body).toBe(200);
  expect(legacyOwner.json().source.content).toBe(legacy.content);
  for (const ref of [note.id, 'whiteboard.md', legacy.id, 'embedded.excalidraw']) {
    const r = await f.app.inject({ url: url + '/whiteboards/' + encodeURIComponent(ref) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      role: 'embedded',
      capabilities: { canEdit: false, canDownloadSource: false },
      preview: { state: 'ready' },
    });
    expect(
      (
        await f.app.inject({
          url: url + '/asset?source=' + encodeURIComponent(r.json().preview.path),
        })
      ).statusCode,
    ).toBe(200);
  }
  const body = await f.app.inject({ url });
  expect(body.statusCode, body.body).toBe(200);
  expect(body.body).not.toContain('PRIVATE_SCENE');
  expect(body.json().html).toContain('img');
  expect((await f.app.inject({ url: url + '/whiteboards/' + other.id })).statusCode).toBe(404);
  const ordinary = await create(f, headers, 'ordinary.md', '# Ordinary');
  expect(
    (
      await f.app.inject({
        url: `/api/notes/${parent.id}/whiteboards/resolve?source=ordinary.md`,
        headers,
      })
    ).statusCode,
  ).toBe(422);
  await f.app.inject({ method: 'DELETE', url: `/api/notes/${parent.id}/share`, headers });
  expect((await f.app.inject({ url: url + '/whiteboards/' + note.id })).statusCode).toBe(404);
});

it('invalidates projected cursors on native source and PNG changes even when the main Markdown is unchanged', async () => {
  const { f, headers } = await setup(),
    { note, prepared } = await primary(f, headers, 'whiteboard'),
    s = await share(f, headers, note.id),
    url = `/api/public/shares/${s.token}`;
  const page = (
    await f.app.inject({ method: 'POST', url: url + '/read', payload: { maxBytes: 64 } })
  ).json().data;
  const sourcePath = join(f.knowledgeRoot, prepared.source.relativePath),
    original = await readFile(sourcePath, 'utf8');
  await writeFile(sourcePath, original.replace('PRIVATE_SCENE', 'CHANGED_SOURCE'));
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: url + '/read',
        payload: { cursor: page.nextCursor },
      })
    ).statusCode,
  ).toBe(409);
  await writeFile(sourcePath, original);
  const changed = Buffer.from(png, 'base64');
  changed[changed.length - 1] ^= 1;
  await writeFile(join(f.knowledgeRoot, prepared.preview.relativePath), changed);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: url + '/read',
        payload: { cursor: page.nextCursor },
      })
    ).statusCode,
  ).toBe(409);
});

it('reuses a complete legacy portable binding, rejects rebinding changed scenes, and keeps inline SVG/Mermaid compatible', async () => {
  const { f, headers } = await setup(),
    board = await create(
      f,
      headers,
      'bound.excalidraw',
      JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'secret', type: 'text', text: 'BOUND_SCENE_SECRET' }],
      }),
    ),
    parent = await create(f, headers, 'bound-parent.md', '# Parent');
  const prepared = await f.app.inject({
    method: 'POST',
    url: `/api/notes/${parent.id}/diagram-artifacts`,
    headers,
    payload: {
      kind: 'excalidraw',
      source: board.content,
      sourceHash: sha(board.content),
      pngBase64: png,
      requestId: randomUUID(),
    },
  });
  expect(prepared.statusCode, prepared.body).toBe(201);
  const a = prepared.json();
  const content = `# Parent\n\n![EXCALIDRAW 预览](${a.preview.markdownPath})\n\n[图形源文件](${a.source.markdownPath})\n\n${serializeDiagramBinding({ kind: 'excalidraw', codeHash: sha(board.id), sourceHash: sha(board.content) })}\n\n\`\`\`excalidraw\n${board.id}\n\`\`\`\n\n\`\`\`mermaid\nflowchart TD\n A-->B\n\`\`\`\n\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n\`\`\`\n`;
  await writeFile(join(f.knowledgeRoot, parent.relativePath), content);
  const s = await share(f, headers, parent.id),
    url = `/api/public/shares/${s.token}`;
  const body = await f.app.inject({ url });
  expect(body.statusCode, body.body).toBe(200);
  expect(body.body).not.toContain('BOUND_SCENE_SECRET');
  expect(body.body).toContain('mermaid');
  expect(body.body).toContain('svg');
  const resource = await f.app.inject({ url: url + '/whiteboards/' + board.id });
  expect(resource.statusCode, resource.body).toBe(200);
  expect(resource.json().preview.state).toBe('ready');
  expect((await f.app.inject({ url: url + '/assets/' + a.source.id })).statusCode).toBe(403);
  const changedPng = Buffer.from(png, 'base64');
  changedPng[changedPng.length - 1] ^= 1;
  await writeFile(join(f.knowledgeRoot, a.preview.relativePath), changedPng);
  expect((await f.app.inject({ url })).statusCode).toBe(409);
  await writeFile(join(f.knowledgeRoot, a.preview.relativePath), Buffer.from(png, 'base64'));
  const fakeSource = a.source.markdownPath.replace(/\.excalidraw$/, '.svg');
  await writeFile(join(f.knowledgeRoot, '00-Inbox', fakeSource), board.content);
  await writeFile(
    join(f.knowledgeRoot, parent.relativePath),
    content
      .replace('EXCALIDRAW 预览', 'SVG 预览')
      .replace('kind=excalidraw', 'kind=svg')
      .replace(a.source.markdownPath, fakeSource),
  );
  expect((await f.app.inject({ url })).statusCode).toBe(409);
  await writeFile(join(f.knowledgeRoot, parent.relativePath), content);
  await writeFile(
    join(f.knowledgeRoot, board.relativePath),
    board.content.replace('BOUND_SCENE_SECRET', 'DIFFERENT_SCENE'),
  );
  expect((await f.app.inject({ url })).statusCode).toBe(409);
});

it('ignores forged type caches and duplicate source links when enforcing diagram capabilities', async () => {
  const { f, headers } = await setup(),
    { note, prepared } = await primary(f, headers, 'whiteboard'),
    s = await share(f, headers, note.id),
    url = `/api/public/shares/${s.token}`,
    db = openDatabase(f.dataRoot);
  try {
    db.prepare("UPDATE document_state SET document_type='markdown' WHERE note_id=?").run(note.id);
    db.prepare("UPDATE shares SET permission='edit' WHERE note_id=?").run(note.id);
    await writeFile(
      join(f.knowledgeRoot, note.relativePath),
      note.content + `\n[重复原件](${prepared.source.markdownPath})\n`,
    );
    const body = await f.app.inject({ url });
    expect(body.statusCode, body.body).toBe(200);
    expect(body.json().canEdit).toBe(false);
    expect(body.body).not.toContain('PRIVATE_SCENE');
    expect((await f.app.inject({ url: url + '/source' })).statusCode).toBe(403);
    expect((await f.app.inject({ url: url + '/assets/' + prepared.source.id })).statusCode).toBe(
      403,
    );
    expect(
      (
        await f.app.inject({
          url: url + '/asset?source=' + encodeURIComponent(prepared.source.markdownPath),
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    db.close();
  }
});

it('rechecks a source grant tightened during the actual attachment read', async () => {
  const { f, headers } = await setup(),
    { note, prepared } = await primary(f, headers, 'whiteboard'),
    s = await share(f, headers, note.id, { allowDiagramSource: true }),
    db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db),
    assets = assetService(f.config, db, notes);
  // This barrier performs real file IO and a real concurrent policy change; no source or proof is mocked.
  const guarded = {
    ...assets,
    file(path: string) {
      const result = assets.file(path);
      if (path === prepared.source.relativePath)
        db.prepare(
          'UPDATE shares SET allow_diagram_source=0,policy_revision=policy_revision+1 WHERE note_id=?',
        ).run(note.id);
      return result;
    },
  };
  try {
    const projection = publicDiagramProjectionService(
      f.config,
      db,
      notes,
      guarded,
      shareService(db, notes),
    );
    await expect(projection.asset(s.token, { id: prepared.source.id })).rejects.toMatchObject({
      code: 'SHARE_POLICY_CHANGED',
    });
  } finally {
    db.close();
  }
});

it('does not let an old portable group upgrade a stale primary rendering capability', async () => {
  const { f, headers } = await setup(),
    { note, prepared, source } = await primary(f, headers, 'whiteboard');
  const content = `# Parent\n\n![EXCALIDRAW 预览](${prepared.preview.markdownPath})\n\n[图形源文件](${prepared.source.markdownPath})\n\n${serializeDiagramBinding({ kind: 'excalidraw', codeHash: sha(note.id), sourceHash: sha(source) })}\n\n\`\`\`excalidraw\n${note.id}\n\`\`\`\n`;
  const parent = await create(f, headers, 'stale-parent.md', content),
    s = await share(f, headers, parent.id);
  await writeFile(
    join(f.knowledgeRoot, note.relativePath),
    note.content.replace('# 公开标题', '# 标题改变'),
  );
  const response = await f.app.inject({ url: `/api/public/shares/${s.token}` });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('DIAGRAM_PREVIEW_REQUIRED');
});

it('renders cross-directory embedded PNG paths with spaces, parentheses and Chinese text', async () => {
  const { f, headers } = await setup();
  await mkdir(join(f.knowledgeRoot, '00-Inbox', '图形 (共享)'), { recursive: true });
  const { note } = await primary(f, headers, 'whiteboard', '00-Inbox/图形 (共享)/board.md'),
    parent = await create(
      f,
      headers,
      'cross-directory.md',
      `# Parent\n\n\`\`\`excalidraw\n${note.id}\n\`\`\`\n`,
    ),
    s = await share(f, headers, parent.id);
  const response = await f.app.inject({ url: `/api/public/shares/${s.token}` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().html).toContain('<img src="/api/public/shares/');
});

it('honors bounded source handles for legacy semantic reads while keeping exact source bytes', async () => {
  const { f, headers } = await setup(),
    note = await create(f, headers, 'bounded.excalidraw', JSON.stringify(emptyWhiteboard())),
    db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db);
  let snapshot: any;
  try {
    const resource = resolvePrimaryDiagram(f.config, db, notes, webPrincipal, note.id, {
      maxInlineBytes: 0,
      sourceHandle(value) {
        snapshot = value;
        return 'private-source-handle';
      },
    });
    expect(resource.source).not.toHaveProperty('content');
    expect(resource.source.readHandle).toBe('private-source-handle');
    expect(snapshot).toMatchObject({
      content: note.content,
      documentHash: sha(note.content),
      sourceHash: sha(note.content),
      modifiedAt: note.modifiedAt,
    });
  } finally {
    db.close();
  }
});

it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'freezes only PNG and author explanation for primary %s and rejects a changed source/preview',
  async (type) => {
    const { f, headers } = await setup(),
      { note, prepared } = await primary(f, headers, type),
      db = openDatabase(f.dataRoot),
      notes = noteService(f.config, db);
    const capture = () =>
      capturePublication(
        f.config,
        db,
        notes,
        webPrincipal,
        notes.getNote(note.id),
        {
          slug: 'primary',
          title: 'Public',
          summary: 'Summary',
          category: 'Test',
          tags: [],
          pinned: false,
          cover: null,
        },
        (hash) => '/blog/assets/' + hash,
      );
    try {
      const captured = capture();
      expect(captured.html).toContain('用户说明');
      expect(captured.html).toContain('img');
      for (const secret of ['PRIVATE_', 'dooknow:', 'renderHash', '图形源文件'])
        expect(captured.html).not.toContain(secret);
      expect(captured.resources).toHaveLength(1);
      expect(captured.resources[0].mime).toBe('image/png');
      for (const changed of [
        note.content.replace('# 公开标题', '# 修改标题'),
        note.content.replace('"config":{}', '"config":{"theme":"dark"}'),
      ]) {
        expect(changed).not.toBe(note.content);
        await writeFile(join(f.knowledgeRoot, note.relativePath), changed);
        expect(capture).toThrowError(expect.objectContaining({ code: 'BLOG_PREVIEW_REQUIRED' }));
        expect(() => captured.revalidate(webPrincipal)).toThrowError(
          expect.objectContaining({ code: 'BLOG_PREVIEW_REQUIRED' }),
        );
        await writeFile(join(f.knowledgeRoot, note.relativePath), note.content);
      }
      await unlink(join(f.knowledgeRoot, prepared.preview.relativePath));
      expect(capture).toThrowError(
        expect.objectContaining({
          details: expect.objectContaining({ code: 'BLOG_PREVIEW_REQUIRED' }),
        }),
      );
      await writeFile(
        join(f.knowledgeRoot, prepared.preview.relativePath),
        Buffer.from(png, 'base64'),
      );
      if (prepared.source)
        await writeFile(
          join(f.knowledgeRoot, prepared.source.relativePath),
          (await readFile(join(f.knowledgeRoot, prepared.source.relativePath), 'utf8')).replace(
            'PRIVATE_SCENE',
            'CHANGED_SECRET',
          ),
        );
      else
        await writeFile(
          join(f.knowledgeRoot, note.relativePath),
          (await readFile(join(f.knowledgeRoot, note.relativePath), 'utf8')).replace(
            'PRIVATE_',
            'CHANGED_',
          ),
        );
      expect(capture).toThrowError(
        expect.objectContaining({
          details: expect.objectContaining({ code: 'BLOG_PREVIEW_REQUIRED' }),
        }),
      );
    } finally {
      db.close();
    }
  },
);
