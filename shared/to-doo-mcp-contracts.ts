import { z } from 'zod';
import { toDooEntitySchemas, toDooId, toDooDate, toDooFilterSchema } from './to-doo-contracts.js';

export const toDooMcpKind = z.enum([
  'statistics',
  ...(Object.keys(toDooEntitySchemas) as Array<keyof typeof toDooEntitySchemas>),
] as const);
export const toDooMcpQuery = z
  .object({
    kind: toDooMcpKind.default('task'),
    ids: z.array(toDooId).max(50).optional(),
    listIds: z.array(toDooId).max(50).optional(),
    filter: toDooFilterSchema.optional(),
    from: toDooDate.optional(),
    to: toDooDate.optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    receiptRequestId: toDooId.optional(),
    field: z
      .enum(['description', 'content', 'criteria', 'resultSummary', 'note', 'summary', 'reason'])
      .optional(),
    offset: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(4).max(8192).optional(),
    expectedRevision: toDooId.optional(),
  })
  .strict();
export const toDooMcpContext = z
  .object({
    listId: toDooId.optional(),
    taskId: toDooId.optional(),
    limit: z.number().int().min(1).max(30).default(10),
  })
  .strict()
  .refine((v) => !!v.listId || !!v.taskId, '需要目标清单或任务 ID');
export const toDooMcpQueryResult = z
  .object({
    items: z.array(
      z
        .object({
          kind: toDooMcpKind,
          entity: z.record(z.string(), z.unknown()),
          truncatedFields: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export const toDooMcpReceipt = z
  .object({
    transactionId: z.string().nullable(),
    replayed: z.boolean(),
    changed: z.array(z.object({ kind: toDooMcpKind, id: toDooId, revision: toDooId }).strict()),
    ids: z.array(toDooId),
    changedCount: z.number().int().nonnegative().optional(),
    idsCount: z.number().int().nonnegative().optional(),
    receiptTruncated: z.boolean().optional(),
    preview: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const toDooMcpContextResult = z
  .object({
    goal: z.record(z.string(), z.unknown()).nullable().optional(),
    tasks: z.array(z.record(z.string(), z.unknown())),
    records: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  })
  .strict();
export type ToDooMcpQuery = z.input<typeof toDooMcpQuery>;
export type ToDooMcpQueryResult = z.infer<typeof toDooMcpQueryResult>;
export type ToDooMcpReceipt = z.infer<typeof toDooMcpReceipt>;
export type ToDooMcpContext = z.input<typeof toDooMcpContext>;
export type ToDooMcpContextResult = z.infer<typeof toDooMcpContextResult>;
