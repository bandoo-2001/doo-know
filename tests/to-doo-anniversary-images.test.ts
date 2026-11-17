import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import { createToDooAssets } from '../packages/core/to-doo/assets.js';
import { canonical } from '../packages/core/to-doo/store.js';
import { createToDooInterop, exportPortableJson } from '../packages/core/to-doo/interop.js';
import { registerToDooAssetRoutes } from '../apps/server/to-doo/asset-routes.js';
import { toDooAnniversaryImageSchema, toDooEntitySchemas } from '../shared/to-doo-contracts.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT0AAAAASUVORK5CYII=',
  'base64',
);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-anniversary-images-')),
    config = {
      knowledgeRoot: join(root, 'knowledge'),
      dataRoot: join(root, 'data'),
      origin: 'http://localhost:3010',
      secret: 'test-only-secret',
    };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot),
    service = createToDooService(config, db, noteService(config, db)),
    assets = createToDooAssets(service, { knowledgeRoot: config.knowledgeRoot, db });
  cleanups.push(async () => {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, db, service, assets };
}
function uploaded(f: Awaited<ReturnType<typeof fixture>>) {
  return f.assets.uploadAnniversaryImage({ name: '旅行照片.png', mime: 'image/png', bytes: png });
}
function save(f: Awaited<ReturnType<typeof fixture>>) {
  const image = { ...uploaded(f), x: 23, y: 71, zoom: 1.8 };
  const result = f.service.command({
    requestId: randomUUID(),
    action: 'save_entity',
    payload: {
      kind: 'anniversary',
      entity: {
        id: 'travel-anniversary',
        name: '第一次旅行',
        date: '2024-06-12',
        appearance: { style: 'photo', palette: 'ocean', image },
      },
    },
  });
  return result.snapshot.anniversaries[0];
}

