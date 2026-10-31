import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { legacyDiagramPreviewService } from '../packages/core/knowledge/legacy-diagram-previews';
import { diagramArtifactService } from '../packages/core/knowledge/diagram-artifacts';
import { serializeDiagramBinding } from '../shared/diagram-binding';
import { renderPreparedDiagramDocument, diagramRendererVersions } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { sha256 } from '../packages/core/knowledge/operations';
import { reconcileService } from '../packages/core/indexing/reconcile';
import { extractArchive } from '../apps/server/platform/archive';
import { create as createTar } from 'tar';
import { portableDeliveryService } from '../packages/core/portable-delivery/service';
import { createFixture, loginFixtureOwner } from './support/fixture';

const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'portable-delivery-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost',
    secret: 'fixture-only',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox/assets'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db);
  clean.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = portableDeliveryService(config, db, notes),
    core = mutationCore(config, db);
  const create = (name: string, content: string) =>
    core.create(webPrincipal, '00-Inbox', name, content, randomUUID());
  const primary = primaryDiagramService(
    config,
    db,
    notes,
    assetService(config, db, notes),
    webPrincipal,
  );
  function diagram(type: 'whiteboard' | 'mindmap' | 'flowchart') {
    const intent = diagramCreationService(config, db, webPrincipal).reserve({
      path: `00-Inbox/${type}.md`,
      type,
      requestId: randomUUID(),
    });
    const source =
      type === 'whiteboard'
        ? JSON.stringify({
            ...emptyWhiteboard(),
            elements: [{ id: 'label', type: 'text', text: '离线节点' }],
          })
        : type === 'mindmap'
          ? '- 节点甲\n  - 节点乙\n'
          : 'flowchart LR\n A[开始] --> B[完成]\n';
    const prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type,
      source,
      sourceHash: sha256(source),
      title: type + ' 标题',
      renderer: diagramRendererVersions[type],
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    });
    const markdown = renderPreparedDiagramDocument({
      prepared,
      title: prepared.title,
      source,
      description: '描述原文\n',
    });
    return {
      note: primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
      prepared,
      source,
      markdown,
    };
  }
  return { root, config, db, notes, service, create, diagram, primary };
}
async function deliveryBytes(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const stream = await f.service.download(webPrincipal, id),
    chunks: Buffer[] = [];
  for await (const part of stream) chunks.push(Buffer.from(part));
  return Buffer.concat(chunks);
}

it('downloads a no-resource single Markdown unchanged, with no archive or empty assets', async () => {
  const f = await fixture(),
    source =
      '# 普通\n\n|甲|乙|\n|-|-|\n|1|2|\n\n[网页](https://example.com)\n\n`![示例](missing.png)`\n';
  const n = f.create('plain.md', source),
    request = { selection: { kind: 'single' as const, noteId: n.id }, requestId: randomUUID() };
  const result = await f.service.create(webPrincipal, request);
  expect(result).toMatchObject({
    kind: 'markdown',
    fileName: 'plain.md',
    mime: 'text/markdown',
    sizeBytes: Buffer.byteLength(source),
    sha256: sha256(source),
  });
  expect(await deliveryBytes(f, result.id)).toEqual(Buffer.from(source));
  expect(await f.service.create(webPrincipal, request)).toEqual(result);
  expect(new MarkdownIt().render((await deliveryBytes(f, result.id)).toString())).toContain('普通');
});

it('keeps explicit multiple and directory selections archives even for one document', async () => {
  const f = await fixture(),
    note = f.create('one.md', '# one');
  for (const selection of [
    { kind: 'multiple' as const, noteIds: [note.id] },
    { kind: 'directory' as const, path: '00-Inbox' },
  ]) {
    const result = await f.service.create(webPrincipal, { selection, requestId: randomUUID() });
    expect(result).toMatchObject({ kind: 'archive', mime: 'application/gzip', manifestVersion: 1 });
  }
});

