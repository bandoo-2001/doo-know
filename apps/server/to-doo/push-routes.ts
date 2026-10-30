import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ToDooNotifications } from '../../../packages/core/to-doo/notifications.js';
import type { ToDooService } from '../../../shared/to-doo-contracts.js';
import {
  createToDooReminders,
  type ToDooReminderOptions,
} from '../../../packages/core/to-doo/reminders.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export function registerToDooPushRoutes(
  app: FastifyInstance,
  getNotifications: () => ToDooNotifications,
  getService: () => ToDooService,
  reminderOptions: ToDooReminderOptions,
) {
  const reminders = () => createToDooReminders(getService(), reminderOptions);
  app.get('/api/to-doo/push', () => getNotifications().status());
  app.post('/api/to-doo/push/device-status', (req) => {
    const body = z
      .object({ endpoint: z.string().min(1).max(8192) })
      .strict()
      .parse(req.body);
    return getNotifications().deviceStatus(body.endpoint);
  });
  app.get('/api/to-doo/reminders/pending', () => reminders().pending());
  app.get<{ Params: { id: string } }>('/api/to-doo/reminders/:id', (req) =>
    reminders().get(id.parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/reminders/:id/complete', (req) =>
    reminders().complete(
      id.parse(req.params.id),
      z
        .object({
          requestId: id,
          expectedRevision: id,
          amount: z.number().positive().max(1000000).optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post('/api/to-doo/push/configure', (req) =>
    getNotifications().configure(
      z
        .object({ enabled: z.boolean(), showContent: z.boolean().optional() })
        .strict()
        .parse(req.body),
    ),
  );
  app.post('/api/to-doo/push/subscribe', (req) => {
    const body = z
      .object({
        subscription: z
          .object({
            endpoint: z.string().max(8192),
            expirationTime: z.number().nullable().optional(),
            keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(128) }).strict(),
          })
          .strict(),
        deviceName: z.string().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    return getNotifications().subscribe(body);
  });
  app.post<{ Params: { id: string } }>('/api/to-doo/push/devices/:id/test', (req) =>
    getNotifications().test(id.parse(req.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/to-doo/push/devices/:id', (req) =>
    getNotifications().revoke(id.parse(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/to-doo/reminders/:id/action', (req) =>
    getNotifications().action(
      id.parse(req.params.id),
      z
        .object({
          action: z.enum(['read', 'acknowledge', 'dismiss', 'snooze']),
          until: z.string().datetime().optional(),
          requestId: id,
          expectedRevision: id,
        })
        .strict()
        .parse(req.body),
    ),
  );
}
