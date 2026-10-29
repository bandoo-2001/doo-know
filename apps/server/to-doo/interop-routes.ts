import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ToDooInterop } from '../../../packages/core/to-doo/interop.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const source = z
  .object({
    name: z.string().min(1).max(256),
    sourceId: id.optional(),
    url: z.string().max(8192),
    headers: z.record(z.string(), z.string().max(8192)).optional(),
  })
  .strict();
export function registerToDooInteropRoutes(app: FastifyInstance, getInterop: () => ToDooInterop) {
  app.get('/api/to-doo/export', (req) => {
    const query = z
      .object({
        format: z.enum(['json', 'ics']).default('json'),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        listIds: z.string().max(4096).optional(),
        mode: z.enum(['events', 'todos']).optional(),
        includeDescription: z.enum(['true', 'false']).optional(),
      })
      .strict()
      .parse(req.query);
    if (query.format === 'json')
      return {
        content: getInterop().exportJson(),
        filename: 'to-doo.json',
        contentType: 'application/json',
      };
    return {
      content: getInterop().exportIcs({
        from: query.from,
        to: query.to,
        listIds: query.listIds?.split(',').filter(Boolean),
        mode: query.mode,
        includeDescription: query.includeDescription === 'true',
      }),
      filename: 'to-doo.ics',
      contentType: 'text/calendar;charset=utf-8',
    };
  });
  app.post('/api/to-doo/import/preview', { bodyLimit: 72 * 1024 * 1024 }, (req) => {
    const input = z
      .object({
        format: z.enum(['json', 'ics', 'csv']),
        content: z.string().max(64 * 1024 * 1024),
        sourceId: id.optional(),
        name: z.string().max(256).optional(),
        timeZone: z.string().max(128).optional(),
        mapping: z.record(z.string(), z.string().max(256)).optional(),
        target: z.enum(['calendar', 'tasks']).optional(),
        listId: id.nullable().optional(),
        mergeMode: z.enum(['skip', 'copy', 'update']).optional(),
      })
      .strict()
      .parse(req.body);
    return getInterop().previewImport(input);
  });
  app.post('/api/to-doo/import/apply', (req) =>
    getInterop().applyImport(z.object({ previewId: id, requestId: id }).strict().parse(req.body)),
  );
  app.get<{ Params: { id: string } }>('/api/to-doo/import/:id/status', (req) =>
    getInterop().importStatus(id.parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/import/:id/cancel', (req) =>
    getInterop().cancelImport(id.parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/import/:id/resume', (req) =>
    getInterop().resumeImport(id.parse(req.params.id)),
  );
  app.get('/api/to-doo/calendars/feeds', () => getInterop().feeds());
  app.post('/api/to-doo/calendars/feeds', (req) =>
    getInterop().createFeed(
      z
        .object({
          name: z.string().min(1).max(256),
          listIds: z.array(id).max(1000).optional(),
          includeDescription: z.boolean().optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.delete<{ Params: { id: string } }>('/api/to-doo/calendars/feeds/:id', (req) =>
    getInterop().revokeFeed(id.parse(req.params.id)),
  );
  app.get('/api/to-doo/calendars/connections', () => getInterop().connections());
  app.post('/api/to-doo/calendars/connect', (req) =>
    getInterop().connectCalendar(source.parse(req.body)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/calendars/:id/refresh', (req) =>
    getInterop().refreshCalendar(id.parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/calendars/:id/pause', (req) =>
    getInterop().pauseCalendar(
      id.parse(req.params.id),
      z.object({ paused: z.boolean() }).strict().parse(req.body).paused,
    ),
  );
  app.delete<{ Params: { id: string } }>('/api/to-doo/calendars/:id/connection', (req) =>
    getInterop().disconnectCalendar(id.parse(req.params.id)),
  );
  // The host must exempt only this exact read-only path from owner-session auth.
  // Tokens are independently hashed, revoked locally, and never accepted by task APIs.
  app.get<{ Params: { token: string } }>('/to-doo/feed/:token.ics', (req, reply) => {
    return reply
      .type('text/calendar;charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .send(getInterop().readFeed(req.params.token));
  });
}