describe('anniversary image assets', () => {
  it('stages immutable image bytes before saving and only puts the reference and crop in the entity', async () => {
    const f = await fixture(),
      before = f.service.getVersion!(),
      image = uploaded(f);
    expect(f.service.getVersion!()).toBe(before);
    expect(image).toEqual({
      hash: sha(png),
      name: '旅行照片.png',
      mime: 'image/png',
      size: png.length,
    });
    expect(uploaded(f)).toEqual(image);
    expect(f.assets.getAnniversaryImage(image.hash).bytes).toEqual(png);
    const anniversary = save(f);
    expect(anniversary.appearance?.image).toEqual({ ...image, x: 23, y: 71, zoom: 1.8 });
    expect(JSON.stringify(anniversary)).not.toContain(png.toString('base64'));
    expect(f.service.exportCheckpoint().assets).toContainEqual({
      hash: image.hash,
      data: png.toString('base64'),
    });
  });

  it('keeps old themes valid and rejects arbitrary URLs and invalid image or crop metadata', () => {
    const at = '2026-11-17T09:00:00.000Z';
    const original = {
      id: 'anniversary',
      revision: 'v1',
      createdAt: at,
      updatedAt: at,
      name: '纪念日',
      date: '2024-06-12',
    };
    for (const style of [
      'bloom',
      'landscape',
      'orbit',
      'minimal',
      'pixel',
      'postcard',
      'paper',
      'night',
      'photo',
    ])
      expect(
        toDooEntitySchemas.anniversary.safeParse({
          ...original,
          appearance: { style, palette: 'rose' },
        }).success,
      ).toBe(true);
    expect(toDooEntitySchemas.anniversary.safeParse(original).success).toBe(true);
    const image = { hash: sha(png), name: 'photo.png', mime: 'image/png', size: png.length };
    expect(toDooAnniversaryImageSchema.parse(image)).toEqual({ ...image, x: 50, y: 50, zoom: 1 });
    for (const invalid of [
      { ...image, hash: 'https://example.com/photo.png' },
      { ...image, name: '../photo.png' },
      { ...image, mime: 'image/svg+xml' },
      { ...image, size: 10 * 1024 * 1024 + 1 },
      { ...image, x: -1 },
      { ...image, y: 101 },
      { ...image, zoom: 0.9 },
      { ...image, zoom: 3.1 },
      { ...image, x: Number.NaN },
      { ...image, y: Infinity },
      { ...image, url: 'data:image/png;base64,anything' },
    ])
      expect(toDooAnniversaryImageSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects unsafe uploads and invalid references, and detects corrupted or missing bytes', async () => {
    const f = await fixture();
    for (const invalid of [
      { name: 'icon.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg/>') },
      { name: 'fake.png', mime: 'image/png', bytes: Buffer.from('<svg/>') },
      { name: '../photo.png', mime: 'image/png', bytes: png },
      { name: 'photo.png', mime: 'image/jpeg', bytes: png },
      { name: 'photo.gif', mime: 'image/gif', bytes: Buffer.from('GIF89a') },
      { name: 'photo.png', mime: 'image/png', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) },
    ])
      expect(() => f.assets.uploadAnniversaryImage(invalid)).toThrow();
    const image = uploaded(f);
    const command = (patch: Record<string, unknown>) =>
      f.service.command({
        requestId: randomUUID(),
        action: 'save_entity',
        payload: {
          kind: 'anniversary',
          entity: {
            name: '无效图片',
            date: '2024-06-12',
            appearance: { style: 'photo', palette: 'ocean', image: { ...image, ...patch } },
          },
        },
      });
    expect(() => command({ hash: 'a'.repeat(64) })).toThrow(/图片.*上传|同步/);
    expect(() => command({ size: png.length + 1 })).toThrow(/校验/);
    expect(() => command({ name: 'photo.jpg', mime: 'image/jpeg' })).toThrow(/内容|类型/);
    const path = join(f.config.knowledgeRoot, '_doo-data/apps/to-doo/assets', image.hash);
    await writeFile(path, 'corrupt');
    expect(() => f.assets.getAnniversaryImage(image.hash)).toThrow(/损坏|校验/);
    await unlink(path);
    expect(() => f.assets.getAnniversaryImage(image.hash)).toThrow(/同步|缺失/);
    expect(f.service.snapshot({ all: true }).anniversaries).toEqual([]);
  });

  it('restores image bytes and crop coordinates through checkpoints, portable subsets and copies', async () => {
    const source = await fixture(),
      restored = await fixture(),
      copied = await fixture();
    const anniversary = save(source),
      checkpoint = source.service.exportCheckpoint();
    restored.service.importCheckpoint(checkpoint, 'restore-anniversary');
    expect(restored.service.snapshot({ all: true }).anniversaries[0].appearance).toEqual(
      anniversary.appearance,
    );
    expect(restored.assets.getAnniversaryImage(sha(png)).bytes).toEqual(png);
    const importer = createToDooInterop(copied.service, {
      db: copied.db,
      dataRoot: copied.config.dataRoot,
      importBatchSize: 1,
    });
    cleanups.unshift(async () => {
      importer.close();
    });
    const portable = exportPortableJson(source.service.snapshot({ all: true }), {
      assets: checkpoint.assets.map((asset) => ({ sha256: asset.hash, content: asset.data })),
    });
    const immediate = createToDooInterop(restored.service, {
      db: restored.db,
      dataRoot: restored.config.dataRoot,
    });
    cleanups.unshift(async () => {
      immediate.close();
    });
    const immediatePreview = immediate.previewImport({
      format: 'json',
      content: portable,
      mergeMode: 'copy',
    });
    immediate.applyImport({
      previewId: immediatePreview.id,
      requestId: 'copy-portable-synchronously',
    });
    expect(immediate.importStatus(immediatePreview.id).status).toBe('completed');
    expect(restored.service.snapshot({ all: true }).anniversaries).toHaveLength(2);
    const preview = importer.previewImport({
      format: 'json',
      content: portable,
      mergeMode: 'copy',
    });
    importer.applyImport({ previewId: preview.id, requestId: 'copy-anniversary' });
    await importer.processImportJobs();
    expect(importer.importStatus(preview.id).status).toBe('completed');
    const copy = copied.service.snapshot({ all: true }).anniversaries[0];
    expect(copy.id).not.toBe(anniversary.id);
    expect(copy.appearance).toEqual(anniversary.appearance);
    expect(copied.assets.getAnniversaryImage(sha(png)).bytes).toEqual(png);
    const fullCopy = importer.previewImport({
      format: 'json',
      content: JSON.stringify(checkpoint),
      mergeMode: 'copy',
    });
    importer.applyImport({ previewId: fullCopy.id, requestId: 'copy-full-anniversary' });
    await importer.processImportJobs();
    expect(importer.importStatus(fullCopy.id).status).toBe('completed');
    expect(copied.service.snapshot({ all: true }).anniversaries).toHaveLength(2);
    expect(
      copied.service
        .snapshot({ all: true })
        .anniversaries.every((item) => item.appearance?.image?.hash === sha(png)),
    ).toBe(true);
  });

  it('validates restored image references and allows a missing blob to arrive after its entity', async () => {
    const source = await fixture(),
      target = await fixture(),
      anniversary = save(source),
      checkpoint = source.service.exportCheckpoint();
    const image = anniversary.appearance!.image!;
    const malformed = structuredClone(checkpoint);
    const entry = malformed.entities.find((item) => item.kind === 'anniversary')!;
    (entry.entity as typeof anniversary).appearance!.image!.size++;
    // Keep the envelope authentic so this exercises reference validation, not inventory hashing.
    const { digest: _digest, ...payload } = malformed;
    malformed.digest = sha(Buffer.from(canonical(payload)));
    expect(() => target.service.importCheckpoint(malformed, 'bad-image-reference')).toThrow(/校验/);
    expect(target.service.snapshot({ all: true }).anniversaries).toEqual([]);

    const { digest: _oldDigest, ...withoutImage } = { ...checkpoint, assets: [] };
    target.service.importCheckpoint(
      { ...withoutImage, digest: sha(Buffer.from(canonical(withoutImage))) },
      'entity-before-image',
    );
    expect(target.service.snapshot({ all: true }).anniversaries[0].appearance?.image).toEqual(
      image,
    );
    expect(() => target.assets.getAnniversaryImage(image.hash)).toThrow(/同步|缺失/);
    uploaded(target);
    expect(target.assets.getAnniversaryImage(image.hash).bytes).toEqual(png);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>');
    await writeFile(
      join(target.config.knowledgeRoot, '_doo-data/apps/to-doo/assets', sha(svg)),
      svg,
    );
    expect(() => target.assets.getAnniversaryImage(sha(svg))).toThrow(/仅支持/);
  });

  it('requires private owner access for upload/read and serves image bytes with inert, uncached headers', async () => {
    const f = await fixture(),
      app = Fastify();
    await app.register(multipart);
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers.authorization !== 'Bearer owner')
        return reply.code(401).send({ error: 'login required' });
    });
    registerToDooAssetRoutes(app, () => f.assets);
    cleanups.unshift(async () => {
      await app.close();
    });
    const boundary = 'anniversary-fixture',
      payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const url = '/api/to-doo/anniversary-images',
      headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
    const uploaded = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, authorization: 'Bearer owner' },
      payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json()).toEqual({
      hash: sha(png),
      name: 'photo.png',
      mime: 'image/png',
      size: png.length,
    });
    const imageUrl = url + '/' + sha(png);
    expect((await app.inject({ url: imageUrl })).statusCode).toBe(401);
    const image = await app.inject({ url: imageUrl, headers: { authorization: 'Bearer owner' } });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.headers['content-disposition']).toContain('inline');
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.rawPayload).toEqual(png);
  });
});
