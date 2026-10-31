import { fail } from '../../../packages/core/knowledge/errors.js';
import type { FastifyInstance } from 'fastify';
import type { organizationService } from '../../../packages/core/organization/service.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
const owner = { ...webPrincipal, scopes: [...webPrincipal.scopes, 'knowledge:organize'] };
/** Use the running service so operations continue across browser refreshes. */
function pageInput(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some((k) => !['limit', 'cursor', 'parentId'].includes(k)))
    fail(400, 'INVALID_INPUT');
  for (const key of ['cursor', 'parentId'])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== 'string' || (input[key] as string).length > 4096)
    )
      fail(400, 'INVALID_INPUT');
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50))
    fail(400, 'INVALID_LIMIT');
  return { ...input, ...(limit !== undefined ? { limit } : {}) };
}
export async function registerOrganizationOperationRoutes(
  app: FastifyInstance,
  service: () => ReturnType<typeof organizationService>,
) {
  app.get('/api/organization/context', async () => service().context(owner));
  app.get('/api/organization/directories', async (req) =>
    service().list(owner, pageInput(req.query)),
  );
  app.post('/api/organization/operations', async (req) => service().submit(owner, req.body as any));
  app.get('/api/organization/operations', async (req) =>
    service().history(owner, pageInput(req.query)),
  );
  app.get<{ Params: { id: string } }>('/api/organization/operations/:id', async (req) =>
    service().operation(owner, { operationId: req.params.id }),
  );
  app.post<{ Params: { id: string } }>('/api/organization/operations/:id/resume', async (req) =>
    service().resume(owner, { operationId: req.params.id }),
  );
  app.post<{ Params: { id: string } }>('/api/organization/operations/:id/undo', async (req) =>
    service().undo(owner, { operationId: req.params.id, requestId: (req.body as any)?.requestId }),
  );
  app.post<{ Params: { id: string } }>('/api/organization/operations/:id/cancel', async (req) =>
    service().cancel(owner, { operationId: req.params.id }),
  );
}
