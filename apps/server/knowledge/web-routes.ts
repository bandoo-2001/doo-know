import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { acquireRead, chargeRate } from '../../../packages/core/agent/budgets.js';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { registerAgentRoutes } from '../agent/routes.js';
import type { shareService } from '../../../packages/core/shares.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { readBlocks } from '../../../packages/core/knowledge/file-reader.js';
import { sha256, findOperation } from '../../../packages/core/knowledge/operations.js';
import { authorizePath } from '../../../packages/core/agent/auth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export async function registerWebKnowledgeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  knowledge: Awaited<ReturnType<typeof registerAgentRoutes>>,
  shares: ReturnType<typeof shareService>,
  verifySession: (req: FastifyRequest) => Promise<boolean>,
) {
  app.post('/api/search/advanced', { bodyLimit: 128 * 1024 }, async (req) =>
    knowledge.search.search(webPrincipal, req.body as any),
  );
  app.get('/api/index/status', async (req) =>
    knowledge.indexing.status(webPrincipal, req.query as any),
  );
  app.post('/api/index/refresh', async (req) =>
    knowledge.indexing.refresh(webPrincipal, req.body as any),
  );
  app.get<{ Params: { id: string } }>('/api/notes/:id/meta', async (req) =>
    knowledge.info(webPrincipal, req.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/notes/:id/outline', async (req) =>
    knowledge.snapshots.outline(webPrincipal, req.params.id, (req.query as any).cursor),
  );
  app.post<{ Params: { id: string } }>(
    '/api/notes/:id/read',
    { bodyLimit: 512 * 1024 },
    async (req) =>
      knowledge.snapshots.read(webPrincipal, req.params.id, (req.body || {}) as any, 'web'),
  );
  app.post<{ Params: { id: string } }>(
    '/api/notes/:id/patch',
    { bodyLimit: 512 * 1024 },
    async (req) => knowledge.files.submit(webPrincipal, req.params.id, req.body as any, 'web'),
  );
  app.post<{ Params: { id: string; revisionId: string } }>(
    '/api/notes/:id/revisions/:revisionId/read',
    { bodyLimit: 512 * 1024 },
    async (req) =>
      knowledge.snapshots.read(
        webPrincipal,
        `${req.params.id}@${req.params.revisionId}`,
        (req.body || {}) as any,
        'web',
      ),
  );
  app.get('/api/operations', async (req) => {
    const op = findOperation(db, webPrincipal, { requestId: (req.query as any).requestId });
    if (db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId))
      return knowledge.files.operation(webPrincipal, op.operationId);
    const intent = db
      .prepare('SELECT path FROM write_intents WHERE id=?')
      .get(op.operationId) as any;
    if (intent) authorizePath(webPrincipal, intent.path);
    return op;
  });
  app.get<{ Params: { id: string } }>('/api/operations/:id', async (req) =>
    knowledge.files.operation(webPrincipal, req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/operations/:id/cancel', async (req) =>
    knowledge.files.cancel(webPrincipal, req.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/notes/:id/download', async (req, reply) => {
    const ready = await knowledge.snapshots.available(webPrincipal, req.params.id, {
      snapshotId: (req.query as any).snapshotId,
    });
    if ('operation' in ready)
      return reply.code(202).send({ kind: 'accepted', operation: ready.operation });
    const release = acquireRead(db, webPrincipal, 'web');
    db.prepare('UPDATE read_snapshots SET refs=refs+1 WHERE id=?').run(ready.id);
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      db.prepare('UPDATE read_snapshots SET refs=max(0,refs-1) WHERE id=?').run(ready.id);
      release();
    };
    reply.raw.once('close', finish);
    const controller = new AbortController();
    req.raw.on('aborted', () => controller.abort());
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
    const iterator = async function* () {
      try {
        for await (const bytes of readBlocks(ready.path, 0, undefined, signal)) {
          if (!(await verifySession(req))) fail(401, 'UNAUTHORIZED');
          if ((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active)
            fail(503, 'SYNC_IN_PROGRESS');
          await knowledge.snapshots.check(webPrincipal, req.params.id, ready.id);
          release.renew();
          db.transaction(() => chargeRate(db, webPrincipal, 'web', bytes.length))();
          yield bytes;
        }
      } finally {
        finish();
      }
    };
    reply.raw.setTimeout(30000, () => controller.abort());
    return reply
      .type('text/markdown; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="note.md"')
      .header('Content-Length', String(ready.size_bytes))
      .send(Readable.from(iterator(), { objectMode: false, highWaterMark: 65536 }));
  });
  const publicPrincipal = (token: string) => {
    const n = shares.lookup(token);
    const p: Principal = {
      id: `share:${sha256(token)}`,
      clientId: 'public-reader',
      scopes: ['knowledge:read'],
      allowedPrefixes: [n.path],
    };
    return { n, p };
  };
  app.get<{ Params: { token: string } }>('/api/public/shares/:token/meta', async (req) => {
    const { n, p } = publicPrincipal(req.params.token),
      info = await knowledge.info(p, n.id);
    return { title: info.title, sizeBytes: info.sizeBytes, editorMode: info.editorMode };
  });
  app.post<{ Params: { token: string } }>(
    '/api/public/shares/:token/read',
    { bodyLimit: 128 * 1024 },
    async (req, reply) => {
      const { n, p } = publicPrincipal(req.params.token);
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return knowledge.snapshots.read(p, n.id, (req.body || {}) as any, 'public');
    },
  );
}
