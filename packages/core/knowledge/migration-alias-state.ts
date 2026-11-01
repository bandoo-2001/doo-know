import type { AppDatabase } from '../db.js';
import { createKnowledgeDataDomain } from '../knowledge-data.js';
import { validateRelative } from '../files.js';
import { fail } from './errors.js';
type State = { version: 1; aliases: { path: string; noteId: string; migrationId: string }[] };
/** Portable aliases follow the library's stable identities when SQLite is rebuilt. */
export function migrationAliasState(config: { knowledgeRoot: string }, db: AppDatabase) {
  return createKnowledgeDataDomain<State>(config, db, 'library/migration-aliases.json', {
    tables: ['note_path_aliases'],
    validate(value: unknown) {
      const state = value as State;
      if (!state || state.version !== 1 || !Array.isArray(state.aliases))
        fail(409, 'INVALID_KNOWLEDGE_DATA');
      const paths = new Set<string>();
      for (const a of state.aliases) {
        if (
          !a ||
          typeof a.path !== 'string' ||
          typeof a.noteId !== 'string' ||
          typeof a.migrationId !== 'string' ||
          paths.has(a.path)
        )
          fail(409, 'INVALID_KNOWLEDGE_DATA');
        validateRelative(a.path, 'note');
        paths.add(a.path);
      }
      return state;
    },
    read: () => ({
      version: 1,
      aliases: db
        .prepare(
          'SELECT path,note_id AS noteId,migration_id AS migrationId FROM note_path_aliases ORDER BY path',
        )
        .all() as State['aliases'],
    }),
    write: (state) =>
      db
        .transaction(() => {
          db.prepare('DELETE FROM note_path_aliases').run();
          for (const a of state.aliases) {
            if (!db.prepare('SELECT 1 FROM notes WHERE id=?').get(a.noteId))
              fail(409, 'INVALID_KNOWLEDGE_DATA');
            db.prepare('INSERT INTO note_path_aliases VALUES(?,?,?)').run(
              a.path,
              a.noteId,
              a.migrationId,
            );
          }
        })
        .immediate(),
  });
}
