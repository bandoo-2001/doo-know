import { createHash } from 'node:crypto';
import type { Principal } from '../../shared/knowledge-contracts.js';
import type { SharePermission, ShareState } from '../../shared/share-contracts.js';
import type { AppDatabase } from './db.js';
import { HttpError } from './errors.js';

export type ShareRow = {
  token: string;
  enabled: number;
  permission: SharePermission;
  expires_at: number | null;
};
export const shareIdentity = (token: string) =>
  `share:${createHash('sha256').update(token).digest('hex')}`;
export const isSharePrincipal = (p: Principal) => p.id.startsWith('share:');
export function shareState(row?: ShareRow, now = Date.now()): ShareState {
  if (!row) return 'private';
  if (!row.enabled) return 'revoked';
  return row.expires_at !== null && row.expires_at <= now ? 'expired' : 'active';
}
export function hasActiveShare(db: AppDatabase, noteId: string) {
  return !!db
    .prepare(
      'SELECT 1 FROM shares WHERE note_id=? AND enabled=1 AND (expires_at IS NULL OR expires_at>?)',
    )
    .get(noteId, Date.now());
}
export function assertSharePrincipal(
  db: AppDatabase,
  p: Principal,
  noteId: string,
  path: string,
  permission: SharePermission = 'view',
) {
  if (!isSharePrincipal(p)) return;
  const row = db
    .prepare(
      'SELECT s.*,n.active,n.path FROM shares s JOIN notes n ON n.id=s.note_id WHERE s.note_id=?',
    )
    .get(noteId) as (ShareRow & { active: number; path: string }) | undefined;
  if (
    !row ||
    !row.active ||
    row.path !== path ||
    p.clientId !== 'public-reader' ||
    p.id !== shareIdentity(row.token) ||
    shareState(row) !== 'active'
  )
    throw new HttpError(404, '分享不存在或已不可用');
  if (permission === 'edit' && row.permission !== 'edit')
    throw new HttpError(403, '此分享仅允许查看');
}
