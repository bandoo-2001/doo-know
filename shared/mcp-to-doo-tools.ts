import { z } from 'zod';
import {
  toDooCommandSchema,
  toDooEntitySchemas,
  toDooId,
  toDooDate,
  type ToDooEntityKind,
} from './to-doo-contracts.js';

export const toDooEntityKindSchema = z.enum(
  Object.keys(toDooEntitySchemas) as [ToDooEntityKind, ...ToDooEntityKind[]],
);
const actionNames = toDooCommandSchema.options.map((schema) => schema.shape.action.value);
export const toDooCommandActionSchema = z.enum(actionNames as [string, ...string[]]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const write = { requestId: toDooId };
const version = { expectedRevision: toDooId };
const transfer = { transferId: z.string().min(1).max(256) };
const metadataFields = new Set(['revision', 'createdAt', 'updatedAt', 'deletedAt']);
/** Top-level defaults belong to creation. A patch must preserve all omitted fields. */
export function toDooEntityFields(kind: ToDooEntityKind, patch = false): z.ZodObject {
  const fields: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(toDooEntitySchemas[kind].shape)) {
    if (metadataFields.has(key) || key === 'id') continue;
    fields[key] = patch
      ? (field instanceof z.ZodDefault ? field.removeDefault() : field).optional()
      : field;
  }
  return z.object(fields).strict();
}
export function toDooSchemaDocument(category: 'command' | 'entity' | 'patch', name: string) {
  const schema =
    category === 'command'
      ? toDooCommandSchema.options.find((schema) => schema.shape.action.value === name)
      : Object.hasOwn(toDooEntitySchemas, name)
        ? toDooEntityFields(name as ToDooEntityKind, category === 'patch')
        : undefined;
  if (!schema) throw new Error('Unknown To Doo schema');
  return z.toJSONSchema(schema, { unrepresentable: 'any' });
}
export const toDooFullToolSchemas = {
  read_to_doo_entity: z
    .object({
      kind: toDooEntityKindSchema,
      id: toDooId,
      expectedRevision: toDooId,
      offset: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(4).max(8192).default(4096),
      expectedContentHash: hash.optional(),
    })
    .strict(),
  get_to_doo_operation: z.object({ requestId: toDooId }).strict(),
  get_to_doo_outcome_operation: z
    .object({
      requestId: toDooId.optional(),
      operationId: toDooId.optional(),
      offset: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(4).max(8192).default(4096),
      expectedRevision: toDooId.optional(),
      includeContent: z.boolean().default(false),
    })
    .strict(),
  describe_to_doo_schema: z
    .object({
      category: z.enum(['catalog', 'command', 'entity', 'patch']).default('catalog'),
      name: z.string().max(80).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(15).default(10),
    })
    .strict(),
  execute_to_doo_command: z
    .object({
      ...write,
      action: toDooCommandActionSchema,
      payload: z
        .record(z.string(), z.unknown())
        .describe(
          'Exact payload schema is available from describe_to_doo_schema(category=command,name=action). Unknown fields are rejected by the shared command engine.',
        ),
    })
    .strict(),
  save_to_doo_entity: z
    .object({
      ...write,
      kind: toDooEntityKindSchema,
      mode: z.enum(['create', 'patch']),
      id: toDooId.optional(),
      expectedRevision: toDooId.optional(),
      fields: z
        .record(z.string(), z.unknown())
        .describe(
          'Read describe_to_doo_schema category entity for create, patch for update, name=kind. Patch omits unchanged fields; expectedRevision and id are required for patches.',
        ),
    })
    .strict(),
  export_to_doo_data: z
    .object({
      ...write,
      format: z.enum(['json', 'ics']),
      listIds: z.array(toDooId).min(1).max(50).optional(),
      from: toDooDate.optional(),
      to: toDooDate.optional(),
      mode: z.enum(['events', 'todos']).optional(),
      includeDescription: z.boolean().default(false),
      fullDataset: z.boolean().default(false),
    })
    .strict(),
  begin_to_doo_import: z
    .object({
      ...write,
      bytes: z
        .number()
        .int()
        .min(0)
        .max(64 * 1024 * 1024),
      sha256: hash,
      listId: toDooId.nullable().optional(),
      fullDataset: z.boolean().default(false),
    })
    .strict(),
  preview_to_doo_import: z
    .object({
      ...write,
      ...transfer,
      format: z.enum(['json', 'csv', 'ics']),
      sourceId: toDooId.optional(),
      name: z.string().max(256).optional(),
      timeZone: z.string().max(128).optional(),
      mapping: z.record(z.string(), z.string().max(256)).optional(),
      target: z.enum(['calendar', 'tasks']).optional(),
      listId: toDooId.nullable().optional(),
      mergeMode: z.enum(['skip', 'copy', 'update']).optional(),
      fullDataset: z.boolean().default(false),
    })
    .strict(),
  read_to_doo_import_preview: z.object({ requestId: toDooId, previewId: toDooId }).strict(),
  manage_to_doo_import: z
    .object({
      ...write,
      previewId: toDooId,
      action: z.enum(['status', 'apply', 'cancel', 'resume']),
    })
    .strict(),
  manage_to_doo_calendar: z
    .object({
      ...write,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(30).default(10),
      action: z.enum(['list', 'connect', 'refresh', 'pause', 'disconnect']),
      sourceId: toDooId.optional(),
      expectedRevision: toDooId.optional(),
      name: z.string().min(1).max(256).optional(),
      url: z.string().max(8192).optional(),
      headers: z.record(z.string(), z.string().max(8192)).optional(),
      paused: z.boolean().optional(),
    })
    .strict(),
  manage_to_doo_feed: z
    .object({
      ...write,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(10).default(5),
      action: z.enum(['list', 'readLists', 'create', 'revoke']),
      id: toDooId.optional(),
      expectedRevision: toDooId.optional(),
      name: z.string().min(1).max(256).optional(),
      listIds: z.array(toDooId).min(1).max(50).optional(),
      includeDescription: z.boolean().default(false),
    })
    .strict(),
  manage_to_doo_notifications: z
    .object({
      ...write,
      action: z.enum(['status', 'configure', 'test', 'revoke']),
      deviceId: toDooId.optional(),
      enabled: z.boolean().optional(),
      showContent: z.boolean().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .strict(),
  act_on_to_doo_reminder: z
    .object({
      ...write,
      id: toDooId,
      ...version,
      action: z.enum(['read', 'acknowledge', 'dismiss', 'snooze']),
      until: z.string().datetime().optional(),
    })
    .strict(),
  begin_to_doo_attachment: z
    .object({
      ...write,
      taskId: toDooId,
      ...version,
      bytes: z
        .number()
        .int()
        .min(0)
        .max(10 * 1024 * 1024),
      sha256: hash,
    })
    .strict(),
  finish_to_doo_attachment: z
    .object({
      ...write,
      ...transfer,
      taskId: toDooId,
      ...version,
      name: z.string().min(1).max(256),
      mime: z.string().max(128),
    })
    .strict(),
  read_to_doo_attachment: z.object({ ...write, taskId: toDooId, ...version, hash }).strict(),
  remove_to_doo_attachment: z.object({ ...write, taskId: toDooId, ...version, hash }).strict(),
  create_to_doo_outcome_note: z
    .object({
      ...write,
      operationId: toDooId.optional(),
      occurrenceId: toDooId,
      ...version,
      title: z.string().min(1).max(256),
      folderPath: z.string().max(1024),
      content: z.string().max(65536),
      verification: z
        .enum(['self_assessed', 'practice', 'reviewed', 'delivered'])
        .default('self_assessed'),
      complete: z.boolean().default(false),
      criteriaResults: z
        .array(z.object({ label: z.string().max(1000), passed: z.boolean() }).strict())
        .max(100)
        .default([]),
    })
    .strict(),
};
export type ToDooFullToolName = keyof typeof toDooFullToolSchemas;
export const toDooFullToolMetadata: Record<
  ToDooFullToolName,
  { scope: string; additionalScopes?: string[]; readOnly: boolean; description: string }
> = {
  read_to_doo_entity: {
    scope: 'to-doo:read',
    readOnly: true,
    description:
      'Read every authorized entity field, including large template/structured arrays, as revision-bound JSON UTF-8 pages under read access. Continue at range.nextOffset with returned sha256 as expectedContentHash. Current list/content/note permissions filter the full JSON; internal workflow records retain their dedicated caller-bound tool.',
  },
  get_to_doo_outcome_operation: {
    scope: 'to-doo:read',
    additionalScopes: ['knowledge:read'],
    readOnly: true,
    description:
      'Inspect a caller-owned durable outcome-note operation by original requestId or operationId. Rechecks current task, records and knowledge path access. Optional content pages require the current operation revision and valid UTF-8 boundaries.',
  },
  get_to_doo_operation: {
    scope: 'to-doo:read',
    readOnly: true,
    description:
      'Recover a caller-owned attachment/import/calendar/feed/device/reminder operation with its original requestId. Rechecks the original operation rights and scope. Shared task command receipts remain queryable via query_to_doos(receiptRequestId).',
  },
  describe_to_doo_schema: {
    scope: 'to-doo:read',
    readOnly: true,
    description:
      'Discover every supported command and entity and retrieve exact JSON input schemas. Catalog pages enumerate all operations and their dedicated tool boundaries; schema pages contain one complete schema.',
  },
  execute_to_doo_command: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Execute a shared To Doo business command with precise fields from describe_to_doo_schema. Dedicated attachment/import/outcome-note tools enforce their extra safeguards; no host paths or owner privileges.',
  },
  save_to_doo_entity: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Create or patch any ordinary To Doo entity using its discoverable strict fields. Patch requires id and expectedRevision and preserves omitted fields. Feed/source/import metadata additionally require the explicit sharing/integrations grant; durable outcome operations use their dedicated tool.',
  },
  export_to_doo_data: {
    scope: 'to-doo:share',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Export authorized lists as JSON or ICS to a bounded download transfer. Full checkpoint export requires explicit fullDataset and all lists/content domains. Data never leaves the grant.',
  },
  begin_to_doo_import: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read', 'to-doo:write'],
    readOnly: false,
    description:
      'Begin a length/hash-bound import upload. Select an authorized target list, or explicitly request fullDataset with unrestricted list and content-domain access.',
  },
  preview_to_doo_import: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read', 'to-doo:write'],
    readOnly: false,
    description:
      'Validate uploaded JSON/CSV/ICS through the existing import engine. Imports are bound to the caller, scope, target list and revisions; returns bounded counts and changes, then explicitly apply.',
  },
  read_to_doo_import_preview: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read', 'to-doo:write'],
    readOnly: true,
    description:
      'Read the full authorized import preview, before/after field values and every warning through a bounded download transfer. Rechecks the caller-owned target, all references and current authorization before export.',
  },
  manage_to_doo_import: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read', 'to-doo:write'],
    readOnly: false,
    description:
      'Query, apply, cancel or resume a caller-owned import preview. Rechecks live authorization before every batch and keeps original request identity for recovery.',
  },
  manage_to_doo_calendar: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'List/connect/refresh/pause/disconnect external calendars. Calendar administration requires unrestricted calendar access; source URLs and headers are never returned.',
  },
  manage_to_doo_feed: {
    scope: 'to-doo:share',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'List, create or revoke private calendar feeds for explicitly authorized lists. Create returns the bearer URL once for the requested disclosure; later listings contain no token.',
  },
  manage_to_doo_notifications: {
    scope: 'to-doo:integrations',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Read notification host/device status, configure activation/content, test or revoke devices. Browser subscription enrollment requires an actual browser permission and is not fabricated by MCP.',
  },
  act_on_to_doo_reminder: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Read, acknowledge, dismiss or snooze an authorized reminder with expected revision and stable request identity.',
  },
  begin_to_doo_attachment: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Begin an opaque upload bound to the authorized task, current revision, declared size and SHA-256. Use generic chunk tools then finish_to_doo_attachment.',
  },
  finish_to_doo_attachment: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Finalize an uploaded attachment through the shared attachment engine, with file-type validation, live task access, revision check and idempotent command receipt.',
  },
  read_to_doo_attachment: {
    scope: 'to-doo:read',
    readOnly: true,
    description:
      'Create a chunked download for one authorized current task attachment; immutable content is verified by the shared attachment engine.',
  },
  remove_to_doo_attachment: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read'],
    readOnly: false,
    description:
      'Remove an attachment link using the task expected revision and stable request identity. Immutable attachment content remains recoverable.',
  },
  create_to_doo_outcome_note: {
    scope: 'to-doo:write',
    additionalScopes: ['to-doo:read', 'knowledge:read', 'knowledge:write'],
    readOnly: false,
    description:
      'Create an evidence note and link/optionally complete an authorized occurrence through the durable recoverable workflow. Requires knowledge read/write to the explicit folder plus task and records access; retries preserve the saved note.',
  },
};

