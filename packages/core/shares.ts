import { randomBytes } from 'node:crypto';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
import { KnowledgeError } from './knowledge/errors.js';
import { isWhiteboard } from '../../shared/whiteboard.js';
import type { PublicShareAccess, ShareOptions, ShareStatus } from '../../shared/share-contracts.js';
import { shareIdentity, shareState, type ShareRow } from './share-policy.js';
export function shareService(db: AppDatabase, notes: NoteService) {
  function editSupport(id: string) {
    if (isWhiteboard(notes.row(id).path))
      return { editSupported: false, editUnavailableReason: '白板分享暂不支持公开编辑' };
    try {
      notes.getNote(id);
      return { editSupported: true };
    } catch (error) {
      if (
        error instanceof KnowledgeError &&
        ['LARGE_FILE_MODE_REQUIRED', 'FILE_TOO_LARGE'].includes(error.code)
      )
        return {
          editSupported: false,
          editUnavailableReason: '大文件或长行文档暂不支持公开编辑，请由所有者编辑',
        };
      throw error;
    }
  }
  function describe(id: string, support: ReturnType<typeof editSupport>): ShareStatus {
    const s = db
      .prepare('SELECT token,enabled,permission,expires_at FROM shares WHERE note_id=?')
      .get(id) as ShareRow | undefined;
    const state = shareState(s);
    return {
      enabled: state === 'active',
      state,
      permission: s?.permission || 'view',
      expiresAt: s?.expires_at == null ? null : new Date(s.expires_at).toISOString(),
      ...support,
      ...(s && state !== 'revoked' ? { token: s.token, url: `/s/${s.token}` } : {}),
    };
  }
  function status(id: string): ShareStatus {
    notes.exists(id);
    return describe(id, editSupport(id));
  }
  function create(id: string, reset = false, input?: unknown) {
    notes.exists(id);
    if (
      input !== undefined &&
      (!input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !['permission', 'expiresAt'].includes(key)))
    )
      throw new HttpError(400, '分享设置格式不正确');
    const options = input as ShareOptions | undefined;
    const explicit = !!options && Object.keys(options).length > 0;
    const old = status(id);
    const permission =
      options?.permission === undefined
        ? old.enabled
          ? old.permission
          : 'view'
        : options.permission;
    if (!['view', 'edit'].includes(permission)) throw new HttpError(400, '分享权限不正确');
    let expiresAt: number | null =
      options?.expiresAt === undefined && old.enabled && old.expiresAt !== null
        ? Date.parse(old.expiresAt)
        : null;
    if (options?.expiresAt !== undefined && options.expiresAt !== null) {
      if (
        typeof options.expiresAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(options.expiresAt)
      )
        throw new HttpError(400, '分享到期时间格式不正确');
      const [year, month, day] = options.expiresAt.slice(0, 10).split('-').map(Number);
      if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      )
        throw new HttpError(400, '分享到期时间格式不正确');
      expiresAt = Date.parse(options.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new HttpError(400, '分享到期时间必须晚于当前时间');
    }
    if (permission === 'edit' && !old.editSupported)
      throw new HttpError(400, old.editUnavailableReason!);
    if (old.enabled && !reset && !explicit) return old;
    const token = old.enabled && !reset ? old.token! : randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO shares(note_id,token,enabled,permission,expires_at) VALUES(?,?,1,?,?) ON CONFLICT(note_id) DO UPDATE SET token=excluded.token,enabled=1,permission=excluded.permission,expires_at=excluded.expires_at',
    ).run(id, token, permission, expiresAt);
    return status(id);
  }
  function revoke(id: string) {
    notes.row(id);
    db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
    let support: ReturnType<typeof editSupport> = {
      editSupported: false,
      editUnavailableReason: '当前原文不可用，暂不支持公开编辑',
    };
    try {
      support = editSupport(id);
    } catch {
      /* A completed revocation does not depend on reading the source. */
    }
    return describe(id, support);
  }
  function lookup(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, '分享不存在或已取消');
    const s = db
      .prepare(
        'SELECT note_id FROM shares WHERE token=? AND enabled=1 AND (expires_at IS NULL OR expires_at>?)',
      )
      .get(token, Date.now()) as { note_id: string } | undefined;
    if (!s) throw new HttpError(404, '分享不存在或已取消');
    return notes.exists(s.note_id);
  }
  function access(token: string): PublicShareAccess {
    const n = lookup(token),
      s = status(n.id);
    lookup(token);
    return {
      permission: s.permission,
      expiresAt: s.expiresAt,
      canEdit: s.permission === 'edit' && s.editSupported,
      ...(!s.editSupported ? { editUnavailableReason: s.editUnavailableReason } : {}),
    };
  }
  function principal(token: string) {
    const n = lookup(token),
      row = db.prepare('SELECT permission FROM shares WHERE note_id=?').get(n.id) as {
        permission: string;
      };
    return {
      n,
      p: {
        id: shareIdentity(token),
        clientId: 'public-reader',
        scopes: ['knowledge:read', ...(row.permission === 'edit' ? ['knowledge:write'] : [])],
        allowedPrefixes: [n.path],
      },
    };
  }
  function document(token: string) {
    const s = lookup(token);
    try {
      return notes.getNote(s.id);
    } catch (e) {
      if (e instanceof KnowledgeError) throw e;
      db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(s.id);
      throw new HttpError(404, '分享不存在或已取消');
    }
  }
  return { status, create, revoke, document, lookup, access, principal };
}
