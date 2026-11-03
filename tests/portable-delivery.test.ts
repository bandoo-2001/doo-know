import { afterEach, expect, it, vi } from 'vitest';
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
  function diagram(type: 'whiteboard' | 'mindmap' | 'flowchart', override?: string, name?: string) {
    const intent = diagramCreationService(config, db, webPrincipal).reserve({
      path: `00-Inbox/${name ?? type}.md`,
      type,
      requestId: randomUUID(),
    });
    const source =
      override ??
      (type === 'whiteboard'
        ? JSON.stringify({
            ...emptyWhiteboard(),
            elements: [{ id: 'label', type: 'text', text: '离线节点' }],
          })
        : type === 'mindmap'
          ? '- 节点甲\n  - 节点乙\n'
          : 'flowchart LR\n A[开始] --> B[完成]\n');
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

it('fails missing, inaccessible and unavailable media dependencies instead of delivering an incomplete package', async () => {
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
    ['remote', '![remote](http://127.0.0.1/a.png)'],
    ['html', '<video poster="poster.png"><source src="movie.mp4"></video>'],
    ['media', '[audio](assets/a.mp3)'],
  ]) {
    const note = f.create(name + '.md', content);
    await expect(
      f.service.create(webPrincipal, {
        selection: { kind: 'single', noteId: note.id },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PORTABLE_DEPENDENCY_UNAVAILABLE' });
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
  expect(bytes.headers['content-disposition']).toContain('http.tar.gz');
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

it('rejects missing native closure targets before requesting any preview', async () => {
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
    code: 'PORTABLE_DEPENDENCY_UNAVAILABLE',
    details: {
      diagnostics: [{ document: '00-Inbox/whiteboard.md', resource: '../../another.md' }],
    },
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

it('localizes wikilinks and reports invalid data or temporary blob resources explicitly', async () => {
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
    ).rejects.toMatchObject({
      code: content.includes('blob:')
        ? 'PORTABLE_REQUIRES_PERSISTENCE'
        : 'PORTABLE_DEPENDENCY_UNAVAILABLE',
    });
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
  ).resolves.toMatchObject({ kind: 'archive' });
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

it('roundtrips uppercase and mixed-case Markdown extensions without changing linked filenames', async () => {
  const f = await fixture(),
    child = f.create('MiXeD.mD', '# Child'),
    parent = f.create('UPPER.MD', '# Upper\n\n[child](MiXeD.mD)\n');
  const out = await f.service.create(webPrincipal, {
      selection: { kind: 'multiple', noteIds: [parent.id] },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'case-preserved.tar.gz');
  await writeFile(archive, await deliveryBytes(f, out.id));
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    });
  expect(imported.notes.map((note) => note.sourcePath).sort()).toEqual([
    '00-Inbox/MiXeD.mD',
    '00-Inbox/UPPER.MD',
  ]);
  const copiedParent = imported.notes.find((note) => note.sourcePath === '00-Inbox/UPPER.MD')!,
    copiedChild = imported.notes.find((note) => note.sourcePath === '00-Inbox/MiXeD.mD')!;
  expect(copiedParent.relativePath).toBe('00-Inbox/imported/00-Inbox/UPPER.MD');
  expect(copiedChild.relativePath).toBe('00-Inbox/imported/00-Inbox/MiXeD.mD');
  expect(copiedParent.noteId).not.toBe(parent.id);
  expect(copiedChild.noteId).not.toBe(child.id);
  const markdown = await readFile(
    join(target.config.knowledgeRoot, copiedParent.relativePath),
    'utf8',
  );
  expect(new MarkdownIt().render(markdown)).toContain('href="MiXeD.mD"');
  expect(await readFile(join(target.config.knowledgeRoot, copiedChild.relativePath), 'utf8')).toBe(
    '# Child',
  );
});

it('still refuses a manifest document entry inside _doo-assets even with a Markdown extension', async () => {
  const f = await fixture(),
    directory = join(f.root, 'asset-role');
  await mkdir(join(directory, '_doo-assets'), { recursive: true });
  const content = '# Not a note',
    path = '_doo-assets/UPPER.MD';
  await writeFile(join(directory, path), content);
  await writeFile(
    join(directory, 'dooknow-portable.json'),
    JSON.stringify({
      format: 'dooknow-portable',
      version: 1,
      files: [
        { path, kind: 'document', sizeBytes: Buffer.byteLength(content), sha256: sha256(content) },
      ],
      selected: [path],
    }),
  );
  await expect(
    f.service.importDirectory(webPrincipal, {
      directoryPath: directory,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PORTABLE_DOCUMENT' });
  expect(f.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toEqual({ n: 0 });
});

it('localizes own-origin note navigation and relative query links into the fixed document closure', async () => {
  const f = await fixture(),
    child = f.create('child.md', '# Section\n\nChild body\n');
  const source = `[absolute](${f.config.origin}/?note=${child.id}#section)\n\n[root-relative](/?note=${child.id}#section)\n\n[query-relative](?note=${child.id}#section)\n\n[escaped-anchor](${f.config.origin}/?note=${child.id}#part\\))\n\n[reference][local]\n\n[local]: ${f.config.origin}/?note=${child.id}#section\n\n[external](https://example.com/?note=${child.id}#section)\n\n\`[example](${f.config.origin}/?note=${child.id})\`\n`;
  const parent = f.create('navigation.md', source),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    });
  expect(out.kind).toBe('archive');
  const archive = join(f.root, 'navigation.tar.gz'),
    directory = join(f.root, 'navigation-offline');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  const markdown = await readFile(join(directory, '00-Inbox/navigation.md'), 'utf8'),
    html = new MarkdownIt().render(markdown);
  expect(html.match(/href="child\.md#section"/g)).toHaveLength(4);
  expect(html).toContain('href="child.md#part%29"');
  expect(html).toContain(`href="https://example.com/?note=${child.id}#section"`);
  expect(html).not.toContain(`href="${f.config.origin}`);
  expect(markdown).toContain(`\`[example](${f.config.origin}/?note=${child.id})\``);
  expect(await readFile(join(directory, '00-Inbox/child.md'), 'utf8')).toBe(
    '# Section\n\nChild body\n',
  );
  const target = await fixture(),
    imported = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/imported',
      requestId: randomUUID(),
    });
  expect(imported.notes).toHaveLength(2);
});

it('denies an ungranted own-origin navigation target without exposing its path or content', async () => {
  const f = await fixture(),
    child = f.create('private-child.md', 'PRIVATE CHILD CONTENT'),
    parent = f.create('restricted-root.md', `[child](${f.config.origin}/?note=child-placeholder)`);
  const note = f.notes.getNote(parent.id);
  mutationCore(f.config, f.db).update(
    webPrincipal,
    parent.id,
    note.content.replace('child-placeholder', child.id),
    note.modifiedAt,
    randomUUID(),
  );
  const p = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: [parent.relativePath] };
  let failure: any;
  try {
    await f.service.create(p, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'PORTABLE_DEPENDENCY_UNAVAILABLE' });
  expect(JSON.stringify(failure.details)).not.toContain('private-child.md');
  expect(JSON.stringify(failure.details)).not.toContain('PRIVATE CHILD CONTENT');
  const externalSource = `[website](https://other.example/?note=${child.id}#section)`,
    external = f.create('external-query.md', externalSource);
  const delivery = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: external.id },
    requestId: randomUUID(),
  });
  expect(delivery.kind).toBe('markdown');
  expect(await deliveryBytes(f, delivery.id)).toEqual(Buffer.from(externalSource));
});

it('requires a matching relocation preview for native own-origin note navigation', async () => {
  const f = await fixture(),
    child = f.create('native-child.md', '# Child'),
    graph = f.diagram('whiteboard');
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [
      { id: 'link', type: 'rectangle', link: `${f.config.origin}/?note=${child.id}#section` },
    ],
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

it('rejects unresolved own-origin autolinks instead of reporting dependency-free Markdown', async () => {
  const f = await fixture(),
    child = f.create('auto-child.md', '# Child'),
    parent = f.create('auto-root.md', `See ${f.config.origin}/?note=${child.id}`);
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: parent.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_UNSUPPORTED' });
});

it('exports and reimports all four real media formats with HTML sources, poster and offline fallback links', async () => {
  const f = await fixture(),
    extensions = ['mp4', 'webm', 'mp3', 'wav'];
  for (const ext of extensions)
    await writeFile(
      join(f.config.knowledgeRoot, '00-Inbox/assets/a.' + ext),
      await readFile(join(import.meta.dirname, 'fixtures/media/sample.' + ext)),
    );
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/assets/poster.png'), png);
  const note = f.create(
    'media.md',
    '<video poster="assets/poster.png"><source src="assets/a.mp4"></video>\n<audio src="assets/a.mp3"></audio>\n\n[WebM](assets/a.webm)\n[WAV](assets/a.wav)\n',
  );
  const delivery = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: note.id },
    requestId: randomUUID(),
  });
  const archive = join(f.root, 'media.tgz'),
    extracted = join(f.root, 'media');
  await writeFile(archive, await deliveryBytes(f, delivery.id));
  await mkdir(extracted);
  await extractArchive(archive, extracted);
  const manifest = JSON.parse(await readFile(join(extracted, 'dooknow-portable.json'), 'utf8'));
  expect(manifest.files.filter((x: any) => x.kind === 'asset')).toHaveLength(5);
  const md = await readFile(join(extracted, '00-Inbox/media.md'), 'utf8');
  expect(md).toContain('[媒体文件]');
  expect(md).not.toContain('/api/');
  expect(md).toContain('assets/a.mp4');
  const target = await fixture();
  const result = await target.service.importDirectory(webPrincipal, {
    directoryPath: extracted,
    folderPath: '10-Projects/relocated',
    requestId: randomUUID(),
  });
  expect(result.assets).toBe(5);
  expect(target.notes.getNote(result.notes[0].noteId).content).toContain(
    'poster="assets/poster.png',
  );
  const again = await target.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: result.notes[0].noteId },
    requestId: randomUUID(),
  });
  expect(again.kind).toBe('archive');
});

