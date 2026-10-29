import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { reconcileService } from '../packages/core/indexing/reconcile.js';
import { managementStorage } from '../apps/server/platform/management-storage.js';
import { startWatcher } from '../packages/core/indexing/watcher.js';
import { portableLibrary } from '../packages/core/portable-library.js';
import { collectionService } from '../packages/core/collections/service.js';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { randomUUID } from 'node:crypto';
import { initializeWorkspaceGate } from '../packages/core/workspace/gate.js';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { shareService } from '../packages/core/shares.js';
import type { AppConfig, TreeEntry } from '../shared/contracts.js';

const flatten = (entries: TreeEntry[]): TreeEntry[] =>
  entries.flatMap((entry) => [entry, ...flatten(entry.children || [])]);

it('retains note IDs and favorites when a knowledge directory is copied to a new machine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-library-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    const notes = noteService(config, first);
    const created = notes.createNote('00-Inbox', 'favorite.md', '# Portable favorite');
    notes.setFavorite('owner', created.id, true);
    await cp(config.knowledgeRoot, join(root, 'another-path'), { recursive: true });
    const moved = { ...config, knowledgeRoot: join(root, 'another-path'), dataRoot: join(root, 'fresh-data') };
    second = openDatabase(moved.dataRoot);
    const copied = noteService(moved, second);
    expect(flatten(copied.tree('owner')).find((entry) => entry.type === 'note')).toMatchObject({
      id: created.id, path: '00-Inbox/favorite.md', favorite: true,
    });
    const portable = await readFile(join(config.knowledgeRoot, '_data/library/state.json'), 'utf8');
    expect(portable).not.toContain(root);
    expect(portable).not.toContain(config.secret);
  } finally {
    second?.close(); first.close(); await rm(root, { recursive: true, force: true });
  }
});

it('uses portable IDs when indexing discovers notes before the note tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-index-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    const original = noteService(config, first).createNote('00-Inbox', 'source.md', '# Source');
    const copiedRoot = join(root, 'copied');
    await cp(config.knowledgeRoot, copiedRoot, { recursive: true });
    const fresh = { ...config, knowledgeRoot: copiedRoot, dataRoot: join(root, 'fresh') };
    second = openDatabase(fresh.dataRoot);
    await reconcileService(fresh, second).reconcile();
    expect(second.prepare('SELECT id,path FROM notes WHERE active=1').get()).toEqual({
      id: original.id, path: '00-Inbox/source.md',
    });
  } finally {
    second?.close(); first.close(); await rm(root, { recursive: true, force: true });
  }
});

