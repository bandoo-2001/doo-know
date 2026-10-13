import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/contracts.js';
import type { Principal, NoteInfo } from '../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { safePath } from '../files.js';
import { authorizeAgent, authorizePath, requireScope, underPrefix } from './auth.js';
import { KnowledgeError, fail } from '../knowledge/errors.js';
import { mutationCore } from '../knowledge/core.js';
import { findOperation } from '../knowledge/operations.js';
import { snapshotService } from '../knowledge/snapshots.js';
import { fileJobService } from '../knowledge/file-jobs.js';
export function metadataService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  return async function getNoteInfo(p: Principal, id: string): Promise<NoteInfo> {
    const row = notes.row(id);
    authorizePath(p, row.path);
    const s = await stat(safePath(config.knowledgeRoot, row.path, 'note'), { bigint: true });
    const state = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(id) as any;
    const ready =
      state?.mtime_ns === s.mtimeNs.toString() &&
      state?.size_bytes === Number(s.size) &&
      state?.longest_line_bytes != null;
    return {
      id,
      title: ready && state.title ? state.title : basename(row.path, '.md'),
      relativePath: row.path,
      url: `${config.origin}/?note=${encodeURIComponent(id)}`,
      sizeBytes: Number(s.size),
      modifiedAt: s.mtimeNs.toString(),
      contentHash: ready ? state.content_hash : null,
      longestLineBytes: ready ? state.longest_line_bytes : null,
      editorMode:
        s.size > 20n * 1024n * 1024n
          ? 'metadata'
          : !ready || s.size > 1024n * 1024n || state.longest_line_bytes > 32768
            ? 'large'
            : 'full',
      readState: ready ? 'ready' : 'unknown',
      shared: !!db.prepare('SELECT 1 FROM shares WHERE note_id=? AND enabled=1').get(id),
    };
  };
}
export async function registerAgentRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
) {
  const core = mutationCore(config, db);
  await core.recover();
  const snapshots = snapshotService(config, db, notes);
  const files = fileJobService(config, db, notes, snapshots);
  await app.register(
    async (api) => {
      api.addHook('onRoute', (route) => {
        route.bodyLimit = 128 * 1024;
      });
      api.addHook('onRequest', async (req) => {
        (req as any).principal = authorizeAgent(req, config.agent);
        if (req.headers['content-encoding']) fail(415, 'COMPRESSED_REQUEST_NOT_ALLOWED');
      });
      api.setErrorHandler((error, _req, reply) => {
        const e = error as KnowledgeError;
        const status = e.statusCode || 500;
        reply
          .code(status)
          .send({
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
        const q = req.query as { limit?: string; cursor?: string };
        const limit = Math.min(50, Math.max(1, Number(q.limit) || 10)),
          offset = Number(q.cursor) || 0;
        const rows = (
          db.prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path').all() as {
            id: string;
            path: string;
          }[]
        ).filter((n) => p.allowedPrefixes.some((prefix) => underPrefix(n.path, prefix)));
        const items = await Promise.all(
          rows.slice(offset, offset + limit).map((n) => info(p, n.id)),
        );
        return {
          data: {
            items,
            ...(offset + items.length < rows.length
              ? { nextCursor: String(offset + items.length) }
              : {}),
          },
        };
      });
      api.get<{ Params: { id: string } }>('/notes/:id', async (req) => ({
        data: await info((req as any).principal, req.params.id),
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
  return { snapshots, files, core, info: metadataService(config, db, notes) };
}