const count = z.number().int().nonnegative();
const receipt = z
  .object({
    transactionId: z.string().nullable(),
    replayed: z.boolean(),
    changed: z
      .array(z.object({ kind: toDooEntityKindSchema, id: toDooId, revision: toDooId }).strict())
      .max(50),
    ids: z.array(toDooId).max(50),
    changedCount: count.optional(),
    idsCount: count.optional(),
    receiptTruncated: z.boolean().optional(),
    preview: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const binding = z
  .object({
    domain: z.enum(['knowledge', 'blog', 'to-doo']),
    kind: z.string(),
    id: z.string(),
    revision: z.string().optional(),
    metadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();
const transferInfo = z
  .object({
    transferId: z.string(),
    direction: z.enum(['upload', 'download']),
    state: z.enum(['uploading', 'ready', 'completed', 'cancelled']),
    name: z.string(),
    mime: z.string(),
    totalBytes: count,
    receivedBytes: count,
    sha256: z.string().nullable(),
    expiresAt: z.string(),
    requestId: z.string(),
    binding,
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const importStatus = z
  .object({
    jobId: toDooId,
    status: z.enum(['preview', 'queued', 'running', 'completed', 'cancelled', 'failed']),
    completed: count,
    total: count.optional(),
    error: z.string().nullable().optional(),
    result: receipt.nullable().optional(),
  })
  .strict();
const generalManagement = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
    id: toDooId.optional(),
    revision: toDooId.optional(),
    listIds: z.array(toDooId).max(10).optional(),
    token: z.string().max(128).optional(),
    url: z.string().max(1024).optional(),
    revoked: z.boolean().optional(),
    sourceId: toDooId.optional(),
    count: count.optional(),
    warnings: z.array(z.string()).max(10).optional(),
    warningCount: count.optional(),
    warningsTransfer: transferInfo.optional(),
    unchanged: z.boolean().optional(),
    paused: z.boolean().optional(),
    disconnected: z.boolean().optional(),
    snapshotsRetained: z.boolean().optional(),
    status: z.string().optional(),
    deviceId: toDooId.optional(),
    enabled: z.boolean().optional(),
    ready: z.boolean().optional(),
    reason: z.string().optional(),
    devices: z
      .array(
        z
          .object({
            id: z.string(),
            deviceName: z.string(),
            createdAt: z.string(),
            lastSuccessAt: z.string().nullable(),
            status: z.string(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    showContent: z.boolean().optional(),
    logoutPolicy: z.string().optional(),
    outbox: z.array(z.object({ state: z.string(), count: count }).strict()).optional(),
    lastError: z.string().nullable().optional(),
    browserEnrollmentRequired: z.boolean().optional(),
    deviceCount: count.optional(),
    total: count.optional(),
    nextOffset: count.nullable().optional(),
  })
  .strict();
export const toDooFullToolOutputs: Record<ToDooFullToolName, z.ZodType> = {
  read_to_doo_entity: z
    .object({
      kind: toDooEntityKindSchema,
      id: toDooId,
      revision: toDooId,
      format: z.literal('json'),
      content: z.string(),
      sha256: hash,
      range: z.object({ offset: count, nextOffset: count.nullable(), totalBytes: count }).strict(),
    })
    .strict(),
  get_to_doo_outcome_operation: z
    .object({
      operationId: toDooId,
      requestId: toDooId,
      state: z.enum(['prepared', 'note_saved', 'completed', 'needs_reconciliation']),
      occurrenceId: toDooId,
      expectedRevision: toDooId,
      revision: toDooId,
      noteId: toDooId.nullable(),
      title: z.string(),
      needsReconciliation: z.boolean(),
      content: z.string().optional(),
      contentRange: z
        .object({ offset: count, nextOffset: count.nullable(), totalBytes: count })
        .strict()
        .optional(),
    })
    .strict(),
  get_to_doo_operation: z
    .object({
      requestId: toDooId,
      state: z.enum(['completed', 'pending', 'unavailable']),
      tool: z.string().optional(),
      result: z.record(z.string(), z.unknown()).nullable(),
    })
    .strict(),
  describe_to_doo_schema: z.union([
    z
      .object({
        category: z.enum(['command', 'entity', 'patch']),
        name: z.string(),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        items: z
          .array(
            z
              .object({
                category: z.enum(['command', 'entity']),
                name: z.string(),
                tool: z.string(),
              })
              .strict(),
          )
          .max(15),
        total: count,
        nextOffset: count.nullable(),
      })
      .strict(),
  ]),
  execute_to_doo_command: receipt,
  save_to_doo_entity: receipt,
  export_to_doo_data: transferInfo,
  begin_to_doo_import: transferInfo,
  preview_to_doo_import: z
    .object({
      previewId: toDooId,
      total: count,
      duplicates: count,
      batchCount: count,
      warnings: z.array(z.string()).max(10),
      changes: z
        .array(
          z
            .object({
              kind: toDooEntityKindSchema,
              id: toDooId,
              fields: z.array(z.string()).max(40),
            })
            .strict(),
        )
        .max(20),
      hasMore: z.boolean(),
    })
    .strict(),
  read_to_doo_import_preview: transferInfo,
  manage_to_doo_import: z.union([receipt, importStatus]),
  manage_to_doo_calendar: generalManagement,
  manage_to_doo_feed: generalManagement,
  manage_to_doo_notifications: generalManagement,
  act_on_to_doo_reminder: receipt,
  begin_to_doo_attachment: transferInfo,
  finish_to_doo_attachment: receipt,
  read_to_doo_attachment: transferInfo,
  remove_to_doo_attachment: receipt,
  create_to_doo_outcome_note: z
    .object({ noteId: toDooId, operationId: toDooId, result: receipt })
    .strict(),
};
