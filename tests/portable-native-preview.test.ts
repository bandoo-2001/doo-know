import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { webPrincipal } from '../packages/core/knowledge/core';
import { sha256 } from '../packages/core/knowledge/operations';
import { portablePreviewRegistry } from '../packages/core/portable-delivery/previews';
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'portable-preview-'));
  const config = {
    dataRoot: join(root, 'data'),
    knowledgeRoot: join(root, 'knowledge'),
    origin: 'http://localhost',
    secret: 'test',
  };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const p = { ...webPrincipal, scopes: ['knowledge:read'] as any };
  return { config, db, p, registry: portablePreviewRegistry(config, db) };
}
it('retains a principal-bound read-only fixed source and PNG under shared staging quota across registry reopen', () => {
  const f = setup(),
    source = '{"type":"excalidraw","elements":[]}';
  const input = {
    direction: 'export' as const,
    requestId: randomUUID(),
    contextHash: sha256('selection'),
    document: '00-Inbox/board.md',
    role: 'primary' as const,
    source,
    type: 'whiteboard' as const,
    title: 'board',
    renderer: 'excalidraw@0.18.1',
    config: {},
    permissions: ['00-Inbox/board.md'],
    proofs: [],
  };
  const need = f.registry.fix(f.p, input);
  expect(f.registry.get(f.p, need.previewId).source).toBe(source);
  expect(() => f.registry.get({ ...f.p, clientId: 'other' }, need.previewId)).toThrow();
  expect(() =>
    f.registry.prepare(f.p, {
      previewId: need.previewId,
      sourceHash: sha256('other'),
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    }),
  ).toThrow();
  f.registry.prepare(f.p, {
    previewId: need.previewId,
    sourceHash: sha256(source),
    pngBase64: png.toString('base64'),
    requestId: 'render',
  });
  const reopened = portablePreviewRegistry(f.config, f.db),
    same = reopened.fix(f.p, input);
  expect(same.previewId).toBe(need.previewId);
  expect(reopened.prepared(f.p, same.previewId)?.previewHash).toBe(sha256(png));
  expect((f.db.prepare('SELECT sum(bytes) n FROM portable_staging_runs').get() as any).n).toBe(
    Buffer.byteLength(source) + png.length,
  );
  expect(f.db.prepare('SELECT count(*) n FROM notes').get()).toMatchObject({ n: 0 });
});
it('rejects changed export dependency bytes, revoked access, expiry and cancelled source explicitly', () => {
  const f = setup(),
    file = join(f.config.knowledgeRoot, 'board.md');
  writeFileSync(file, 'before');
  const need = f.registry.fix(f.p, {
    direction: 'export',
    requestId: 'fixed',
    contextHash: sha256('fixed'),
    document: 'board.md',
    role: 'primary',
    source: '{}',
    type: 'whiteboard',
    title: 'board',
    renderer: 'excalidraw@0.18.1',
    config: {},
    permissions: ['board.md'],
    proofs: [{ path: 'board.md', hash: sha256('before') }],
  });
  writeFileSync(file, 'after');
  expect(() => f.registry.get(f.p, need.previewId)).toThrowError(
    expect.objectContaining({ code: 'PORTABLE_VERSION_CONFLICT' }),
  );
  writeFileSync(file, 'before');
  expect(() =>
    f.registry.get({ ...f.p, knowledgeAll: false, allowedPrefixes: ['other'] }, need.previewId),
  ).toThrow();
  f.db.prepare('UPDATE portable_native_previews SET expires=0 WHERE id=?').run(need.previewId);
  expect(() => f.registry.get(f.p, need.previewId)).toThrowError(
    expect.objectContaining({ code: 'PORTABLE_PREVIEW_EXPIRED' }),
  );
});
it('persists structured portable preview needs on an unfinished owner job', async () => {
  const f = setup(),
    { portableOwnerJobs } = await import('../apps/server/knowledge/portable-owner-jobs');
  const jobs = portableOwnerJobs(f.db),
    need = {
      previewId: randomUUID(),
      document: 'board.md',
      role: 'primary',
      sourceHash: sha256('{}'),
      renderHash: sha256('render'),
      type: 'whiteboard',
      title: 'board',
      renderer: 'excalidraw@0.18.1',
      config: {},
      expiresAt: Date.now() + 1000,
      direction: 'export',
      sourceBytes: 2,
    };
  await expect(
    jobs.run(
      'owner',
      'same',
      'export',
      { selection: { kind: 'single', noteId: 'board' } },
      async () => {
        throw Object.assign(Error('preview'), {
          code: 'DIAGRAM_PREVIEW_REQUIRED',
          details: { portablePreviews: [need] },
        });
      },
    ),
  ).rejects.toThrow();
  expect(portableOwnerJobs(f.db).list('owner')[0]).toMatchObject({
    state: 'failed',
    portablePreviews: [need],
  });
});
it('recovers one matching durable PNG after interruption before its preparation receipt is complete', () => {
  const f = setup(),
    source = '{}',
    need = f.registry.fix(f.p, {
      direction: 'export',
      requestId: 'crash',
      contextHash: sha256('crash'),
      document: 'board.md',
      role: 'primary',
      source,
      type: 'whiteboard',
      title: 'board',
      renderer: 'excalidraw@0.18.1',
      config: {},
      permissions: ['board.md'],
      proofs: [],
    }),
    row = f.db
      .prepare('SELECT stage FROM portable_native_previews WHERE id=?')
      .get(need.previewId) as { stage: string };
  writeFileSync(join(f.config.dataRoot, 'portable-staging', row.stage, 'preview.png'), png, {
    mode: 0o600,
  });
  expect(() =>
    f.registry.prepare(f.p, {
      previewId: need.previewId,
      sourceHash: sha256(source),
      pngBase64: png.toString('base64'),
      requestId: 'recover',
    }),
  ).not.toThrow();
  expect(f.registry.prepared(f.p, need.previewId)?.previewHash).toBe(sha256(png));
});
it('uses bounded source pages with explicit EOF and rejects a changed private source even after a verified page', () => {
  const f = setup(),
    source = ' '.repeat(40000) + '{}',
    need = f.registry.fix(f.p, {
      direction: 'export',
      requestId: 'pages',
      contextHash: sha256('pages'),
      document: 'board.md',
      role: 'primary',
      source,
      type: 'whiteboard',
      title: 'board',
      renderer: 'excalidraw@0.18.1',
      config: {},
      permissions: ['board.md'],
      proofs: [],
    });
  const first = f.registry.readSource(f.p, need.previewId, { offset: 0, maxBytes: 16384 });
  expect(Buffer.from(first.content, 'base64').length).toBe(16384);
  expect(first.eof).toBe(false);
  const end = f.registry.readSource(f.p, need.previewId, {
    offset: Buffer.byteLength(source),
    maxBytes: 16384,
  });
  expect(end).toMatchObject({ content: '', eof: true, nextOffset: Buffer.byteLength(source) });
  const row = f.db
    .prepare('SELECT stage FROM portable_native_previews WHERE id=?')
    .get(need.previewId) as { stage: string };
  writeFileSync(
    join(f.config.dataRoot, 'portable-staging', row.stage, 'source.excalidraw'),
    'changed',
  );
  expect(() => f.registry.readSource(f.p, need.previewId, { offset: 0 })).toThrowError(
    expect.objectContaining({ code: 'PORTABLE_VERSION_CONFLICT' }),
  );
});
it('rejects own-origin native API links as unavailable package dependencies while preserving external hyperlinks', async () => {
  const { checkNativeLinks } = await import('../packages/core/portable-delivery/paths');
  const source = (link: string) => JSON.stringify({ elements: [{ link }] });
  expect(() =>
    checkNativeLinks(
      source('https://own.invalid/api/assets/id'),
      '_doo-assets/source.excalidraw',
      'https://own.invalid',
    ),
  ).toThrowError(expect.objectContaining({ code: 'PORTABLE_DEPENDENCY_UNAVAILABLE' }));
  expect(() =>
    checkNativeLinks(
      source('https://external.invalid/api/docs'),
      '_doo-assets/source.excalidraw',
      'https://own.invalid',
    ),
  ).not.toThrow();
});
it('binds an incoming import source to current write prefixes without activating or looking up a note identity', () => {
  const f = setup(),
    input = {
      direction: 'import' as const,
      requestId: 'incoming',
      contextHash: sha256('manifest-and-target'),
      document: '00-Inbox/import/scene.md',
      role: 'primary' as const,
      source: '{}',
      type: 'whiteboard' as const,
      title: 'incoming',
      renderer: 'excalidraw@0.18.1',
      config: {},
      permissions: ['00-Inbox/import/scene.md'],
      proofs: [],
    };
  expect(() => f.registry.fix(f.p, input)).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN' }),
  );
  const writer = {
      ...f.p,
      scopes: ['knowledge:read', 'knowledge:write'],
      knowledgeAll: false,
      allowedPrefixes: ['00-Inbox/import'],
    },
    need = f.registry.fix(writer, input);
  expect(f.registry.get(writer, need.previewId).source).toBe('{}');
  expect(() => f.registry.get(f.p, need.previewId)).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN' }),
  );
  expect(() =>
    f.registry.get({ ...writer, allowedPrefixes: ['other'] }, need.previewId),
  ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  expect(f.db.prepare('SELECT count(*) n FROM notes').get()).toMatchObject({ n: 0 });
  f.db.prepare('UPDATE portable_native_previews SET expires=0 WHERE id=?').run(need.previewId);
  expect(f.registry.cancel({ ...writer, allowedPrefixes: [] }, need.previewId)).toEqual({
    cancelled: true,
  });
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({
    n: 0,
  });
});
it('review: reclaims an owned input shard after its target parent moved during upload', async () => {
  const f = setup(),
    { portableStaging } = await import('../packages/core/portable-delivery/staging'),
    { portableInputSnapshot } = await import('../packages/core/portable-delivery/input-snapshot'),
    { noteService } = await import('../packages/core/notes'),
    { rename } = await import('node:fs/promises'),
    p = { ...f.p, scopes: ['knowledge:read', 'knowledge:write'] },
    stage = await portableStaging(f.config, f.db),
    snapshot = portableInputSnapshot(
      f.config,
      f.db,
      noteService(f.config, f.db),
      p,
      'target',
      stage,
    ),
    file = await snapshot.allocate('notes/a.md');
  writeFileSync(file, '# A');
  stage.resize(3);
  await rename(join(f.config.knowledgeRoot, 'target'), join(f.config.knowledgeRoot, 'moved'));
  await expect(stage.release()).resolves.toBeUndefined();
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({
    n: 0,
  });
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
    n: 0,
  });
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(join(f.config.knowledgeRoot, 'moved/notes'))).toEqual([]);
});
it('review: real permission-denied input allocation leaves no locator that can poison later staging', async () => {
  const f = setup(),
    { portableStaging } = await import('../packages/core/portable-delivery/staging'),
    { portableInputSnapshot } = await import('../packages/core/portable-delivery/input-snapshot'),
    { noteService } = await import('../packages/core/notes'),
    { mkdir, chmod } = await import('node:fs/promises'),
    target = join(f.config.knowledgeRoot, 'target');
  await mkdir(target);
  const stage = await portableStaging(f.config, f.db),
    snapshot = portableInputSnapshot(
      f.config,
      f.db,
      noteService(f.config, f.db),
      { ...f.p, scopes: ['knowledge:read', 'knowledge:write'] },
      'target',
      stage,
    );
  await chmod(target, 0o500);
  try {
    await expect(snapshot.allocate('note.md')).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    await chmod(target, 0o700);
  }
  await expect(stage.release()).resolves.toBeUndefined();
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
    n: 0,
  });
  const next = await portableStaging(f.config, f.db);
  await next.release();
});
it.each([false, true])(
  'review: expiry reclaims a planned allocation after a crash before confirmation (directory exists: %s)',
  async (created) => {
    const f = setup(),
      { portableStaging } = await import('../packages/core/portable-delivery/staging'),
      { mkdir } = await import('node:fs/promises'),
      stage = await portableStaging(f.config, f.db),
      location = join(f.config.knowledgeRoot, '.portable-' + stage.id + '-planned');
    stage.addLocation(location);
    if (created) await mkdir(join(location, 'assets'), { recursive: true, mode: 0o700 });
    f.db.prepare('UPDATE portable_staging_runs SET expires=0 WHERE id=?').run(stage.id);
    const next = await portableStaging(f.config, f.db);
    expect(f.db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
      n: 0,
    });
    expect(
      await import('node:fs/promises').then((fs) => fs.stat(location)).catch(() => undefined),
    ).toBeUndefined();
    await next.release();
    expect(f.db.prepare('SELECT count(*) n FROM portable_staging_runs').get()).toMatchObject({
      n: 0,
    });
  },
);
it('review: a confirmed created shard moved outside the knowledge root retains its unknown bytes and locator', async () => {
  const f = setup(),
    { portableStaging } = await import('../packages/core/portable-delivery/staging'),
    { portableInputSnapshot } = await import('../packages/core/portable-delivery/input-snapshot'),
    { noteService } = await import('../packages/core/notes'),
    { rename } = await import('node:fs/promises'),
    stage = await portableStaging(f.config, f.db),
    snapshot = portableInputSnapshot(
      f.config,
      f.db,
      noteService(f.config, f.db),
      { ...f.p, scopes: ['knowledge:read', 'knowledge:write'] },
      'target',
      stage,
    ),
    file = await snapshot.allocate('note.md');
  writeFileSync(file, 'data');
  stage.resize(4);
  await rename(join(f.config.knowledgeRoot, 'target'), join(f.config.dataRoot, 'moved-outside'));
  await expect(stage.release()).rejects.toMatchObject({ code: 'PORTABLE_STAGING_CONFLICT' });
  expect(
    f.db.prepare('SELECT bytes FROM portable_staging_runs WHERE id=?').get(stage.id),
  ).toMatchObject({ bytes: 4 });
  expect(f.db.prepare('SELECT count(*) n FROM portable_staging_locations').get()).toMatchObject({
    n: 1,
  });
  f.db.prepare('UPDATE portable_staging_runs SET expires=0 WHERE id=?').run(stage.id);
  await expect(portableStaging(f.config, f.db)).rejects.toMatchObject({
    code: 'PORTABLE_STAGING_CONFLICT',
  });
});
it('review: migration keeps unknown historical locators fail-closed instead of treating them as uncreated', async () => {
  const f = setup(),
    { portableStaging } = await import('../packages/core/portable-delivery/staging'),
    id = randomUUID(),
    location = join(f.config.knowledgeRoot, '.portable-' + id + '-legacy');
  f.db.exec(
    'CREATE TABLE portable_staging_locations(run_id TEXT NOT NULL,directory TEXT NOT NULL,PRIMARY KEY(run_id,directory))',
  );
  f.db.prepare('INSERT INTO portable_staging_runs VALUES(?,?,?)').run(id, 4, 0);
  f.db.prepare('INSERT INTO portable_staging_locations VALUES(?,?)').run(id, location);
  await expect(portableStaging(f.config, f.db)).rejects.toMatchObject({
    code: 'PORTABLE_STAGING_CONFLICT',
  });
  expect(
    f.db.prepare('SELECT created FROM portable_staging_locations WHERE run_id=?').get(id),
  ).toMatchObject({ created: 1 });
  expect(f.db.prepare('SELECT bytes FROM portable_staging_runs WHERE id=?').get(id)).toMatchObject({
    bytes: 4,
  });
});
