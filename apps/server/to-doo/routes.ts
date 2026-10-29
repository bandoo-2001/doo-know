import type { FastifyInstance } from 'fastify';
import type { createToDooService } from '../../../packages/core/to-doo/service.js';
import { z } from 'zod';
import {
  toDooEntitySchemas,
  toDooFilterSchema,
  toDooDate,
  toDooId,
} from '../../../shared/to-doo-contracts.js';
import { outcomeNoteInput, type createOutcomeNoteService } from './outcome-note.js';
import { HttpError } from '../../../packages/core/errors.js';

export type ToDooService = ReturnType<typeof createToDooService>;

/** The host's API hook enforces owner session, maintenance, Origin and CSRF. */
export function registerToDooRoutes(
  app: FastifyInstance,
  getService: () => ToDooService,
  getOutcome?: () => ReturnType<typeof createOutcomeNoteService>,
) {
  app.get('/api/to-doo/state', async (req) => {
    const query = z
      .object({
        kind: z
          .enum(
            Object.keys(toDooEntitySchemas) as [
              keyof typeof toDooEntitySchemas,
              ...Array<keyof typeof toDooEntitySchemas>,
            ],
          )
          .optional(),
        kinds: z.string().max(1000).optional(),
        ids: z.string().max(8192).optional(),
        listIds: z.string().max(8192).optional(),
        taskIds: z.string().max(8192).optional(),
        includeTree: z.enum(['true', 'false']).optional(),
        view: z.string().max(80).optional(),
        from: toDooDate.optional(),
        to: toDooDate.optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        filter: z.string().max(8192).optional(),
      })
      .strict()
      .parse(req.query);
    const kinds = query.kinds
      ?.split(',')
      .filter(Boolean)
      .map((kind) => {
        if (!Object.hasOwn(toDooEntitySchemas, kind)) throw new HttpError(400, '内容类别无效');
        return kind as keyof typeof toDooEntitySchemas;
      });
    const ids = (value?: string) =>
      value ? z.array(toDooId).max(1000).parse(value.split(',').filter(Boolean)) : undefined;
    let filter;
    if (query.filter) {
      let value: unknown;
      try {
        value = JSON.parse(query.filter);
      } catch {
        throw new HttpError(400, '筛选条件格式无效');
      }
      filter = toDooFilterSchema.parse(value);
    }
    return getService().snapshot({
      ...query,
      kinds,
      ids: ids(query.ids),
      listIds: ids(query.listIds),
      taskIds: ids(query.taskIds),
      includeTree: query.includeTree === 'true',
      filter,
    });
  });
  app.post('/api/to-doo/commands', { bodyLimit: 4 * 1024 ** 2 }, async (req) =>
    getService().command(req.body as Parameters<ToDooService['command']>[0]),
  );
  if (getOutcome)
    app.post('/api/to-doo/outcome-note', { bodyLimit: 256 * 1024 }, (req) =>
      getOutcome().create(outcomeNoteInput.parse(req.body)),
    );
}
