import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal, NoteInfo } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { requireScope } from '../agent/auth.js';
import { validateRelative } from '../files.js';
import { fail } from './errors.js';
import { sha256 } from './operations.js';
import { decodeCursor, signCursor } from '../agent/budgets.js';
import { recallFilter } from '../search/filters.js';
import { messageSize } from './limits.js';
import { currentLibraryIdentity } from '../auth/permissions.js';
export async function listMetadata(config: AppConfig, db: AppDatabase, notes: NoteService,
  info: (p: Principal, id: string) => Promise<NoteInfo>, p: Principal,
  q: { limit?: number | string; cursor?: string; directory?: string }) {
  requireScope(p, 'knowledge:read'); notes.scan();
  if (q.directory) { try { validateRelative(q.directory, 'folder'); } catch { fail(400, 'INVALID_DIRECTORY'); } }
  const limit = Number(q.limit || 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'INVALID_LIMIT');
  const fingerprint = sha256(JSON.stringify([p.id, p.clientId, p.allowedPrefixes, p.knowledgeAll, p.permissionPolicy, currentLibraryIdentity(db)?.structureRevision, q.directory, limit]));
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor(config.secret, q.cursor); if (c.fingerprint !== fingerprint) fail(403, 'FORBIDDEN');
    if (c.expires <= Date.now()) fail(410, 'CURSOR_EXPIRED'); offset = c.offset;
  }
  const filter = recallFilter(p, { directory: q.directory }, 'n.path');
  const rows = db.prepare(`SELECT n.id,n.path FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND (${filter.sql}) ORDER BY n.path LIMIT ? OFFSET ?`)
    .all(...filter.values, limit + 1, offset) as { id: string; path: string }[];
  let items = await Promise.all(rows.slice(0, limit).map(n => info(p, n.id)));
  const output = () => ({ items, ...(rows.length > items.length ? { nextCursor: signCursor(config.secret,
    { fingerprint, offset: offset + items.length, expires: Date.now() + 15 * 60000 }) } : {}) });
  while (items.length && messageSize(output()) > 64512) items = items.slice(0, -1);
  if (!items.length && rows.length) fail(413, 'RESPONSE_TOO_LARGE'); return output();
}
