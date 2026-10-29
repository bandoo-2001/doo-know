import type { ToDooPort } from '../../../packages/plugin-sdk/index.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import {
  TO_DOO_COLLECTIONS,
  toDooCommandSchema,
  type ToDooService,
  type ToDooEntityKind,
  type ToDooEntity,
} from '../../../shared/to-doo-contracts.js';
import {
  toDooMcpQuery,
  toDooMcpContext,
  type ToDooMcpQueryResult,
} from '../../../shared/to-doo-mcp-contracts.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { requireScope } from '../../../packages/core/agent/auth.js';
import { dateTimeInstant } from '../../../packages/core/to-doo/recurrence.js';
import { createHash } from 'node:crypto';

type Access = { listIds: string[]; domains: string[]; resourceListIds?: string[] };
type Options = {
  authorize(write: boolean): Principal;
  access(): Access;
  canReadNote(principal: Principal, id: string): boolean | Promise<boolean>;
};
const domains: Record<ToDooEntityKind, string> = {
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
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function shortText(value: string, maximum = 2048) {
  const buffer = Buffer.from(value);
  if (buffer.length <= maximum) return value;
  let end = maximum;
  while (end && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** Scope enforcement belongs to the host, never to model-supplied filters. */
export function createToDooAgentPort(service: ToDooService, options: Options): ToDooPort {
  const signature = (principal: Principal, access: Access) =>
    JSON.stringify([
      principal.id,
      principal.clientId,
      principal.grantId,
      principal.grantVersion,
      [...principal.scopes].sort(),
      [...principal.allowedPrefixes].sort(),
      [...access.listIds].sort(),
      [...access.domains].sort(),
      access.resourceListIds ? [...access.resourceListIds].sort() : null,
    ]);
  function recheck(write: boolean, original: string) {
    const current = options.authorize(write);
    if (signature(current, options.access()) !== original)
      fail(403, 'FORBIDDEN', '授权范围已变化，请重新读取后再操作');
  }
  const get = (kind: ToDooEntityKind, id: unknown) =>
    typeof id === 'string'
      ? (service.getEntity(kind, id) as (ToDooEntity & Record<string, any>) | undefined)
      : undefined;
  function listOf(
    kind: ToDooEntityKind,
    value: Record<string, any>,
    depth = 0,
  ): string | null | undefined {
    if (depth > 8) return undefined;
    if (kind === 'list') return value.id;
    if (kind === 'task' || kind === 'section') return value.listId ?? null;
    if (Object.hasOwn(value, 'listId') && value.listId) return value.listId;
    const related = value.taskId
      ? get('task', value.taskId)
      : value.occurrenceId
        ? get('occurrence', value.occurrenceId)
        : value.habitId
          ? get('habit', value.habitId)
          : value.sourceSessionId
            ? get('focusSession', value.sourceSessionId)
            : undefined;
    if (related)
      return listOf(
        value.taskId
          ? 'task'
          : value.occurrenceId
            ? 'occurrence'
            : value.habitId
              ? 'habit'
              : 'focusSession',
        related,
        depth + 1,
      );
    if (kind === 'activity') {
      const target = get('task', value.entityId) ?? get('occurrence', value.entityId);
      if (target) return listOf('taskId' in target ? 'occurrence' : 'task', target, depth + 1);
    }
    if (kind === 'reminderEvent') {
      const targetKind =
        value.sourceType === 'task'
          ? 'occurrence'
          : value.sourceType === 'habit'
            ? 'habit'
            : 'anniversary';
      const target = get(targetKind, value.sourceId);
      if (target) return listOf(targetKind, target, depth + 1);
    }
    return undefined;
  }
  function allowedList(list: string | null | undefined, access: Access) {
    const id = list === null ? 'inbox' : list;
    return (
      (!access.listIds.length || (typeof id === 'string' && access.listIds.includes(id))) &&
      (access.resourceListIds === undefined ||
        (typeof id === 'string' && access.resourceListIds.includes(id)))
    );
  }
  function queryLists(access: Access) {
    if (access.resourceListIds !== undefined)
      return access.resourceListIds.filter(
        (id) => !access.listIds.length || access.listIds.includes(id),
      );
    return access.listIds.length ? access.listIds : undefined;
  }
  function allowed(kind: ToDooEntityKind, entity: Record<string, any>, access: Access) {
    if (!access.domains.includes(domains[kind])) return false;
    if (access.resourceListIds !== undefined && !allowedList(listOf(kind, entity), access))
      return false;
    if (!access.listIds.length) return true;
    if (['anniversaries', 'calendar', 'settings'].includes(domains[kind])) return true;
    if (kind === 'plan')
      return (
        entity.changes?.length > 0 &&
        entity.changes.every((change: any) => {
          const occurrence = get('occurrence', change.occurrenceId);
          return !!occurrence && allowedList(listOf('occurrence', occurrence), access);
        })
      );
    if (kind === 'view')
      return (
        entity.filter?.listIds?.length > 0 &&
        entity.filter.listIds.every((id: string) => allowedList(id, access))
      );
    if (kind === 'tag' || kind === 'template') return false;
    const list = listOf(kind, entity);
    if (list === undefined && ['focus', 'habits'].includes(domains[kind])) return true;
    return allowedList(list, access);
  }
  function check(kind: ToDooEntityKind, id: string, access: Access) {
    const value = get(kind, id);
    if (!value || !allowed(kind, value, access))
      fail(403, 'FORBIDDEN', 'To Doo 项目不在当前授权范围');
    return value;
  }
  async function sanitize(
    value: any,
    principal: Principal,
    truncated: string[],
    path = '',
  ): Promise<any> {
    if (typeof value === 'string') {
      const text = shortText(value);
      if (text !== value) truncated.push(path);
      return text;
    }
    if (Array.isArray(value)) {
      if (value.length > 30) truncated.push(path);
      const result = await Promise.all(
        value.slice(0, 30).map((item, i) => sanitize(item, principal, truncated, `${path}[${i}]`)),
      );
      return result.filter((item) => item !== null);
    }
    if (!value || typeof value !== 'object') return value;
    if (typeof value.noteId === 'string' && !(await options.canReadNote(principal, value.noteId)))
      return null;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      result[key] = await sanitize(item, principal, truncated, path ? `${path}.${key}` : key);
    return result;
  }
  async function bounded(kind: ToDooEntityKind, entity: ToDooEntity, principal: Principal) {
    const truncatedFields: string[] = [];
    let safe = await sanitize(entity, principal, truncatedFields);
    if (bytes(safe) > 4000) {
      safe = Object.fromEntries(
        [
          'id',
          'revision',
          'title',
          'name',
          'status',
          'listId',
          'taskId',
          'parentTaskId',
          'scheduledDate',
          'due',
          'updatedAt',
          'deletedAt',
        ]
          .filter((key) => Object.hasOwn(safe, key))
          .map((key) => [key, safe[key]]),
      );
      truncatedFields.push('*');
    }
    return { kind, entity: safe, ...(truncatedFields.length ? { truncatedFields } : {}) };
  }
  async function query(raw: Parameters<ToDooPort['query']>[0]): Promise<ToDooMcpQueryResult> {
    const principal = options.authorize(false);
    requireScope(principal, 'to-doo:read');
    const input = toDooMcpQuery.parse(raw),
      access = options.access();
    const admitted = signature(principal, access);
    if (input.receiptRequestId) {
      const receipt = service.getReceipt(input.receiptRequestId);
      if (!receipt) fail(404, 'TO_DOO_RECEIPT_UNAVAILABLE');
      const changed = receipt.changed.filter((change) => {
        const entity = get(change.kind, change.id);
        return !!entity && allowed(change.kind, entity, access);
      });
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([input.receiptRequestId, changed, admitted]))
        .digest('hex');
      let offset = 0;
      if (input.cursor) {
        let cursor: { fingerprint?: string; offset?: number };
        try {
          cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        } catch {
          fail(400, 'INVALID_INPUT');
        }
        if (
          cursor.fingerprint !== fingerprint ||
          !Number.isInteger(cursor.offset) ||
          cursor.offset! < 0 ||
          cursor.offset! > changed.length
        )
          fail(409, 'VERSION_CONFLICT', '回执授权范围已变化，请从第一页重新读取');
        offset = cursor.offset!;
      }
      const end = Math.min(changed.length, offset + input.limit);
      recheck(false, admitted);
      return {
        items: changed.slice(offset, end).map((change) => ({
          kind: change.kind,
          entity: {
            id: change.id,
            revision: change.revision,
            transactionId: receipt.transactionId,
          },
        })),
        total: changed.length,
        hasMore: end < changed.length,
        ...(end < changed.length
          ? {
              nextCursor: Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString(
                'base64url',
              ),
            }
          : {}),
      };
    }
    if (input.kind === 'statistics') {
      if (!access.domains.includes('statistics')) fail(403, 'FORBIDDEN');
      if (input.listIds?.some((id) => !allowedList(id, access))) fail(403, 'FORBIDDEN');
      const state = service.snapshot({ all: true });
      const scope = {
        ...access,
        listIds: input.listIds ?? access.listIds,
        domains: Object.values(domains),
      };
      const taskIds = new Set(
        state.tasks
          .filter((task) => !task.deletedAt && !task.archivedAt && allowed('task', task, scope))
          .map((task) => task.id),
      );
      const parentIds = new Set(
        state.tasks
          .filter((task) => taskIds.has(task.id))
          .map((task) => task.parentTaskId)
          .filter(Boolean),
      );
      const leafIds = new Set([...taskIds].filter((id) => !parentIds.has(id)));
      const day = (at: string) =>
        new Intl.DateTimeFormat('sv-SE', { timeZone: state.settings.timeZone }).format(
          new Date(at),
        );
      const within = (value: string) =>
        (!input.from || value >= input.from) && (!input.to || value <= input.to);
      const occurrences = state.occurrences.filter(
        (occurrence) => leafIds.has(occurrence.taskId) && !occurrence.deletedAt,
      );
      const active = occurrences.filter(
        (occurrence) =>
          !['done', 'cancelled', 'skipped'].includes(occurrence.status) &&
          within(occurrence.scheduledDate ?? occurrence.due?.date ?? day(state.now)),
      );
      const completed = occurrences.filter(
        (occurrence) =>
          occurrence.status === 'done' &&
          occurrence.completedAt &&
          within(day(occurrence.completedAt)),
      );
      let focusMinutes = 0;
      for (const session of state.focusSessions.filter(
        (session) =>
          !session.deletedAt &&
          session.mode !== 'break' &&
          !['cancelled', 'interrupted'].includes(session.status) &&
          allowed('focusSession', session, scope),
      )) {
        const segments = session.segments.filter((segment) => within(day(segment.start)));
        focusMinutes +=
          session.correctedMinutes ??
          segments.reduce(
            (total, segment) =>
              total +
              Math.max(0, Date.parse(segment.end ?? state.now) - Date.parse(segment.start)) / 60000,
            0,
          );
      }
      const habits = new Set(
        state.habits
          .filter((habit) => !habit.deletedAt && allowed('habit', habit, scope))
          .map((habit) => habit.id),
      );
      const habitAmount = state.habitEntries
        .filter(
          (entry) =>
            !entry.deletedAt &&
            !entry.skipped &&
            habits.has(entry.habitId) &&
            within(entry.localDate),
        )
        .reduce((total, entry) => total + entry.amount, 0);
      const outcomes = state.outcomes.filter(
        (outcome) =>
          !outcome.deletedAt &&
          allowed('outcome', outcome, scope) &&
          within(day(outcome.updatedAt)),
      ).length;
      const overdue = active.filter(
        (occurrence) =>
          occurrence.due &&
          dateTimeInstant(occurrence.due, occurrence.due.time ?? '23:59').getTime() <
            Date.parse(state.now),
      ).length;
      const entity = {
        id: 'statistics',
        revision: state.version,
        scope: 'authorized',
        from: input.from ?? null,
        to: input.to ?? null,
        asOf: state.now,
        timeZone: state.settings.timeZone,
        completed: completed.length,
        pending: active.length,
        overdue,
        focusMinutes: Math.round(focusMinutes * 100) / 100,
        habitAmount,
        outcomes,
      };
      recheck(false, admitted);
      return { items: [{ kind: 'statistics' as const, entity }], total: 1, hasMore: false };
    }
    if (!access.domains.includes(domains[input.kind])) fail(403, 'FORBIDDEN');
    if (input.listIds?.some((id) => !allowedList(id, access))) fail(403, 'FORBIDDEN');
    if (input.field) {
      if (input.ids?.length !== 1 || input.cursor)
        fail(400, 'INVALID_INPUT', '字段分页需要一个实体 ID，使用 offset 继续读取');
      const entity = check(input.kind, input.ids[0], access);
      if (input.expectedRevision && input.expectedRevision !== entity.revision)
        fail(409, 'VERSION_CONFLICT', '内容已变化，请从当前版本重新读取');
      const text = entity[input.field];
      if (typeof text !== 'string') fail(400, 'INVALID_INPUT', '该实体没有所选文本字段');
      const content = Buffer.from(text),
        start = input.offset ?? 0;
      if (start > content.length || (start < content.length && (content[start] & 0xc0) === 0x80))
        fail(400, 'INVALID_INPUT', '读取位置不在有效字符边界');
      let end = Math.min(content.length, start + (input.maxBytes ?? 4096));
      while (end < content.length && end > start && (content[end] & 0xc0) === 0x80) end--;
      recheck(false, admitted);
      return {
        items: [
          {
            kind: input.kind,
            entity: {
              id: entity.id,
              revision: entity.revision,
              [input.field]: content.subarray(start, end).toString('utf8'),
              fieldRange: {
                field: input.field,
                startByte: start,
                endByte: end,
                totalBytes: content.length,
                nextByte: end < content.length ? end : null,
              },
            },
          },
        ],
        total: 1,
        hasMore: false,
      };
    }
    const state = service.snapshot({
      ...input,
      kind: input.kind,
      limit: Math.min(input.limit, 5),
      listIds: input.listIds ?? queryLists(access),
    });
    const entities: ToDooEntity[] =
      input.kind === 'settings'
        ? [state.settings]
        : state[TO_DOO_COLLECTIONS[input.kind as keyof typeof TO_DOO_COLLECTIONS]];
    const kind = input.kind;
    const items = await Promise.all(
      entities
        .filter((entity) => allowed(kind, entity, access))
        .map((entity) => bounded(kind, entity, principal)),
    );
    const next = state.page.nextCursor;
    const result: ToDooMcpQueryResult = {
      items,
      total: state.page.total,
      hasMore: !!next,
      ...(next ? { nextCursor: next } : {}),
      ...(input.limit > 5
        ? { warnings: ['每页最多返回5项以保证完整的结构化响应预算；使用 nextCursor 继续。'] }
        : {}),
    };
    if (access.listIds.length && ['tag', 'template'].includes(input.kind)) {
      result.total = 0;
      result.hasMore = false;
      delete result.nextCursor;
    }
    recheck(false, admitted);
    return result;
  }
  async function command(raw: Parameters<ToDooPort['command']>[0]) {
    const parsed = toDooCommandSchema.safeParse(raw);
    if (!parsed.success) fail(400, 'INVALID_INPUT');
    const cmd = parsed.data,
      write = cmd.action !== 'preview_plan';
    const principal = options.authorize(write),
      access = options.access();
    const admitted = signature(principal, access);
    requireScope(principal, 'to-doo:read');
    if (write) requireScope(principal, 'to-doo:write');
    const p = cmd.payload as Record<string, any>;
    const target = (kind: ToDooEntityKind, id: unknown) => {
      if (typeof id === 'string') return check(kind, id, access);
      return undefined;
    };
    const prospective = (kind: ToDooEntityKind, value: Record<string, any>) => {
      if (!allowed(kind, value, access)) fail(403, 'FORBIDDEN');
    };
    function guardIntent() {
      switch (cmd.action) {
        case 'create_task':
          if (get('task', p.id)) target('task', p.id);
          prospective('task', p);
          target('task', p.parentTaskId);
          break;
        case 'update_task': {
          const current = check('task', p.id, access);
          prospective('task', { ...current, ...p.patch });
          break;
        }
        case 'set_occurrence_status':
          target('occurrence', p.id);
          break;
        case 'save_outcome':
          if (!access.domains.includes('records') || p.operationId) fail(403, 'FORBIDDEN');
          if (get('outcome', p.outcome.id)) target('outcome', p.outcome.id);
          target('occurrence', p.occurrenceId);
          break;
        case 'batch_tasks':
          for (const id of p.ids) target('task', id);
          if (p.listId !== undefined && !allowedList(p.listId, access)) fail(403, 'FORBIDDEN');
          if (p.patch?.listId !== undefined && !allowedList(p.patch.listId, access))
            fail(403, 'FORBIDDEN');
          target('task', p.parentTaskId);
          break;
        case 'save_entity': {
          const current = get(p.kind, p.entity.id);
          if (current) target(p.kind, p.entity.id);
          prospective(p.kind, { ...current, ...p.entity });
          break;
        }
        case 'delete_entity':
          target(p.kind, p.id);
          break;
        case 'materialize_occurrences':
        case 'change_recurrence':
          target('task', p.taskId);
          break;
        case 'start_focus':
          if (!access.domains.includes('focus')) fail(403, 'FORBIDDEN');
          if (access.resourceListIds !== undefined) prospective('focusSession', p);
          target('occurrence', p.occurrenceId);
          if (p.listId !== null && !allowedList(p.listId, access)) fail(403, 'FORBIDDEN');
          break;
        case 'control_focus':
          target('focusSession', p.id);
          break;
        case 'checkin_habit':
          target('habit', p.habitId);
          break;
        case 'apply_template':
          target('template', p.templateId);
          if (!allowedList(p.listId, access)) fail(403, 'FORBIDDEN');
          break;
        case 'preview_plan':
        case 'apply_plan':
          for (const change of cmd.action === 'preview_plan' ? p.changes : p.plan.changes)
            target('occurrence', change.occurrenceId);
          break;
        case 'import_entities':
          fail(403, 'FORBIDDEN', '批量导入请使用主人数据导入入口');
        default:
          fail(403, 'FORBIDDEN', '该操作需要主人在应用中执行');
      }
    }
    guardIntent();
    const related: Record<string, ToDooEntityKind> = {
      parentTaskId: 'task',
      taskId: 'task',
      occurrenceId: 'occurrence',
      parentOccurrenceId: 'occurrence',
      habitId: 'habit',
      sourceSessionId: 'focusSession',
      sectionId: 'section',
      blockId: 'timeBlock',
    };
    function checkEntityReferences(value: any): void {
      if (Array.isArray(value)) {
        for (const item of value) checkEntityReferences(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (related[key] && typeof item === 'string') target(related[key], item);
        if (key === 'listId' && item !== undefined && !allowedList(item as string | null, access))
          fail(403, 'FORBIDDEN');
        checkEntityReferences(item);
      }
    }
    async function authorizeNotes(value: any): Promise<void> {
      if (Array.isArray(value)) {
        for (const item of value) await authorizeNotes(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (typeof value.noteId === 'string' && !(await options.canReadNote(principal, value.noteId)))
        fail(403, 'FORBIDDEN', '资料关联需要对应的知识库读取权限');
      for (const item of Object.values(value)) await authorizeNotes(item);
    }
    checkEntityReferences(p);
    await authorizeNotes(p);
    recheck(write, admitted);
    // Metadata may have moved to a different list while note authorization awaited I/O.
    guardIntent();
    checkEntityReferences(p);
    if (cmd.action === 'apply_plan') {
      for (const key of Object.keys(p.plan.expectedRevisions ?? {})) {
        const split = key.indexOf(':'),
          kind = key.slice(0, split),
          id = key.slice(split + 1);
        if (!['task', 'occurrence', 'timeBlock'].includes(kind) || !id) fail(400, 'INVALID_INPUT');
        target(kind as ToDooEntityKind, id);
      }
    }
    const trustedContext =
      ['preview_plan', 'apply_plan'].includes(cmd.action) &&
      (access.listIds.length || access.resourceListIds !== undefined)
        ? {
            allowedTaskIds: service
              .snapshot({ all: true, kind: 'task' })
              .tasks.filter((task) => !task.deletedAt && allowedList(task.listId, access))
              .map((task) => task.id),
          }
        : undefined;
    const result = service.command(cmd, trustedContext);
    if (result.preview && bytes(result.preview) > 22000)
      fail(413, 'REQUEST_TOO_LARGE', '计划预览超过单次连接预算，请分批预览或在应用中核对');
    const receipt = {
      transactionId: result.transactionId,
      replayed: result.replayed,
      changed: result.changed.slice(0, 50),
      ids: result.ids.slice(0, 50),
      changedCount: result.changed.length,
      idsCount: result.ids.length,
      receiptTruncated: result.changed.length > 50 || result.ids.length > 50,
      ...(result.preview
        ? {
            preview: {
              ...result.preview,
              conflicts: result.preview.conflicts.map(
                () => '该安排与现有内容存在冲突，请在应用中核对。',
              ),
            },
          }
        : {}),
    };
    return receipt;
  }
  return {
    query,
    command,
    context: async (raw) => {
      const input = toDooMcpContext.parse(raw),
        access = options.access();
      const principal = options.authorize(false);
      requireScope(principal, 'to-doo:read');
      const admitted = signature(principal, access);
      const task = input.taskId ? check('task', input.taskId, access) : undefined;
      const listId = input.listId ?? task?.listId;
      const goal = listId ? check('list', listId, access) : null;
      const tasks = await query({
        kind: 'task',
        ...(input.taskId ? { ids: [input.taskId] } : listId ? { listIds: [listId] } : {}),
        limit: Math.min(input.limit ?? 5, 5),
      });
      const records = access.domains.includes('records')
        ? await query({ kind: 'record', ...(listId ? { listIds: [listId] } : {}), limit: 2 })
        : { items: [] };
      const result = {
        goal: goal ? (await bounded('list', goal, principal)).entity : null,
        tasks: tasks.items.map((item) => item.entity),
        records: records.items.map((item) => item.entity),
        warnings: tasks.warnings ?? [],
      };
      recheck(false, admitted);
      return result;
    },
  };
}
