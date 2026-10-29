import { createHash, createHmac } from 'node:crypto';
import type { McpDomainContext } from '../plugins/mcp-domain-context.js';
import type {
  McpManagedDomainPort,
  McpTransferBinding,
  McpTransferInfo,
} from '../../../shared/mcp-domain-tools.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import {
  toDooFullToolSchemas,
  toDooFullToolMetadata,
  toDooSchemaDocument,
  toDooEntityFields,
  type ToDooFullToolName,
} from '../../../shared/mcp-to-doo-tools.js';
import {
  toDooEntitySchemas,
  toDooCommandSchema,
  TO_DOO_COLLECTIONS,
  type ToDooEntityKind,
  type ToDooSnapshot,
  type ToDooCommandResult,
  type ToDooService,
} from '../../../shared/to-doo-contracts.js';
import { createToDooAgentPort } from './agent-port.js';
import { createToDooAssets } from '../../../packages/core/to-doo/assets.js';
import {
  exportPortableJson,
  snapshotCalendarItems,
} from '../../../packages/core/to-doo/interop.js';
import { canonical } from '../../../packages/core/to-doo/store.js';
import { exportCalendar } from '../../../packages/core/to-doo/calendar.js';
import { authorizePath } from '../../../packages/core/agent/auth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../../../shared/mcp-frame.js';
import { createOutcomeNoteService } from './outcome-note.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const allDomains = [
  'tasks',
  'records',
  'focus',
  'habits',
  'anniversaries',
  'calendar',
  'statistics',
  'settings',
];
const internalKinds = new Set(['operation', 'calendarFeed', 'calendarSource', 'import']);
const entityDomains: Record<ToDooEntityKind, string> = {
  settings: 'settings',
  list: 'tasks',
  section: 'tasks',
  tag: 'tasks',
  task: 'tasks',
  occurrence: 'tasks',
  exception: 'tasks',
  timeBlock: 'tasks',
  outcome: 'records',
  record: 'records',
  activity: 'records',
  focusSession: 'focus',
  habit: 'habits',
  habitEntry: 'habits',
  anniversary: 'anniversaries',
  view: 'tasks',
  template: 'tasks',
  review: 'records',
  plan: 'tasks',
  reminderEvent: 'records',
  calendarSource: 'calendar',
  calendarEvent: 'calendar',
  calendarFeed: 'calendar',
  import: 'calendar',
  operation: 'internal',
};
const brief = (result: Omit<ToDooCommandResult, 'snapshot'> | any) => ({
  transactionId: result.transactionId ?? null,
  replayed: !!result.replayed,
  changed: (result.changed ?? []).slice(0, 50),
  ids: (result.ids ?? []).slice(0, 50),
  changedCount: result.changed?.length ?? 0,
  idsCount: result.ids?.length ?? 0,
  receiptTruncated: (result.changed?.length ?? 0) > 50 || (result.ids?.length ?? 0) > 50,
});
const need = <T>(value: T | undefined, field: string): T => {
  if (value === undefined) fail(400, 'INVALID_INPUT', `缺少必要字段：${field}`);
  return value;
};

