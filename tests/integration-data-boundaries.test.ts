import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../shared/contracts.js';
import { organizationFixture } from './support/organization-fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { readDocument, scanFiles, validateRelative } from '../packages/core/files.js';
import { archiveFolder } from '../packages/core/folders.js';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { portableLibrary } from '../packages/core/portable-library.js';
import { organizationService } from '../packages/core/organization/service.js';
import { workspaceExclusive } from '../packages/core/workspace/gate.js';

const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); });
function fixture() {
  const f = organizationFixture();
  closes.push(() => f.close());
  return f;
}

for (const [kind, path] of [
  ['note', '_data/private.md'], ['folder', '_data'], ['asset', '_data/apps/private.png'],
] as const)
  it(`rejects reserved root application data as a ${kind} path`, () => {
    expect(() => validateRelative(path, kind)).toThrow();
    expect(() => validateRelative('00-Inbox/' + path, kind)).not.toThrow();
  });

it('excludes root application data from knowledge scans and directory catalogs while retaining nested data folders', () => {
  const f = fixture();
  mkdirSync(join(f.config.knowledgeRoot, '_data/private'), { recursive: true });
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/_data'));
  writeFileSync(join(f.config.knowledgeRoot, '_data/private/note.md'), '# Private');
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/_data/note.md'), '# Ordinary');
  const scanned = scanFiles(f.config.knowledgeRoot);
  expect(scanned.notes).toEqual(['00-Inbox/_data/note.md']);
  expect(scanned.folders).toContain('00-Inbox/_data');
  expect(scanned.folders.some((path) => path === '_data' || path.startsWith('_data/'))).toBe(false);
  const s = organizationService(f.config, f.db, f.notes);
  closes.push(() => s.close());
  expect(s.list(f.p).items.map((item) => item.path)).not.toContain('_data');
  expect(() => readDocument(f.config.knowledgeRoot, '_data/private/note.md')).toThrow();
  expect(f.notes.scan().notes).toEqual(['00-Inbox/_data/note.md']);
});

for (const source of ['SQLite only', 'portable file', 'portable file with stale SQLite'] as const)
  it(`upgrades legacy root application-data identities from ${source} without touching their files`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dooknow-legacy-data-'));
    const config = {
      knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
      origin: 'http://localhost', secret: 'test-only-legacy-data-secret',
    } as AppConfig;
    mkdirSync(join(config.knowledgeRoot, '_data'), { recursive: true });
    mkdirSync(join(config.knowledgeRoot, '00-Inbox'));
    writeFileSync(join(config.knowledgeRoot, '_data/private.md'), '# Application-owned record');
    writeFileSync(join(config.knowledgeRoot, '00-Inbox/ordinary.md'), '# Ordinary');
    const db = openDatabase(config.dataRoot);
    closes.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    if (source !== 'portable file') {
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('legacy-private', '_data/private.md');
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('ordinary', '00-Inbox/ordinary.md');
      db.prepare('INSERT INTO note_favorites VALUES(?,?)').run('owner', 'legacy-private');
      db.prepare('INSERT INTO note_favorites VALUES(?,?)').run('owner', 'ordinary');
      db.prepare('INSERT INTO shares(note_id,token) VALUES(?,?)').run('legacy-private', 'test-only-legacy-share');
      db.prepare('INSERT INTO document_state(note_id) VALUES(?)').run('legacy-private');
    }
    if (source !== 'SQLite only')
      writeKnowledgeDataFile(config.knowledgeRoot, 'library/state.json', JSON.stringify({
        format: 1, revision: 'legacy-data-registry', data: {
          version: 1,
          notes: [
            { id: 'legacy-private', path: '_data/private.md', active: true },
            { id: 'ordinary', path: '00-Inbox/ordinary.md', active: true },
          ],
          favorites: [{ username: 'owner', noteId: 'legacy-private' }, { username: 'owner', noteId: 'ordinary' }],
        },
      }));
    const notes = noteService(config, db);
    expect(db.prepare('SELECT id,path FROM notes WHERE active=1').all()).toEqual([{ id: 'ordinary', path: '00-Inbox/ordinary.md' }]);
    expect(db.prepare('SELECT note_id FROM note_favorites').all()).toEqual([{ note_id: 'ordinary' }]);
    if (source !== 'portable file') {
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get('legacy-private')).toEqual({ enabled: 0 });
      expect(db.prepare('SELECT active FROM document_state WHERE note_id=?').get('legacy-private')).toEqual({ active: 0 });
    }
    notes.scan();
    notes.createNote('00-Inbox', 'new.md', '# Subsequent ordinary write');
    expect(notes.getNote('ordinary').content).toBe('# Ordinary');
    expect(readFileSync(join(config.knowledgeRoot, '_data/private.md'), 'utf8')).toBe('# Application-owned record');
    const saved = JSON.parse(readKnowledgeDataFile(config.knowledgeRoot, 'library/state.json')!.toString()).data;
    expect(saved.notes.map((note: { path: string }) => note.path).sort()).toEqual(['00-Inbox/new.md', '00-Inbox/ordinary.md']);
    expect(saved.favorites).toEqual([{ username: 'owner', noteId: 'ordinary' }]);
  });