it('does not count application records as knowledge notes or attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-storage-'));
  try {
    await mkdir(join(root, '_data/app'), { recursive: true });
    await mkdir(join(root, '00-Inbox/_data'), { recursive: true });
    await writeFile(join(root, '00-Inbox/visible.md'), 'hello');
    await writeFile(join(root, '00-Inbox/_data/ordinary.md'), 'yes');
    await writeFile(join(root, '00-Inbox/_data/ordinary.txt'), 'text');
    await writeFile(join(root, '_data/app/private.md'), 'private application record');
    await writeFile(join(root, '_data/app/state.json'), '{"application":true}');
    const usage = await managementStorage({ dataRoot: join(root, 'runtime') } as any, root);
    expect(usage.categories.notes).toMatchObject({ count: 2, bytes: 8 });
    expect(usage.categories.assets).toMatchObject({ count: 1, bytes: 4 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('restores username-owned favorites after the local owner is initialized with a new ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-owner-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    first.exec("CREATE TABLE user(id TEXT PRIMARY KEY,username TEXT UNIQUE); INSERT INTO user VALUES('old-machine-owner-id','alice')");
    const notes = noteService(config, first);
    const original = notes.createNote('00-Inbox', 'owned.md', '# Owned');
    notes.setFavorite('old-machine-owner-id', original.id, true);
    portableLibrary(config, first).flush();
    const portable = readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString();
    expect(portable).toContain('alice');
    expect(portable).not.toContain('old-machine-owner-id');
    const fresh = { ...config, knowledgeRoot: join(root, 'copied'), dataRoot: join(root, 'fresh') };
    await cp(config.knowledgeRoot, fresh.knowledgeRoot, { recursive: true });
    second = openDatabase(fresh.dataRoot);
    second.exec('CREATE TABLE user(id TEXT PRIMARY KEY,username TEXT UNIQUE)');
    const imported = noteService(fresh, second);
    // Import precedes owner creation on a new installation.
    expect(second.prepare('SELECT count(*) n FROM note_favorites').get()).toEqual({ n: 0 });
    second.prepare('INSERT INTO user VALUES(?,?)').run('new-machine-owner-id', 'alice');
    expect(flatten(imported.tree('new-machine-owner-id')).find((entry) => entry.id === original.id)?.favorite).toBe(true);
    expect(second.prepare('SELECT owner_id FROM note_favorites').get()).toEqual({ owner_id: 'new-machine-owner-id' });
  } finally {
    second?.close(); first.close(); await rm(root, { recursive: true, force: true });
  }
});

it('keeps favorites and note identities after a rename and a new database projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-move-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    const notes = noteService(config, first);
    const original = notes.createNote('00-Inbox', 'before.md', '# Original');
    notes.setFavorite('owner', original.id, true);
    mutationCore(config, first).move(webPrincipal, original.id, '00-Inbox', 'after.md', original.modifiedAt, 'portable-rename');
    portableLibrary(config, first).flush();
    const fresh = { ...config, knowledgeRoot: join(root, 'copied'), dataRoot: join(root, 'fresh') };
    await cp(config.knowledgeRoot, fresh.knowledgeRoot, { recursive: true });
    second = openDatabase(fresh.dataRoot);
    const copied = noteService(fresh, second);
    expect(flatten(copied.tree('owner')).find((entry) => entry.id === original.id)).toMatchObject({
      id: original.id, path: '00-Inbox/after.md', favorite: true,
    });
  } finally {
    second?.close(); first.close(); await rm(root, { recursive: true, force: true });
  }
});

it('adopts remote unfavorites before reads and does not restore omitted registry records on later writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-remote-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db);
    const kept = notes.createNote('00-Inbox', 'kept.md', '# Kept');
    const removed = notes.createNote('00-Inbox', 'removed.md', '# Removed');
    notes.setFavorite('owner', kept.id, true);
    portableLibrary(config, db).flush();
    const remote = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
    remote.revision = randomUUID();
    remote.data.favorites = [];
    remote.data.notes = remote.data.notes.filter((note: { id: string }) => note.id !== removed.id);
    await rm(join(config.knowledgeRoot, removed.relativePath));
    writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify(remote));
    expect(flatten(notes.tree('owner')).find((entry) => entry.id === kept.id)?.favorite).toBe(false);
    notes.createNote('00-Inbox', 'later.md', '# Later local write');
    portableLibrary(config, db).flush();
    const after = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
    expect(after.data.notes.some((note: { id: string }) => note.id === removed.id)).toBe(false);
    expect(after.data.favorites).toEqual([]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('imports identities before collection discovery and keeps application records outside collections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-collection-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  let collections: ReturnType<typeof collectionService> | undefined;
  try {
    const notes = noteService(config, first);
    const original = notes.createNote('00-Inbox', 'collected.md', '# Collected');
    notes.setFavorite('owner', original.id, true);
    portableLibrary(config, first).flush();
    await writeFile(join(config.knowledgeRoot, '_data/private.md'), '# Private record');
    const fresh = { ...config, knowledgeRoot: join(root, 'copied'), dataRoot: join(root, 'fresh') };
    await cp(config.knowledgeRoot, fresh.knowledgeRoot, { recursive: true });
    second = openDatabase(fresh.dataRoot);
    // Construct collection monitoring directly, before any note-tree read.
    initializeWorkspaceGate(second);
    collections = collectionService(fresh, second, noteService(fresh, second));
    const page = await collections.page('owner', { kind: 'favorites' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: original.id, path: '00-Inbox/collected.md', favorite: true });
  } finally {
    await collections?.close(); second?.close(); first.close(); await rm(root, { recursive: true, force: true });
  }
});