it('exports the local linked Markdown closure with anchors and reference images while preserving code examples', async () => {
  const f = await fixture();
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/assets/图 (1).png'), png);
  const a = f.create(
      'a.md',
      '# A\n\n[B](b.md#anchor)\n\n![图][pic]\n\n[pic]: <assets/图 (1).png>\n\n`[code](missing.md)`\n',
    ),
    b = f.create('b.md', '# B\n\n[A](a.md)\n');
  const out = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: a.id },
    requestId: randomUUID(),
  });
  expect(out.kind).toBe('archive');
  const archive = join(f.root, 'out.tar.gz'),
    relocated = join(f.root, 'relocated');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(relocated);
  await extractArchive(archive, relocated);
  const md = await readFile(join(relocated, '00-Inbox/a.md'), 'utf8');
  expect(md).toContain('b.md#anchor');
  expect(md).toContain('`[code](missing.md)`');
  const html = new MarkdownIt().render(md),
    image = /<img src="([^"]+)"/.exec(html)![1];
  expect(await readFile(join(relocated, '00-Inbox', decodeURIComponent(image)))).toEqual(png);
  expect(await readFile(join(relocated, '00-Inbox/b.md'), 'utf8')).toContain('# B');
  const manifest = JSON.parse(await readFile(join(relocated, 'dooknow-portable.json'), 'utf8'));
  expect(manifest.files).toHaveLength(3);
  expect(manifest.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  expect(b.id).not.toBe(a.id);
});

it('fails missing, inaccessible and unsupported media dependencies instead of delivering an incomplete package', async () => {
  const f = await fixture(),
    missing = f.create('missing.md', '![broken](assets/missing.png)');
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: missing.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: 'PORTABLE_DEPENDENCY_UNAVAILABLE',
    details: { diagnostics: [{ document: '00-Inbox/missing.md', resource: 'assets/missing.png' }] },
  });
  const privateNote = f.create('secret.md', 'private'),
    parent = f.create('parent.md', '[other](secret.md)');
  await expect(
    f.service.create(
      { ...webPrincipal, knowledgeAll: false, allowedPrefixes: [parent.relativePath] },
      { selection: { kind: 'single', noteId: parent.id }, requestId: randomUUID() },
    ),
  ).rejects.toMatchObject({ code: 'PORTABLE_DEPENDENCY_UNAVAILABLE' });
  expect(privateNote.id).toBeTruthy();
  for (const [name, content] of [
    ['remote', '![remote](https://example.com/a.png)'],
    ['html', '<video poster="poster.png"><source src="movie.mp4"></video>'],
    ['media', '[audio](assets/a.mp3)'],
  ]) {
    const note = f.create(name + '.md', content);
    await expect(
      f.service.create(webPrincipal, {
        selection: { kind: 'single', noteId: note.id },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_UNSUPPORTED' });
  }
});

it('roundtrips an entire manifest archive into new editable identities for all three primary types', async () => {
  const f = await fixture(),
    diagrams = ['whiteboard', 'mindmap', 'flowchart'].map((type) => f.diagram(type as any));
  const out = await f.service.create(webPrincipal, {
    selection: { kind: 'multiple', noteIds: diagrams.map((d) => d.note.id) },
    requestId: randomUUID(),
  });
  const archive = join(f.root, 'portable.tar.gz');
  await writeFile(archive, await deliveryBytes(f, out.id));
  const target = await fixture(),
    result = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    });
  expect(result.notes).toHaveLength(3);
  for (const original of diagrams) {
    const copied = result.notes.find(
      (note: any) => note.sourcePath === original.note.relativePath,
    )!;
    expect(copied.noteId).not.toBe(original.note.id);
    const reopened = target.primary.resolve(copied.noteId);
    expect(reopened).toMatchObject({
      documentType: original.prepared.type,
      source: { content: original.source },
      preview: { state: 'ready' },
      capabilities: { canEdit: true },
    });
    expect(target.notes.getNote(copied.noteId).content).toContain('描述原文\n');
  }
});