for (const archive of ['note', 'folder'] as const)
  it(`does not recycle ${archive}-archived identities or favorites after copying into a fresh database`, async () => {
    const f = fixture();
    mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/Original'));
    const original = f.notes.createNote('00-Inbox/Original', 'same.md', '# Original');
    f.notes.setFavorite('owner', original.id, true);
    if (archive === 'note')
      mutationCore(f.config, f.db).archive(webPrincipal, original.id, original.modifiedAt, 'archive-original');
    else await workspaceExclusive(f.db, { kind: 'test.archive-folder' }, async () =>
      archiveFolder(f.config, f.db, '00-Inbox/Original', 'archive-original', f.notes.scan));
    portableLibrary(f.config, f.db).flush();
    const fresh = { ...f.config, knowledgeRoot: join(f.root, 'copied'), dataRoot: join(f.root, 'fresh') };
    cpSync(f.config.knowledgeRoot, fresh.knowledgeRoot, { recursive: true });
    const db = openDatabase(fresh.dataRoot);
    closes.push(() => { db.close(); });
    const copied = noteService(fresh, db);
    mkdirSync(join(fresh.knowledgeRoot, '00-Inbox/Original'), { recursive: true });
    writeFileSync(join(fresh.knowledgeRoot, original.relativePath), '# Unrelated replacement');
    copied.scan();
    const current = db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(original.relativePath) as { id: string };
    expect(current.id).not.toBe(original.id);
    expect(db.prepare('SELECT active FROM notes WHERE id=?').get(original.id)).toEqual({ active: 0 });
    expect(db.prepare('SELECT 1 FROM note_favorites WHERE owner_id=? AND note_id=?').get('owner', current.id)).toBeUndefined();
    const state = readKnowledgeDataFile(fresh.knowledgeRoot, 'library/state.json')!.toString();
    expect(JSON.parse(state).data.notes.find((n: { id: string }) => n.id === original.id)).toMatchObject({ archived: true });
    expect(state).not.toContain(f.root);
  });

it('retains a synchronized archive marker across subsequent writes and discovery in an existing projection', () => {
  const f = fixture();
  const original = f.notes.createNote('00-Inbox', 'same.md', '# Original');
  const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
  state.revision = 'remote-archive';
  state.data.notes[0] = { ...state.data.notes[0], active: false, archived: true };
  rmSync(join(f.config.knowledgeRoot, original.relativePath));
  writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
  portableLibrary(f.config, f.db).refresh();
  f.notes.createNote('Topic', 'unrelated.md', '# Subsequent local write');
  writeFileSync(join(f.config.knowledgeRoot, original.relativePath), '# Replacement');
  f.notes.scan();
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(original.id)).toEqual({ active: 0 });
});

it('keeps a known archive tombstone when an older client omits its marker from an inactive record', () => {
  const f = fixture();
  const original = f.notes.createNote('00-Inbox', 'same.md', '# Original');
  const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
  state.revision = 'remote-archive';
  state.data.notes[0] = { ...state.data.notes[0], active: false, archived: true };
  rmSync(join(f.config.knowledgeRoot, original.relativePath));
  writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
  portableLibrary(f.config, f.db).refresh();
  state.revision = 'remote-legacy-inactive';
  delete state.data.notes[0].archived;
  writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
  portableLibrary(f.config, f.db).refresh();
  writeFileSync(join(f.config.knowledgeRoot, original.relativePath), '# Unrelated replacement');
  f.notes.scan();
  expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(original.id)).toEqual({ active: 0 });
});

