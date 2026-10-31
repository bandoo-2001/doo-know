import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { authorizePath } from '../agent/auth.js';
/** An alias names an identity, never a grant: current-path rights remain authoritative. */
export function noteIdAtPath(db: AppDatabase, path: string, principal?: Principal) {
  const note = db
    .prepare(
      `SELECT id,path FROM notes WHERE active=1 AND path=?
    UNION ALL SELECT n.id,n.path FROM note_path_aliases a JOIN notes n ON n.id=a.note_id WHERE a.path=? AND n.active=1 LIMIT 1`,
    )
    .get(path, path) as { id: string; path: string } | undefined;
  if (note && principal) authorizePath(principal, note.path);
  return note?.id;
}