it('refuses stale primary PNG/source and rechecks the fixed delivery closure during download', async () => {
  const f = await fixture(),
    graph = f.diagram('whiteboard');
  const out = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: graph.note.id },
    requestId: randomUUID(),
  });
  await writeFile(
    join(f.config.knowledgeRoot, graph.prepared.source!.relativePath),
    graph.source.replace('离线节点', '外部编辑'),
  );
  await expect(f.service.download(webPrincipal, out.id)).rejects.toMatchObject({
    code: 'PORTABLE_VERSION_CONFLICT',
  });
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: graph.note.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
});

it('protects owner HTTP delivery, streams the actual filename and supports complete archive upload', async () => {
  const f = await createFixture();
  clean.push(f.close);
  expect(
    (await f.app.inject({ method: 'POST', url: '/api/portable-deliveries', payload: {} }))
      .statusCode,
  ).toBe(401);
  const headers = await loginFixtureOwner(f);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers,
    payload: { folderPath: '00-Inbox', fileName: 'http.md', content: '# HTTP' },
  });
  expect(created.statusCode).toBe(201);
  const delivery = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries',
    headers,
    payload: {
      selection: { kind: 'multiple', noteIds: [created.json().id] },
      requestId: randomUUID(),
    },
  });
  expect(delivery.statusCode).toBe(201);
  const bytes = await f.app.inject({ url: delivery.json().downloadUrl, headers });
  expect(bytes.statusCode).toBe(200);
  expect(bytes.headers['content-type']).toContain('application/gzip');
  expect(bytes.headers['content-disposition']).toContain('documents.tar.gz');
  const boundary = 'portable-fixture-' + randomUUID();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="folderPath"\r\n\r\n00-Inbox/copied\r\n--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="portable.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    ),
    bytes.rawPayload,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imported = await f.app.inject({
    method: 'POST',
    url: '/api/portable-deliveries/import',
    headers: { ...headers, 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload: body,
  });
  expect(imported.statusCode).toBe(201);
  expect(imported.json().notes[0].noteId).not.toBe(created.json().id);
});

it('rejects source-native relocation before exporting a changed source with an old PNG', async () => {
  const f = await fixture(),
    graph = f.diagram('whiteboard');
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'link', type: 'rectangle', link: '../../another.md' }],
  });
  const prepared = f.primary.prepare({
    target: {
      kind: 'document',
      noteId: graph.note.id,
      expectedDocumentHash: sha256(graph.markdown),
      expectedSourceHash: sha256(graph.source),
    },
    type: 'whiteboard',
    source,
    sourceHash: sha256(source),
    title: graph.prepared.title,
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  f.primary.commit({
    preparedId: prepared.id,
    markdown: renderPreparedDiagramDocument({ prepared, title: prepared.title, source }),
    requestId: randomUUID(),
  });
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: graph.note.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: 'DIAGRAM_PREVIEW_REQUIRED',
    details: { reason: 'native-link-relocation' },
  });
});

it('preserves unknown machine fields and source/prose bytes across portable reimport', async () => {
  const f = await fixture(),
    graph = f.diagram('flowchart');
  const content = graph.markdown
    .replace('"version":1,"type"', '"future":{"opaque":true},"version":1,"type"')
    .replace('<!-- dooknow:primary-binding {', '<!-- dooknow:primary-binding {"future":"keep",');
  mutationCore(f.config, f.db).update(
    webPrincipal,
    graph.note.id,
    content,
    graph.note.modifiedAt,
    randomUUID(),
  );
  const delivery = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: graph.note.id },
    requestId: randomUUID(),
  });
  const archive = join(f.root, 'fields.tar.gz');
  await writeFile(archive, await deliveryBytes(f, delivery.id));
  const target = await fixture(),
    copied = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/copy',
      requestId: randomUUID(),
    });
  const imported = target.notes.getNote(copied.notes[0].noteId).content;
  expect(imported).toContain('"future":{"opaque":true}');
  expect(imported).toContain('"future":"keep"');
  expect(imported).toContain(graph.source);
  expect(imported).toContain('描述原文\n');
});

