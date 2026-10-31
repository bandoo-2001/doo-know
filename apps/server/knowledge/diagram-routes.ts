import { registerDocumentOperationRoutes } from './document-operation-routes.js';
import { registerDiagramOperationPreviewRoutes } from './diagram-operation-preview-routes.js';
import { registerWhiteboardMigrationRoutes } from './whiteboard-migration-routes.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import type { assetService } from '../../../packages/core/assets.js';
import { diagramCreationService } from '../../../packages/core/knowledge/diagram-creation.js';
import { primaryDiagramService } from '../../../packages/core/knowledge/primary-diagrams.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { diagramCommitSchema } from '../../../shared/diagram-document-contracts.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { posix } from 'node:path';
import { legacyDiagramPreviewService } from '../../../packages/core/knowledge/legacy-diagram-previews.js';

/** The application's normal owner-session, origin and CSRF hooks protect every route here. */
export async function registerDiagramDocumentRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; notes: NoteService; assets: ReturnType<typeof assetService> },
) {
  await registerWhiteboardMigrationRoutes(app,db,runtime);
  await registerDiagramOperationPreviewRoutes(app,db,runtime);
  await registerDocumentOperationRoutes(app,db,runtime);
  const services = () => {
    const { config, notes, assets } = runtime();
    return {
      notes,
      creations: diagramCreationService(config, db, webPrincipal),
      primary: primaryDiagramService(config, db, notes, assets, webPrincipal),
      legacy: legacyDiagramPreviewService(config, db, notes, assets, webPrincipal),
    };
  };
  app.post('/api/diagram-documents/intents', async (req, reply) =>
    reply.code(201).send(services().creations.reserve(req.body as any)),
  );
  app.get<{ Params: { intentId: string } }>(
    '/api/diagram-documents/intents/:intentId',
    async (req) => services().creations.get(req.params.intentId),
  );
  app.delete<{ Params: { intentId: string } }>(
    '/api/diagram-documents/intents/:intentId',
    async (req) => services().creations.cancel(req.params.intentId),
  );
  app.post('/api/diagram-documents/prepare', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) =>
    reply.code(201).send(services().primary.prepare(req.body)),
  );
  app.post('/api/diagram-documents/commit', { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
    const input = diagramCommitSchema.safeParse(req.body);
    if (!input.success) fail(400, 'INVALID_INPUT');
    return services().primary.commit(input.data);
  });
  app.get<{ Params: { id: string } }>('/api/notes/:id/diagram', async (req) =>
    services().primary.resolve(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/api/notes/:id/diagram/legacy-preview',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req) => services().legacy.prepare(req.params.id, req.body),
  );
  app.get<{ Params: { id: string }; Querystring: { documentHash?: string; sourceHash?: string } }>(
    '/api/notes/:id/diagram/source',
    async (req, reply) => {
      const resource = services().primary.resolve(req.params.id);
      if (
        resource.documentHash !== req.query.documentHash ||
        resource.source.hash !== req.query.sourceHash
      )
        fail(409, 'VERSION_CONFLICT');
      if (!resource.capabilities.canDownloadSource || resource.source.content === undefined)
        fail(409, 'DIAGRAM_SOURCE_UNAVAILABLE');
      const extension =
        resource.source.format === 'excalidraw'
          ? '.excalidraw'
          : resource.source.format === 'mermaid'
            ? '.mmd'
            : '.md';
      const mime =
        resource.source.format === 'excalidraw'
          ? 'application/vnd.excalidraw+json'
          : resource.source.format === 'mermaid'
            ? 'text/plain'
            : 'text/markdown';
      const name = posix.basename(services().notes.row(req.params.id).path, '.md') + extension;
      return reply
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name))
        .type(mime + '; charset=utf-8')
        .send(Buffer.from(resource.source.content, 'utf8'));
    },
  );
}
