import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { authorizePath } from '../agent/auth.js';
/** Resolve the active document at its current path. */
export function noteIdAtPath(db: AppDatabase, path: string, principal?: Principal) {
  const note = db
    .prepare(
      'SELECT id,path FROM notes WHERE active=1 AND path=?',
    )
    .get(path) as { id: string; path: string } | undefined;
  if (note && principal) authorizePath(principal, note.path);
  return note?.id;
}
