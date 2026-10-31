import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import type { assetService } from '../../../packages/core/assets.js';
import { diagramHistoryRestoreService } from '../../../packages/core/knowledge/diagram-history-restore.js';
import {legacyDraftConversionService} from '../../../packages/core/knowledge/legacy-draft-conversion.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const planInput = z.object({ expectedModifiedAt: z.string().regex(/^\d+$/), requestId }).strict();
const previewInput = z
  .object({
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    pngBase64: z.string().max(14 * 1024 * 1024),
    requestId: requestId.max(100).min(8),
  })
  .strict();
const commitInput = z.object({ requestId }).strict();

export async function registerDiagramHistoryRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; notes: NoteService; assets: ReturnType<typeof assetService> },
) {
  const service = () => {
    const r = runtime();
    return diagramHistoryRestoreService(r.config, db, r.notes, r.assets, webPrincipal);
  };
  app.post<{Params:{id:string}}>('/api/notes/:id/diagram/legacy-draft-conversion',{bodyLimit:20*1024*1024},async req=>{
    const body=z.object({draft:z.string().max(8*1024*1024),baseRevision:z.string().max(512),expectedDocumentHash:z.string().regex(/^[a-f0-9]{64}$/),expectedSourceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(req.body);
    if(!body.success)fail(400,'INVALID_INPUT');
    const r=runtime();return legacyDraftConversionService(r.config,db,r.notes,r.assets,webPrincipal)(req.params.id,body.data);
  });
  app.post<{ Params: { id: string; revisionId: string } }>(
    '/api/notes/:id/revisions/:revisionId/diagram-restore',
    async (req) => {
      const body = planInput.safeParse(req.body);
      if (!body.success) fail(400, 'INVALID_INPUT');
      return service().plan(
        req.params.id,
        req.params.revisionId,
        body.data.expectedModifiedAt,
        body.data.requestId,
      );
    },
  );
  app.get<{ Params: { id: string } }>('/api/diagram-history-restores/:id', async (req) =>
    service().get(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diagram-history-restores/:id/prepare',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req) => {
      const body = previewInput.safeParse(req.body);
      if (!body.success) fail(400, 'INVALID_INPUT');
      return service().prepare(req.params.id, body.data);
    },
  );
  app.post<{ Params: { id: string } }>('/api/diagram-history-restores/:id/commit', async (req) => {
    const body = commitInput.safeParse(req.body);
    if (!body.success) fail(400, 'INVALID_INPUT');
    return service().commit(req.params.id, body.data);
  });
}