it('localizes typed data media and leaves ordinary external hyperlinks unfetched', async () => {
  const f = await fixture(),
    wav = await readFile(join(import.meta.dirname, 'fixtures/media/sample.wav'));
  const note = f.create(
    'data.md',
    `<audio src="data:audio/wav;base64,${wav.toString('base64')}"></audio>\n\n[site](http://127.0.0.1/no-fetch)\n`,
  );
  const delivery = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: note.id },
    requestId: randomUUID(),
  });
  expect(delivery.kind).toBe('archive');
  const archive = join(f.root, 'data.tgz'),
    extracted = join(f.root, 'data-extracted');
  await writeFile(archive, await deliveryBytes(f, delivery.id));
  await mkdir(extracted);
  await extractArchive(archive, extracted);
  expect(await readFile(join(extracted, '00-Inbox/data.md'), 'utf8')).toContain(
    '[site](http://127.0.0.1/no-fetch)',
  );
});

it('streams a slow remote media outside the workspace lock and aborts/reclaims cancelled staging', async () => {
  const { createServer, request } = await import('node:http');
  const f = await fixture(),
    wav = await readFile(join(import.meta.dirname, 'fixtures/media/sample.wav'));
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    release = new Promise<void>((r) => (finish = r));
  const server = createServer(async (_req, res) => {
    res.setHeader('Content-Type', 'audio/wav');
    res.flushHeaders();
    entered();
    await release;
    res.end(wav);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const service = portableDeliveryService(f.config, f.db, f.notes, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url, options, cb) =>
      request(`http://127.0.0.1:${port}${url.pathname}`, { ...options, lookup: undefined }, cb),
  });
  const remote = f.create('remote.md', '<audio src="https://fixture.test/media.wav"></audio>'),
    ordinary = f.create('ordinary.md', '# Old\n');
  const work = service.create(webPrincipal, {
    selection: { kind: 'single', noteId: remote.id },
    requestId: randomUUID(),
  });
  try {
    await started;
    const before = f.notes.getNote(ordinary.id),
      start = Date.now();
    await f.notes.saveNote(ordinary.id, '# Changed while remote waits\n', before.modifiedAt);
    expect(Date.now() - start).toBeLessThan(1000);
    finish();
    expect((await work).kind).toBe('archive');
  } finally {
    finish();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it('cancels slow network acquisition and reclaims all private staging and receipt bytes', async () => {
  const { createServer, request } = await import('node:http'),
    { readdir } = await import('node:fs/promises');
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'audio/wav');
    res.flushHeaders();
    entered();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const service = portableDeliveryService(f.config, f.db, f.notes, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url, options, cb) =>
      request(`http://127.0.0.1:${port}${url.pathname}`, { ...options, lookup: undefined }, cb),
  });
  const note = f.create('cancel.md', '<audio src="https://fixture.test/slow.wav"></audio>'),
    controller = new AbortController();
  const work = service.create(
    webPrincipal,
    { selection: { kind: 'single', noteId: note.id }, requestId: randomUUID() },
    { signal: controller.signal },
  );
  const rejected = expect(work).rejects.toThrow();
  try {
    await started;
    controller.abort(Error('user cancelled'));
    await rejected;
    expect(f.db.prepare('SELECT count(*) n FROM portable_deliveries').get()).toEqual({ n: 0 });
    expect(await readdir(join(f.config.dataRoot, 'portable-deliveries'))).toEqual([]);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it('resolves owned API asset identities without fetching private application URLs', async () => {
  const f = await fixture(),
    note = f.create('api-asset.md', '# Media\n'),
    assets = assetService(f.config, f.db, f.notes);
  const { Readable } = await import('node:stream'),
    bytes = await readFile(join(import.meta.dirname, 'fixtures/media/sample.mp4'));
  const asset = await assets.uploadStream(
    note.id,
    'clip.mp4',
    'video/mp4',
    Readable.from([bytes]),
    randomUUID(),
  );
  const source = f.create('api-source.md', `<video src="/api/assets/${asset.id}"></video>\n`);
  const out = await f.service.create(webPrincipal, {
    selection: { kind: 'single', noteId: source.id },
    requestId: randomUUID(),
  });
  expect(out.kind).toBe('archive');
  const archive = join(f.root, 'api.tgz'),
    extracted = join(f.root, 'api-extracted');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(extracted);
  await extractArchive(archive, extracted);
  const md = await readFile(join(extracted, '00-Inbox/api-source.md'), 'utf8');
  expect(md).not.toContain('/api/');
  expect(md).toContain('[媒体文件]');
});

it('streams a 24 MiB WAV upload with bounded Buffer allocations', async () => {
  const f = await fixture(),
    note = f.create('bounded-media.md', '# Bounded media\n'),
    assets = assetService(f.config, f.db, f.notes),
    size = 24 * 1024 * 1024;
  const head = Buffer.from(
    await readFile(join(import.meta.dirname, 'fixtures/media/sample.wav')),
  ).subarray(0, 44);
  head.writeUInt32LE(size + 36, 4);
  head.writeUInt32LE(size, 40);
  const chunk = Buffer.alloc(65536);
  let largest = 0;
  const unsafe = Buffer.allocUnsafe,
    allocate = Buffer.alloc;
  const a = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((n: number) => {
    largest = Math.max(largest, n);
    return unsafe(n);
  });
  const b = vi.spyOn(Buffer, 'alloc').mockImplementation(((n: number, ...args: any[]) => {
    largest = Math.max(largest, n);
    return (allocate as any)(n, ...args);
  }) as any);
  let result: any;
  try {
    async function* input() {
      yield head;
      for (let at = 0; at < size; at += chunk.length) yield chunk;
    }
    result = await assets.uploadStream(note.id, 'bounded.wav', 'audio/wav', input(), randomUUID());
    expect(assets.inspect(result.relativePath).sizeBytes).toBe(size + 44);
    expect(largest).toBeLessThanOrEqual(65536);
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
});

it('review regression: remote failure diagnostics redact URL userinfo and inline data bytes', async () => {
  const f = await fixture();
  for (const [url, diagnostic] of [
    ['https://user:pass@fixture.invalid/media.mp4', 'https://fixture.invalid/media.mp4'],
    ['data:audio/wav;base64,c2VjcmV0LWJ5dGVz', 'data:audio/wav;base64,[inline bytes]'],
  ]) {
    const note = f.create(randomUUID() + '.md', `<video src="${url}"></video>`);
    const error = await f.service
      .create(webPrincipal, {
        selection: { kind: 'single', noteId: note.id },
        requestId: randomUUID(),
      })
      .catch((error) => error);
    expect(error.code).toBe('PORTABLE_DEPENDENCY_UNAVAILABLE');
    expect(error.details.diagnostics[0].resource).toBe(diagnostic);
    expect(JSON.stringify(error.details)).not.toContain('user:pass');
    expect(JSON.stringify(error.details)).not.toContain('c2VjcmV0LWJ5dGVz');
  }
});

it('review regression: own-origin API asset autolinks cannot publish an archive retaining the application URL', async () => {
  const f = await fixture();
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/assets/auto.png'), png);
  const asset = assetService(f.config, f.db, f.notes).register('00-Inbox/assets/auto.png');
  const note = f.create('auto-api.md', `<http://localhost/api/assets/${asset.id}>\n`);
  await expect(
    f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_UNSUPPORTED' });
  expect(f.db.prepare('SELECT count(*) n FROM portable_deliveries').get()).toEqual({ n: 0 });
});

it('review regression: exact 128 MiB incompressible PCM roundtrips while its export remains retained within 512 MiB staging', async () => {
  const f = await fixture(),
    { open } = await import('node:fs/promises'),
    { randomFillSync } = await import('node:crypto');
  const size = 128 * 1024 * 1024,
    path = join(f.config.knowledgeRoot, '00-Inbox/assets/limit.wav');
  const header = Buffer.from(
    await readFile(join(import.meta.dirname, 'fixtures/media/sample.wav')),
  ).subarray(0, 44);
  header.writeUInt32LE(size - 8, 4);
  header.writeUInt32LE(size - 44, 40);
  const fd = await open(path, 'wx'),
    chunk = randomFillSync(Buffer.alloc(65536));
  try {
    await fd.write(header);
    for (let at = 44; at < size; at += chunk.length)
      await fd.write(chunk.subarray(0, Math.min(chunk.length, size - at)));
  } finally {
    await fd.close();
  }
  const note = f.create('limit-media.md', '[WAV](assets/limit.wav)\n'),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    });
  expect(out.sizeBytes).toBeGreaterThan(size);
  const row = f.db.prepare('SELECT artifact FROM portable_deliveries WHERE id=?').get(out.id) as {
    artifact: string;
  };
  let peak = 0;
  const result = await f.service.importArchive(
    webPrincipal,
    { archivePath: row.artifact, folderPath: '10-Projects/large-copy', requestId: randomUUID() },
    {
      check: () => {
        const active = (
          f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as {
            n: number;
          }
        ).n;
        const retained = (
          f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries').get() as {
            n: number;
          }
        ).n;
        peak = Math.max(peak, active + retained);
        return webPrincipal;
      },
    },
  );
  expect(result.assets).toBe(1);
  expect(result.notes).toHaveLength(1);
  expect(peak).toBeLessThanOrEqual(512 * 1024 * 1024);
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toEqual({ n: 0 });
}, 60000);
it.each(['svg', 'mermaid', 'excalidraw'] as const)(
  'roundtrips a bound v1 %s source/PNG pair without redraw or application note identities',
  async (kind) => {
    const f = await fixture(),
      note = f.create('bound-' + kind + '.md', '# Parent\n');
    let source =
        kind === 'svg'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'
          : 'flowchart LR\n A-->B\n',
      code = source;
    if (kind === 'excalidraw') {
      const board = f.create('bound-board.excalidraw', JSON.stringify(emptyWhiteboard()));
      source = f.notes.getNote(board.id).content;
      code = board.id;
    }
    const prepared = diagramArtifactService(
      f.db,
      f.notes,
      assetService(f.config, f.db, f.notes),
      webPrincipal,
    ).prepare(note.id, {
      kind,
      source,
      sourceHash: sha256(source),
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    });
    const group = `![${kind.toUpperCase()} 预览](${prepared.preview.markdownPath})\n\n[图形源文件](${prepared.source.markdownPath})\n\n${serializeDiagramBinding({ kind, codeHash: sha256(code.trimEnd()), sourceHash: sha256(source) })}\n\n\`\`\`${kind}\n${code}\n\`\`\`\n`;
    mutationCore(f.config, f.db).update(
      webPrincipal,
      note.id,
      group,
      note.modifiedAt,
      randomUUID(),
    );
    const delivery = await f.service.create(webPrincipal, {
        selection: { kind: 'single', noteId: note.id },
        requestId: randomUUID(),
      }),
      archive = join(f.root, 'bound.tgz');
    await writeFile(archive, await deliveryBytes(f, delivery.id));
    const target = await fixture(),
      request = { archivePath: archive, folderPath: '00-Inbox/whole', requestId: randomUUID() },
      imported = await target.service.importArchive(webPrincipal, request);
    expect(imported.notes).toHaveLength(1);
    const copy = target.notes.getNote(imported.notes[0].noteId);
    const { boundDiagramSources } = await import('../shared/diagram-portability');
    const groups = boundDiagramSources(copy.content);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe(kind);
    expect(copy.content).not.toContain('/api/');
    if (kind === 'excalidraw') expect(groups[0].code.trim()).not.toMatch(/^[a-f0-9-]{36}$/);
    await expect(
      target.service.create(webPrincipal, {
        selection: { kind: 'single', noteId: copy.id },
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: 'archive' });
    const moved = mutationCore(target.config, target.db).move(
      webPrincipal,
      copy.id,
      '00-Inbox',
      'moved-' + kind + '.md',
      copy.modifiedAt,
      randomUUID(),
    );
    expect((await target.service.importArchive(webPrincipal, request)).notes[0]).toMatchObject({
      noteId: copy.id,
      relativePath: moved.relativePath,
    });
  },
);

it('preserves native relative source base and collects its authorized offline document closure', async () => {
  const f = await fixture(),
    child = f.create('native-child.md', '# Native child');
  const source = JSON.stringify({
    ...emptyWhiteboard(),
    elements: [{ id: 'link', type: 'rectangle', link: '../native-child.md#anchor' }],
  });
  const graph = f.diagram('whiteboard', source);
  const delivery = await f.service.create(
    { ...webPrincipal, scopes: ['knowledge:read'] },
    { selection: { kind: 'single', noteId: graph.note.id }, requestId: randomUUID() },
  );
  const archive = join(f.root, 'native.tar.gz'),
    out = join(f.root, 'native-out');
  await writeFile(archive, await deliveryBytes(f, delivery.id));
  await mkdir(out);
  await extractArchive(archive, out);
  const doc = (await import('../shared/diagram-document')).parseDiagramDocument(
    await readFile(join(out, graph.note.relativePath), 'utf8'),
  );
  expect(doc.status).toBe('diagram');
  if (doc.status !== 'diagram' || doc.primary.source.format !== 'excalidraw') throw Error('native');
  const { localReference } = await import('../packages/core/render');
  const path = localReference(graph.note.relativePath, doc.primary.source.path)!;
  expect(await readFile(join(out, path), 'utf8')).toBe(source);
  expect(await readFile(join(out, child.relativePath), 'utf8')).toBe('# Native child');
});
it('returns a fixed read-only source plan for native UUID links and resumes same request with a new matching PNG', async () => {
  const f = await fixture(),
    child = f.create('native-uuid.md', '# Native UUID'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [
        { id: 'link', type: 'rectangle', link: f.config.origin + '/?note=' + child.id + '#part' },
      ],
    }),
    graph = f.diagram('whiteboard', source),
    p = { ...webPrincipal, scopes: ['knowledge:read'] },
    input = {
      selection: { kind: 'single' as const, noteId: graph.note.id },
      requestId: randomUUID(),
    };
  const error = await f.service.create(p, input).catch((e) => e);
  expect(error.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
  const need = error.details.portablePreviews[0];
  const fixed = f.service.previews.get(p, { previewId: need.previewId });
  expect(fixed.source).not.toBe(source);
  expect(fixed.source).not.toContain(child.id);
  expect(JSON.parse(fixed.source).elements[0].link).toContain('native-uuid.md#part');
  f.service.previews.prepare(p, {
    previewId: need.previewId,
    sourceHash: need.sourceHash,
    pngBase64: png.toString('base64'),
    requestId: 'portable-render',
  });
  const delivery = await f.service.create(p, input);
  expect(delivery.kind).toBe('archive');
  expect(
    await readFile(join(f.config.knowledgeRoot, graph.prepared.source!.relativePath), 'utf8'),
  ).toBe(source);
  const archive = join(f.root, 'uuid.tar.gz'),
    out = join(f.root, 'uuid-out');
  await writeFile(archive, await deliveryBytes(f, delivery.id));
  await mkdir(out);
  await extractArchive(archive, out);
  const target = await fixture();
  await mkdir(join(target.config.knowledgeRoot, '00-Inbox/again'));
  const imported = await target.service.importDirectory(webPrincipal, {
    directoryPath: out,
    folderPath: '00-Inbox/again',
    requestId: randomUUID(),
  });
  const main = imported.notes.find((n) => n.sourcePath === graph.note.relativePath)!;
  const parsed = (await import('../shared/diagram-document')).parseDiagramDocument(
    await readFile(join(target.config.knowledgeRoot, main.relativePath), 'utf8'),
  );
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw')
    throw Error('native');
  const { localReference } = await import('../packages/core/render');
  const finalPath = localReference(main.relativePath, parsed.primary.source.path)!;
  expect(await readFile(join(target.config.knowledgeRoot, finalPath), 'utf8')).toBe(fixed.source);
  expect(
    await target.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: main.noteId },
      requestId: randomUUID(),
    }),
  ).toMatchObject({ kind: 'archive' });
});
it('rebases a legacy self-reference to its renamed Markdown target before preview planning and updates the full render tuple', async () => {
  const f = await fixture(),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'self', type: 'rectangle', link: 'legacy-self.excalidraw#self' }],
    }),
    board = f.create('legacy-self.excalidraw', source),
    state = f.primary.resolve(board.id);
  legacyDiagramPreviewService(
    f.config,
    f.db,
    f.notes,
    assetService(f.config, f.db, f.notes),
    webPrincipal,
  ).prepare(board.id, {
    expectedDocumentHash: state.documentHash,
    expectedSourceHash: state.source.hash,
    renderer: diagramRendererVersions.whiteboard,
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const parent = f.create('legacy-self-parent.md', '```excalidraw\n' + board.id + '\n```\n');
  const input = {
      selection: { kind: 'single' as const, noteId: parent.id },
      requestId: randomUUID(),
    },
    error = await f.service.create(webPrincipal, input).catch((e) => e),
    need = error.details.portablePreviews[0],
    fixed = f.service.previews.get(webPrincipal, need.previewId);
  expect(JSON.parse(fixed.source).elements[0].link).toBe('../00-Inbox/legacy-self.md#self');
  const changed = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  f.service.previews.prepare(webPrincipal, {
    previewId: need.previewId,
    sourceHash: need.sourceHash,
    pngBase64: changed.toString('base64'),
    requestId: 'legacy-fixed',
  });
  const out = await f.service.create(webPrincipal, input),
    archive = join(f.root, 'self.tar.gz'),
    directory = join(f.root, 'self-out');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  const parsed = (await import('../shared/diagram-document')).parseDiagramDocument(
    await readFile(join(directory, '00-Inbox/legacy-self.md'), 'utf8'),
  );
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram') throw Error('diagram');
  expect(parsed.primary.binding).toMatchObject({
    sourceHash: sha256(fixed.source),
    previewHash: sha256(changed),
    renderHash: need.renderHash,
  });
  expect(parsed.primary.binding.previewHash).not.toBe(sha256(png));
  const manifest = JSON.parse(await readFile(join(directory, 'dooknow-portable.json'), 'utf8'));
  expect(manifest.files.filter((file: any) => file.kind === 'asset')).toHaveLength(2);
  expect(await readFile(join(f.config.knowledgeRoot, board.relativePath), 'utf8')).toBe(
    state.source.content,
  );
});
it('rejects an incoming native dependency absent from the fixed manifest before publishing any main document', async () => {
  const f = await fixture(),
    graph = f.diagram('whiteboard'),
    input = {
      selection: { kind: 'single' as const, noteId: graph.note.id },
      requestId: randomUUID(),
    },
    out = await f.service.create(webPrincipal, input),
    archive = join(f.root, 'bad-native.tar.gz'),
    directory = join(f.root, 'bad-native');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  const { parseDiagramDocument } = await import('../shared/diagram-document'),
    { localReference } = await import('../packages/core/render'),
    { serializePrimaryBinding } = await import('../shared/diagram-document-binding');
  const mainPath = join(directory, graph.note.relativePath),
    content = await readFile(mainPath, 'utf8'),
    parsed = parseDiagramDocument(content);
  if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw')
    throw Error('diagram');
  const sourcePath = localReference(graph.note.relativePath, parsed.primary.source.path)!,
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'bad', type: 'rectangle', link: '../missing.md' }],
    }),
    binding = { ...parsed.primary.binding, sourceHash: sha256(source) };
  const { serializeDiagramRenderInput } = await import('../shared/diagram-document-binding');
  binding.renderHash = sha256(
    serializeDiagramRenderInput({
      type: 'whiteboard',
      sourceHash: binding.sourceHash,
      title: parsed.title,
      renderer: graph.prepared.renderer,
      config: {},
    }),
  );
  await writeFile(join(directory, sourcePath), source);
  const final = content.replace(
    serializePrimaryBinding(parsed.primary.binding),
    serializePrimaryBinding(binding),
  );
  await writeFile(mainPath, final);
  const manifestPath = join(directory, 'dooknow-portable.json'),
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    file.sha256 = sha256(bytes);
    file.sizeBytes = bytes.length;
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const target = await fixture();
  await expect(
    target.service.importDirectory(webPrincipal, {
      directoryPath: directory,
      folderPath: '00-Inbox/missing',
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'PORTABLE_DEPENDENCY_UNAVAILABLE' });
  expect(target.db.prepare('SELECT count(*) n FROM notes WHERE active=1').get()).toMatchObject({
    n: 0,
  });
});
it('plans the complete nested native asset closure before rendering its final per-document sources', async () => {
  const f = await fixture(),
    child = f.create('nested-target.md', '# Nested'),
    nested = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'nested', type: 'rectangle', link: f.config.origin + '/?note=' + child.id }],
    }),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'outer', type: 'rectangle', link: 'nested.EXCALIDRAW' }],
    });
  await mkdir(join(f.config.knowledgeRoot, '00-Inbox/_doo-assets'), { recursive: true });
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/_doo-assets/nested.EXCALIDRAW'), nested);
  const graph = f.diagram('whiteboard', source),
    input = {
      selection: { kind: 'single' as const, noteId: graph.note.id },
      requestId: randomUUID(),
    },
    error = await f.service.create(webPrincipal, input).catch((e) => e);
  expect(error.code).toBe('DIAGRAM_PREVIEW_REQUIRED');
  expect(error.details.portablePreviews).toHaveLength(2);
  for (const need of error.details.portablePreviews)
    f.service.previews.prepare(webPrincipal, {
      previewId: need.previewId,
      sourceHash: need.sourceHash,
      pngBase64: png.toString('base64'),
      requestId: 'nested-' + need.previewId,
    });
  const out = await f.service.create(webPrincipal, input),
    archive = join(f.root, 'nested.tar.gz'),
    directory = join(f.root, 'nested-out');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  const manifest = JSON.parse(await readFile(join(directory, 'dooknow-portable.json'), 'utf8'));
  for (const file of manifest.files.filter((file: any) => file.path.endsWith('.excalidraw')))
    expect(await readFile(join(directory, file.path), 'utf8')).not.toContain(child.id);
  const target = await fixture();
  expect(
    await target.service.importDirectory(webPrincipal, {
      directoryPath: directory,
      folderPath: '00-Inbox/nested',
      requestId: randomUUID(),
    }),
  ).toMatchObject({
    notes: expect.arrayContaining([expect.objectContaining({ sourcePath: child.relativePath })]),
  });
});
it('keeps a shared immutable native source unchanged and stages independent per-document export snapshots', async () => {
  const f = await fixture(),
    child = f.create('shared-target.md', '# Shared'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'shared', type: 'rectangle', link: f.config.origin + '/?note=' + child.id }],
    }),
    a = f.diagram('whiteboard', source, 'shared-a');
  const intent = diagramCreationService(f.config, f.db, webPrincipal).reserve({
      path: '00-Inbox/shared-b.md',
      type: 'whiteboard',
      requestId: randomUUID(),
    }),
    prepared = f.primary.prepareImported(
      {
        target: { kind: 'creation', intentId: intent.id },
        type: 'whiteboard',
        source,
        sourceHash: sha256(source),
        title: a.prepared.title,
        renderer: diagramRendererVersions.whiteboard,
        config: {},
        pngBase64: png.toString('base64'),
        requestId: randomUUID(),
      },
      { sourcePath: a.prepared.source!.relativePath, previewPath: a.prepared.preview.relativePath },
    ),
    markdown = renderPreparedDiagramDocument({ prepared, title: prepared.title, source }),
    b = {
      note: f.primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() }),
      markdown,
      prepared,
    };
  expect(a.prepared.source!.relativePath).toBe(b.prepared.source!.relativePath);
  const input = {
      selection: { kind: 'multiple' as const, noteIds: [a.note.id, b.note.id] },
      requestId: randomUUID(),
    },
    p = { ...webPrincipal, scopes: ['knowledge:read'] },
    error = await f.service.create(p, input).catch((e) => e),
    needs = error.details.portablePreviews;
  expect(needs).toHaveLength(2);
  expect(needs[0].previewId).not.toBe(needs[1].previewId);
  for (const need of needs)
    f.service.previews.prepare(p, {
      previewId: need.previewId,
      sourceHash: need.sourceHash,
      pngBase64: png.toString('base64'),
      requestId: 'shared-' + need.previewId,
    });
  const out = await f.service.create(p, input);
  expect(out.kind).toBe('archive');
  expect(
    await readFile(join(f.config.knowledgeRoot, a.prepared.source!.relativePath), 'utf8'),
  ).toBe(source);
  expect(f.notes.getNote(a.note.id).content).toBe(a.markdown);
  expect(f.notes.getNote(b.note.id).content).toBe(b.markdown);
});
it('authorizes native UUID targets before returning any private final-source plan', async () => {
  const f = await fixture(),
    child = f.create('private-native-target.md', '# Private'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [
        { id: 'private', type: 'rectangle', link: f.config.origin + '/?note=' + child.id },
      ],
    }),
    graph = f.diagram('whiteboard', source),
    p = {
      ...webPrincipal,
      scopes: ['knowledge:read'],
      knowledgeAll: false,
      allowedPrefixes: [graph.note.relativePath],
    };
  await expect(
    f.service.create(p, {
      selection: { kind: 'single', noteId: graph.note.id },
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.db.prepare('SELECT count(*) n FROM portable_native_previews').get()).toMatchObject({
    n: 0,
  });
  expect(f.db.prepare('SELECT count(*) n FROM portable_deliveries').get()).toMatchObject({ n: 0 });
});
it('applies the 256 MiB package bound to final files while counting superseded native snapshots only against staging', async () => {
  const f = await fixture(),
    child = f.create('large-native-child.md', '# Large target'),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      padding: 'x'.repeat(6 * 1024 ** 2),
      elements: [{ id: 'large', type: 'rectangle', link: f.config.origin + '/?note=' + child.id }],
    }),
    graph = f.diagram('whiteboard', source);
  const { open } = await import('node:fs/promises');
  for (const [name, total] of [
    ['large-a.wav', 128 * 1024 ** 2],
    ['large-b.wav', 118 * 1024 ** 2],
  ] as const) {
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(total - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(total - 44, 40);
    const file = await open(join(f.config.knowledgeRoot, '00-Inbox/assets', name), 'wx');
    try {
      await file.write(header);
      await file.truncate(total);
    } finally {
      await file.close();
    }
  }
  const parent = f.create(
    'large-native-parent.md',
    `[graph](whiteboard.md)\n[a](assets/large-a.wav)\n[b](assets/large-b.wav)\n`,
  );
  const input = {
      selection: { kind: 'single' as const, noteId: parent.id },
      requestId: randomUUID(),
    },
    error = await f.service.create(webPrincipal, input).catch((e) => e),
    need = error.details.portablePreviews[0];
  f.service.previews.prepare(webPrincipal, {
    previewId: need.previewId,
    sourceHash: need.sourceHash,
    pngBase64: png.toString('base64'),
    requestId: 'large-fixed',
  });
  expect(await f.service.create(webPrincipal, input)).toMatchObject({ kind: 'archive' });
}, 30000);
it('review: preserves passive native external API, mail and telephone navigation exactly across package roundtrip', async () => {
  const f = await fixture(),
    links = ['https://example.com/api/reference', 'mailto:alice@example.com', 'tel:+1234567890'],
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: links.map((link, index) => ({ id: 'external-' + index, type: 'rectangle', link })),
    }),
    graph = f.diagram('whiteboard', source),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: graph.note.id },
      requestId: randomUUID(),
    }),
    archive = join(f.root, 'external-native.tar.gz'),
    directory = join(f.root, 'external-native');
  await writeFile(archive, await deliveryBytes(f, out.id));
  await mkdir(directory);
  await extractArchive(archive, directory);
  expect(await readFile(join(directory, graph.prepared.source!.relativePath), 'utf8')).toBe(source);
  const target = await fixture(),
    result = await target.service.importArchive(webPrincipal, {
      archivePath: archive,
      folderPath: '00-Inbox/external',
      requestId: randomUUID(),
    });
  expect(result.notes).toHaveLength(1);
  expect(
    await target.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: result.notes[0].noteId },
      requestId: randomUUID(),
    }),
  ).toMatchObject({ kind: 'archive' });
});
it('review: keeps ordinary external API, mail and telephone links resource-free and unchanged in package roundtrip', async () => {
  const f = await fixture(),
    content =
      '[API docs](https://example.com/api/reference)\n[mail](mailto:alice@example.com)\n[call](tel:+1234567890)\n',
    note = f.create('external-nav.md', content);
  let calls = 0;
  const service = portableDeliveryService(f.config, f.db, f.notes, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (() => {
      calls++;
      throw Error('must not fetch navigation');
    }) as any,
  });
  const plain = await service.create(webPrincipal, {
    selection: { kind: 'single', noteId: note.id },
    requestId: randomUUID(),
  });
  expect(plain.kind).toBe('markdown');
  expect(await deliveryBytes(f, plain.id)).toEqual(Buffer.from(content));
  const out = await service.create(webPrincipal, {
      selection: { kind: 'multiple', noteIds: [note.id] },
      requestId: randomUUID(),
    }),
    row = f.db.prepare('SELECT artifact FROM portable_deliveries WHERE id=?').get(out.id) as {
      artifact: string;
    },
    target = await fixture(),
    result = await target.service.importArchive(webPrincipal, {
      archivePath: row.artifact,
      folderPath: '00-Inbox/external',
      requestId: randomUUID(),
    });
  expect(target.notes.getNote(result.notes[0].noteId).content).toBe(content);
  expect(result.assets).toBe(0);
  expect(calls).toBe(0);
});
it('review: two real incompressible 126 MiB WAVs roundtrip with the original 252 MiB archive retained under 512 MiB', async () => {
  const f = await fixture(),
    { open } = await import('node:fs/promises'),
    { randomFillSync } = await import('node:crypto'),
    total = 126 * 1024 ** 2,
    chunk = Buffer.alloc(65536);
  for (const name of ['max-a.wav', 'max-b.wav']) {
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(total - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(total - 44, 40);
    const file = await open(join(f.config.knowledgeRoot, '00-Inbox/assets', name), 'wx');
    try {
      await file.write(header);
      for (let at = 44; at < total; at += chunk.length)
        await file.write(randomFillSync(chunk.subarray(0, Math.min(chunk.length, total - at))));
    } finally {
      await file.close();
    }
  }
  const note = f.create('max-package.md', '[a](assets/max-a.wav)\n[b](assets/max-b.wav)\n'),
    out = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
    row = f.db.prepare('SELECT artifact FROM portable_deliveries WHERE id=?').get(out.id) as {
      artifact: string;
    };
  expect(out.sizeBytes).toBeGreaterThan(252 * 1024 ** 2);
  expect(out.sizeBytes).toBeLessThan(256 * 1024 ** 2);
  let peak = 0;
  const result = await f.service.importArchive(
    webPrincipal,
    { archivePath: row.artifact, folderPath: '00-Inbox/max-copy', requestId: randomUUID() },
    {
      check: () => {
        const stages = (
            f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any
          ).n,
          retained = (
            f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries').get() as any
          ).n;
        peak = Math.max(peak, stages + retained);
        return webPrincipal;
      },
    },
  );
  expect(result.assets).toBe(2);
  expect(result.notes).toHaveLength(1);
  expect(peak).toBeLessThanOrEqual(512 * 1024 ** 2);
  expect(f.service.validate(webPrincipal, out.id).sha256).toBe(out.sha256);
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({
    n: 0,
  });
  const { hashFile } = await import('../packages/core/portable-delivery/manifest');
  for (const name of ['max-a.wav', 'max-b.wav'])
    expect(
      await hashFile(join(f.config.knowledgeRoot, '00-Inbox/max-copy/00-Inbox/assets', name)),
    ).toBe(await hashFile(join(f.config.knowledgeRoot, '00-Inbox/assets', name)));
}, 60000);
it('review: revocation during streamed archive extraction reclaims private shards before any asset or main publication', async () => {
  const f = await fixture();
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/assets/cancel.png'), png);
  const note = f.create('cancel-extract.md', '![image](assets/cancel.png)\n'),
    delivery = await f.service.create(webPrincipal, {
      selection: { kind: 'single', noteId: note.id },
      requestId: randomUUID(),
    }),
    row = f.db.prepare('SELECT artifact FROM portable_deliveries WHERE id=?').get(delivery.id) as {
      artifact: string;
    };
  await expect(
    f.service.importArchive(
      webPrincipal,
      { archivePath: row.artifact, folderPath: '00-Inbox/cancel-extract', requestId: randomUUID() },
      {
        check: () => {
          const staged = (
            f.db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any
          ).n;
          if (staged > 0) return { ...webPrincipal, scopes: ['knowledge:read'] };
          return webPrincipal;
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM notes WHERE active=1 AND path LIKE '00-Inbox/cancel-extract/%'",
      )
      .get(),
  ).toMatchObject({ n: 0 });
  expect(
    f.db.prepare("SELECT count(*) n FROM assets WHERE path LIKE '00-Inbox/cancel-extract/%'").get(),
  ).toMatchObject({ n: 0 });
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({
    n: 0,
  });
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
    n: 0,
  });
  expect(
    await stat(join(f.config.knowledgeRoot, '00-Inbox/cancel-extract')).catch(() => undefined),
  ).toBeUndefined();
});
