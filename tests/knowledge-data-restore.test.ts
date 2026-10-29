import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { backup, restore } from '../apps/server/backup.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import type { AppConfig } from '../shared/contracts.js';

// Model the committed SQLite outbox left behind when atomic file replacement
// fails. Keeping the old, valid source file makes this independent of OS user
// permissions and allows the real backup to contain both recoverable versions.
function stagePending(db: AppDatabase, root: string, path: string, data: unknown) {
  const pending = JSON.stringify({ format: 1, revision: randomUUID(), data }, null, 2) + '\n';
  const updated = db
    .prepare(
      `UPDATE knowledge_data_state SET
    pending=?,pending_digest=?,pending_base=digest,pending_version=dirty
    WHERE root=? AND path=? AND dirty>0`,
    )
    .run(pending, createHash('sha256').update(pending).digest('hex'), root, path);
  expect(updated.changes).toBe(1);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-portable-restore-'));
  const config: AppConfig = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-portable-restore-secret',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const target = {
    ...config,
    knowledgeRoot: join(root, 'restored-knowledge'),
    dataRoot: join(root, 'restored-data'),
  };
  return {
    root,
    config,
    target,
    db: openDatabase(config.dataRoot),
    snapshot: join(root, 'backup'),
  };
}

it('replays a pending favorite after a full backup is restored at a different root', async () => {
  const f = await fixture();
  let restored: AppDatabase | undefined;
  try {
    const note = noteService(f.config, f.db).createNote('00-Inbox', 'saved.md', '# Durable note');
    const path = 'library/state.json';
    const baseline = readKnowledgeDataFile(f.config.knowledgeRoot, path)!;
    const envelope = JSON.parse(baseline.toString());
    expect(envelope.data.favorites).toEqual([]);
    f.db.prepare('INSERT INTO note_favorites(owner_id,note_id) VALUES(?,?)').run('owner', note.id);
    envelope.data.favorites.push({ username: 'owner', noteId: note.id });
    stagePending(f.db, f.config.knowledgeRoot, path, envelope.data);
    await backup(f.config, f.snapshot);
    expect(readKnowledgeDataFile(f.config.knowledgeRoot, path)).toEqual(baseline);

    await restore(f.snapshot, f.target);
    restored = openDatabase(f.target.dataRoot);
    const notes = noteService(f.target, restored);
    expect(notes.getNote(note.id).content).toBe('# Durable note');
    expect(restored.prepare('SELECT owner_id,note_id FROM note_favorites').all()).toEqual([
      { owner_id: 'owner', note_id: note.id },
    ]);
    const persisted = JSON.parse(readKnowledgeDataFile(f.target.knowledgeRoot, path)!.toString());
    expect(persisted.data.favorites).toEqual([{ username: 'owner', noteId: note.id }]);
    expect(
      restored
        .prepare('SELECT pending FROM knowledge_data_state WHERE root=? AND path=?')
        .get(f.target.knowledgeRoot, path),
    ).toEqual({ pending: null });
  } finally {
    restored?.close();
    f.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it('replays pending plugin user data after restore without installing or activating the plugin', async () => {
  const f = await fixture();
  let restored: AppDatabase | undefined;
  let targetHost: ReturnType<typeof pluginHost> | undefined;
  const sourceHost = pluginHost({ ...f.config, pluginCatalog: [] }, f.db);
  try {
    noteService(f.config, f.db);
    const path = 'plugins/saved-data/state.json';
    const data = {
      schemaVersion: 1,
      plugin: { id: 'saved-data', version: '1.0.0', apiVersion: '^1.0.0' },
      config: {},
      userData: {} as Record<string, unknown>,
    };
    writeKnowledgeDataFile(
      f.config.knowledgeRoot,
      path,
      JSON.stringify({ format: 1, revision: randomUUID(), data }),
    );
    expect(sourceHost.dataDependencies()).toMatchObject([
      { id: 'saved-data', state: 'unavailable' },
    ]);
    f.db
      .prepare('INSERT INTO portable_plugin_data(root,plugin_id,key,value) VALUES(?,?,?,?)')
      .run(
        f.config.knowledgeRoot,
        'saved-data',
        'draft',
        JSON.stringify({ content: 'Keep this draft' }),
      );
    data.userData.draft = { content: 'Keep this draft' };
    stagePending(f.db, f.config.knowledgeRoot, path, data);
    await backup(f.config, f.snapshot);
    await restore(f.snapshot, f.target);

    restored = openDatabase(f.target.dataRoot);
    targetHost = pluginHost({ ...f.target, pluginCatalog: [] }, restored);
    expect(targetHost.dataDependencies()).toMatchObject([
      { id: 'saved-data', state: 'unavailable' },
    ]);
    expect(targetHost.list()).toEqual([]);
    expect(targetHost.contributions()).toEqual([]);
    const persisted = JSON.parse(
      await readFile(join(f.target.knowledgeRoot, '_data', path), 'utf8'),
    );
    expect(persisted.data.userData).toEqual({ draft: { content: 'Keep this draft' } });
    expect(
      restored
        .prepare('SELECT root,value FROM portable_plugin_data WHERE plugin_id=? AND key=?')
        .get('saved-data', 'draft'),
    ).toEqual({
      root: f.target.knowledgeRoot,
      value: JSON.stringify({ content: 'Keep this draft' }),
    });
  } finally {
    await targetHost?.close();
    await sourceHost.close();
    restored?.close();
    f.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
