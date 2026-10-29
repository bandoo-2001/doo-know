import { randomUUID } from 'node:crypto';
import type { AppDatabase } from './db.js';
import { validateRelative } from './files.js';
import { createKnowledgeDataDomain } from './knowledge-data.js';
import { fail } from './knowledge/errors.js';
import { assertRoot } from './indexing/reconcile.js';

type PortableNote = { id: string; path: string; active: boolean; archived?: boolean };
type PortableFavorite = { username: string; noteId: string };
type LibraryState = { version: 1; notes: PortableNote[]; favorites: PortableFavorite[] };
type NoteIdentity = { id: string; path: string; active: number; trash_path: string | null };
const libraries = new WeakMap<AppDatabase, { root: string; library: ReturnType<typeof createLibrary> }>();
const label = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const reservedDataNote = (path: string) => path.startsWith('_data/');

function validateState(value: unknown): LibraryState {
  const state = value as LibraryState;
  if (!state || state.version !== 1 || !Array.isArray(state.notes) || !Array.isArray(state.favorites))
    fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库身份数据格式不正确');
  const ids = new Set<string>(), paths = new Set<string>(), favorites = new Set<string>(), retired = new Set<string>();
  for (const note of state.notes) {
    if (!note || !label(note.id) || typeof note.path !== 'string' || typeof note.active !== 'boolean' || ids.has(note.id))
      fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库笔记身份重复或无效');
    if ((note.archived !== undefined && typeof note.archived !== 'boolean') || (note.active && note.archived))
      fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库笔记归档状态无效');
    // Previous scanners could register application-owned Markdown as notes.
    // Accept only otherwise-valid legacy paths so migration cannot hide corrupt paths.
    try { validateRelative(reservedDataNote(note.path) ? 'legacy/' + note.path : note.path, 'note'); }
    catch { fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库笔记路径不正确'); }
    if (reservedDataNote(note.path)) retired.add(note.id);
    if (note.active && paths.has(note.path)) fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库笔记路径重复');
    ids.add(note.id);
    if (note.active) paths.add(note.path);
  }
  for (const favorite of state.favorites) {
    if (!favorite || !label(favorite.username) || !ids.has(favorite.noteId))
      fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库收藏关联无效');
    const key = JSON.stringify([favorite.username, favorite.noteId]);
    if (favorites.has(key)) fail(409, 'INVALID_KNOWLEDGE_DATA', '知识库收藏重复');
    favorites.add(key);
  }
  // Select portable fields explicitly; imported objects cannot carry local paths or auth state.
  return {
    version: 1,
    notes: state.notes.filter((note) => !retired.has(note.id))
      .map(({ id, path, active, archived }) => ({ id, path, active, ...(archived ? { archived: true } : {}) })),
    favorites: state.favorites.filter((favorite) => !retired.has(favorite.noteId))
      .map(({ username, noteId }) => ({ username, noteId })),
  };
}

function createLibrary(config: { knowledgeRoot: string }, db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS portable_library_pending_favorites(
    username TEXT NOT NULL,note_id TEXT NOT NULL,PRIMARY KEY(username,note_id));
    CREATE TABLE IF NOT EXISTS portable_library_omitted_notes(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS portable_library_archived_notes(id TEXT PRIMARY KEY);`);
  const hasUsers = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get();
  const localOwner = (username: string) => hasUsers()
    ? (db.prepare('SELECT id FROM user WHERE username=?').get(username) as { id: string } | undefined)?.id
    : username;
  const portableOwner = (id: string) => hasUsers()
    ? (db.prepare('SELECT username FROM user WHERE id=?').get(id) as { username: string } | undefined)?.username || id
    : id;
  function resolveFavorites() {
    for (const row of db.prepare('SELECT username,note_id FROM portable_library_pending_favorites').all() as { username: string; note_id: string }[]) {
      const owner = localOwner(row.username);
      if (!owner) continue;
      db.prepare('INSERT OR IGNORE INTO note_favorites(owner_id,note_id) VALUES(?,?)').run(owner, row.note_id);
      db.prepare('DELETE FROM portable_library_pending_favorites WHERE username=? AND note_id=?').run(row.username, row.note_id);
    }
  }
  function retireReservedNotes() {
    const reserved = db.prepare("SELECT id,path FROM notes WHERE substr(path,1,6)='_data/'").all() as { id: string; path: string }[];
    if (!reserved.length) return;
    db.transaction(() => {
      for (const note of reserved) {
        validateRelative('legacy/' + note.path, 'note');
        db.prepare('UPDATE notes SET active=0 WHERE id=? AND active<>0').run(note.id);
        db.prepare('INSERT OR IGNORE INTO portable_library_omitted_notes VALUES(?)').run(note.id);
        db.prepare('DELETE FROM note_favorites WHERE note_id=?').run(note.id);
        db.prepare('DELETE FROM portable_library_pending_favorites WHERE note_id=?').run(note.id);
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=? AND enabled<>0').run(note.id);
        db.prepare('UPDATE document_state SET active=0 WHERE note_id=? AND active<>0').run(note.id);
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=? AND active<>0').run(note.id);
        db.prepare("UPDATE index_jobs SET status='superseded' WHERE note_id=? AND status NOT IN ('done','superseded')").run(note.id);
      }
    }).immediate();
  }
  const domain = createKnowledgeDataDomain<LibraryState>(config, db, 'library/state.json', {
    tables: ['notes', 'note_favorites', 'portable_library_pending_favorites', 'portable_library_omitted_notes', 'portable_library_archived_notes'],
    validate: validateState,
    read: () => {
      const notes = (db.prepare(`SELECT id,path,active,
        NOT active AND (trash_path IS NOT NULL OR
          id IN (SELECT id FROM portable_library_archived_notes) OR
          EXISTS(SELECT 1 FROM folder_trash f,json_each(f.notes_json) n
            WHERE f.state IN ('trashed','archiving','restoring') AND json_extract(n.value,'$.id')=notes.id)) AS archived
        FROM notes WHERE id NOT IN (SELECT id FROM portable_library_omitted_notes) ORDER BY id`).all() as { id: string; path: string; active: number; archived: number }[])
        .map(({ id, path, active, archived }) => ({ id, path, active: !!active, ...(archived ? { archived: true } : {}) }));
      const included = new Set(notes.map((note) => note.id));
      const favorites = new Map<string, PortableFavorite>();
      for (const row of db.prepare('SELECT username,note_id FROM portable_library_pending_favorites').all() as { username: string; note_id: string }[]) {
        if (!included.has(row.note_id)) continue;
        const item = { username: row.username, noteId: row.note_id };
        favorites.set(JSON.stringify([item.username, item.noteId]), item);
      }
      for (const row of db.prepare('SELECT owner_id,note_id FROM note_favorites ORDER BY owner_id,note_id').all() as { owner_id: string; note_id: string }[]) {
        if (!included.has(row.note_id)) continue;
        const item = { username: portableOwner(row.owner_id), noteId: row.note_id };
        favorites.set(JSON.stringify([item.username, item.noteId]), item);
      }
      return { version: 1, notes, favorites: [...favorites.values()].sort((a, b) => a.username.localeCompare(b.username) || a.noteId.localeCompare(b.noteId)) };
    },
    write: (state) => db.transaction(() => {
      const wanted = new Map(state.notes.map((note) => [note.id, note]));
      db.prepare('DELETE FROM portable_library_omitted_notes').run();
      for (const current of db.prepare('SELECT id,path,active FROM notes').all() as NoteIdentity[]) {
        const next = wanted.get(current.id);
        // Imported removal/restoration follows the same grant revocation as
        // local archive/restore. A later import must not revive an old token.
        if (!next?.active || !current.active)
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(current.id);
        if (!next) {
          db.prepare('UPDATE notes SET active=0 WHERE id=?').run(current.id);
          db.prepare('INSERT INTO portable_library_omitted_notes VALUES(?)').run(current.id);
        } else if (current.path !== next.path) {
          // Release unique active paths inside the import transaction without
          // withdrawing a published source merely because its path moved.
          db.prepare('UPDATE notes SET path=? WHERE id=?').run('_data/import/' + current.id, current.id);
        }
      }
      for (const note of state.notes) {
        db.prepare('INSERT INTO notes(id,path,active) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,active=excluded.active,trash_path=CASE WHEN excluded.active=1 THEN NULL ELSE notes.trash_path END')
          .run(note.id, note.path, Number(note.active));
        // Older clients omit the marker. Only an explicit active restoration
        // clears a known tombstone; inactive imports cannot recycle its identity.
        if (note.active)
          db.prepare('DELETE FROM portable_library_archived_notes WHERE id=?').run(note.id);
        else if (note.archived)
          db.prepare('INSERT OR IGNORE INTO portable_library_archived_notes VALUES(?)').run(note.id);
      }
      db.prepare('DELETE FROM note_favorites').run();
      db.prepare('DELETE FROM portable_library_pending_favorites').run();
      for (const favorite of state.favorites)
        db.prepare('INSERT INTO portable_library_pending_favorites VALUES(?,?)').run(favorite.username, favorite.noteId);
      resolveFavorites();
    }).immediate(),
  });
  return {
    refresh() {
      domain.refresh();
      retireReservedNotes();
      db.transaction(resolveFavorites).immediate();
      domain.flush();
    },
    flush: domain.flush,
    identity(path: string, preferred?: string) {
      const active = db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as { id: string } | undefined;
      if (active) return active.id;
      const eligible = (note: NoteIdentity | undefined) => note && !note.active && !note.trash_path &&
        !db.prepare('SELECT 1 FROM portable_library_omitted_notes WHERE id=?').get(note.id) &&
        !db.prepare('SELECT 1 FROM portable_library_archived_notes WHERE id=?').get(note.id) &&
        !db.prepare("SELECT 1 FROM folder_trash f,json_each(f.notes_json) n WHERE f.state IN ('trashed','archiving','restoring') AND json_extract(n.value,'$.id')=? LIMIT 1").get(note.id) &&
        !db.prepare("SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted')").get(note.id);
      if (preferred) {
        const prior = db.prepare('SELECT * FROM notes WHERE id=?').get(preferred) as NoteIdentity | undefined;
        if (!prior || eligible(prior)) return preferred;
      }
      const previous = db.prepare('SELECT * FROM notes WHERE path=? AND active=0 AND trash_path IS NULL AND id NOT IN (SELECT id FROM portable_library_omitted_notes) ORDER BY rowid DESC LIMIT 1').get(path) as NoteIdentity | undefined;
      return eligible(previous) ? previous!.id : randomUUID();
    },
    remember(id: string) {
      db.prepare('DELETE FROM portable_library_omitted_notes WHERE id=?').run(id);
      db.prepare('DELETE FROM portable_library_archived_notes WHERE id=?').run(id);
    },
  };
}

export function portableLibrary(config: { knowledgeRoot: string }, db: AppDatabase) {
  assertRoot(config, db);
  const existing = libraries.get(db);
  if (existing) {
    if (existing.root !== config.knowledgeRoot) fail(409, 'KNOWLEDGE_DATA_BINDING_CHANGED');
    return existing.library;
  }
  const library = createLibrary(config, db);
  libraries.set(db, { get root() { return config.knowledgeRoot; }, library });
  library.refresh();
  return library;
}