it('exposes synced favorites through the authenticated API with a newly created owner account', async () => {
  const first = await createFixture();
  let second: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const headers = await loginFixtureOwner(first);
    const created = await first.app.inject({
      method: 'POST', url: '/api/notes', headers,
      payload: { folderPath: '00-Inbox', fileName: 'api-favorite.md', content: '# Favorite through API' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const original = created.json();
    const starred = await first.app.inject({
      method: 'PUT', url: `/api/notes/${original.id}/favorite`, headers, payload: { favorite: true },
    });
    expect(starred.statusCode, starred.body).toBe(200);
    const copied = join(first.root, 'new-machine-library');
    await cp(first.knowledgeRoot, copied, { recursive: true });
    second = await createFixture({ knowledgeRoot: copied });
    const secondHeaders = await loginFixtureOwner(second);
    const response = await second.app.inject({ url: '/api/tree', headers: secondHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(flatten(response.json()).find((entry) => entry.id === original.id)).toMatchObject({ favorite: true });
    const favorites = await second.app.inject({ url: '/api/collections?kind=favorites', headers: secondHeaders });
    expect(favorites.statusCode, favorites.body).toBe(200);
    expect(favorites.json().items.map((item: { id: string }) => item.id)).toEqual([original.id]);
  } finally { await second?.close(); await first.close(); }
});

it('rejects invalid synchronized registry paths without changing local identities or replacing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-invalid-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db);
    const original = notes.createNote('00-Inbox', 'safe.md', '# Safe');
    const invalid = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
    invalid.revision = randomUUID();
    invalid.data.notes[0].path = '_data/private.md';
    const invalidBytes = JSON.stringify(invalid);
    writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', invalidBytes);
    expect(() => notes.tree()).toThrow();
    expect(db.prepare('SELECT id,path,active FROM notes').get()).toEqual({ id: original.id, path: original.relativePath, active: 1 });
    expect(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString()).toBe(invalidBytes);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('checks the bound source identity before migrating data into another knowledge directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-root-boundary-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  const original = noteService(config, first).createNote('00-Inbox', 'bound.md', '# Bound');
  first.close();
  const wrongRoot = join(root, 'unrelated-library');
  await mkdir(join(wrongRoot, '00-Inbox'), { recursive: true });
  const second = openDatabase(config.dataRoot);
  try {
    expect(() => noteService({ ...config, knowledgeRoot: wrongRoot }, second)).toThrow();
    expect(second.prepare('SELECT id,path FROM notes WHERE active=1').get()).toEqual({ id: original.id, path: original.relativePath });
    expect(readKnowledgeDataFile(wrongRoot, 'library/state.json')).toBeUndefined();
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});

it('gives an existing synchronized registry priority over unrelated local note projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-initial-import-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const first = openDatabase(config.dataRoot);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    const original = noteService(config, first).createNote('00-Inbox', 'same-path.md', '# Source');
    const fresh = { ...config, knowledgeRoot: join(root, 'copied'), dataRoot: join(root, 'fresh') };
    await cp(config.knowledgeRoot, fresh.knowledgeRoot, { recursive: true });
    const synchronized = readKnowledgeDataFile(fresh.knowledgeRoot, 'library/state.json')!;
    second = openDatabase(fresh.dataRoot);
    second.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('stale-local-id', original.relativePath);
    second.prepare('INSERT INTO note_favorites VALUES(?,?)').run('owner', 'stale-local-id');
    const imported = noteService(fresh, second);
    expect(flatten(imported.tree('owner')).find((entry) => entry.type === 'note')).toMatchObject({ id: original.id, favorite: false });
    expect(readKnowledgeDataFile(fresh.knowledgeRoot, 'library/state.json')).toEqual(synchronized);
    expect(second.prepare('SELECT active FROM notes WHERE id=?').get('stale-local-id')).toEqual({ active: 0 });
  } finally { second?.close(); first.close(); await rm(root, { recursive: true, force: true }); }
});

it('ignores application-data writes while still indexing ordinary source-file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-watcher-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: true },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot);
  const indexing = reconcileService(config, db);
  const stop = startWatcher(config, db, indexing);
  try {
    await writeFile(join(config.knowledgeRoot, '_data/library/unrelated.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(db.prepare("SELECT value FROM index_meta WHERE key='root'").get()).toBeUndefined();
    await writeFile(join(config.knowledgeRoot, '00-Inbox/watched.md'), '# Watched');
    const deadline = Date.now() + 4000;
    while (!db.prepare('SELECT 1 FROM notes WHERE path=?').get('00-Inbox/watched.md') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(db.prepare('SELECT path FROM notes WHERE active=1').get()).toEqual({ path: '00-Inbox/watched.md' });
  } finally {
    stop(); await indexing.close(); db.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const change of ['inactive', 'omitted'] as const)
  it(`permanently revokes an edit share when synchronized source identity becomes ${change}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-revoke-share-'));
    const config = {
      knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
      origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
      indexing: { enabled: false, watch: false },
    } as AppConfig;
    await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
    const db = openDatabase(config.dataRoot);
    try {
      const notes = noteService(config, db), shares = shareService(db, notes);
      const original = notes.createNote('00-Inbox', 'shared.md', '# Shared');
      const share = shares.create(original.id, false, { permission: 'edit' });
      expect(shares.access(share.token!)).toMatchObject({ permission: 'edit', canEdit: true });
      const restored = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
      const removed = structuredClone(restored);
      removed.revision = randomUUID();
      if (change === 'inactive') removed.data.notes[0].active = false;
      else removed.data.notes = [];
      await rm(join(config.knowledgeRoot, original.relativePath));
      writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify(removed));
      portableLibrary(config, db).refresh();
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(original.id)).toEqual({ enabled: 0 });
      expect(() => shares.lookup(share.token!)).toThrow();
      await writeFile(join(config.knowledgeRoot, original.relativePath), '# Shared');
      restored.revision = randomUUID();
      writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify(restored));
      portableLibrary(config, db).refresh();
      expect(notes.getNote(original.id).content).toBe('# Shared');
      expect(() => shares.access(share.token!)).toThrow();
      expect(shares.status(original.id)).toMatchObject({ enabled: false, state: 'revoked' });
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

it('revokes stale local shares when a synchronized identity is reactivated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-reactivate-share-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db), shares = shareService(db, notes);
    const original = notes.createNote('00-Inbox', 'shared.md', '# Shared');
    const share = shares.create(original.id, false, { permission: 'edit' });
    const restored = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
    // Model a previously interrupted deactivation retaining an enabled token.
    db.prepare('UPDATE notes SET active=0 WHERE id=?').run(original.id);
    portableLibrary(config, db).flush();
    restored.revision = randomUUID();
    writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify(restored));
    portableLibrary(config, db).refresh();
    expect(notes.getNote(original.id).content).toBe('# Shared');
    expect(() => shares.access(share.token!)).toThrow();
    expect(shares.status(original.id)).toMatchObject({ enabled: false, state: 'revoked' });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('retains existing shares when synchronization only renames an active source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-rename-share-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'fixture-only-portable-library-secret',
    indexing: { enabled: false, watch: false },
  } as AppConfig;
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db), shares = shareService(db, notes);
    const original = notes.createNote('00-Inbox', 'before.md', '# Shared');
    const share = shares.create(original.id, false, { permission: 'edit' });
    const renamed = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString());
    renamed.revision = randomUUID();
    renamed.data.notes[0].path = '00-Inbox/after.md';
    await rename(join(config.knowledgeRoot, original.relativePath), join(config.knowledgeRoot, '00-Inbox/after.md'));
    writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify(renamed));
    portableLibrary(config, db).refresh();
    expect(shares.document(share.token!)).toMatchObject({ id: original.id, relativePath: '00-Inbox/after.md', content: '# Shared' });
    expect(shares.access(share.token!)).toMatchObject({ permission: 'edit', canEdit: true });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
