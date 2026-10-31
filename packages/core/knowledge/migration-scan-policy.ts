import type { AppDatabase } from '../db.js';
/** Both owner tree scans and asynchronous index discovery must honor the same cutover reservations. */
export function migrationPathProtected(db: AppDatabase, path: string) {
  return (
    !!db
      .prepare(
        "SELECT 1 FROM whiteboard_migrations WHERE (old_path=? OR new_path=?) AND status IN ('committing','rolling_back')",
      )
      .get(path, path) ||
    !!db
      .prepare(
        'SELECT 1 FROM note_path_aliases a JOIN notes n ON n.id=a.note_id WHERE a.path=? AND n.active=1 AND n.path<>a.path',
      )
      .get(path)
  );
}
export function migrationNoteProtected(db: AppDatabase, id: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM whiteboard_migrations WHERE note_id=? AND status IN ('committing','rolling_back')",
    )
    .get(id);
}
