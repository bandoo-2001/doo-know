import { z } from 'zod';
import { noteIdAtPath } from '../../../packages/core/knowledge/note-path-aliases.js';
import { validateRelative } from '../../../packages/core/files.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import type { assetService } from '../../../packages/core/assets.js';
import { whiteboardMigrationService } from '../../../packages/core/knowledge/whiteboard-migrations.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
/** Registered beneath the application's owner-session + CSRF hooks. */
export async function registerWhiteboardMigrationRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; notes: NoteService; assets: ReturnType<typeof assetService> },
) {
  const service = () => {
    const r = runtime();
    return whiteboardMigrationService(r.config, db, r.notes, r.assets, webPrincipal);
  };
  const requestId = z.string().min(1).max(128),
    identifier = z.string().uuid();
  const planSchema = z.object({ noteId: identifier, requestId }).strict(),
    actionSchema = z.object({ migrationId: identifier, requestId }).strict(),
    prepareSchema = actionSchema.extend({
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      pngBase64: z.string().max(14 * 1024 * 1024),
    });
  const input = (schema: z.ZodType, body: unknown) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) fail(400, 'INVALID_INPUT');
    return parsed.data as any;
  };
  app.get<{ Querystring: { path: string } }>('/api/note-path-alias', async (req) => {
    if (typeof req.query.path !== 'string') fail(400, 'INVALID_INPUT');
    validateRelative(req.query.path, 'note');
    const noteId = noteIdAtPath(db, req.query.path, webPrincipal);
    if (!noteId) fail(404, 'NOT_FOUND');
    return { noteId };
  });
  app.get('/api/whiteboard-migrations', async () => ({
    jobs: service().list(),
    candidates: service().candidates(),
  }));
  app.get<{ Params: { noteId: string } }>(
    '/api/whiteboard-migrations/preflight/:noteId',
    async (req) => service().preflight(req.params.noteId),
  );
  app.post('/api/whiteboard-migrations/plan', async (req) =>
    service().plan(input(planSchema, req.body)),
  );
  app.post('/api/whiteboard-migrations/prepare', { bodyLimit: 24 * 1024 * 1024 }, async (req) =>
    service().prepare(input(prepareSchema, req.body)),
  );
  app.post('/api/whiteboard-migrations/commit', async (req) =>
    service().commit(input(actionSchema, req.body)),
  );
  app.post('/api/whiteboard-migrations/rollback', async (req) =>
    service().rollback(input(actionSchema, req.body)),
  );
  app.post<{ Params: { id: string } }>('/api/whiteboard-migrations/:id/resume', async (req) =>
    service().resume(req.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/whiteboard-migrations/:id', async (req) =>
    service().get(req.params.id),
  );
}
