import type { FastifyInstance } from 'fastify';
import type { gitRemoteService } from './service.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export function registerGitRemoteRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof gitRemoteService>,
) {
  const owner = (req: any) => {
    if (!req.ownerId) fail(401, 'UNAUTHORIZED');
    return req.ownerId as string;
  };
  app.get('/api/platform/git/status', async (req) => service.status(owner(req)));
  app.get('/api/platform/git/credentials', async (req) => ({
    items: service.credentials.list(owner(req)),
  }));
  app.post('/api/platform/git/credentials', async (req) =>
    service.credentials.save(owner(req), req.body as any),
  );
  app.delete<{ Params: { id: string } }>('/api/platform/git/credentials/:id', async (req) => {
    service.credentials.remove(owner(req), req.params.id);
    return { removed: true };
  });
  app.get('/api/platform/git/jobs', async (req) => ({ items: service.listJobs(owner(req)) }));
  app.get<{ Params: { id: string } }>('/api/platform/git/jobs/:id', async (req) =>
    service.job(owner(req), req.params.id),
  );
  app.post('/api/platform/git/jobs', async (req, reply) =>
    reply.code(202).send(service.start(owner(req), req.body as any)),
  );
  app.post<{ Params: { id: string } }>('/api/platform/git/jobs/:id/retry', async (req, reply) =>
    reply.code(202).send(service.retry(owner(req), req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/platform/git/jobs/:id/cancel', async (req) =>
    service.cancel(owner(req), req.params.id),
  );
}