it('keeps legacy unarchived inactive identities eligible for source rediscovery', () => {
  const f = fixture();
  const original = f.notes.createNote('00-Inbox', 'same.md', '# Original');
  const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
  state.revision = 'legacy-missing-source';
  state.data.notes[0].active = false;
  rmSync(join(f.config.knowledgeRoot, original.relativePath));
  writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
  portableLibrary(f.config, f.db).refresh();
  writeFileSync(join(f.config.knowledgeRoot, original.relativePath), '# Original');
  f.notes.scan();
  expect(f.db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(original.relativePath)).toEqual({ id: original.id });
});

it('clears a synchronized archive marker when the original note is explicitly restored', () => {
  const f = fixture(), core = mutationCore(f.config, f.db);
  const original = f.notes.createNote('00-Inbox', 'restore.md', '# Original');
  f.notes.setFavorite('owner', original.id, true);
  core.archive(webPrincipal, original.id, original.modifiedAt, 'archive');
  portableLibrary(f.config, f.db).flush();
  const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
  state.revision = 'remote-archive';
  writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
  portableLibrary(f.config, f.db).refresh();
  core.restore(webPrincipal, original.id, undefined, 'restore');
  portableLibrary(f.config, f.db).flush();
  expect(f.notes.getNote(original.id)).toMatchObject({ content: '# Original', relativePath: original.relativePath });
  const restored = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
  expect(restored.data.notes).toEqual([{ id: original.id, path: original.relativePath, active: true }]);
  expect(restored.data.favorites).toEqual([{ username: 'owner', noteId: original.id }]);
});

