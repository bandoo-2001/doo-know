import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import type { assetService } from '../../../packages/core/assets.js';
import { documentCopyService } from '../../../packages/core/knowledge/document-copy.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
export async function registerDocumentOperationRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; notes: NoteService; assets: ReturnType<typeof assetService> },
) {
  app.post<{ Params: { id: string } }>('/api/notes/:id/copy', async (req) => {
    const { config, notes, assets } = runtime();
    return documentCopyService(config, db, notes, assets, webPrincipal).copy(
      req.params.id,
      req.body as any,
    );
  });
}
