import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import { createMcpTransferStore } from './mcp-transfers.js';

export function registerMcpTransferRoutes(app: FastifyInstance, config: { dataRoot: string }, db: AppDatabase) {
  app.get<{ Params: { id: string } }>('/api/mcp/transfers/:id/download', (request, reply) => {
    const ownerId = (request as any).ownerId;
    if (!ownerId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const file = createMcpTransferStore(config, db).downloadForOwner(ownerId, request.params.id);
    return reply.header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
      .header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)))
      .type(file.mime).send(file.bytes);
  });
}
