import { diagramOperationPreviewNeeds } from '../../../packages/core/knowledge/diagram-operation-preview-pages.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { assetService } from '../../../packages/core/assets.js';
import { diagramOperationPreviewRegistry } from '../../../packages/core/knowledge/diagram-operation-previews.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export async function registerDiagramOperationPreviewRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; assets: ReturnType<typeof assetService> },
) {
  const service = () => {
    const { config, assets } = runtime();
    return diagramOperationPreviewRegistry(config, db, webPrincipal, assets);
  };
  app.get('/api/document-operation-previews/needs', async (req) => {
    const query = req.query as any;
    if (
      typeof query?.operationId !== 'string' ||
      (query.cursor !== undefined && typeof query.cursor !== 'string')
    )
      fail(400, 'INVALID_INPUT');
    const { config } = runtime();
    return diagramOperationPreviewNeeds(config, db, webPrincipal, {
      operationId: query.operationId,
      cursor: query.cursor,
    });
  });
  app.get<{ Params: { id: string } }>('/api/diagram-operation-previews/:id', async (req) =>
    service().get(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diagram-operation-previews/:id/prepare',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req) => {
      const body = req.body as any;
      if (
        !body ||
        Object.keys(body).some((k) => !['sourceHash', 'pngBase64', 'requestId'].includes(k)) ||
        typeof body.sourceHash !== 'string' ||
        typeof body.pngBase64 !== 'string' ||
        typeof body.requestId !== 'string'
      )
        fail(400, 'INVALID_INPUT');
      return service().prepare(req.params.id, body);
    },
  );
}
