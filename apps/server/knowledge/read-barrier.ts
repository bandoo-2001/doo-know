import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import { workspaceRead } from '../../../packages/core/workspace/gate.js';

/** Hold the shared lease through response streaming, so a move cannot publish a mixed read. */
export function registerKnowledgeReadBarrier(app: FastifyInstance, db: AppDatabase) {
  app.addHook('preHandler', (request, reply, done) => {
    const path = request.url.split('?')[0];
    const readsKnowledge =
      request.method === 'GET' || request.method === 'HEAD'
        ? /^\/api\/(?:tree|notes|assets|search|collections|graph|index|trash|public)(?:\/|$)/.test(
            path,
          ) || /^\/api\/agent\/v1\/(?:notes|index|search)(?:\/|$)/.test(path)
        : request.method === 'POST' &&
          (path === '/api/search/advanced' ||
            path === '/api/agent/v1/search' ||
            /^\/api\/(?:agent\/v1\/)?notes\/[^/]+\/(?:read|revisions\/[^/]+\/read)$/.test(path));
    if (!readsKnowledge) {
      done();
      return;
    }
    let handedOff = false;
    void workspaceRead(
      db,
      { kind: 'http.knowledge.read' },
      () =>
        new Promise<void>((resolve, reject) => {
          const release = () => {
            reply.raw.removeListener('finish', release);
            reply.raw.removeListener('close', release);
            resolve();
          };
          reply.raw.once('finish', release);
          reply.raw.once('close', release);
          handedOff = true;
          try {
            done();
          } catch (error) {
            release();
            reject(error);
          }
        }),
    ).catch((error) => {
      if (!handedOff) done(error);
      else request.log.error({ err: error }, 'Knowledge read lease release failed');
    });
  });
}
