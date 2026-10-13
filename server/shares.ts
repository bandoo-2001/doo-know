import { randomBytes } from 'node:crypto';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
export function shareService(db: AppDatabase, notes: NoteService) {
  function status(id: string) {
    notes.getNote(id);
    const s = db.prepare('SELECT token,enabled FROM shares WHERE note_id=?').get(id) as
      | { token: string; enabled: number }
      | undefined;
    return s?.enabled
      ? { enabled: true, token: s.token, url: `/s/${s.token}` }
      : { enabled: false };
  }
  function create(id: string, reset = false) {
    notes.getNote(id);
    const old = status(id);
    if (old.enabled && !reset) return old;
    const token = randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1) ON CONFLICT(note_id) DO UPDATE SET token=excluded.token,enabled=1',
    ).run(id, token);
    return status(id);
  }
  function revoke(id: string) {
    notes.row(id);
    db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
    return { enabled: false };
  }
  function document(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, '分享不存在或已取消');
    const s = db.prepare('SELECT note_id FROM shares WHERE token=? AND enabled=1').get(token) as
      | { note_id: string }
      | undefined;
    if (!s) throw new HttpError(404, '分享不存在或已取消');
    try {
      return notes.getNote(s.note_id);
    } catch {
      db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(s.note_id);
      throw new HttpError(404, '分享不存在或已取消');
    }
  }
  return { status, create, revoke, document };
}
