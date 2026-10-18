import { createHmac, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type {
  ManagementBatchInput,
  ManagementBatchResult,
  ManagementDiagnostics,
  ManagementOverview,
  ManagementPage,
  ManagementShare,
  ManagementSession,
  ManagementTrashItem,
  ManagementTrashPage,
  ManagementItemResult,
} from '../../../shared/management-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { createAuth } from '../auth.js';
import type { platformRuntime } from './runtime.js';
import { fail, KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  sha256,
} from '../../../packages/core/knowledge/operations.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { workspaceWriteSync, workspaceExclusive } from '../../../packages/core/workspace/gate.js';
import { releaseInfo } from './release.js';
import { managementStorage } from './management-storage.js';
import { trashFile, purgeTrashFile } from './management-trash.js';

type Platform = Pick<ReturnType<typeof platformRuntime>, 'get' | 'status' | 'settings'>;
type TrashProof = { name: string; fingerprint: string };
function batchInput(value: unknown): ManagementBatchInput {
  const b = value as ManagementBatchInput | undefined;
  if (
    !b ||
    !Array.isArray(b.ids) ||
    b.ids.length < 1 ||
    b.ids.length > 100 ||
    new Set(b.ids).size !== b.ids.length ||
    b.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    fail(400, 'INVALID_IDS');
  if (
    typeof b.requestId !== 'string' ||
    !b.requestId.length ||
    b.requestId.length > 128 ||
    /[\x00-\x1f]/.test(b.requestId)
  )
    fail(400, 'INVALID_REQUEST_ID');
  return { ids: b.ids, requestId: b.requestId };
}
const itemError = (id: string, error: unknown): ManagementItemResult => ({
  id,
  ok: false,
  code:
    error instanceof KnowledgeError
      ? error.code
      : ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code || '')
        ? 'TRASH_UNAVAILABLE'
        : 'OPERATION_FAILED',
});

export function registerManagementRoutes(
  app: FastifyInstance,
  config: HostConfig,
  db: AppDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  platform: Platform,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS management_trash_snapshots(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,items TEXT NOT NULL,expires_at INTEGER NOT NULL);`,
  );
  const sessionId = (id: string) =>
    createHmac('sha256', config.secret)
      .update('manage-session:' + id)
      .digest('base64url');
  const owner = (req: FastifyRequest) => {
    const id = (req as FastifyRequest & { ownerId?: string }).ownerId;
    if (!id || !db.prepare('SELECT 1 FROM user WHERE id=?').get(id)) fail(401, 'UNAUTHORIZED');
    return id;
  };
  const release = () => ({
    version: releaseInfo(config.applicationRoot).version,
    environment: (config as HostConfig & { environment?: string }).environment || 'unspecified',
  });
  function pageQuery(req: FastifyRequest, kind: string) {
    const q = req.query as Record<string, unknown>;
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_LIMIT');
    if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 200))
      fail(400, 'INVALID_FILTER');
    const filter = typeof q.q === 'string' ? q.q.trim() : '';
    let after = '';
    const context = JSON.stringify([kind, filter, q.enabled ?? null]);
    if (q.cursor !== undefined) {
      if (typeof q.cursor !== 'string' || q.cursor.length > 2048) fail(400, 'INVALID_CURSOR');
      try {
        const [payload, signature, extra] = q.cursor.split('.');
        if (
          extra !== undefined ||
          !payload ||
          signature !== createHmac('sha256', config.secret).update(payload).digest('base64url')
        )
          fail(400, 'INVALID_CURSOR');
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (
          parsed.context !== context ||
          typeof parsed.after !== 'string' ||
          parsed.after.length > 256
        )
          fail(400, 'INVALID_CURSOR');
        after = parsed.after;
      } catch {
        fail(400, 'INVALID_CURSOR');
      }
    }
    const cursor = (after: string) => {
      const payload = Buffer.from(JSON.stringify({ context, after })).toString('base64url');
      return (
        payload + '.' + createHmac('sha256', config.secret).update(payload).digest('base64url')
      );
    };
    return { limit, filter, after, cursor };
  }
  function batch(
    ownerId: string,
    kind: string,
    input: ManagementBatchInput,
    params: unknown,
    work: () => ManagementItemResult[],
  ): ManagementBatchResult {
    const started = db
      .transaction(() =>
        beginOperation(
          db,
          { ...webPrincipal, id: ownerId, clientId: 'management-web' },
          'management_' + kind,
          input.requestId,
          params,
        ),
      )
      .immediate();
    if (!started.fresh) return existingResult(started.operation);
    const result = { results: work() };
    completeOperation(db, started.operation.id, result);
    return result;
  }

  app.get('/api/manage/overview', async (req): Promise<ManagementOverview> => {
    const id = owner(req),
      status = platform.status();
    const user = db.prepare('SELECT name,username FROM user WHERE id=?').get(id) as {
      name: string;
      username: string | null;
    };
    return {
      username: user.username || user.name,
      library: {
        name: status.knowledgeRoot ? basename(status.knowledgeRoot) : null,
        path: status.knowledgeRoot || null,
        timeZone: status.timeZone,
        ready: status.components.knowledge,
      },
      release: release(),
      capabilities: {
        shares: status.components.knowledge,
        trash: status.components.knowledge,
        sessions: true,
        diagnostics: true,
      },
    };
  });
  app.get('/api/manage/storage', async (req) => {
    owner(req);
    const status = platform.status();
    return managementStorage(
      config,
      status.components.knowledge ? status.knowledgeRoot : undefined,
    );
  });
  app.get('/api/manage/shares', async (req): Promise<ManagementPage<ManagementShare>> => {
    owner(req);
    platform.get();
    const { limit, filter, after, cursor } = pageQuery(req, 'shares');
    const enabled = (req.query as { enabled?: unknown }).enabled;
    if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
      fail(400, 'INVALID_FILTER');
    const rows = db
      .prepare(
        `SELECT n.id,n.path,d.title,s.enabled,s.token FROM shares s JOIN notes n ON n.id=s.note_id LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND n.id>? AND (?='' OR instr(lower(n.path),lower(?))>0 OR instr(lower(coalesce(d.title,'')),lower(?))>0) AND (? IS NULL OR s.enabled=?) ORDER BY n.id LIMIT ?`,
      )
      .all(
        after,
        filter,
        filter,
        filter,
        enabled === undefined ? null : enabled === 'true' ? 1 : 0,
        enabled === 'true' ? 1 : 0,
        limit + 1,
      ) as { id: string; path: string; title: string | null; enabled: number; token: string }[];
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title || basename(r.path, '.md'),
      relativePath: r.path,
      enabled: !!r.enabled,
      url: r.enabled ? `/s/${r.token}` : null,
    }));
    return { items, nextCursor: rows.length > limit ? cursor(items.at(-1)!.id) : null };
  });
  app.post('/api/manage/shares/revoke', async (req) => {
    const id = owner(req),
      input = batchInput(req.body);
    platform.get();
    return workspaceWriteSync(db, { kind: 'management.shares' }, () =>
      batch(id, 'shares_revoke', input, input.ids, () =>
        input.ids.map((noteId) => {
          try {
            if (!db.prepare('SELECT 1 FROM shares WHERE note_id=?').get(noteId))
              fail(404, 'NOT_FOUND');
            db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(noteId);
            return { id: noteId, ok: true };
          } catch (e) {
            return itemError(noteId, e);
          }
        }),
      ),
    );
  });
  async function sessions(req: FastifyRequest) {
    const ownerId = owner(req),
      headers = fromNodeHeaders(req.headers);
    const current = await auth.api.getSession({ headers });
    if (!current || current.user.id !== ownerId) fail(401, 'UNAUTHORIZED');
    const items = await auth.api.listSessions({ headers });
    return { current, items, headers };
  }
  app.get('/api/manage/sessions', async (req): Promise<ManagementPage<ManagementSession>> => {
    const { items, current } = await sessions(req),
      { limit, after, cursor } = pageQuery(req, 'sessions');
    const safe = items
      .map((s) => ({
        id: sessionId(s.id),
        device: (s.userAgent || '未知设备').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180),
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
        expiresAt: new Date(s.expiresAt).toISOString(),
        current: s.id === current.session.id,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((s) => s.id > after);
    return {
      items: safe.slice(0, limit),
      nextCursor: safe.length > limit ? cursor(safe[limit - 1].id) : null,
    };
  });
  app.delete<{ Params: { id: string } }>('/api/manage/sessions/:id', async (req) => {
    const { items, current, headers } = await sessions(req);
    const selected = items.find((s) => sessionId(s.id) === req.params.id);
    if (!selected) fail(404, 'SESSION_NOT_FOUND');
    if (selected.id === current.session.id)
      fail(409, 'CURRENT_SESSION', '请使用退出登录结束当前会话');
    await auth.api.revokeSession({ headers, body: { token: selected.token } });
    return { revoked: true };
  });
  app.post('/api/manage/sessions/revoke-others', async (req) => {
    const { headers } = await sessions(req);
    await auth.api.revokeOtherSessions({ headers });
    return { revoked: true };
  });
  app.get('/api/manage/diagnostics', async (req): Promise<ManagementDiagnostics> => {
    owner(req);
    const s = platform.status();
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      generatedAt: new Date().toISOString(),
      release: release(),
      platform: { phase: s.phase, knowledge: s.components.knowledge, search: s.components.search },
      counts: {
        activeNotes: count('SELECT count(*) n FROM notes WHERE active=1'),
        trashNotes: count('SELECT count(*) n FROM notes WHERE active=0 AND trash_path IS NOT NULL'),
        enabledShares: count(
          'SELECT count(*) n FROM shares s JOIN notes n ON n.id=s.note_id WHERE s.enabled=1 AND n.active=1',
        ),
        writeConflicts: count("SELECT count(*) n FROM write_intents WHERE status='conflicted'"),
      },
      scope: 'redacted-status-only',
    };
  });
  app.get('/api/manage/trash', async (req): Promise<ManagementTrashPage> => {
    const ownerId = owner(req),
      runtime = platform.get(),
      { limit, filter, after, cursor } = pageQuery(req, 'trash');
    const rows = db
      .prepare(
        `SELECT n.id,n.path,n.trash_path,(SELECT max(o.updated_at) FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.note_id=n.id AND w.kind='archive' AND w.status='recorded') deleted_at FROM notes n WHERE n.active=0 AND n.trash_path IS NOT NULL AND n.id>? AND (?='' OR instr(lower(n.path),lower(?))>0) ORDER BY n.id LIMIT ?`,
      )
      .all(after, filter, filter, limit + 1) as {
      id: string;
      path: string;
      trash_path: string;
      deleted_at: number | null;
    }[];
    const proof: Record<string, TrashProof> = Object.create(null);
    const items: ManagementTrashItem[] = rows.slice(0, limit).map((r) => {
      let sizeBytes: number | null = null;
      try {
        trashFile(runtime.config.knowledgeRoot, r.id, r.trash_path, (_file, fingerprint, size) => {
          sizeBytes = size;
          proof[r.id] = { name: r.trash_path, fingerprint };
        });
      } catch {
        /* Unavailable files stay visible but cannot be purged. */
      }
      return {
        id: r.id,
        title: basename(r.path, '.md'),
        relativePath: r.path,
        deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
        sizeBytes,
        available: sizeBytes !== null,
      };
    });
    const snapshotId = randomUUID();
    db.transaction(() => {
      db.prepare('DELETE FROM management_trash_snapshots WHERE expires_at<?').run(Date.now());
      db.prepare(
        'DELETE FROM management_trash_snapshots WHERE owner_id=? AND id NOT IN (SELECT id FROM management_trash_snapshots WHERE owner_id=? ORDER BY expires_at DESC LIMIT 19)',
      ).run(ownerId, ownerId);
      db.prepare('INSERT INTO management_trash_snapshots VALUES(?,?,?,?)').run(
        snapshotId,
        ownerId,
        JSON.stringify(proof),
        Date.now() + 30 * 60000,
      );
    }).immediate();
    return { items, nextCursor: rows.length > limit ? cursor(items.at(-1)!.id) : null, snapshotId };
  });
  app.post('/api/manage/trash/restore', async (req) => {
    const ownerId = owner(req),
      input = batchInput(req.body),
      runtime = platform.get();
    const fileNames = (req.body as { fileNames?: Record<string, unknown> }).fileNames ?? {};
    if (
      typeof fileNames !== 'object' ||
      Array.isArray(fileNames) ||
      Object.keys(fileNames).some(
        (id) => !input.ids.includes(id) || typeof fileNames[id] !== 'string',
      )
    )
      fail(400, 'INVALID_FILE_NAMES');
    return workspaceWriteSync(db, { kind: 'management.restore' }, () =>
      batch(ownerId, 'trash_restore', input, { ids: input.ids, fileNames }, () =>
        input.ids.map((id) => {
          try {
            runtime.recovery.restore(
              id,
              fileNames[id] as string | undefined,
              sha256(JSON.stringify([ownerId, input.requestId, id])),
            );
            const row = db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(id) as
              | { path: string }
              | undefined;
            if (!row) fail(409, 'RESTORE_UNAVAILABLE');
            return { id, ok: true, relativePath: row.path };
          } catch (e) {
            return itemError(id, e);
          }
        }),
      ),
    );
  });
  app.post('/api/manage/trash/purge', async (req) => {
    const ownerId = owner(req),
      input = batchInput(req.body),
      runtime = platform.get();
    const b = req.body as { snapshotId?: unknown; confirm?: unknown };
    if (b.confirm !== 'PERMANENTLY_DELETE' || typeof b.snapshotId !== 'string')
      fail(400, 'PURGE_CONFIRMATION_REQUIRED');
    // Check the exact selected scope before creating a durable operation. A retry of an
    // already completed request uses its saved receipt even after the snapshot expires.
    const params = { ids: input.ids, snapshotId: b.snapshotId, confirm: b.confirm };
    const prior = db
      .prepare(
        "SELECT * FROM operations WHERE principal=? AND client_id='management-web' AND kind='management_trash_purge' AND request_id=?",
      )
      .get(ownerId, input.requestId);
    if (!prior) {
      const snapshot = db
        .prepare(
          'SELECT items FROM management_trash_snapshots WHERE id=? AND owner_id=? AND expires_at>?',
        )
        .get(b.snapshotId, ownerId, Date.now()) as { items: string } | undefined;
      if (!snapshot) fail(409, 'TRASH_SNAPSHOT_EXPIRED');
      const proof = JSON.parse(snapshot.items) as Record<string, TrashProof>;
      if (input.ids.some((id) => !Object.hasOwn(proof, id))) fail(409, 'TRASH_SCOPE_MISMATCH');
    }
    const result = await workspaceExclusive(
      db,
      { kind: 'management.purge', waitMs: 1000 },
      async () =>
        batch(ownerId, 'trash_purge', input, params, () => {
          const snapshot = db
            .prepare(
              'SELECT items FROM management_trash_snapshots WHERE id=? AND owner_id=? AND expires_at>?',
            )
            .get(b.snapshotId, ownerId, Date.now()) as { items: string } | undefined;
          if (!snapshot) fail(409, 'TRASH_SNAPSHOT_EXPIRED');
          const proof = JSON.parse(snapshot.items) as Record<string, TrashProof>;
          return input.ids.map((id) => {
            try {
              if (!Object.hasOwn(proof, id)) fail(409, 'TRASH_SCOPE_MISMATCH');
              return purgeTrashFile(db, runtime.config.knowledgeRoot, id, proof[id]);
            } catch (e) {
              return itemError(id, e);
            }
          });
        }),
    );
    return {
      ...result,
      scope: 'selected-trash-source-files' as const,
      retained: ['history', 'backups', 'metadata'] as const,
    };
  });
}