for (const timing of ['before undo', 'after undo preparation', 'after undo staging'] as const)
  it(`refuses undo without changing files when portable import replaces an affected identity ${timing}`, async () => {
    const f = fixture(), s = organizationService(f.config, f.db, f.notes);
    closes.push(() => s.close());
    const n = f.create('00-Inbox/a.md', '# Unchanged body'), c = s.context(f.p);
    const moved = await s.submit(f.p, {
      requestId: 'move', libraryId: c.libraryId, expectedStructureRevision: c.structureRevision,
      actions: [{ type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' }],
    });
    await s.drain();
    expect(s.operation(f.p, { operationId: moved.operation.operationId }).status).toBe('succeeded');
    portableLibrary(f.config, f.db).flush();
    function replaceIdentity() {
      const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
      state.revision = 'remote-replacement';
      state.data.notes = state.data.notes.map((note: { id: string }) => note.id === n.noteId ? { ...note, id: 'imported-replacement' } : note);
      writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
      portableLibrary(f.config, f.db).refresh();
    }
    if (timing === 'before undo') replaceIdentity();
    let checks = 0;
    const undo = await s.undo(f.p, { operationId: moved.operation.operationId, requestId: 'undo' }, () => {
      checks++;
      if ((timing === 'after undo preparation' && checks === 2) || (timing === 'after undo staging' && checks === 3)) replaceIdentity();
      return f.p;
    });
    await s.drain();
    expect(s.operation(f.p, { operationId: undo.operation.operationId })).toMatchObject({ status: 'failed', error: { code: 'UNDO_CONFLICT' } });
    expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(false);
    expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/a.md'), 'utf8')).toBe('# Unchanged body');
    expect(f.db.prepare('SELECT path,active FROM notes WHERE id=?').get('imported-replacement')).toEqual({ path: 'Topic/a.md', active: 1 });
    expect(() => f.notes.scan()).not.toThrow();
  });

for (const change of ['id', 'path', 'deleted'] as const)
  it(`refuses directory undo before file publication after a managed attachment ${change} changes`, async () => {
    const f = fixture(), s = organizationService(f.config, f.db, f.notes);
    closes.push(() => s.close());
    f.create('00-Inbox/a.md', '![attachment](assets/image.png)');
    mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/assets'));
    writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/assets/image.png'), 'original image');
    f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run('original-asset', '00-Inbox/assets/image.png');
    const c = s.context(f.p), d = f.directory('00-Inbox');
    const moved = await s.submit(f.p, {
      requestId: 'move-tree', libraryId: c.libraryId, expectedStructureRevision: c.structureRevision,
      actions: [{ type: 'move_directory', directoryId: d.id, toDirectoryId: f.directory('Topic').id, name: 'Moved', expectedSubtreeRevision: d.subtreeRevision }],
    });
    await s.drain();
    expect(s.operation(f.p, { operationId: moved.operation.operationId }).status).toBe('succeeded');
    if (change === 'id') f.db.prepare('UPDATE assets SET id=? WHERE id=?').run('replacement-asset', 'original-asset');
    if (change === 'path') f.db.prepare('UPDATE assets SET path=? WHERE id=?').run('Topic/another.png', 'original-asset');
    if (change === 'deleted') f.db.prepare('DELETE FROM assets WHERE id=?').run('original-asset');
    const undo = await s.undo(f.p, { operationId: moved.operation.operationId, requestId: 'undo-tree' });
    await s.drain();
    expect(s.operation(f.p, { operationId: undo.operation.operationId })).toMatchObject({ status: 'failed', error: { code: 'UNDO_CONFLICT' } });
    expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox'))).toBe(false);
    expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/Moved/assets/image.png'), 'utf8')).toBe('original image');
    expect(() => f.notes.scan()).not.toThrow();
  });

for (const phase of [2, 3])
  for (const kind of ['note', 'asset', 'directory'] as const)
    it(`refuses undo when a ${kind} destination gains an owner at preflight ${phase}`, async () => {
      const f = fixture(), s = organizationService(f.config, f.db, f.notes);
      closes.push(() => s.close());
      const n = f.create('00-Inbox/a.md', '# Original');
      if (kind === 'asset') {
        mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/assets'));
        writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/assets/a.png'), 'original asset');
        f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run('original-asset', '00-Inbox/assets/a.png');
      }
      const c = s.context(f.p), directory = f.directory('00-Inbox');
      const moved = await s.submit(f.p, {
        requestId: 'move', libraryId: c.libraryId, expectedStructureRevision: c.structureRevision,
        actions: kind === 'note'
          ? [{ type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' }]
          : [{ type: 'move_directory', directoryId: directory.id, toDirectoryId: f.directory('Topic').id, name: 'Moved', expectedSubtreeRevision: directory.subtreeRevision }],
      });
      await s.drain();
      expect(s.operation(f.p, { operationId: moved.operation.operationId }).status).toBe('succeeded');
      portableLibrary(f.config, f.db).flush();
      let calls = 0;
      const undo = await s.undo(f.p, { operationId: moved.operation.operationId, requestId: 'undo' }, () => {
        if (++calls === phase) {
          if (kind === 'asset')
            f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run('other-asset', '00-Inbox/assets/a.png');
          else if (kind === 'directory')
            f.db.prepare('INSERT INTO organization_directories(id,library_id,path,active,dev,ino,birthtime_ns) VALUES(?,?,?,1,?,?,?)')
              .run('other-directory', c.libraryId, '00-Inbox', '0', '0', '0');
          else {
            const state = JSON.parse(readKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json')!.toString());
            state.revision = 'new-destination-owner';
            state.data.notes.push({ id: 'other-note', path: '00-Inbox/a.md', active: true });
            writeKnowledgeDataFile(f.config.knowledgeRoot, 'library/state.json', JSON.stringify(state));
            portableLibrary(f.config, f.db).refresh();
          }
        }
        return f.p;
      });
      await s.drain();
      expect(s.operation(f.p, { operationId: undo.operation.operationId })).toMatchObject({ status: 'failed', error: { code: 'UNDO_CONFLICT' } });
      expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(false);
      const path = kind === 'note' ? 'Topic/a.md' : 'Topic/Moved/a.md';
      expect(readFileSync(join(f.config.knowledgeRoot, path), 'utf8')).toBe('# Original');
      expect(f.db.prepare('SELECT path,active FROM notes WHERE id=?').get(n.noteId)).toEqual({ path, active: 1 });
      expect(() => f.notes.scan()).not.toThrow();
    });