it('imports a whole extracted manifest directory with more than the old 200-file limit', async () => {
  const f = await fixture(),
    directory = join(f.root, 'directory');
  await mkdir(directory);
  const files = [];
  for (let n = 0; n < 201; n++) {
    const path = `note-${n}.md`,
      content = `# Note ${n}\n`;
    await writeFile(join(directory, path), content);
    files.push({
      path,
      kind: 'document',
      sizeBytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
  }
  await writeFile(
    join(directory, 'dooknow-portable.json'),
    JSON.stringify({ format: 'dooknow-portable', version: 1, files, selected: [files[0].path] }),
  );
  const result = await f.service.importDirectory(webPrincipal, {
    directoryPath: directory,
    folderPath: '00-Inbox/batch',
    requestId: randomUUID(),
  });
  expect(result.notes).toHaveLength(201);
  expect(new Set(result.notes.map((note) => note.noteId)).size).toBe(201);
});

it('validates complete manifest digests and rejects undeclared files, aliases and unsafe archives before writing notes', async () => {
  const f = await fixture(),
    directory = join(f.root, 'bad');
  await mkdir(directory);
  const content = '# original\n';
  await writeFile(join(directory, 'note.md'), content);
  const manifest = {
    format: 'dooknow-portable',
    version: 1,
    files: [
      {
        path: 'note.md',
        kind: 'document',
        sizeBytes: Buffer.byteLength(content),
        sha256: sha256(content),
      },
    ],
    selected: ['note.md'],
  };
  await writeFile(join(directory, 'dooknow-portable.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'note.md'), '# tampered\n');
  await expect(
    f.service.importDirectory(webPrincipal, {
      directoryPath: directory,
      folderPath: '00-Inbox/bad',
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PORTABLE_DIGEST_MISMATCH' });
  await writeFile(join(directory, 'note.md'), content);
  await writeFile(join(directory, 'extra.md'), 'extra');
  await expect(
    f.service.importDirectory(webPrincipal, {
      directoryPath: directory,
      folderPath: '00-Inbox/bad',
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PORTABLE_MANIFEST_FILES_MISMATCH' });
  const archive = join(f.root, 'unsafe.tar.gz');
  await createTar({ cwd: directory, gzip: true, file: archive, prefix: '../escape' }, ['note.md']);
  await expect(
    f.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/bad',
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PORTABLE_PATH' });
  expect(f.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toEqual({ n: 0 });
});

it('terminates later download chunks after the current document grant is revoked', async () => {
  const f = await fixture(),
    note = f.create('large.md', '# large\n' + '内容'.repeat(60000));
  const p = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: [note.relativePath] };
  const delivery = await f.service.create(p, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
    stream = await f.service.download(p, delivery.id);
  p.allowedPrefixes = [];
  await expect(
    (async () => {
      for await (const _part of stream) {
        /* consume real file stream */
      }
    })(),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('exports a prepared legacy UUID embed as ordinary PNG plus a linked Markdown diagram document', async () => {
  const f = await fixture(),
    board = f.create('legacy).excalidraw', JSON.stringify(emptyWhiteboard()));
  const source = f.primary.resolve(board.id),
    legacy = legacyDiagramPreviewService(
      f.config,
      f.db,
      f.notes,
      assetService(f.config, f.db, f.notes),
      webPrincipal,
    );
  legacy.prepare(board.id, {
    expectedDocumentHash: source.documentHash,
    expectedSourceHash: source.source.hash,
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const parent = f.create('parent.md', '正文\n\n```excalidraw\n' + board.id + '\n```\n');
  const out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'legacy.tar.gz'),
    relocated = join(f.root, 'legacy-offline');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(relocated);
  await extractArchive(archive, relocated);
  const body = await readFile(join(relocated, '00-Inbox/parent.md'), 'utf8');
  expect(body).not.toContain(board.id);
  expect(body).not.toContain('```excalidraw');
  const html = new MarkdownIt().render(body);
  expect(html).toContain('<img');
  expect(html).toContain('href="legacy%29.md"');
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/reimport',
      requestId: randomUUID(),
    });
  const copied = imported.notes.find((note) => note.sourcePath === '00-Inbox/legacy).md')!;
  expect(target.primary.resolve(copied.noteId).preview?.state).toBe('ready');
});

it('localizes wikilinks as ordinary Markdown navigation and rejects data/blob resources explicitly', async () => {
  const f = await fixture();
  f.create('target.md', '# Target');
  const parent = f.create('wiki.md', '[[target|显示文本]]\n\n`[[missing]]`\n');
  const out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'wiki.tar.gz'),
    extracted = join(f.root, 'wiki');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(extracted);
  await extractArchive(archive, extracted);
  const md = await readFile(join(extracted, '00-Inbox/wiki.md'), 'utf8');
  expect(new MarkdownIt().render(md)).toContain('href="target.md"');
  expect(md).toContain('`[[missing]]`');
  for (const content of [
    '![audio](data:audio/mpeg;base64,AAAA)',
    '[temp](blob:https://example.com/id)',
  ]) {
    const note = f.create(randomUUID() + '.md', content);
    await expect(
      f.service.create(webPrincipal, {
        selection: { kind: 'single', noteId: note.id },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_UNSUPPORTED' });
  }
});

it('coalesces concurrent identical export requests into the same delivery', async () => {
  const f = await fixture(),
    note = f.create('concurrent.md', '# Same request');
  const request = {
    selection: { kind: 'single' as const, noteId: note.id },
    requestId: randomUUID(),
  };
  const [first, second] = await Promise.all([
    f.service.create(webPrincipal, request),
    f.service.create(webPrincipal, request),
  ]);
  expect(second).toEqual(first);
});

it('reimports a complete package above the old 20 MiB JSON total without flattening assets into the response', async () => {
  const f = await fixture();
  let content = '# Large attachments\n';
  for (let n = 0; n < 3; n++) {
    const bytes = Buffer.alloc(8 * 1024 ** 2, n + 1);
    bytes.write('%PDF-1.7\n');
    await writeFile(join(f.config.knowledgeRoot, `00-Inbox/assets/large-${n}.pdf`), bytes);
    content += `\n[attachment ${n}](assets/large-${n}.pdf)\n`;
  }
  const note = f.create('attachments.md', content),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'large.tar.gz');
  await writeFile(archive, await deliveryBytes(f, out.id));
  const target = await fixture(),
    result = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/large',
      requestId: randomUUID(),
    });
  expect(result.notes).toHaveLength(1);
  expect(result.assets).toBe(3);
  expect(JSON.stringify(result).length).toBeLessThan(2048);
  expect(target.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({ n: 3 });
  const copied = target.notes.getNote(result.notes[0].noteId).content;
  for (const match of copied.matchAll(/\]\(([^)]+\.pdf)\)/g))
    expect(
      (
        await stat(
          join(
            target.config.knowledgeRoot,
            '00-Inbox/large/00-Inbox',
            decodeURIComponent(match[1]),
          ),
        )
      ).size,
    ).toBe(8 * 1024 ** 2);
});

it('recovers already committed note identities when the import progress receipt was interrupted', async () => {
  const f = await fixture(),
    graph = f.diagram('whiteboard'),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: graph.note.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'resume.tar.gz');
  await writeFile(archive, await deliveryBytes(f, out.id));
  const target = await fixture(),
    request = { archivePath: archive, folderPath: '00-Inbox/resumed', requestId: randomUUID() },
    first = await target.service.importArchive(webPrincipal, request);
  target.db
    .prepare('UPDATE portable_import_jobs SET complete=0,result=? WHERE id=?')
    .run(JSON.stringify({ ...first, notes: [] }), first.id);
  const resumed = await target.service.importArchive(webPrincipal, request);
  expect(resumed).toEqual(first);
  expect(target.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
  const denied = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: [] };
  await expect(target.service.importArchive(denied, request)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

it('rejects archive symlinks, duplicate entries and case aliases before materializing library notes', async () => {
  const f = await fixture(),
    directory = join(f.root, 'unsafe-members');
  await mkdir(directory);
  await writeFile(join(directory, 'A.md'), '# A');
  await writeFile(join(directory, 'a.md'), '# a');
  await symlink(join(f.root, 'outside'), join(directory, 'link.md'));
  for (const entries of [['A.md', 'a.md'], ['A.md', 'A.md'], ['link.md']]) {
    const archive = join(f.root, randomUUID() + '.tar.gz');
    await createTar({ cwd: directory, file: archive, gzip: true }, entries);
    await expect(
      f.service.importArchive(webPrincipal, {
        archivePath: archive,
        folderPath: '00-Inbox/rejected',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PORTABLE_ENTRY' });
  }
  expect(f.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toEqual({ n: 0 });
});

it('refuses an externally replaced inline diagram PNG instead of blessing its current bytes', async () => {
  const f = await fixture(),
    note = f.create('inline.md', '# Inline\n'),
    source = 'flowchart LR\n A-->B\n';
  const prepared = diagramArtifactService(
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    webPrincipal,
  ).prepare(note.id, {
    kind: 'mermaid',
    source,
    sourceHash: sha256(source),
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const group = `![MERMAID 预览](${prepared.preview.markdownPath})\n\n[图形源文件](${prepared.source.markdownPath})\n\n${serializeDiagramBinding({ kind: 'mermaid', codeHash: sha256(source.trimEnd()), sourceHash: sha256(source) })}\n\n\`\`\`mermaid\n${source}\`\`\`\n`;
  mutationCore(f.config, f.db).update(
    webPrincipal,
    note.id,
    '# Inline\n\n' + group,
    note.modifiedAt,
    randomUUID(),
  );
  const exported = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: note.id },
    requestId: randomUUID(),
  });
  expect(exported.kind).toBe('archive');
  const archive = join(f.root, 'inline-roundtrip.tar.gz');
  await writeFile(archive, await deliveryBytes(f, exported.id));
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/inline',
      requestId: randomUUID(),
    });
  await expect(
    target.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: imported.notes[0].noteId },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
  await writeFile(
    join(f.config.knowledgeRoot, prepared.preview.relativePath),
    Buffer.concat([png, Buffer.from('modified')]),
  );
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
});

it('roundtrips scanned ordinary Markdown above the public create size limit through the trusted portable path', async () => {
  const f = await fixture(),
    source = '# Large\n' + 'x'.repeat(1_120_000 - 8),
    path = '00-Inbox/large-text.md';
  await writeFile(join(f.config.knowledgeRoot, path), source);
  await reconcileService(f.config, f.db).reconcile(undefined, true);
  const scanned = f.db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as {
    id: string;
  };
  const out = await f.service.create(webPrincipal, {
      selection: { kind: 'multiple', noteIds: [scanned.id] },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'large-text.tar.gz');
  await writeFile(archive, await deliveryBytes(f, out.id));
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    });
  expect(imported.notes).toHaveLength(1);
  expect(imported.notes[0].noteId).not.toBe(scanned.id);
  expect(
    await readFile(join(target.config.knowledgeRoot, imported.notes[0].relativePath), 'utf8'),
  ).toBe(source);
  expect(() => target.create('public-limit.md', source)).toThrowError(
    expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }),
  );
});

it('preserves unbalanced parentheses in inline and reference document paths across export and complete import', async () => {
  const f = await fixture();
  f.create('a)b.md', '# closing');
  f.create('a(b.md', '# opening');
  f.create('a%29b.md', '# literal percent');
  const parent = f.create(
    'parentheses.md',
    '[inline](a%29b.md)\n\n[reference][child]\n\n[child]: a%28b.md\n\n[percent](a%2529b.md)\n',
  );
  const out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'parens.tar.gz'),
    directory = join(f.root, 'parens-offline');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  const markdown = await readFile(join(directory, '00-Inbox/parentheses.md'), 'utf8'),
    html = new MarkdownIt().render(markdown);
  expect(html).toContain('href="a%29b.md"');
  expect(html).toContain('href="a%28b.md"');
  expect(html).toContain('href="a%2529b.md"');
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    });
  expect(imported.notes).toHaveLength(4);
});
