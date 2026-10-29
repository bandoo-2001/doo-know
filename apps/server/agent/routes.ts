import {isWhiteboard,documentTitle,MAX_WHITEBOARD_BYTES} from '../../../shared/whiteboard.js';
import { hasActiveShare } from '../../../packages/core/share-policy.js';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal, NoteInfo } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import { safePath } from '../../../packages/core/files.js';
import {
  authorizeAgent,
  authorizePath,
  requireScope,
  underPrefix,
  authorizationCutoff,
} from '../../../packages/core/agent/auth.js';
import { KnowledgeError, fail } from '../../../packages/core/knowledge/errors.js';
import { mutationCore } from '../../../packages/core/knowledge/core.js';
import { findOperation } from '../../../packages/core/knowledge/operations.js';
import { snapshotService } from '../../../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../../../packages/core/knowledge/file-jobs.js';
import { currentAgentConfig, projectMachinePrincipal } from '../../../packages/core/agent/config.js';
import { reconcileService, assertRoot } from '../../../packages/core/indexing/reconcile.js';
import { startWatcher } from '../../../packages/core/indexing/watcher.js';
import { syncService } from '../../../packages/core/indexing/sync.js';
import { indexWorker } from '../../../packages/core/indexing/worker.js';
import { searchService } from '../../../packages/core/search/service.js';
import { researchService } from '../../../packages/core/search/research.js';
import { decodeCursor, signCursor } from '../../../packages/core/agent/budgets.js';
import { recallFilter } from '../../../packages/core/search/filters.js';
import { sha256 } from '../../../packages/core/knowledge/operations.js';
import { validateRelative } from '../../../packages/core/files.js';
import { messageSize } from '../../../packages/core/knowledge/limits.js';
import { setDesiredEmbeddingSpace } from '../../../packages/core/indexing/space.js';
import { organizationService } from '../../../packages/core/organization/service.js';
import { syncDirectoryCatalog } from '../../../packages/core/organization/catalog.js';
import { organizationPending } from '../../../packages/core/organization/schema.js';
export function metadataService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  return async function getNoteInfo(p: Principal, id: string): Promise<NoteInfo> {
    const row = notes.row(id);
    authorizePath(p, row.path);
    const s = await stat(safePath(config.knowledgeRoot, row.path, 'note'), { bigint: true });
    const state = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(id) as any;
    const known = state?.mtime_ns === s.mtimeNs.toString() && state?.size_bytes === Number(s.size);
    const ready = known && state?.longest_line_bytes != null;
    return {
      id,
      ...(isWhiteboard(row.path) ? {documentType: 'whiteboard' as const} : {}),
      title: [...(ready && state.title ? state.title : documentTitle(row.path))]
        .slice(0, 256)
        .join(''),
      relativePath: row.path,
      url: `${config.origin}/?note=${encodeURIComponent(id)}`,
      sizeBytes: Number(s.size),
      modifiedAt: s.mtimeNs.toString(),
      contentHash: known ? state.content_hash : null,
      sourceRevision: known ? state.source_revision : null,
      longestLineBytes: ready ? state.longest_line_bytes : null,
      editorMode: isWhiteboard(row.path) ? (s.size <= BigInt(MAX_WHITEBOARD_BYTES) ? 'full' : 'metadata') :
        s.size > 20n * 1024n * 1024n
          ? 'metadata'
          : !ready || s.size > 1024n * 1024n || state.longest_line_bytes > 32768
            ? 'large'
            : 'full',
      readState: isWhiteboard(row.path) ? 'ready' : ready
        ? 'ready'
        : db
              .prepare(
                "SELECT 1 FROM file_operations WHERE note_id=? AND kind='prepare_snapshot' AND status IN ('queued','running')",
              )
              .get(id)
          ? 'preparing'
          : 'unknown',
      shared: hasActiveShare(db, id),
    };
  };
}
export async function createKnowledgeRuntime(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
) {
  const organization = organizationService(config, db, notes);
  await organization.recover();
  syncDirectoryCatalog(config, db);
  const core = mutationCore(config, db);
  await core.recover();
  notes.scan();
  const snapshots = snapshotService(config, db, notes);
  const files = fileJobService(config, db, notes, snapshots);
  const indexing = reconcileService(config, db);
  setDesiredEmbeddingSpace(db, config);
  let worker = indexWorker(config, db, notes, snapshots),
    search = searchService(config, db, notes, indexing, worker);
  const research = researchService(config, db, notes);
  await snapshots.recover();
  await files.recover();
  let stopWatching = () => {};
  if (config.indexing?.enabled !== false) {
    await syncService(config, db, indexing).recover();
    await indexing.reconcile(undefined, true);
    stopWatching = startWatcher(config, db, indexing);
  }
  const workerTimer =
    config.indexing?.enabled !== false && config.indexing?.embedded !== false
      ? setInterval(() => void worker.drain(), 1000)
      : undefined;
  workerTimer?.unref();
  let maintenanceRunning: Promise<void> | undefined;
  const maintenanceTimer =
    config.fileTasks?.embedded !== false
      ? setInterval(() => {
          if (maintenanceRunning) return;
          maintenanceRunning = (async () => {
            await organization.recover();
            await organization.drain();
            await organization.cleanup();
            await core.recover();
            await snapshots.recover();
            await files.recover();
            await files.drain();
            await snapshots.drain();
            await snapshots.clean();
            db.prepare("DELETE FROM index_meta WHERE key='file_maintenance_error'").run();
          })()
            .catch(() => {
              db.prepare(
                "INSERT INTO index_meta VALUES('file_maintenance_error','FILE_MAINTENANCE_FAILED') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              ).run();
            })
            .finally(() => {
              maintenanceRunning = undefined;
            });
        }, 1000)
      : undefined;
  maintenanceTimer?.unref();
  return {
    organization,
    snapshots,
    files,
    core,
    indexing,
    get worker() {
      return worker;
    },
    get search() {
      return search;
    },
    reconfigureSearch: async (updates: Partial<AppConfig>) => {
      await worker.close();
      Object.assign(config, updates);
      setDesiredEmbeddingSpace(db, config);
      worker = indexWorker(config, db, notes, snapshots);
      search = searchService(config, db, notes, indexing, worker);
    },
    research,
    stopWatching: async () => {
      stopWatching();
      if (workerTimer) clearInterval(workerTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      await maintenanceRunning;
      await organization.close();
    },
    info: metadataService(config, db, notes),
  };
}
export type KnowledgeRuntime = Awaited<ReturnType<typeof createKnowledgeRuntime>>;
export async function registerAgentRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  supplied?: () => KnowledgeRuntime,
) {
  const ready = supplied ? undefined : await createKnowledgeRuntime(config, db, notes);
  const get = supplied || (() => ready!);
  const service = <T extends object>(read: () => T): T =>
    new Proxy({} as T, {
      get:
        (_target, key) =>
        (...args: unknown[]) => {
          const object = read();
          const value = (object as any)[key];
          return typeof value === 'function' ? value.apply(object, args) : value;
        },
    });
  const core = service(() => get().core),
    snapshots = service(() => get().snapshots),
    files = service(() => get().files),
    indexing = service(() => get().indexing),
    search = service(() => get().search),
    research = service(() => get().research);
  await app.register(
    async (api) => {
      api.addHook('onRoute', (route) => {
        route.bodyLimit = 128 * 1024;
      });
      api.addHook('onRequest', async (req) => {
        let authenticated: Principal;
        try {
          authenticated = authorizeAgent(
            req,
            currentAgentConfig(config),
            authorizationCutoff(db),
          );
        } catch {
          fail(401, 'UNAUTHORIZED');
        }
        assertRoot(config, db);
        if (!organizationPending(db)) syncDirectoryCatalog(config, db);
        const projected = projectMachinePrincipal(config, db, authenticated);
        if (!projected) fail(401, 'UNAUTHORIZED');
        (req as any).principal = projected;
        if (req.headers['content-encoding']) fail(415, 'COMPRESSED_REQUEST_NOT_ALLOWED');
      });
      api.setErrorHandler((error, _req, reply) => {
        const e = error as KnowledgeError;
        const status = e.statusCode || 500;
        reply.code(status).send({
          error: {
            code:
              e instanceof KnowledgeError
                ? e.code
                : status === 413
                  ? 'REQUEST_TOO_LARGE'
                  : status === 404
                    ? 'NOT_FOUND'
                    : status === 400
                      ? 'INVALID_INPUT'
                      : 'INTERNAL_ERROR',
            message: e instanceof KnowledgeError ? e.message : '操作未完成',
            retryable: e.retryable || false,
          },
        });
      });
      const info = metadataService(config, db, notes);
      api.get('/notes', async (req) => {
        const p = (req as any).principal as Principal;
        requireScope(p, 'knowledge:read');
        notes.scan();
        const q = req.query as { limit?: string; cursor?: string; directory?: string };
        if (q.directory) {
          try {
            validateRelative(q.directory, 'folder');
          } catch {
            fail(400, 'INVALID_DIRECTORY');
          }
        }
        const limit = Number(q.limit || 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'INVALID_LIMIT');
        const fingerprint = sha256(
          JSON.stringify([p.id, p.clientId, p.allowedPrefixes, p.knowledgeAll, p.permissionPolicy, q.directory, limit]),
        );
        let offset = 0;
        if (q.cursor) {
          const c = decodeCursor(config.secret, q.cursor);
          if (c.fingerprint !== fingerprint) fail(403, 'FORBIDDEN');
          if (c.expires <= Date.now()) fail(410, 'CURSOR_EXPIRED');
          offset = c.offset;
        }
        const filter = recallFilter(p, { directory: q.directory }, 'n.path');
        const rows = db
          .prepare(
            `SELECT n.id,n.path FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND (${filter.sql}) ORDER BY n.path LIMIT ? OFFSET ?`,
          )
          .all(...filter.values, limit + 1, offset) as { id: string; path: string }[];
        let items = await Promise.all(rows.slice(0, limit).map((n) => info(p, n.id)));
        const output = () => ({
          items,
          ...(rows.length > items.length
            ? {
                nextCursor: signCursor(config.secret, {
                  fingerprint,
                  offset: offset + items.length,
                  expires: Date.now() + 15 * 60000,
                }),
              }
            : {}),
        });
        while (items.length && messageSize(output()) > 64512) items = items.slice(0, -1);
        if (!items.length && rows.length) fail(413, 'RESPONSE_TOO_LARGE');
        return { data: output() };
      });
      api.get<{ Params: { id: string } }>('/notes/:id', async (req) => ({
        data: await info((req as any).principal, req.params.id),
      }));
      api.post('/index/refresh', async (req) => ({
        data: await indexing.refresh((req as any).principal, req.body as any),
      }));
      api.post('/search', async (req) => ({
        data: await search.search((req as any).principal, req.body as any),
      }));
      api.get<{ Params: { id: string } }>('/notes/:id/research', async (req) => ({
        data: await research.fetch(
          (req as any).principal,
          req.params.id,
          undefined,
          req.query as any,
        ),
      }));
      api.get<{ Params: { id: string; chunkId: string } }>(
        '/notes/:id/chunks/:chunkId',
        async (req) => ({
          data: await research.fetch(
            (req as any).principal,
            req.params.id,
            req.params.chunkId,
            req.query as any,
          ),
        }),
      );
      api.get('/index/status', async (req) => ({
        data: indexing.status((req as any).principal, req.query as any),
      }));
      api.post<{ Params: { id: string } }>('/notes/:id/read', async (req) => ({
        data: await snapshots.read(
          (req as any).principal,
          req.params.id,
          (req.body || {}) as any,
          'mcp',
        ),
      }));
      api.get<{ Params: { id: string } }>('/notes/:id/outline', async (req) => ({
        data: await snapshots.outline(
          (req as any).principal,
          req.params.id,
          (req.query as any).cursor,
        ),
      }));
      api.post<{ Params: { id: string } }>('/notes/:id/patch', async (req) => ({
        data: await files.submit((req as any).principal, req.params.id, req.body as any),
      }));
      api.post('/notes', async (req, reply) => {
        const p = (req as any).principal as Principal;
        requireScope(p, 'knowledge:write');
        const b = req.body as any;
        if (typeof b?.content !== 'string' || Buffer.byteLength(b.content) > 32768)
          fail(413, 'REQUEST_TOO_LARGE');
        return reply
          .code(201)
          .send({ data: core.create(p, b.directory, b.fileName, b.content, b.requestId) });
      });
      api.put<{ Params: { id: string } }>('/notes/:id', async (req) => {
        const p = (req as any).principal as Principal;
        requireScope(p, 'knowledge:write');
        const b = req.body as any;
        if (typeof b?.content !== 'string' || Buffer.byteLength(b.content) > 32768)
          fail(413, 'REQUEST_TOO_LARGE');
        return {
          data: core.update(p, req.params.id, b.content, b.expectedModifiedAt, b.requestId),
        };
      });
      api.post<{ Params: { id: string } }>('/notes/:id/archive', async (req) => {
        const p = (req as any).principal as Principal;
        requireScope(p, 'knowledge:write');
        const b = req.body as any;
        return { data: core.archive(p, req.params.id, b?.expectedModifiedAt, b?.requestId) };
      });
      const operation = (p: Principal, key: { id?: string; requestId?: string }) => {
        requireScope(p, 'knowledge:read');
        const op = findOperation(db, p, key);
        if (db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId))
          return { data: files.operation(p, op.operationId) };
        const row = db.prepare('SELECT path FROM write_intents WHERE id=?').get(op.operationId) as
          | { path: string }
          | undefined;
        if (row) authorizePath(p, row.path);
        return { data: op };
      };
      api.get('/operations', async (req) =>
        operation((req as any).principal, { requestId: (req.query as any).requestId }),
      );
      api.get<{ Params: { id: string } }>('/operations/:id', async (req) =>
        operation((req as any).principal, { id: req.params.id }),
      );
      api.post<{ Params: { id: string } }>('/operations/:id/cancel', async (req) => ({
        data: files.cancel((req as any).principal, req.params.id),
      }));
    },
    { prefix: '/api/agent/v1' },
  );
  return new Proxy({} as KnowledgeRuntime, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      const object = get();
      const value = (object as any)[key];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}
