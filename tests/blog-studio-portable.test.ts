import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { blogService } from '../packages/core/blog/service';
import { backup, restore } from '../apps/server/backup';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const p: Principal = {
  id: 'studio-owner',
  clientId: 'web',
  scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string,
  config: AppConfig,
  db: ReturnType<typeof openDatabase>,
  blog: ReturnType<typeof blogService>;
const opened: ReturnType<typeof openDatabase>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-studio-portable-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
  opened.push(db);
  blog = blogService(config, db, noteService(config, db));
});
afterEach(async () => {
  for (const d of opened.splice(0)) if (d.open) d.close();
  await rm(root, { recursive: true, force: true });
});
function customize() {
  const media = blog.uploadDesignMedia(p, {
    name: 'avatar.png',
    mime: 'image/png',
    base64: png.toString('base64'),
    requestId: randomUUID(),
  });
  const state = blog.designState(p);
  state.draft.profile.name = 'Portable identity';
  state.draft.profile.avatar = media.url;
  const saved = blog.saveDesign(p, {
    design: state.draft,
    expectedVersion: state.version,
    requestId: randomUUID(),
  });
  const published = blog.publishDesign(p, {
    expectedVersion: saved.version,
    requestId: randomUUID(),
  });
  return { media, published };
}
it('rebuilds saved and published designs, history and images from knowledge files on a fresh machine', async () => {
  const { media, published } = customize();
  const destination = {
    ...config,
    knowledgeRoot: join(root, 'other-knowledge'),
    dataRoot: join(root, 'other-data'),
  };
  await cp(config.knowledgeRoot, destination.knowledgeRoot, { recursive: true });
  const otherDb = openDatabase(destination.dataRoot);
  opened.push(otherDb);
  const other = blogService(destination, otherDb, noteService(destination, otherDb));
  expect(other.designState(p)).toEqual(published);
  expect(other.designMedia(p, media.hash).bytes.equals(png)).toBe(true);
  const legacy = JSON.parse(
    await readFile(join(config.knowledgeRoot, '_data/apps/blog/state.json'), 'utf8'),
  );
  expect(legacy.data.version).toBe(1);
  expect(legacy.data).not.toHaveProperty('studio');
  expect(
    await readFile(join(config.knowledgeRoot, '_data/apps/blog/design.json'), 'utf8'),
  ).toContain('Portable identity');
});
it('rejects tampered synchronized design media and preserves the last local projection', async () => {
  const { media, published } = customize();
  const path = join(config.knowledgeRoot, '_data/apps/blog/design-media', media.hash);
  await writeFile(path, Buffer.from('not-an-image'));
  const statePath = join(config.knowledgeRoot, '_data/apps/blog/design.json');
  const data = JSON.parse(await readFile(statePath, 'utf8'));
  data.data.state.version += 1;
  data.data.state.draft.profile.name = 'Tampered';
  await writeFile(statePath, JSON.stringify(data));
  expect(() => blog.designState(p)).toThrow();
  const row = db.prepare('SELECT draft_json FROM blog_design_state WHERE id=1').get() as {
    draft_json: string;
  };
  expect(JSON.parse(row.draft_json)).toEqual(published.draft);
});
it('keeps restored design and media but leaves all public access disabled', async () => {
  const { media } = customize();
  blog.updateSettings(p, {
    settings: { ...blog.settings(), enabled: true },
    requestId: randomUUID(),
  });
  const backupPath = join(root, 'backup');
  await backup(config, backupPath);
  const target = {
    ...config,
    knowledgeRoot: join(root, 'restored-knowledge'),
    dataRoot: join(root, 'restored-data'),
  };
  await restore(backupPath, target);
  const restoredDb = openDatabase(target.dataRoot);
  opened.push(restoredDb);
  const restored = blogService(target, restoredDb, noteService(target, restoredDb));
  expect(restored.settings().enabled).toBe(false);
  expect(restored.designState(p).published.profile.name).toBe('Portable identity');
  expect(restored.designMedia(p, media.hash).bytes.equals(png)).toBe(true);
  expect(() => restored.publicDesignMedia(media.hash)).toThrow();
});

it('rejects a stale publish confirmation after another device imports a different draft at the same counter', async () => {
  const baseline = blog.designState(p);
  const otherConfig = {
    ...config,
    knowledgeRoot: join(root, 'device-b-knowledge'),
    dataRoot: join(root, 'device-b-data'),
  };
  await cp(config.knowledgeRoot, otherConfig.knowledgeRoot, { recursive: true });
  const otherDb = openDatabase(otherConfig.dataRoot);
  opened.push(otherDb);
  const other = blogService(otherConfig, otherDb, noteService(otherConfig, otherDb));
  const local = blog.saveDesign(p, {
    design: { ...baseline.draft, profile: { ...baseline.draft.profile, name: 'Reviewed on A' } },
    expectedVersion: baseline.version,
    requestId: randomUUID(),
  });
  const remote = other.designState(p);
  other.saveDesign(p, {
    design: { ...remote.draft, profile: { ...remote.draft.profile, name: 'Unreviewed on B' } },
    expectedVersion: remote.version,
    requestId: randomUUID(),
  });
  await cp(
    join(otherConfig.knowledgeRoot, '_data/apps/blog/design.json'),
    join(config.knowledgeRoot, '_data/apps/blog/design.json'),
  );
  expect(() =>
    blog.publishDesign(p, { expectedVersion: local.version, requestId: randomUUID() }),
  ).toThrow();
  const current = blog.designState(p);
  expect(current.version).toBeGreaterThan(local.version);
  expect(current.draft.profile.name).toBe('Unreviewed on B');
  expect(current.publishedRevision).toBe(0);
});