export function createToDooToolPort(context: McpDomainContext): McpManagedDomainPort {
  const { runtime, db, transfers } = context;
  // Optional To Doo data stays lazy: constructing the knowledge/plugin service
  // must not initialize an unrelated optional application store.
  const todo: ToDooService = {
    snapshot: (q) => runtime.toDoo.snapshot(q),
    command: (input, trusted) => runtime.toDoo.command(input, trusted),
    getEntity: (kind, id) => runtime.toDoo.getEntity(kind, id),
    getReceipt: (id) => runtime.toDoo.getReceipt(id),
    exportCheckpoint: () => runtime.toDoo.exportCheckpoint(),
    importCheckpoint: (checkpoint, id, options) =>
      runtime.toDoo.importCheckpoint(checkpoint, id, options),
    close: () => runtime.toDoo.close(),
  };
  let initialized = false;
  function initialize() {
    if (initialized) return;
    db.exec(`CREATE TABLE IF NOT EXISTS to_doo_mcp_actions(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,tool TEXT NOT NULL,scope TEXT NOT NULL,targets TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS to_doo_mcp_imports(preview_id TEXT PRIMARY KEY,owner TEXT NOT NULL,scope TEXT NOT NULL,full_dataset INTEGER NOT NULL,list_id TEXT);
      CREATE TABLE IF NOT EXISTS to_doo_mcp_export_access(binding_id TEXT NOT NULL,owner TEXT NOT NULL,transfer_id TEXT NOT NULL,note_ids TEXT NOT NULL,note_paths TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(binding_id,owner));`);
    initialized = true;
  }
  const owner = (p: Principal) => digest([p.id, p.clientId]);
  const policyKey = (p: Principal, options?: ServiceCallOptions) =>
    digest([
      p.id,
      p.clientId,
      p.grantId,
      p.grantVersion,
      p.scopes,
      p.allowedPrefixes,
      p.permissionPolicy,
      p.permissionCeiling,
      context.toDooAccess(options),
    ]);
  function principal(scopes: readonly string[], options?: ServiceCallOptions) {
    return context.authorize(scopes, options);
  }
  function agent(options?: ServiceCallOptions) {
    return createToDooAgentPort(todo, {
      authorize: (write) =>
        principal(write ? ['to-doo:read', 'to-doo:write'] : ['to-doo:read'], options),
      access: () => context.toDooAccess(options),
      canReadNote: async (_p, id) => {
        try {
          await runtime.knowledge.info(principal(['knowledge:read'], options), id);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  function canReadNote(p: Principal, id: string) {
    try {
      const row = db.prepare('SELECT path,active FROM notes WHERE id=?').get(id) as
        | { path: string; active: number }
        | undefined;
      if (!row?.active) return false;
      authorizePath(p, row.path, 'knowledge:read');
      return true;
    } catch {
      return false;
    }
  }
  function fullAccess(options?: ServiceCallOptions) {
    const access = context.toDooAccess(options);
    if (
      access.listIds.length ||
      access.resourceListIds !== undefined ||
      allDomains.some((domain) => !access.domains.includes(domain))
    )
      fail(403, 'FORBIDDEN', '全量数据操作需要全部清单和全部内容领域的明确授权');
  }
  function domainAccess(domain: string, options?: ServiceCallOptions, unrestricted = false) {
    const access = context.toDooAccess(options);
    if (
      !access.domains.includes(domain) ||
      (unrestricted && (access.listIds.length || access.resourceListIds !== undefined))
    )
      fail(403, 'FORBIDDEN');
  }
  function lists(ids: string[] | undefined, options?: ServiceCallOptions): string[] | undefined {
    const a = context.toDooAccess(options),
      port = agent(options);
    const result =
      ids ??
      (a.resourceListIds !== undefined
        ? a.resourceListIds.filter((id) => !a.listIds.length || a.listIds.includes(id))
        : a.listIds.length
          ? a.listIds
          : undefined);
    if (result?.length === 0) fail(403, 'FORBIDDEN');
    for (const id of result ?? []) port.assertList(id === 'inbox' ? null : id);
    return result;
  }
  function checkVersion(
    kind: ToDooEntityKind,
    id: string,
    expected: string,
    options?: ServiceCallOptions,
  ) {
    const entity = agent(options).inspect(kind, id);
    if (entity.revision !== expected)
      fail(409, 'VERSION_CONFLICT', 'To Doo 内容版本已变化，请重新读取');
    return entity;
  }
  async function memo(
    p: Principal,
    requestId: string,
    tool: string,
    input: any,
    work: () => unknown | Promise<unknown>,
    options?: ServiceCallOptions,
  ) {
    initialize();
    const key = owner(p),
      fingerprint = digest([tool, input]);
    const previous = db
      .prepare('SELECT fingerprint,result FROM to_doo_mcp_actions WHERE owner=? AND request_id=?')
      .get(key, requestId) as { fingerprint: string; result: string | null } | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail(409, 'VERSION_CONFLICT', 'requestId 已用于不同的 To Doo 操作');
      if (previous.result === null)
        fail(
          409,
          'OPERATION_OUTCOME_UNKNOWN',
          '此请求尚待核对；使用 get_to_doo_operation 与原 requestId 查询，不要生成新 ID',
        );
      return JSON.parse(previous.result) as Record<string, unknown>;
    }
    const targets = Object.fromEntries(
      ['sourceId', 'deviceId', 'id', 'taskId', 'listIds', 'previewId']
        .filter((field) => input[field] !== undefined)
        .map((field) => [field, input[field]]),
    );
    db.prepare('INSERT INTO to_doo_mcp_actions VALUES(?,?,?,?,?,?,NULL)').run(
      key,
      requestId,
      fingerprint,
      tool,
      policyKey(p, options),
      JSON.stringify(targets),
    );
    try {
      const result = (await work()) as Record<string, unknown>;
      db.prepare('UPDATE to_doo_mcp_actions SET result=? WHERE owner=? AND request_id=?').run(
        JSON.stringify(result),
        key,
        requestId,
      );
      return result;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        !['OPERATION_OUTCOME_UNKNOWN', 'OUTCOME_NEEDS_RECONCILIATION'].includes((error as any).code)
      )
        db.prepare(
          'DELETE FROM to_doo_mcp_actions WHERE owner=? AND request_id=? AND result IS NULL',
        ).run(key, requestId);
      throw error;
    }
  }
  function authorizeTransfer(
    binding: McpTransferBinding,
    write: boolean,
    options?: ServiceCallOptions,
    state?: McpTransferInfo['state'],
  ) {
    if (binding.domain !== 'to-doo') fail(403, 'FORBIDDEN');
    if (binding.kind === 'attachment') {
      const p = principal(write ? ['to-doo:read', 'to-doo:write'] : ['to-doo:read'], options);
      if (state === 'completed') agent(options).inspect('task', binding.id);
      else checkVersion('task', binding.id, need(binding.revision, 'revision'), options);
      return p;
    }
    if (binding.kind === 'calendar-report') {
      const p = principal(['to-doo:read', 'to-doo:integrations'], options);
      domainAccess('calendar', options, true);
      checkVersion('calendarSource', binding.id, need(binding.revision, 'revision'), options);
      return p;
    }
    if (binding.kind === 'import') {
      const p = principal(['to-doo:read', 'to-doo:write', 'to-doo:integrations'], options);
      if (binding.metadata?.scope !== policyKey(p, options))
        fail(403, 'FORBIDDEN', '导入授权范围已变化');
      if (binding.metadata?.fullDataset) fullAccess(options);
      else agent(options).assertList(binding.id === 'inbox' ? null : binding.id);
      if (typeof binding.metadata?.previewId === 'string')
        importGuard(binding.metadata.previewId, p, options);
      return p;
    }
    if (binding.kind === 'export') {
      const p = principal(['to-doo:read', 'to-doo:share'], options);
      if (binding.metadata?.scope !== policyKey(p, options))
        fail(403, 'FORBIDDEN', '导出授权范围已变化');
      if (!binding.revision || binding.revision !== todo.snapshot().version)
        fail(409, 'VERSION_CONFLICT', '导出数据版本已变化，请重新导出');
      initialize();
      const access = db
        .prepare(
          'SELECT note_ids,note_paths FROM to_doo_mcp_export_access WHERE binding_id=? AND owner=?',
        )
        .get(binding.id, owner(p)) as { note_ids: string; note_paths: string } | undefined;
      if (!access) fail(403, 'FORBIDDEN');
      for (const noteId of JSON.parse(access.note_ids))
        if (!canReadNote(p, noteId)) fail(403, 'FORBIDDEN', '导出引用的知识资料权限已变化');
      for (const path of JSON.parse(access.note_paths)) authorizePath(p, path, 'knowledge:read');
      return p;
    }
    fail(403, 'FORBIDDEN');
  }
  function sanitize(value: any, p: Principal): any {
    if (Array.isArray(value))
      return value.map((item) => sanitize(item, p)).filter((item) => item !== null);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.noteId === 'string' && !canReadNote(p, value.noteId)) return null;
    for (const [field, kind] of [
      ['taskId', 'task'],
      ['parentTaskId', 'task'],
      ['occurrenceId', 'occurrence'],
      ['parentOccurrenceId', 'occurrence'],
      ['habitId', 'habit'],
      ['sourceSessionId', 'focusSession'],
    ] as const) {
      if (typeof value[field] === 'string')
        try {
          agent().inspect(kind, value[field]);
        } catch {
          return null;
        }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, p)]));
  }
  function selectedSnapshot(
    p: Principal,
    listIds: string[] | undefined,
    options?: ServiceCallOptions,
  ) {
    const snapshot = todo.snapshot({ all: true }),
      port = agent(options),
      selected = { ...snapshot } as ToDooSnapshot;
    for (const [kind, collection] of Object.entries(TO_DOO_COLLECTIONS)) {
      (selected as any)[collection] = (snapshot as any)[collection]
        .filter((entity: any) => {
          if (internalKinds.has(kind)) return false;
          try {
            port.inspect(kind as ToDooEntityKind, entity.id);
            if (listIds?.length) {
              if (kind === 'list') return listIds.includes(entity.id);
              const task =
                kind === 'task'
                  ? entity
                  : entity.taskId
                    ? todo.getEntity('task', entity.taskId)
                    : entity.occurrenceId
                      ? todo.getEntity(
                          'task',
                          (todo.getEntity('occurrence', entity.occurrenceId) as any)?.taskId,
                        )
                      : undefined;
              const listId = task ? (task as any).listId : entity.listId;
              return listIds.includes(listId === null ? 'inbox' : listId);
            }
            return true;
          } catch {
            return false;
          }
        })
        .map((entity: any) => sanitize(entity, p))
        .filter(Boolean);
    }
    return selected;
  }
  function importGuard(
    previewId: string,
    p: Principal,
    options?: ServiceCallOptions,
    allowMissing = false,
  ) {
    initialize();
    const row = db.prepare('SELECT * FROM to_doo_mcp_imports WHERE preview_id=?').get(previewId) as
      | { owner: string; scope: string; full_dataset: number; list_id: string | null }
      | undefined;
    if (!row || row.owner !== owner(p)) fail(403, 'FORBIDDEN', '导入预览不属于当前调用者');
    const current = principal(['to-doo:read', 'to-doo:write', 'to-doo:integrations'], options);
    if (row.scope !== policyKey(current, options))
      fail(403, 'FORBIDDEN', '导入授权范围已变化，请重新预览');
    if (row.full_dataset) fullAccess(options);
    else agent(options).assertList(row.list_id === 'inbox' ? null : row.list_id);
    const material = db
      .prepare('SELECT content FROM to_doo_import_previews WHERE id=?')
      .get(previewId) as { content: string } | undefined;
    if (!material) {
      if (allowMissing) return null;
      fail(404, 'NOT_FOUND');
    }
    const applied = db
      .prepare('SELECT offset FROM to_doo_import_jobs WHERE preview_id=?')
      .get(previewId) as { offset: number } | undefined;
    const restored = db
      .prepare('SELECT applied_result FROM to_doo_import_previews WHERE id=?')
      .get(previewId) as { applied_result: string | null };
    const preview = JSON.parse(material.content),
      completed =
        applied?.offset ??
        (restored.applied_result ? JSON.parse(material.content).items.length : 0),
      entities = new Map<string, any>(
        preview.items.map((item: any) => [item.kind + ':' + item.entity.id, item.entity]),
      );
    function entity(kind: string, id: string) {
      return entities.get(kind + ':' + id) ?? todo.getEntity(kind as ToDooEntityKind, id);
    }
    function entityList(kind: string, value: any, depth = 0): string | null | undefined {
      if (!value || depth > 8) return undefined;
      if (kind === 'list') return value.id;
      if (kind === 'task' || Object.hasOwn(value, 'listId')) return value.listId ?? null;
      for (const [field, related] of [
        ['taskId', 'task'],
        ['occurrenceId', 'occurrence'],
        ['habitId', 'habit'],
        ['sourceSessionId', 'focusSession'],
      ] as const)
        if (value[field]) return entityList(related, entity(related, value[field]), depth + 1);
      return undefined;
    }
    function references(value: any) {
      if (Array.isArray(value)) {
        value.forEach(references);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (typeof value.noteId === 'string' && !canReadNote(current, value.noteId))
        fail(403, 'FORBIDDEN', '导入资料引用需要知识库读取授权');
      const related: Record<string, string> = {
        taskId: 'task',
        parentTaskId: 'task',
        occurrenceId: 'occurrence',
        parentOccurrenceId: 'occurrence',
        habitId: 'habit',
        sourceSessionId: 'focusSession',
        sectionId: 'section',
        blockId: 'timeBlock',
      };
      for (const [field, kind] of Object.entries(related))
        if (typeof value[field] === 'string') {
          const target = entity(kind, value[field]);
          if (!target) fail(403, 'FORBIDDEN');
          if (!row!.full_dataset) {
            domainAccess(entityDomains[kind as ToDooEntityKind], options);
            const list = entityList(kind, target);
            if ((list === null ? 'inbox' : list) !== row!.list_id)
              fail(403, 'FORBIDDEN', '导入引用超出目标清单');
          }
        }
      for (const item of Object.values(value)) references(item);
    }
    for (const item of preview.items) {
      const kind = item.kind as ToDooEntityKind;
      if (!row.full_dataset && !['calendarSource', 'import'].includes(kind)) {
        domainAccess(entityDomains[kind], options);
        const list = entityList(kind, item.entity);
        if (list === undefined || (list === null ? 'inbox' : list) !== row.list_id)
          fail(403, 'FORBIDDEN', '导入内容超出明确目标清单');
        agent(options).assertList(list);
      }
      if (kind === 'operation') {
        if (!row.full_dataset) fail(403, 'FORBIDDEN');
        authorizePath(
          current,
          (item.entity.folderPath ? item.entity.folderPath + '/' : '') + item.entity.fileName,
          'knowledge:read',
        );
      }
      const existing = todo.getEntity(kind, item.entity.id);
      if (
        existing &&
        !row.full_dataset &&
        ['calendarSource', 'import'].includes(kind) &&
        preview.items.indexOf(item) >= completed
      )
        fail(403, 'FORBIDDEN', '有限清单导入不能覆盖全局集成记录');
      if (existing && !['calendarSource', 'import', 'operation'].includes(kind))
        agent(options).inspect(kind, item.entity.id);
      references(item.entity);
    }
    return preview;
  }
  function managedCommand(raw: any, options?: ServiceCallOptions) {
    const parsed = toDooCommandSchema.safeParse(raw);
    if (!parsed.success) fail(400, 'INVALID_INPUT');
    const cmd = parsed.data,
      payload = cmd.payload as any;
    if (!['save_entity', 'delete_entity'].includes(cmd.action) || !internalKinds.has(payload.kind))
      return agent(options).command(cmd);
    const kind = payload.kind as ToDooEntityKind;
    if (kind === 'operation') fail(403, 'FORBIDDEN', '成果操作必须通过成果笔记工作流管理');
    principal(
      [
        'to-doo:read',
        'to-doo:write',
        kind === 'calendarFeed' ? 'to-doo:share' : 'to-doo:integrations',
      ],
      options,
    );
    domainAccess('calendar', options, kind !== 'calendarFeed');
    const id = cmd.action === 'save_entity' ? payload.entity.id : payload.id;
    const current = typeof id === 'string' ? (todo.getEntity(kind, id) as any) : undefined;
    if (cmd.action === 'delete_entity' && !current) fail(403, 'FORBIDDEN');
    if (kind === 'calendarFeed') {
      domainAccess('tasks', options);
      const checkFeed = (feed: any) => {
        if (!feed.listIds?.length) {
          domainAccess('tasks', options, true);
          domainAccess('calendar', options, true);
          return;
        }
        for (const listId of feed.listIds)
          agent(options).assertList(listId === 'inbox' ? null : listId);
      };
      if (current) checkFeed(current);
      if (cmd.action === 'save_entity') checkFeed({ ...current, ...payload.entity });
    }
    const references = (value: any): void => {
      if (Array.isArray(value)) {
        value.forEach(references);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (
        typeof value.noteId === 'string' &&
        !canReadNote(principal(['knowledge:read'], options), value.noteId)
      )
        fail(403, 'FORBIDDEN');
      Object.values(value).forEach(references);
    };
    references(payload);
    return Promise.resolve(brief(todo.command(cmd)));
  }
  async function call(
    tool: string,
    raw: unknown,
    options?: ServiceCallOptions,
  ): Promise<Record<string, unknown>> {
    if (!Object.hasOwn(toDooFullToolSchemas, tool)) fail(400, 'INVALID_INPUT');
    const name = tool as ToDooFullToolName,
      schema = toDooFullToolSchemas[name],
      meta = toDooFullToolMetadata[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail(400, 'INVALID_INPUT', 'To Doo 工具字段不正确');
    const a: any = parsed.data,
      p = principal([meta.scope, ...(meta.additionalScopes ?? [])], options),
      port = agent(options);
    switch (name) {
      case 'read_to_doo_entity': {
        if (a.offset > 0 && !a.expectedContentHash)
          fail(400, 'INVALID_INPUT', '继续读取需要 expectedContentHash');
        const entity = await port.readEntity(a.kind, a.id, a.expectedRevision);
        const bytes = Buffer.from(JSON.stringify(entity)),
          sha256 = createHash('sha256').update(bytes).digest('hex');
        if (a.expectedContentHash && a.expectedContentHash !== sha256)
          fail(409, 'VERSION_CONFLICT', '内容或资料引用授权已变化，请从当前视图重新读取');
        const start = a.offset;
        if (start > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80))
          fail(400, 'INVALID_INPUT', '读取位置不在有效字符边界');
        let end = Math.min(bytes.length, start + a.maxBytes);
        while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
        const result = () => ({
          kind: a.kind,
          id: a.id,
          revision: a.expectedRevision,
          format: 'json' as const,
          content: bytes.subarray(start, end).toString('utf8'),
          sha256,
          range: {
            offset: start,
            nextOffset: end < bytes.length ? end : null,
            totalBytes: bytes.length,
          },
        });
        while (mcpResultFrameSize({ data: result() }) > mcpMaximumFrameBytes) {
          end = start + Math.floor((end - start) / 2);
          while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
          if (end === start) fail(413, 'REQUEST_TOO_LARGE', '单个实体字段无法放入读取预算');
        }
        return result();
      }
      case 'get_to_doo_outcome_operation': {
        if (!a.operationId && !a.requestId)
          fail(400, 'INVALID_INPUT', '需要原 requestId 或 operationId');
        const identity = JSON.stringify([p.id, p.clientId]);
        const operationId =
          a.operationId ??
          'out_' +
            createHash('sha256')
              .update(JSON.stringify([p.id, p.clientId, a.requestId]))
              .digest('hex')
              .slice(0, 40);
        const operation = todo.getEntity('operation', operationId) as any;
        if (
          !operation ||
          operation.callerIdentity !== createHash('sha256').update(identity).digest('hex')
        )
          fail(403, 'FORBIDDEN');
        if (a.requestId && operation.requestId !== a.requestId) fail(403, 'FORBIDDEN');
        domainAccess('records', options);
        port.inspect('occurrence', operation.occurrenceId);
        authorizePath(
          p,
          (operation.folderPath ? operation.folderPath + '/' : '') + operation.fileName,
          'knowledge:read',
        );
        if (operation.noteId && !canReadNote(p, operation.noteId)) fail(403, 'FORBIDDEN');
        if (a.expectedRevision && operation.revision !== a.expectedRevision)
          fail(409, 'VERSION_CONFLICT');
        const result: Record<string, unknown> = {
          operationId,
          requestId: operation.requestId,
          state: operation.state,
          occurrenceId: operation.occurrenceId,
          expectedRevision: operation.expectedRevision,
          revision: operation.revision,
          noteId: operation.noteId,
          title: operation.title,
          needsReconciliation: operation.state !== 'completed',
        };
        if (a.includeContent) {
          if (!a.expectedRevision) fail(400, 'INVALID_INPUT', '读取成果草稿需要 expectedRevision');
          const bytes = Buffer.from(operation.content),
            start = a.offset;
          if (start > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80))
            fail(400, 'INVALID_INPUT');
          let end = Math.min(bytes.length, start + a.maxBytes);
          while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
          result.content = bytes.subarray(start, end).toString('utf8');
          result.contentRange = {
            offset: start,
            nextOffset: end < bytes.length ? end : null,
            totalBytes: bytes.length,
          };
        }
        return result;
      }
      case 'get_to_doo_operation': {
        initialize();
        const row = db
          .prepare('SELECT * FROM to_doo_mcp_actions WHERE owner=? AND request_id=?')
          .get(owner(p), a.requestId) as
          | { tool: ToDooFullToolName; scope: string; targets: string; result: string | null }
          | undefined;
        if (!row) return { requestId: a.requestId, state: 'unavailable', result: null };
        const required = toDooFullToolMetadata[row.tool];
        const current = principal([required.scope, ...(required.additionalScopes ?? [])], options);
        if (row.scope !== policyKey(current, options)) fail(403, 'FORBIDDEN');
        const targets = JSON.parse(row.targets);
        if (targets.taskId) port.inspect('task', targets.taskId);
        if (targets.listIds) lists(targets.listIds, options);
        if (targets.previewId && (!row.result || JSON.parse(row.result).status !== 'cancelled'))
          importGuard(targets.previewId, current, options);
        if (targets.sourceId) domainAccess('calendar', options, true);
        if (targets.deviceId) domainAccess('settings', options, true);
        if (targets.id && row.tool === 'act_on_to_doo_reminder')
          port.inspect('reminderEvent', targets.id);
        return {
          requestId: a.requestId,
          state: row.result === null ? 'pending' : 'completed',
          tool: row.tool,
          result: row.result === null ? null : JSON.parse(row.result),
        };
      }
      case 'describe_to_doo_schema': {
        if (a.category !== 'catalog') {
          if (!a.name) fail(400, 'INVALID_INPUT', 'schema 查询需要 name');
          try {
            return {
              category: a.category,
              name: a.name,
              schema: toDooSchemaDocument(a.category, a.name),
            };
          } catch {
            fail(400, 'INVALID_INPUT');
          }
        }
        const catalog = [
          ...toDooCommandSchema.options.map((command) => ({
            category: 'command',
            name: command.shape.action.value,
            tool:
              command.shape.action.value === 'attach_asset'
                ? 'finish_to_doo_attachment'
                : command.shape.action.value === 'detach_asset'
                  ? 'remove_to_doo_attachment'
                  : command.shape.action.value === 'import_entities'
                    ? 'preview_to_doo_import'
                    : 'execute_to_doo_command',
          })),
          ...Object.keys(toDooEntitySchemas).map((kind) => ({
            category: 'entity',
            name: kind,
            tool:
              kind === 'operation'
                ? 'create_to_doo_outcome_note'
                : kind === 'calendarFeed'
                  ? 'manage_to_doo_feed'
                  : kind === 'calendarSource'
                    ? 'manage_to_doo_calendar'
                    : kind === 'import'
                      ? 'manage_to_doo_import'
                      : 'save_to_doo_entity',
          })),
        ];
        return {
          items: catalog.slice(a.offset, a.offset + a.limit),
          total: catalog.length,
          nextOffset: a.offset + a.limit < catalog.length ? a.offset + a.limit : null,
        };
      }
      case 'execute_to_doo_command': {
        if (['attach_asset', 'detach_asset', 'import_entities'].includes(a.action))
          fail(400, 'INVALID_INPUT', '请使用 schema 目录注明的专用工具');
        if (a.action === 'save_entity') {
          const kind = a.payload.kind as ToDooEntityKind,
            entity = a.payload.entity;
          if (!Object.hasOwn(toDooEntitySchemas, kind) || !entity || typeof entity !== 'object')
            fail(400, 'INVALID_INPUT');
          const { id, ...fields } = entity,
            patch = !!todo.getEntity(kind, id);
          toDooEntityFields(kind, patch).parse(fields);
        }
        return managedCommand(a, options);
      }
      case 'save_to_doo_entity': {
        const fields = toDooEntityFields(a.kind, a.mode === 'patch').parse(a.fields);
        if (a.mode === 'patch') {
          need(a.id, 'id');
          need(a.expectedRevision, 'expectedRevision');
        } else if (a.expectedRevision) fail(400, 'INVALID_INPUT');
        if (
          a.mode === 'create' &&
          a.id &&
          todo.getEntity(a.kind, a.id) &&
          !todo.getReceipt(a.requestId)
        )
          fail(409, 'VERSION_CONFLICT', '实体 ID 已存在');
        return managedCommand(
          {
            requestId: a.requestId,
            action: 'save_entity',
            payload: {
              kind: a.kind,
              entity: { ...fields, ...(a.id ? { id: a.id } : {}) },
              ...(a.expectedRevision ? { expectedRevision: a.expectedRevision } : {}),
            },
          },
          options,
        );
      }
      case 'export_to_doo_data': {
        const key = policyKey(p, options),
          selectedLists = lists(a.listIds, options);
        if (a.fullDataset) fullAccess(options);
        const snapshot = selectedSnapshot(p, selectedLists, options);
        let content: string;
        const noteIds = new Set<string>(),
          notePaths = new Set<string>();
        const rememberReferences = (value: any): void => {
          if (Array.isArray(value)) {
            value.forEach(rememberReferences);
            return;
          }
          if (!value || typeof value !== 'object') return;
          if (typeof value.noteId === 'string') noteIds.add(value.noteId);
          if (value.kind === 'outcome_note')
            notePaths.add((value.folderPath ? value.folderPath + '/' : '') + value.fileName);
          Object.values(value).forEach(rememberReferences);
        };
        rememberReferences(snapshot);
        if (a.fullDataset) {
          // A checkpoint contains original receipts and recovery material. Every referenced
          // note must remain readable; selective exports never include these internals.
          const checkpoint = todo.exportCheckpoint();
          const check = (value: any): void => {
            if (Array.isArray(value)) {
              value.forEach(check);
              return;
            }
            if (!value || typeof value !== 'object') return;
            if (typeof value.noteId === 'string' && !canReadNote(p, value.noteId))
              fail(403, 'FORBIDDEN');
            if (value.kind === 'outcome_note') {
              authorizePath(
                p,
                (value.folderPath ? value.folderPath + '/' : '') + value.fileName,
                'knowledge:read',
              );
            }
            Object.values(value).forEach(check);
          };
          check(checkpoint.entities);
          rememberReferences(checkpoint.entities);
          content =
            a.format === 'json'
              ? JSON.stringify(checkpoint)
              : exportCalendar(snapshotCalendarItems(snapshot, a), {
                  datasetId: snapshot.datasetId,
                  mode: a.mode,
                  includeDescription: a.includeDescription,
                });
        } else
          content =
            a.format === 'json'
              ? exportPortableJson(snapshot, {
                  includeSettings:
                    context.toDooAccess(options).domains.includes('settings') && !selectedLists,
                })
              : exportCalendar(snapshotCalendarItems(snapshot, { ...a, listIds: undefined }), {
                  datasetId: snapshot.datasetId,
                  mode: a.mode,
                  includeDescription: a.includeDescription,
                });
        if (todo.snapshot().version !== snapshot.version)
          fail(409, 'VERSION_CONFLICT', '导出数据版本已变化，请重新导出');
        const current = principal(['to-doo:read', 'to-doo:share'], options);
        if (key !== policyKey(current, options)) fail(403, 'FORBIDDEN');
        const bindingId = digest([
          owner(current),
          a.requestId,
          snapshot.version,
          selectedLists,
          a.format,
        ]);
        const download = transfers.createDownload(current, {
          requestId: a.requestId,
          binding: {
            domain: 'to-doo',
            kind: 'export',
            id: bindingId,
            revision: snapshot.version,
            metadata: { scope: key },
          },
          name: 'to-doo.' + a.format,
          mime: a.format === 'json' ? 'application/json' : 'text/calendar',
          bytes: Buffer.from(content),
        });
        initialize();
        db.prepare('DELETE FROM to_doo_mcp_export_access WHERE expires_at<=?').run(Date.now());
        db.prepare('INSERT OR REPLACE INTO to_doo_mcp_export_access VALUES(?,?,?,?,?,?)').run(
          bindingId,
          owner(current),
          download.transferId,
          JSON.stringify([...noteIds]),
          JSON.stringify([...notePaths]),
          Date.parse(download.expiresAt),
        );
        return download as unknown as Record<string, unknown>;
      }
      case 'begin_to_doo_import': {
        if (a.fullDataset) fullAccess(options);
        else {
          if (a.listId === undefined) fail(400, 'INVALID_INPUT', '导入需要明确目标清单');
          port.assertList(a.listId);
        }
        return transfers.beginUpload(p, {
          requestId: a.requestId,
          binding: {
            domain: 'to-doo',
            kind: 'import',
            id: a.listId ?? 'inbox',
            metadata: { scope: policyKey(p, options), fullDataset: a.fullDataset },
          },
          name: 'to-doo-import',
          mime: 'application/octet-stream',
          totalBytes: a.bytes,
          sha256: a.sha256,
        }) as unknown as Record<string, unknown>;
      }
      case 'preview_to_doo_import': {
        const info = transfers.info(p, a.transferId);
        authorizeTransfer(info.binding, true, options);
        const expected = {
          domain: 'to-doo' as const,
          kind: 'import',
          id: a.listId ?? 'inbox',
          metadata: { scope: policyKey(p, options), fullDataset: a.fullDataset },
        };
        const upload = transfers.readUpload(p, a.transferId, expected, a.requestId);
        return memo(p, a.requestId, name, a, () => {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes);
          if (a.format === 'json' && !a.fullDataset) {
            let data;
            try {
              data = JSON.parse(content);
            } catch {
              fail(400, 'INVALID_INPUT');
            }
            if (data.checkpoint || data.appId === 'to-doo')
              fail(403, 'FORBIDDEN', '检查点恢复需要明确 fullDataset 和全部领域授权');
          }
          const preview = runtime.toDooInterop.previewImport({ ...a, content });
          initialize();
          db.prepare('INSERT INTO to_doo_mcp_imports VALUES(?,?,?,?,?)').run(
            preview.id,
            owner(p),
            policyKey(p, options),
            a.fullDataset ? 1 : 0,
            a.listId ?? 'inbox',
          );
          try {
            importGuard(preview.id, p, options);
          } catch (error) {
            runtime.toDooInterop.cancelImport(preview.id);
            db.prepare('DELETE FROM to_doo_mcp_imports WHERE preview_id=?').run(preview.id);
            throw error;
          }
          runtime.toDooInterop.protectImport(preview.id, () => {
            importGuard(preview.id, p, options);
          });
          return {
            previewId: preview.id,
            total: preview.items.length,
            duplicates: preview.duplicates,
            batchCount: preview.batchCount,
            warnings: preview.warnings.slice(0, 10).map((w) => w.slice(0, 256)),
            changes: preview.changes.slice(0, 20).map((change) => ({
              kind: change.kind,
              id: change.id,
              fields: change.diff.map((field) => field.field).slice(0, 40),
            })),
            hasMore: preview.changes.length > 20,
          };
        });
      }
      case 'read_to_doo_import_preview': {
        const preview = importGuard(a.previewId, p, options);
        const row = db
          .prepare('SELECT full_dataset,list_id FROM to_doo_mcp_imports WHERE preview_id=?')
          .get(a.previewId) as { full_dataset: number; list_id: string };
        return transfers.createDownload(p, {
          requestId: a.requestId,
          binding: {
            domain: 'to-doo',
            kind: 'import',
            id: row.list_id,
            metadata: {
              scope: policyKey(p, options),
              fullDataset: !!row.full_dataset,
              previewId: a.previewId,
            },
          },
          name: 'to-doo-import-preview.json',
          mime: 'application/json',
          bytes: Buffer.from(
            JSON.stringify({
              previewId: a.previewId,
              changes: preview.changes.map((change: any) => ({
                kind: change.kind,
                id: change.id,
                before: sanitize(change.before, p),
                after: change.after,
                fields: change.diff.map((field: any) => field.field),
              })),
              warnings: preview.warnings,
              duplicates: preview.duplicates,
            }),
          ),
        }) as unknown as Record<string, unknown>;
      }
      case 'manage_to_doo_import': {
        const preview = importGuard(a.previewId, p, options, a.action === 'cancel');
        if (preview)
          runtime.toDooInterop.protectImport(a.previewId, () => {
            importGuard(a.previewId, p, options);
          });
        const result =
          a.action === 'status'
            ? runtime.toDooInterop.importStatus(a.previewId)
            : await memo(p, a.requestId, name, a, () =>
                a.action === 'apply'
                  ? ((result: any) => ('snapshot' in result ? brief(result) : result))(
                      runtime.toDooInterop.applyImport({
                        previewId: a.previewId,
                        requestId: a.requestId,
                      }),
                    )
                  : a.action === 'cancel'
                    ? runtime.toDooInterop.cancelImport(a.previewId)
                    : a.action === 'resume'
                      ? runtime.toDooInterop.resumeImport(a.previewId)
                      : runtime.toDooInterop.importStatus(a.previewId),
              );
        if ('snapshot' in result || 'transactionId' in result) return brief(result);
        return { ...result, ...(result.result ? { result: brief(result.result) } : {}) };
      }
      case 'manage_to_doo_calendar': {
        domainAccess('calendar', options, true);
        const guard = () => {
          principal(['to-doo:read', 'to-doo:integrations'], options);
          domainAccess('calendar', options, true);
          if (a.sourceId && todo.getEntity('calendarSource', a.sourceId))
            checkVersion(
              'calendarSource',
              a.sourceId,
              need(a.expectedRevision, 'expectedRevision'),
              options,
            );
        };
        if (a.action === 'list') {
          const items = runtime.toDooInterop.connections();
          return {
            items: items.slice(a.offset, a.offset + a.limit),
            total: items.length,
            nextOffset: a.offset + a.limit < items.length ? a.offset + a.limit : null,
          };
        }
        if (a.action !== 'connect') port.inspect('calendarSource', need(a.sourceId, 'sourceId'));
        return memo(p, a.requestId, name, a, async () => {
          if (a.action !== 'connect')
            checkVersion(
              'calendarSource',
              a.sourceId,
              need(a.expectedRevision, 'expectedRevision'),
              options,
            );
          const result: any = await (a.action === 'connect'
            ? runtime.toDooInterop.connectCalendar(
                {
                  sourceId:
                    a.sourceId ?? 'calendar_' + digest([owner(p), a.requestId]).slice(0, 40),
                  name: need(a.name, 'name'),
                  url: need(a.url, 'url'),
                  headers: a.headers,
                },
                guard,
              )
            : a.action === 'refresh'
              ? runtime.toDooInterop.refreshCalendar(a.sourceId, guard)
              : a.action === 'pause'
                ? runtime.toDooInterop.pauseCalendar(a.sourceId, need(a.paused, 'paused'))
                : runtime.toDooInterop.disconnectCalendar(a.sourceId));
          if (!Array.isArray(result.warnings)) return result;
          const warnings = result.warnings as string[];
          const warningsTransfer =
            warnings.length > 10
              ? transfers.createDownload(p, {
                  requestId: 'calendar_report_' + digest([owner(p), a.requestId]).slice(0, 40),
                  binding: {
                    domain: 'to-doo',
                    kind: 'calendar-report',
                    id: result.sourceId,
                    revision: todo.getEntity('calendarSource', result.sourceId)?.revision,
                  },
                  name: 'to-doo-calendar-warnings.json',
                  mime: 'application/json',
                  bytes: Buffer.from(JSON.stringify({ warnings })),
                })
              : undefined;
          return {
            ...result,
            warnings: warnings.slice(0, 10).map((warning) => warning.slice(0, 256)),
            warningCount: warnings.length,
            ...(warningsTransfer ? { warningsTransfer } : {}),
          };
        });
      }
      case 'manage_to_doo_feed': {
        domainAccess('calendar', options);
        domainAccess('tasks', options);
        const allowed = (feed: any) => {
          try {
            if (!feed.listIds.length) {
              domainAccess('tasks', options, true);
              domainAccess('calendar', options, true);
              return true;
            }
            for (const id of feed.listIds) port.assertList(id === 'inbox' ? null : id);
            return true;
          } catch {
            return false;
          }
        };
        if (a.action === 'list') {
          const items = runtime.toDooInterop.feeds().filter(allowed);
          return {
            items: items.slice(a.offset, a.offset + a.limit).map((feed) => ({
              ...feed,
              listIds: feed.listIds.slice(0, 10),
              listCount: feed.listIds.length,
              listIdsTruncated: feed.listIds.length > 10,
            })),
            total: items.length,
            nextOffset: a.offset + a.limit < items.length ? a.offset + a.limit : null,
          };
        }
        if (a.action === 'readLists') {
          const feed = todo.getEntity('calendarFeed', need(a.id, 'id')) as any;
          if (!feed || !allowed(feed)) fail(403, 'FORBIDDEN');
          if (feed.revision !== need(a.expectedRevision, 'expectedRevision'))
            fail(409, 'VERSION_CONFLICT');
          return {
            id: feed.id,
            revision: feed.revision,
            listIds: feed.listIds.slice(a.offset, a.offset + a.limit),
            total: feed.listIds.length,
            nextOffset: a.offset + a.limit < feed.listIds.length ? a.offset + a.limit : null,
          };
        }
        if (a.action === 'create') {
          const ids = lists(need(a.listIds, 'listIds'), options)!;
          const id = 'feed_' + digest([owner(p), a.requestId]).slice(0, 40),
            token = createHmac('sha256', context.config.secret)
              .update('mcp-feed:' + owner(p) + ':' + a.requestId)
              .digest('base64url');
          const currentFeed = todo.getEntity('calendarFeed', id);
          if (currentFeed && !allowed(currentFeed)) fail(403, 'FORBIDDEN');
          const result = await memo(
            p,
            a.requestId,
            name,
            a,
            () => {
              const feed = runtime.toDooInterop.createFeed(
                {
                  name: need(a.name, 'name'),
                  listIds: ids,
                  includeDescription: a.includeDescription,
                },
                { id, requestId: a.requestId, token },
              );
              return { id: feed.id };
            },
            options,
          );
          return { ...result, token, url: '/to-doo/feed/' + token + '.ics' };
        }
        const feed = todo.getEntity('calendarFeed', need(a.id, 'id')) as any;
        if (!feed || !allowed(feed)) fail(403, 'FORBIDDEN');
        return memo(p, a.requestId, name, a, () => {
          if (feed.revision !== need(a.expectedRevision, 'expectedRevision'))
            fail(409, 'VERSION_CONFLICT');
          return runtime.toDooInterop.revokeFeed(a.id);
        });
      }
      case 'manage_to_doo_notifications': {
        domainAccess('settings', options, true);
        const safeStatus = () => {
          const { publicKey: _key, ...status } = runtime.toDooNotifications.status();
          return {
            ...status,
            devices: status.devices.slice(a.offset, a.offset + a.limit),
            deviceCount: status.devices.length,
            nextOffset: a.offset + a.limit < status.devices.length ? a.offset + a.limit : null,
            lastError: status.lastError ? '通知主机最近有投递失败，请在应用中检查' : null,
            browserEnrollmentRequired: true,
          };
        };
        if (a.action === 'status') return safeStatus();
        return memo(p, a.requestId, name, a, async () => {
          if (a.action === 'configure') {
            await runtime.toDooNotifications.configure({
              enabled: need(a.enabled, 'enabled'),
              showContent: a.showContent,
            });
            return safeStatus();
          }
          return a.action === 'test'
            ? runtime.toDooNotifications.test(need(a.deviceId, 'deviceId'))
            : runtime.toDooNotifications.revoke(need(a.deviceId, 'deviceId'));
        });
      }
      case 'act_on_to_doo_reminder': {
        port.inspect('reminderEvent', a.id);
        return memo(p, a.requestId, name, a, () => {
          checkVersion('reminderEvent', a.id, a.expectedRevision, options);
          return brief(runtime.toDooNotifications.action(a.id, a));
        });
      }
      case 'begin_to_doo_attachment': {
        checkVersion('task', a.taskId, a.expectedRevision, options);
        return transfers.beginUpload(p, {
          requestId: a.requestId,
          binding: {
            domain: 'to-doo',
            kind: 'attachment',
            id: a.taskId,
            revision: a.expectedRevision,
          },
          name: 'attachment',
          mime: 'application/octet-stream',
          totalBytes: a.bytes,
          sha256: a.sha256,
        }) as unknown as Record<string, unknown>;
      }
      case 'finish_to_doo_attachment': {
        const binding = {
          domain: 'to-doo' as const,
          kind: 'attachment',
          id: a.taskId,
          revision: a.expectedRevision,
        };
        const upload = transfers.readUpload(p, a.transferId, binding, a.requestId);
        // Replays are safe after the original CAS changed the task revision; the
        // receipt is still gated by current task access and immutable transfer ownership.
        port.inspect('task', a.taskId);
        const result = await memo(p, a.requestId, name, a, () => {
          checkVersion('task', a.taskId, a.expectedRevision, options);
          return brief(
            createToDooAssets(todo, { knowledgeRoot: context.config.knowledgeRoot, db }).upload({
              ...a,
              bytes: upload.bytes,
            }),
          );
        });
        transfers.complete(p, a.transferId, a.requestId, result);
        return result;
      }
      case 'read_to_doo_attachment': {
        checkVersion('task', a.taskId, a.expectedRevision, options);
        const asset = createToDooAssets(todo, {
          knowledgeRoot: context.config.knowledgeRoot,
          db,
        }).get(a.taskId, a.hash);
        return transfers.createDownload(p, {
          requestId: a.requestId,
          binding: {
            domain: 'to-doo',
            kind: 'attachment',
            id: a.taskId,
            revision: a.expectedRevision,
          },
          name: asset.name,
          mime: asset.mime,
          bytes: asset.bytes,
        }) as unknown as Record<string, unknown>;
      }
      case 'remove_to_doo_attachment': {
        port.inspect('task', a.taskId);
        return memo(p, a.requestId, name, a, () => {
          checkVersion('task', a.taskId, a.expectedRevision, options);
          return brief(
            createToDooAssets(todo, { knowledgeRoot: context.config.knowledgeRoot, db }).remove(a),
          );
        });
      }
      case 'create_to_doo_outcome_note': {
        const caller = {
          authorize(occurrenceId: string, path?: string, noteId?: string | null) {
            const current = principal(
              ['to-doo:read', 'to-doo:write', 'knowledge:read', 'knowledge:write'],
              options,
            );
            domainAccess('records', options);
            agent(options).inspect('occurrence', occurrenceId);
            if (path) {
              authorizePath(current, path, 'knowledge:read');
              authorizePath(current, path, 'knowledge:write');
            }
            if (noteId && !canReadNote(current, noteId)) fail(403, 'FORBIDDEN');
            return current;
          },
        };
        const result = createOutcomeNoteService(
          context.config,
          db,
          runtime.notes,
          todo,
          caller,
        ).create(a);
        return {
          noteId: result.noteId,
          operationId: result.operationId,
          result: brief(result.result),
        };
      }
    }
  }
  return { call, authorizeTransfer };
}
