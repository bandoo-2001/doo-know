import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../shared/contracts.js';
import { openDatabase, type AppDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core.js';
import { createKnowledgeDataDomain, readKnowledgeDataFile, refreshKnowledgeData, writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { portablePluginData } from '../apps/server/plugins/portable.js';
import { portableBlog } from '../packages/core/blog/portable.js';
import { renameRootInPlace } from '../apps/server/platform/root-migration.js';

const closes: Array<() => void> = [];
afterEach(() => { while (closes.length) closes.pop()!(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-portable-rename-'));
  const config: AppConfig = {
    knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost', secret: 'fixture-only-root-migration-secret',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  let db = openDatabase(config.dataRoot);
  closes.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const notes = noteService(config, db);
  const note = notes.createNote('00-Inbox', 'keep.md', '# Keep');
  const archived = notes.createNote('00-Inbox', 'archived.md', '# Archived');
  mutationCore(config, db).archive(webPrincipal, archived.id, archived.modifiedAt, 'archive-before-rename');
  const blog = portableBlog(config, db);
  db.exec("CREATE TABLE user_content(value TEXT NOT NULL); INSERT INTO user_content VALUES('initial'); CREATE TABLE platform_plugins(id TEXT PRIMARY KEY,installed_version TEXT,state TEXT,manifest_json TEXT,config_json TEXT,installed INTEGER)");
  const generic = () => createKnowledgeDataDomain(config, db, 'apps/rename-test/state.json', {
    tables: ['user_content'],
    read: () => db.prepare('SELECT value FROM user_content').get() as { value: string },
    validate: (data) => {
      if (!data || typeof (data as any).value !== 'string') throw Error('Invalid fixture');
      return data as { value: string };
    },
    write: (data) => { db.prepare('UPDATE user_content SET value=?').run(data.value); },
  });
  const domain = generic();
  const pluginState = {
    schemaVersion: 1,
    plugin: { id: 'saved-data', version: '1.0.0', apiVersion: '^1.0.0' },
    config: {}, userData: { draft: 'Pending draft' },
  };
  writeKnowledgeDataFile(config.knowledgeRoot, 'plugins/saved-data/state.json', JSON.stringify({ format: 1, revision: 'initial', data: { ...pluginState, userData: {} } }));
  const plugins = portablePluginData(db, () => config.knowledgeRoot);
  expect(plugins.dependencies([])).toMatchObject([{ id: 'saved-data', state: 'unavailable' }]);
  db.prepare('INSERT INTO portable_plugin_data VALUES(?,?,?,?)').run(config.knowledgeRoot, 'saved-data', 'draft', JSON.stringify('Pending draft'));
  const library = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString()).data;
  db.prepare('INSERT INTO note_favorites VALUES(?,?)').run('owner', note.id);
  library.favorites.push({ username: 'owner', noteId: note.id });
  for (const [path, data] of [['library/state.json', library], ['plugins/saved-data/state.json', pluginState]] as const) {
    const pending = JSON.stringify({ format: 1, revision: 'pending-' + path, data });
    db.prepare('UPDATE knowledge_data_state SET pending=?,pending_digest=?,pending_base=digest,pending_version=dirty WHERE root=? AND path=?')
      .run(pending, createHash('sha256').update(pending).digest('hex'), config.knowledgeRoot, path);
  }
  db.prepare('UPDATE user_content SET value=?').run('Unsaved local content');
  const oldRoot = config.knowledgeRoot, target = join(root, 'renamed');
  const identity = () => (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as { value: string }).value;
  const rows = () => db.prepare('SELECT * FROM knowledge_data_state ORDER BY path').all();
  return {
    config, notes, note, archived, blog, domain, plugins, generic, oldRoot, target, identity, rows,
    get db() { return db; },
    reopen() { db.close(); db = openDatabase(config.dataRoot); },
  };
}

for (const cached of [true, false])
  it(`preserves portable outboxes, dirty records and archive identities through offline rename ${cached ? 'with cached services' : 'on a reopened database'}`, () => {
    const f = fixture(), before = f.rows();
    if (!cached) f.reopen();
    renameRootInPlace(f.db, { oldRoot: f.oldRoot, newRoot: f.target, expectedIdentity: f.identity() });
    f.config.knowledgeRoot = f.target;
    expect(f.rows()).toEqual(before.map((row: any) => ({ ...row, root: f.target })));
    const notes = cached ? f.notes : noteService(f.config, f.db);
    expect(notes.getNote(f.note.id).content).toBe('# Keep');
    const plugins = cached ? f.plugins : portablePluginData(f.db, () => f.config.knowledgeRoot);
    expect(plugins.userData('saved-data').get('draft')).toBe('Pending draft');
    const domain = cached ? f.domain : f.generic();
    domain.refresh();
    const blog = portableBlog({ ...f.config }, f.db);
    if (cached) expect(blog).toBe(f.blog);
    f.db.prepare("UPDATE blog_settings SET settings_json=json_set(settings_json,'$.title',?)").run('Renamed library blog');
    blog.flush();
    expect(JSON.parse(readKnowledgeDataFile(f.target, 'apps/blog/state.json')!.toString()).data.settings.title).toBe('Renamed library blog');
    refreshKnowledgeData(f.db);
    expect(JSON.parse(readKnowledgeDataFile(f.target, 'library/state.json')!.toString()).data.favorites).toEqual([{ username: 'owner', noteId: f.note.id }]);
    expect(JSON.parse(readKnowledgeDataFile(f.target, 'apps/rename-test/state.json')!.toString()).data.value).toBe('Unsaved local content');
    expect(JSON.parse(readKnowledgeDataFile(f.target, 'plugins/saved-data/state.json')!.toString()).data.userData).toEqual({ draft: 'Pending draft' });
    f.db.prepare('UPDATE user_content SET value=?').run('Written after rename');
    expect(f.db.prepare('SELECT dirty FROM knowledge_data_state WHERE path=?').get('apps/rename-test/state.json')).toEqual({ dirty: 1 });
    domain.flush();
    expect(noteService({ ...f.config }, f.db).getNote(f.note.id).id).toBe(f.note.id);
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(f.archived.id)).toEqual({ active: 0 });
    expect(existsSync(f.oldRoot)).toBe(false);
    f.reopen();
    expect(noteService(f.config, f.db).getNote(f.note.id).content).toBe('# Keep');
    f.generic();
    f.db.prepare('UPDATE user_content SET value=?').run('Written after restart');
    expect(f.db.prepare('SELECT dirty FROM knowledge_data_state WHERE path=?').get('apps/rename-test/state.json')).toEqual({ dirty: 1 });
    refreshKnowledgeData(f.db);
    expect(JSON.parse(readKnowledgeDataFile(f.target, 'apps/rename-test/state.json')!.toString()).data.value).toBe('Written after restart');
    expect(f.db.prepare('SELECT DISTINCT root FROM portable_plugin_data').all()).toEqual([{ root: f.target }]);
  });

it('rolls portable SQL, triggers, cached services and pending bytes back when offline configuration fails', () => {
  const f = fixture(), before = f.rows(), baseline = readKnowledgeDataFile(f.oldRoot, 'library/state.json');
  const triggers = () => f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_data_%' ORDER BY name").all();
  const originalTriggers = triggers();
  expect(() => renameRootInPlace(f.db, {
    oldRoot: f.oldRoot, newRoot: f.target, expectedIdentity: f.identity(),
    configuration: { apply() { throw Error('Controlled rollback'); }, rollback() {} },
  })).toThrow('Controlled rollback');
  expect(f.rows()).toEqual(before);
  expect(triggers()).toEqual(originalTriggers);
  expect(readKnowledgeDataFile(f.oldRoot, 'library/state.json')).toEqual(baseline);
  expect(f.config.knowledgeRoot).toBe(f.oldRoot);
  expect(existsSync(f.target)).toBe(false);
  expect(f.notes.getNote(f.note.id).content).toBe('# Keep');
  expect(f.plugins.userData('saved-data').get('draft')).toBe('Pending draft');
  f.domain.refresh();
  f.reopen();
  expect(noteService(f.config, f.db).getNote(f.note.id).content).toBe('# Keep');
});
