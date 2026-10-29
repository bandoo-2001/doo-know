import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import {
  TO_DOO_COLLECTIONS,
  toDooEntitySchemas,
  toDooRecurrenceSchema,
  type ToDooEntityKind,
  type ToDooDateTime,
  type ToDooService,
  type ToDooSnapshot,
  type ToDooCheckpoint,
  type ToDooRecurrence,
} from '../../../shared/to-doo-contracts.js';
import { canonical as checkpointCanonical } from './store.js';
import { interruptImportedToDooFocusSession } from './service.js';
import {
  addDays,
  dateTimeInstant,
  expandRecurrence,
  localDate,
  stableToDooId,
} from './recurrence.js';
import {
  calendarItemId,
  expandCalendar,
  exportCalendar,
  parseCalendar,
  type CalendarItem,
} from './calendar.js';
import { createToDooNetwork, type ToDooNetwork } from './network.js';

export class ToDooInteropError extends Error {
  statusCode = 400;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ToDooInteropError';
    this.statusCode = statusCode;
  }
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value))
    .digest('hex');
export type PortableEntity = {
  kind: ToDooEntityKind;
  entity: Record<string, unknown>;
  sha256: string;
};
export type PortablePackage = {
  format: 'dooknow.to-doo';
  version: 1;
  datasetId: string;
  createdAt: string;
  entities: PortableEntity[];
  transactions: unknown[];
  assets: { sha256: string; content: string }[];
  inventoryHash: string;
  checkpoint?: ToDooCheckpoint;
};
export function exportPortableJson(
  snapshot: ToDooSnapshot,
  extra: {
    transactions?: unknown[];
    assets?: { sha256: string; content: string }[];
    includeSettings?: boolean;
  } = {},
): string {
  const entities: PortableEntity[] =
    extra.includeSettings === false
      ? []
      : [{ kind: 'settings', entity: snapshot.settings, sha256: hash(snapshot.settings) }];
  for (const [kind, collection] of Object.entries(TO_DOO_COLLECTIONS))
    for (const entity of (snapshot as unknown as Record<string, Record<string, unknown>[]>)[
      collection
    ] ?? [])
      entities.push({ kind: kind as ToDooEntityKind, entity, sha256: hash(entity) });
  const base = {
    format: 'dooknow.to-doo' as const,
    version: 1 as const,
    datasetId: snapshot.datasetId,
    createdAt: snapshot.now,
    entities,
    transactions: extra.transactions ?? [],
    assets: extra.assets ?? [],
  };
  return JSON.stringify({ ...base, inventoryHash: hash(base) }, null, 2);
}
export function validatePortableJson(content: string): PortablePackage {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 64 * 1024 * 1024)
    throw new ToDooInteropError('JSON package exceeds input budget');
  let data: PortablePackage;
  try {
    data = JSON.parse(content);
  } catch {
    throw new ToDooInteropError('Invalid JSON package');
  }
  if (
    (data as unknown as ToDooCheckpoint)?.format === 1 &&
    (data as unknown as ToDooCheckpoint).appId === 'to-doo'
  ) {
    const checkpoint = data as unknown as ToDooCheckpoint;
    const { digest, ...payload } = checkpoint;
    if (
      !Array.isArray(checkpoint.entities) ||
      !Array.isArray(checkpoint.receipts) ||
      !Array.isArray(checkpoint.transactions) ||
      !Array.isArray(checkpoint.assets) ||
      hash(checkpointCanonical(payload)) !== digest
    )
      throw new ToDooInteropError('Portable checkpoint integrity hash mismatch');
    const base = {
      format: 'dooknow.to-doo' as const,
      version: 1 as const,
      datasetId: checkpoint.datasetId,
      createdAt: checkpoint.createdAt,
      entities: checkpoint.entities.map((item) => ({
        ...item,
        entity: item.entity as unknown as Record<string, unknown>,
        sha256: hash(item.entity),
      })),
      transactions: checkpoint.transactions,
      assets: checkpoint.assets.map((a) => ({ sha256: a.hash, content: a.data })),
      checkpoint,
    };
    data = { ...base, inventoryHash: hash(base) };
  }
  if (data?.format !== 'dooknow.to-doo' || data.version !== 1)
    throw new ToDooInteropError('Unsupported portable JSON format or version');
  if (
    typeof data.datasetId !== 'string' ||
    !Array.isArray(data.entities) ||
    data.entities.length > 200000 ||
    !Array.isArray(data.transactions) ||
    !Array.isArray(data.assets)
  )
    throw new ToDooInteropError('Invalid portable JSON inventory');
  const { inventoryHash, ...base } = data;
  if (hash(base) !== inventoryHash)
    throw new ToDooInteropError('Portable inventory integrity hash mismatch');
  const identities = new Set<string>();
  for (const item of data.entities) {
    if (
      !item ||
      !Object.hasOwn(toDooEntitySchemas, item.kind) ||
      !item.entity ||
      hash(item.entity) !== item.sha256
    )
      throw new ToDooInteropError('Portable entity integrity hash mismatch');
    const result = toDooEntitySchemas[item.kind].safeParse(item.entity);
    if (!result.success) throw new ToDooInteropError('Portable entity schema validation failed');
    const key = item.kind + ':' + result.data.id;
    if (identities.has(key)) throw new ToDooInteropError('Duplicate portable entity identity');
    identities.add(key);
  }
  let assetBytes = 0;
  for (const asset of data.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.content !== 'string')
      throw new ToDooInteropError('Invalid portable asset');
    const bytes = Buffer.from(asset.content, 'base64');
    assetBytes += bytes.length;
    if (assetBytes > 32 * 1024 * 1024 || hash(bytes) !== asset.sha256)
      throw new ToDooInteropError('Portable asset hash or size mismatch');
  }
  return data;
}

export type CsvItem = {
  sourceKey: string;
  externalId: string | null;
  title: string;
  description: string;
  listName: string;
  parentKey: string | null;
  tags: string[];
  priority: 'none' | 'low' | 'normal' | 'high';
  status: 'todo' | 'done' | 'cancelled';
  due: ToDooDateTime | null;
  start: ToDooDateTime | null;
  repeat: string;
  unknown: Record<string, string>;
};
export type CsvMapping = Partial<
  Record<
    | 'id'
    | 'title'
    | 'description'
    | 'list'
    | 'parent'
    | 'tags'
    | 'priority'
    | 'status'
    | 'due'
    | 'start'
    | 'repeat',
    string
  >
>;
function csvRows(content: string): string[][] {
  if (Buffer.byteLength(content) > 10 * 1024 * 1024)
    throw new ToDooInteropError('CSV input limit exceeded');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
      continue;
    }
    if (char === '"') {
      if (cell || closed) throw new ToDooInteropError('Malformed CSV quote');
      quoted = true;
    } else if (char === ',') endCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && content[i + 1] === '\n') i++;
      endRow();
    } else {
      if (closed && !/\s/.test(char)) throw new ToDooInteropError('Malformed CSV trailing data');
      if (!closed) cell += char;
    }
    if (rows.length > 10000 || cell.length > 65536)
      throw new ToDooInteropError('CSV row or cell limit exceeded');
  }
  if (quoted) throw new ToDooInteropError('Unterminated CSV quote');
  if (cell || row.length) endRow();
  return rows;
}
const aliases: Record<keyof CsvMapping, string[]> = {
  id: ['task id', 'id', '任务id'],
  title: ['title', 'task name', '标题', '任务名称'],
  description: ['content', 'description', 'note', '备注', '内容'],
  list: ['list name', 'list', 'project', '清单'],
  parent: ['parent id', 'parent', '父任务id'],
  tags: ['tags', 'tag', '标签'],
  priority: ['priority', '优先级'],
  status: ['status', '状态'],
  due: ['due date', 'due', '截止日期'],
  start: ['start date', 'start', '开始日期'],
  repeat: ['repeat', 'recurrence', '重复'],
};
export function parseTickTickCsv(
  content: string,
  options: { timeZone: string; mapping?: CsvMapping },
): { items: CsvItem[]; warnings: string[]; columns: string[] } {
  try {
    new Intl.DateTimeFormat('en', { timeZone: options.timeZone });
  } catch {
    throw new ToDooInteropError('CSV default time zone is required');
  }
  const rows = csvRows(content.replace(/^\uFEFF/, ''));
  const headerIndex = rows.findIndex((row) =>
    row.some(
      (cell) =>
        aliases.title.includes(cell.trim().toLowerCase()) || cell.trim() === options.mapping?.title,
    ),
  );
  if (headerIndex < 0) throw new ToDooInteropError('CSV title column needs explicit mapping');
  const columns = rows[headerIndex].map((v) => v.trim());
  const mapping: Record<string, number> = {};
  const consumed = new Set<number>();
  for (const [key, names] of Object.entries(aliases)) {
    const explicit = options.mapping?.[key as keyof CsvMapping];
    const index = columns.findIndex((column) =>
      explicit ? column === explicit : names.includes(column.toLowerCase()),
    );
    if (index >= 0) {
      mapping[key] = index;
      consumed.add(index);
    }
  }
  const warnings: string[] = [];
  const items: CsvItem[] = [];
  const parseDate = (value: string, row: number): ToDooDateTime | null => {
    if (!value.trim()) return null;
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?$/);
    if (
      !match ||
      !Number.isFinite(Date.parse(match[1] + 'T00:00:00Z')) ||
      new Date(match[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== match[1] ||
      (match[2] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(match[2]))
    ) {
      warnings.push(`Row ${row}: unrecognized date retained for review`);
      return null;
    }
    return { date: match[1], time: match[2] ?? null, timeZone: options.timeZone };
  };
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length !== columns.length)
      throw new ToDooInteropError(`CSV row ${i + 1} column count does not match header`);
    const get = (key: keyof CsvMapping) => row[mapping[key]] ?? '';
    if (!get('title').trim()) {
      warnings.push(`Row ${i + 1}: empty title skipped`);
      continue;
    }
    const status = get('status').toLowerCase();
    const priority = get('priority').toLowerCase();
    const unknown = Object.fromEntries(
      columns.map((key, index) => [key, row[index]]).filter((_, index) => !consumed.has(index)),
    );
    if (get('repeat'))
      warnings.push(
        `Row ${i + 1}: repeat expression is retained in source metadata and checked before task mapping`,
      );
    const due = parseDate(get('due'), i + 1),
      start = parseDate(get('start'), i + 1);
    for (const [field, parsed] of [
      ['due', due],
      ['start', start],
    ] as const)
      if (get(field) && !parsed) unknown[columns[mapping[field]]] = get(field);
    if (
      priority &&
      !['0', 'none', '5', 'high', '高', '3', 'normal', '中', '1', 'low', '低'].includes(priority)
    ) {
      unknown[columns[mapping.priority]] = get('priority');
      warnings.push(`Row ${i + 1}: unrecognized priority retained; mapped to none`);
    }
    if (
      status &&
      ![
        '0',
        'todo',
        '未完成',
        '2',
        'done',
        'completed',
        '已完成',
        '-1',
        'cancelled',
        '已取消',
      ].includes(status)
    ) {
      unknown[columns[mapping.status]] = get('status');
      warnings.push(`Row ${i + 1}: unrecognized status retained; mapped to todo`);
    }
    items.push({
      sourceKey:
        get('id') || hash({ title: get('title'), list: get('list'), parent: get('parent') }),
      externalId: get('id') || null,
      title: get('title'),
      description: get('description'),
      listName: get('list'),
      parentKey: get('parent') || null,
      tags: get('tags')
        .split(/[,;，]/)
        .map((v) => v.trim())
        .filter(Boolean),
      priority: ['5', 'high', '高'].includes(priority)
        ? 'high'
        : ['3', 'normal', '中'].includes(priority)
          ? 'normal'
          : ['1', 'low', '低'].includes(priority)
            ? 'low'
            : 'none',
      status: ['2', 'done', 'completed', '已完成'].includes(status)
        ? 'done'
        : ['-1', 'cancelled', '已取消'].includes(status)
          ? 'cancelled'
          : 'todo',
      due,
      start,
      repeat: get('repeat'),
      unknown,
    });
  }
  return { items, warnings, columns };
}

export type ImportPreviewInput = {
  format: 'json' | 'ics' | 'csv';
  content: string;
  sourceId?: string;
  name?: string;
  timeZone?: string;
  mapping?: CsvMapping;
  target?: 'calendar' | 'tasks';
  listId?: string | null;
  mergeMode?: 'skip' | 'copy' | 'update';
};
type ImportEntry = {
  kind: ToDooEntityKind;
  entity: Record<string, unknown>;
  expectedRevision?: string;
};
type StoredPreview = {
  id: string;
  fingerprint: string;
  items: ImportEntry[];
  warnings: string[];
  duplicates: number;
  sourceId: string;
  createdAt: string;
  batchSize: number;
  batchCount: number;
  mergeMode: 'skip' | 'copy' | 'update';
  copyJobId: string | null;
  changes: {
    kind: ToDooEntityKind;
    id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    expectedRevision?: string;
    diff: { field: string; before: unknown; after: unknown }[];
  }[];
  package?: PortablePackage;
};
type ImportJob = {
  preview_id: string;
  request_id: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  offset: number;
  total: number;
  error: string | null;
  result: string | null;
};
export type ToDooInteropOptions = {
  db: AppDatabase;
  dataRoot: string;
  network?: ToDooNetwork;
  now?: () => Date;
  importBatchSize?: number;
};
export function createToDooInterop(service: ToDooService, options: ToDooInteropOptions) {
  const db = options.db,
    network = options.network ?? createToDooNetwork(),
    now = options.now ?? (() => new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS to_doo_import_previews(id TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL,applied_result TEXT);
    CREATE TABLE IF NOT EXISTS to_doo_import_jobs(preview_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,offset INTEGER NOT NULL,total INTEGER NOT NULL,error TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS to_doo_feed_tokens(hash TEXT PRIMARY KEY,feed_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS to_doo_import_guards(preview_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS to_doo_calendar_connections(source_id TEXT PRIMARY KEY,url TEXT NOT NULL,headers TEXT NOT NULL,etag TEXT,last_fetched_at TEXT,status TEXT NOT NULL DEFAULT 'ready',error TEXT);`);
  // Protected previews cannot resume background mutations until their caller's live
  // authorization callback is reattached. The durable flag survives host restarts.
  const importGuards = new Map<string, () => void>();
  function protectImport(previewId: string, guard: () => void) {
    guard();
    db.prepare('INSERT OR IGNORE INTO to_doo_import_guards VALUES(?)').run(previewId);
    importGuards.set(previewId, guard);
  }
  function checkImportGuard(previewId: string) {
    if (!db.prepare('SELECT 1 FROM to_doo_import_guards WHERE preview_id=?').get(previewId)) return;
    const guard = importGuards.get(previewId);
    if (!guard) throw new ToDooInteropError('Import caller must reauthorize before resuming', 403);
    guard();
  }
  const all = () => service.snapshot({ all: true });
  const existing = (snapshot: ToDooSnapshot, kind: ToDooEntityKind, id: string) =>
    kind === 'settings'
      ? snapshot.settings
      : (
          snapshot[TO_DOO_COLLECTIONS[kind as keyof typeof TO_DOO_COLLECTIONS]] as
            | { id: string; revision: string }[]
            | undefined
        )?.find((e) => e.id === id);
  function previewImport(input: ImportPreviewInput) {
    if (!['json', 'ics', 'csv'].includes(input.format))
      throw new ToDooInteropError('Unsupported import format');
    const snapshot = all();
    const previewId = randomUUID(),
      mergeMode = input.mergeMode ?? 'skip',
      copyJobId = mergeMode === 'copy' ? previewId : null;
    if (!['skip', 'copy', 'update'].includes(mergeMode))
      throw new ToDooInteropError('Unknown import merge mode');
    const sourceId = copyJobId
      ? 'src_' + hash([input.sourceId ?? input.name ?? input.format, copyJobId]).slice(0, 32)
      : (input.sourceId ??
        'src_' + hash([input.format, input.name ?? 'Imported ' + input.format]).slice(0, 32));
    const fingerprint = hash([
      input.format,
      sourceId,
      input.content,
      input.target ?? 'calendar',
      input.listId ?? null,
      input.mapping ?? null,
      mergeMode,
      copyJobId,
    ]);
    const items: ImportEntry[] = [],
      warnings: string[] = [];
    let duplicates = 0;
    let portable: PortablePackage | undefined;
    const append = (
      kind: ToDooEntityKind,
      entity: Record<string, unknown>,
      stableIdentity = true,
    ) => {
      const previous = existing(snapshot, kind, String(entity.id));
      if (previous) {
        duplicates++;
        if (mergeMode === 'update' && stableIdentity) {
          const merged: Record<string, unknown> = { ...previous, ...entity };
          if (
            kind === 'occurrence' &&
            ['due', 'scheduledDate', 'reminders'].every(
              (field) =>
                canonical((previous as unknown as Record<string, unknown>)[field] ?? null) ===
                canonical(merged[field] ?? null),
            )
          )
            merged.scheduleRevision = (
              previous as unknown as Record<string, unknown>
            ).scheduleRevision;
          if (importDiff(previous as unknown as Record<string, unknown>, merged).length)
            items.push({ kind, entity: merged, expectedRevision: previous.revision });
        } else if (mergeMode === 'update' && !stableIdentity)
          warnings.push(
            `${kind} ${entity.id}: missing stable external identity; existing content was not matched by title`,
          );
        return;
      }
      items.push({ kind, entity });
    };
    if (input.format === 'json') {
      portable = validatePortableJson(input.content);
      if (copyJobId) {
        portable.entities = copyPortableEntities(portable.entities, copyJobId);
        if (portable.checkpoint)
          portable.checkpoint = { ...portable.checkpoint, transactions: [], receipts: [] };
        warnings.push(
          'Copies receive independent identities; original request receipts and active cross-content operations are not copied',
        );
      }
      const empty = Object.values(TO_DOO_COLLECTIONS).every(
        (collection) => (snapshot[collection] as unknown[]).length === 0,
      );
      for (const item of portable.entities) {
        const previous = existing(snapshot, item.kind, String(item.entity.id));
        if (previous) {
          if (item.kind === 'settings' && empty && mergeMode !== 'copy') {
            items.push({
              kind: item.kind,
              entity: item.entity,
              expectedRevision: previous.revision,
            });
            warnings.push('The empty destination will adopt the imported application settings');
            continue;
          }
          if (mergeMode === 'update') {
            append(item.kind, item.entity);
            continue;
          }
          if (hash(previous) !== item.sha256)
            warnings.push(
              `${item.kind} ${item.entity.id}: existing entity differs; default merge preserves it`,
            );
          duplicates++;
          continue;
        }
        items.push({ kind: item.kind, entity: item.entity });
      }
      if (portable.datasetId !== snapshot.datasetId)
        warnings.push(
          'Import comes from another dataset; identities are preserved and existing entities are not overwritten',
        );
    } else if (input.format === 'ics') {
      const parsed = parseCalendar(input.content, { timeZone: input.timeZone });
      warnings.push(...parsed.warnings);
      append('calendarSource', {
        id: sourceId,
        name: input.name ?? 'Imported calendar',
        type: 'ics',
        metadata: {},
      });
      if (input.target === 'tasks') {
        const processed = new Set<string>();
        for (const event of parsed.items.filter((item) => !item.recurrenceId)) {
          const id = 'task_' + calendarItemId(sourceId, event.uid, null),
            ruleId = 'series_' + hash([sourceId, event.uid]).slice(0, 32);
          const rule = mapCalendarRule(event, ruleId);
          const related = parsed.items.filter((item) => item.uid === event.uid);
          processed.add(event.uid);
          if ((event.rrule || event.additionalDates.length) && !rule) {
            warnings.push(
              `${event.title}: unsupported recurrence retained as a read-only calendar layer; no one-off task was substituted`,
            );
            for (const entity of projectCalendar(
              related,
              sourceId,
              true,
              now(),
              snapshot.settings.timeZone,
            ))
              append('calendarEvent', entity);
            continue;
          }
          if (rule)
            for (const exception of related.filter((item) => item.recurrenceId)) {
              const cycleKey = rule.id + ':' + exception.recurrenceId!.slice(0, 10);
              append('exception', {
                id: 'exception_' + hash([id, cycleKey]).slice(0, 32),
                taskId: id,
                cycleKey,
                kind: exception.status === 'CANCELLED' ? 'skip' : 'override',
                date: exception.recurrenceId!.slice(0, 10),
                due: exception.start,
                title: exception.title,
              });
            }
          append('task', {
            id,
            title: event.title,
            description: event.description,
            listId: input.listId ?? null,
            recurrence: rule,
          });
          const today = localDate(now(), snapshot.settings.timeZone),
            expanded = rule
              ? expandCalendar(related, {
                  from: addDays(today, -30),
                  to: addDays(today, 90),
                  limit: 9000,
                })
              : [event];
          for (const instance of expanded) {
            const cycleKey = rule
              ? rule.id + ':' + (instance.recurrenceId?.slice(0, 10) ?? instance.start.date)
              : 'once';
            append('occurrence', {
              id: stableToDooId(id, cycleKey),
              taskId: id,
              cycleKey,
              seriesSegmentId: rule?.id ?? null,
              scheduledDate: instance.start.date,
              scheduleRevision: 'import_' + hash(instance).slice(0, 24),
              due: instance.start,
              titleOverride: instance.title !== event.title ? instance.title : null,
              status:
                instance.status === 'COMPLETED'
                  ? 'done'
                  : instance.status === 'CANCELLED'
                    ? 'cancelled'
                    : 'todo',
              completedAt: null,
              manuallyEdited:
                !!instance.recurrenceId &&
                related.some((item) => item.recurrenceId === instance.recurrenceId),
            });
          }
        }
        for (const event of parsed.items.filter(
          (item) => item.recurrenceId && !processed.has(item.uid),
        )) {
          warnings.push(
            `${event.title}: orphan recurrence exception retained as an independent calendar event`,
          );
          append(
            'calendarEvent',
            calendarEntity(
              event,
              sourceId,
              calendarItemId(sourceId, event.uid, event.recurrenceId),
              false,
            ),
          );
        }
      }
      if (input.target !== 'tasks')
        for (const entity of projectCalendar(
          parsed.items,
          sourceId,
          false,
          now(),
          snapshot.settings.timeZone,
        ))
          append('calendarEvent', entity);
    } else {
      if (!input.timeZone) throw new ToDooInteropError('Confirm a CSV time zone before import');
      const parsed = parseTickTickCsv(input.content, {
        timeZone: input.timeZone,
        mapping: input.mapping,
      });
      warnings.push(...parsed.warnings);
      append('calendarSource', {
        id: sourceId,
        name: input.name ?? 'Imported CSV',
        type: 'csv',
        metadata: {
          columns: parsed.columns,
          rows: parsed.items.map((i) => ({
            sourceKey: i.sourceKey,
            parentKey: i.parentKey,
            unknown: i.unknown,
            repeat: i.repeat,
          })),
        },
      });
      const ids = new Map(
        parsed.items.map((item) => [
          item.sourceKey,
          'task_' + hash([sourceId, item.sourceKey]).slice(0, 40),
        ]),
      );
      const lists = new Map<string, string>();
      const tags = new Map<string, string>();
      for (const item of parsed.items) {
        let listId = input.listId ?? null;
        if (!listId && item.listName) {
          listId =
            lists.get(item.listName) ?? 'list_' + hash([sourceId, item.listName]).slice(0, 32);
          if (!lists.has(item.listName)) {
            lists.set(item.listName, listId);
            append('list', { id: listId, name: item.listName });
          }
        }
        const tagIds = item.tags.map((name) => {
          const id = tags.get(name) ?? 'tag_' + hash([sourceId, name]).slice(0, 32);
          if (!tags.has(name)) {
            tags.set(name, id);
            append('tag', { id, name });
          }
          return id;
        });
        const id = ids.get(item.sourceKey)!;
        let parentTaskId = item.parentKey ? (ids.get(item.parentKey) ?? null) : null;
        if (item.parentKey && !parentTaskId)
          warnings.push(
            `${item.title}: missing parent retained in import source; task will be a root`,
          );
        const anchor = item.due ?? item.start;
        const repeatNames: Record<string, string> = {
          每天: 'DAILY',
          每日: 'DAILY',
          daily: 'DAILY',
          'every day': 'DAILY',
          每周: 'WEEKLY',
          weekly: 'WEEKLY',
          'every week': 'WEEKLY',
          每月: 'MONTHLY',
          monthly: 'MONTHLY',
          'every month': 'MONTHLY',
          每年: 'YEARLY',
          yearly: 'YEARLY',
        };
        const raw = item.repeat.replace(/^RRULE:/i, '').trim();
        const expression = repeatNames[raw.toLowerCase()]
          ? 'FREQ=' + repeatNames[raw.toLowerCase()]
          : raw;
        const rule =
          anchor && expression
            ? mapCalendarRule(
                {
                  component: 'VTODO',
                  uid: id,
                  recurrenceId: null,
                  recurrenceTimeZone: null,
                  title: item.title,
                  description: item.description,
                  start: anchor,
                  end: null,
                  allDay: anchor.time === null,
                  status: null,
                  rrule: expression,
                  excludedDates: [],
                  additionalDates: [],
                  raw: '',
                },
                'series_' + hash([sourceId, item.sourceKey]).slice(0, 32),
              )
            : null;
        if (item.repeat && !rule)
          warnings.push(
            `${item.title}: unsupported repetition remains in source metadata; review the rule before enabling repetition`,
          );
        if (mergeMode === 'update' && !item.externalId)
          warnings.push(
            `${item.title}: no stable external ID; similar titles are not used to infer an update`,
          );
        append(
          'task',
          {
            id,
            title: item.title,
            description: item.description,
            listId,
            parentTaskId,
            tagIds,
            priority: item.priority,
            recurrence: rule,
          },
          !!item.externalId,
        );
        const cycleKey = rule ? rule.id + ':' + rule.anchorDate : 'once',
          occurrenceId = stableToDooId(id, cycleKey);
        append(
          'occurrence',
          {
            id: occurrenceId,
            taskId: id,
            cycleKey,
            seriesSegmentId: rule?.id ?? null,
            scheduleRevision: 'import_' + hash(item).slice(0, 24),
            due: item.due,
            scheduledDate: item.start?.date ?? rule?.anchorDate ?? null,
            status: item.status,
            completedAt: null,
          },
          !!item.externalId,
        );
        if (rule) {
          const today = localDate(now(), rule.timeZone);
          for (const period of expandRecurrence(
            rule,
            addDays(today, -30),
            addDays(today, 90),
            2000,
          )) {
            if (period.cycleKey === cycleKey) continue;
            append(
              'occurrence',
              {
                id: stableToDooId(id, period.cycleKey),
                taskId: id,
                cycleKey: period.cycleKey,
                seriesSegmentId: rule.id,
                scheduleRevision: 'import_' + hash([item.sourceKey, period.cycleKey]).slice(0, 24),
                due: { date: period.date, time: rule.time, timeZone: rule.timeZone },
                scheduledDate: period.date,
                status: 'todo',
              },
              !!item.externalId,
            );
          }
        }
        if (item.start)
          append(
            'timeBlock',
            {
              id: 'block_' + hash([sourceId, item.sourceKey]).slice(0, 40),
              occurrenceId,
              start: item.start,
              allDay: item.start.time === null,
              durationMinutes: 30,
            },
            !!item.externalId,
          );
      }
    }
    if (!portable?.checkpoint) {
      const importId = 'import_' + fingerprint.slice(0, 40);
      if (!existing(snapshot, 'import', importId))
        items.push({
          kind: 'import',
          entity: {
            id: importId,
            sourceType: input.format,
            name: input.name ?? 'Import',
            fingerprint,
            importedIds: items.map((item) => String(item.entity.id)),
            warnings,
          },
        });
    }
    const batchSize = Math.max(1, Math.min(options.importBatchSize ?? 500, 1000));
    const ordered = orderImportEntries(items).map((item) =>
      item.kind === 'focusSession'
        ? {
            ...item,
            entity: interruptImportedToDooFocusSession(item.entity),
          }
        : item,
    );
    validateImportEntries(ordered, snapshot, now().toISOString());
    const preview: StoredPreview = {
      id: previewId,
      fingerprint,
      items: ordered,
      warnings,
      duplicates,
      sourceId,
      createdAt: now().toISOString(),
      batchSize,
      batchCount: Math.max(1, Math.ceil(items.length / batchSize)),
      mergeMode,
      copyJobId,
      changes: ordered.map((item) => {
        const before = existing(snapshot, item.kind, String(item.entity.id)) as unknown as
          | Record<string, unknown>
          | undefined;
        return {
          kind: item.kind,
          id: String(item.entity.id),
          before: before ?? null,
          after: item.entity,
          expectedRevision: item.expectedRevision,
          diff: importDiff(before ?? null, item.entity),
        };
      }),
      ...(portable ? { package: portable } : {}),
    };
    db.prepare('INSERT INTO to_doo_import_previews(id,content,created_at) VALUES(?,?,?)').run(
      preview.id,
      JSON.stringify(preview),
      preview.createdAt,
    );
    return preview;
  }
  function applyImport(input: { previewId: string; requestId: string }) {
    checkImportGuard(input.previewId);
    const row = db
      .prepare('SELECT content,applied_result FROM to_doo_import_previews WHERE id=?')
      .get(input.previewId) as { content: string; applied_result: string | null } | undefined;
    if (!row) throw new ToDooInteropError('Import preview not found', 404);
    if (row.applied_result) return JSON.parse(row.applied_result);
    const preview = JSON.parse(row.content) as StoredPreview;
    const job = db
      .prepare('SELECT * FROM to_doo_import_jobs WHERE preview_id=?')
      .get(preview.id) as ImportJob | undefined;
    if (job) {
      if (job.request_id !== input.requestId)
        throw new ToDooInteropError('Import already has a different request identity', 409);
      return importStatus(preview.id);
    }
    const current = all(),
      alreadyCommitted = service
        .exportCheckpoint()
        .receipts.some((receipt) => receipt.requestId === input.requestId);
    if (!alreadyCommitted)
      for (const item of preview.items) {
        const previous = existing(current, item.kind, String(item.entity.id));
        if (item.expectedRevision ? previous?.revision !== item.expectedRevision : !!previous)
          throw new ToDooInteropError('Import preview is stale; preview again', 409);
      }
    // A protected checkpoint can replace the portable dataset identity. Commit it
    // once under the explicit full-dataset authorization, so an identity change
    // cannot strand half an import between separately authorized batches.
    const protectedCheckpoint =
      !!preview.package?.checkpoint &&
      !!db.prepare('SELECT 1 FROM to_doo_import_guards WHERE preview_id=?').get(preview.id);
    if (preview.items.length > preview.batchSize && !protectedCheckpoint) {
      db.prepare(
        "INSERT INTO to_doo_import_jobs(preview_id,request_id,state,offset,total) VALUES(?,?,'queued',0,?)",
      ).run(preview.id, input.requestId, preview.items.length);
      setImmediate(() => {
        if (!closed) void processImportJobs();
      });
      return importStatus(preview.id);
    }
    if (preview.package?.checkpoint) {
      const { digest, ...payload } = preview.package.checkpoint;
      const selected = {
        ...payload,
        entities: preview.items.map((item) => ({ kind: item.kind, entity: item.entity })),
      };
      const checkpoint = {
        ...selected,
        digest: hash(checkpointCanonical(selected)),
      } as ToDooCheckpoint;
      const result = service.importCheckpoint(checkpoint, input.requestId, {
        expectedRevisions: Object.fromEntries(
          preview.items
            .filter((item) => item.expectedRevision)
            .map((item) => [item.kind + ':' + item.entity.id, item.expectedRevision!]),
        ),
      });
      db.prepare('UPDATE to_doo_import_previews SET applied_result=? WHERE id=?').run(
        JSON.stringify(result),
        input.previewId,
      );
      return result;
    }
    const entries = [...preview.items];
    const result = service.command({
      requestId: input.requestId,
      action: 'import_entities',
      payload: { entities: entries },
    });
    db.prepare('UPDATE to_doo_import_previews SET applied_result=? WHERE id=?').run(
      JSON.stringify(result),
      input.previewId,
    );
    return result;
  }
  function importStatus(previewId: string) {
    const job = db.prepare('SELECT * FROM to_doo_import_jobs WHERE preview_id=?').get(previewId) as
      | ImportJob
      | undefined;
    if (job)
      return {
        jobId: previewId,
        status: job.state,
        completed: job.offset,
        total: job.total,
        error: job.error,
        result: job.result ? JSON.parse(job.result) : null,
      };
    const preview = db
      .prepare('SELECT content,applied_result FROM to_doo_import_previews WHERE id=?')
      .get(previewId) as { content: string; applied_result: string | null } | undefined;
    if (!preview) throw new ToDooInteropError('Import not found', 404);
    const parsed = JSON.parse(preview.content) as StoredPreview;
    return {
      jobId: previewId,
      status: preview.applied_result ? 'completed' : 'preview',
      completed: preview.applied_result ? parsed.items.length : 0,
      total: parsed.items.length,
      error: null,
      result: preview.applied_result ? JSON.parse(preview.applied_result) : null,
    };
  }
  function cancelImport(previewId: string) {
    importGuards.delete(previewId);
    const job = db.prepare('SELECT * FROM to_doo_import_jobs WHERE preview_id=?').get(previewId) as
      | ImportJob
      | undefined;
    if (!job) {
      const row = db
        .prepare('SELECT applied_result FROM to_doo_import_previews WHERE id=?')
        .get(previewId) as { applied_result: string | null } | undefined;
      if (!row) throw new ToDooInteropError('Import not found', 404);
      if (row.applied_result)
        throw new ToDooInteropError(
          'Committed import requires an explicit reverse transaction',
          409,
        );
      db.prepare('DELETE FROM to_doo_import_previews WHERE id=?').run(previewId);
      return { jobId: previewId, status: 'cancelled', completed: 0 };
    }
    if (job.state === 'completed')
      throw new ToDooInteropError('Committed import requires an explicit reverse transaction', 409);
    db.prepare("UPDATE to_doo_import_jobs SET state='cancelled' WHERE preview_id=?").run(previewId);
    return importStatus(previewId);
  }
  function resumeImport(previewId: string) {
    checkImportGuard(previewId);
    const job = db.prepare('SELECT * FROM to_doo_import_jobs WHERE preview_id=?').get(previewId) as
      | ImportJob
      | undefined;
    if (!job) throw new ToDooInteropError('Import job not found', 404);
    if (job.state !== 'completed')
      db.prepare("UPDATE to_doo_import_jobs SET state='queued',error=NULL WHERE preview_id=?").run(
        previewId,
      );
    setImmediate(() => {
      if (!closed) void processImportJobs();
    });
    return importStatus(previewId);
  }
  let importing: Promise<void> | null = null;
  function processImportJobs() {
    if (!importing)
      importing = (async () => {
        for (;;) {
          if (closed) break;
          const job = db
            .prepare(
              "SELECT * FROM to_doo_import_jobs WHERE state IN ('queued','running') ORDER BY rowid LIMIT 1",
            )
            .get() as ImportJob | undefined;
          if (!job) break;
          const row = db
            .prepare('SELECT content FROM to_doo_import_previews WHERE id=?')
            .get(job.preview_id) as { content: string } | undefined;
          if (!row) {
            db.prepare(
              "UPDATE to_doo_import_jobs SET state='failed',error='Preview materials are missing' WHERE preview_id=?",
            ).run(job.preview_id);
            continue;
          }
          const preview = JSON.parse(row.content) as StoredPreview;
          const batch = preview.items.slice(job.offset, job.offset + preview.batchSize),
            end = job.offset + batch.length,
            last = end >= preview.items.length;
          db.prepare("UPDATE to_doo_import_jobs SET state='running' WHERE preview_id=?").run(
            job.preview_id,
          );
          try {
            checkImportGuard(preview.id);
            const requestId =
              'import_batch_' +
              hash([job.request_id, preview.fingerprint, job.offset]).slice(0, 40);
            let result;
            if (preview.package?.checkpoint) {
              const { digest, ...original } = preview.package.checkpoint;
              const payload = {
                ...original,
                entities: batch.map((item) => ({ kind: item.kind, entity: item.entity })),
                transactions: last ? original.transactions : [],
                receipts: last ? original.receipts : [],
                assets: last ? original.assets : [],
              };
              result = service.importCheckpoint(
                { ...payload, digest: hash(checkpointCanonical(payload)) } as ToDooCheckpoint,
                requestId,
                {
                  expectedRevisions: Object.fromEntries(
                    batch
                      .filter((item) => item.expectedRevision)
                      .map((item) => [item.kind + ':' + item.entity.id, item.expectedRevision!]),
                  ),
                },
              );
            } else
              result = service.command({
                requestId,
                action: 'import_entities',
                payload: { entities: batch },
              });
            const brief = JSON.stringify({
              transactionId: result.transactionId,
              replayed: result.replayed,
              ids: result.ids,
              changed: result.changed,
            });
            db.prepare(
              'UPDATE to_doo_import_jobs SET state=?,offset=?,result=?,error=NULL WHERE preview_id=?',
            ).run(last ? 'completed' : 'queued', end, brief, job.preview_id);
            if (last)
              db.prepare('UPDATE to_doo_import_previews SET applied_result=? WHERE id=?').run(
                brief,
                job.preview_id,
              );
          } catch {
            db.prepare(
              "UPDATE to_doo_import_jobs SET state='failed',error='Import stopped at a conflicting batch; committed batches are retained' WHERE preview_id=?",
            ).run(job.preview_id);
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })().finally(() => {
        importing = null;
      });
    return importing;
  }
  function exportIcs(
    input: {
      listIds?: string[];
      from?: string;
      to?: string;
      mode?: 'events' | 'todos';
      includeDescription?: boolean;
      includeCompleted?: boolean;
    } = {},
  ) {
    const snapshot = all(),
      today = localDate(now(), snapshot.settings.timeZone),
      bounded = {
        ...input,
        from: input.from ?? addDays(today, -30),
        to: input.to ?? addDays(today, 90),
      };
    return exportCalendar(snapshotCalendarItems(snapshot, bounded), {
      datasetId: snapshot.datasetId,
      mode: input.mode,
      includeDescription: input.includeDescription,
    });
  }
  function createFeed(
    input: { name: string; listIds?: string[]; includeDescription?: boolean },
    intent?: { id: string; requestId: string; token: string },
  ) {
    const id = intent?.id ?? randomUUID();
    service.command({
      requestId: intent?.requestId ?? randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'calendarFeed',
        entity: {
          id,
          name: input.name,
          listIds: input.listIds ?? [],
          includeDescription: !!input.includeDescription,
          enabled: true,
        },
      },
    });
    const token = intent?.token ?? randomBytes(32).toString('base64url');
    db.prepare('INSERT OR IGNORE INTO to_doo_feed_tokens VALUES(?,?,?)').run(
      hash(token),
      id,
      now().toISOString(),
    );
    return { id, token, url: '/to-doo/feed/' + token + '.ics' };
  }
  function revokeFeed(id: string) {
    db.prepare('DELETE FROM to_doo_feed_tokens WHERE feed_id=?').run(id);
    const feed = all().calendarFeeds.find((f) => f.id === id);
    if (feed)
      service.command({
        requestId: randomUUID(),
        action: 'save_entity',
        payload: {
          kind: 'calendarFeed',
          entity: { ...feed, enabled: false },
          expectedRevision: feed.revision,
        },
      });
    return { revoked: true };
  }
  function readFeed(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ToDooInteropError('Feed not found', 404);
    const row = db
      .prepare('SELECT feed_id FROM to_doo_feed_tokens WHERE hash=?')
      .get(hash(token)) as { feed_id: string } | undefined;
    const feed =
      row && all().calendarFeeds.find((f) => f.id === row.feed_id && !f.deletedAt && f.enabled);
    if (!feed) throw new ToDooInteropError('Feed not found', 404);
    return exportIcs({
      listIds: feed.listIds,
      includeDescription: feed.includeDescription,
      includeCompleted: feed.includeCompleted,
    });
  }
  async function connectCalendar(
    input: {
      sourceId?: string;
      name: string;
      url: string;
      headers?: Record<string, string>;
    },
    guard?: () => void,
  ) {
    guard?.();
    const sourceId = input.sourceId ?? randomUUID();
    const response = await network.request({ url: input.url, headers: input.headers });
    if (response.status !== 200)
      throw new ToDooInteropError('Calendar source did not return a complete response', 502);
    const parsed = parseCalendar(response.body.toString('utf8'), {
      timeZone: all().settings.timeZone,
    });
    guard?.();
    applyCalendar(sourceId, input.name, parsed.items);
    db.prepare(
      'INSERT OR REPLACE INTO to_doo_calendar_connections(source_id,url,headers,etag,last_fetched_at,status) VALUES(?,?,?,?,?,?)',
    ).run(
      sourceId,
      input.url,
      JSON.stringify(input.headers ?? {}),
      response.headers.etag ?? null,
      now().toISOString(),
      'ready',
    );
    return { sourceId, count: parsed.items.length, warnings: parsed.warnings };
  }
  function applyCalendar(sourceId: string, name: string, items: CalendarItem[]) {
    const snapshot = all();
    const oldSource = snapshot.calendarSources.find((s) => s.id === sourceId);
    const entries: ImportEntry[] = [
      {
        kind: 'calendarSource',
        entity: {
          ...(oldSource ?? {}),
          id: sourceId,
          name,
          type: 'ics',
          enabled: true,
          metadata: {},
        },
        ...(oldSource ? { expectedRevision: oldSource.revision } : {}),
      },
    ];
    const ids = new Set<string>();
    for (const entity of projectCalendar(
      items,
      sourceId,
      true,
      now(),
      snapshot.settings.timeZone,
    )) {
      const id = String(entity.id);
      ids.add(id);
      const old = snapshot.calendarEvents.find((e) => e.id === id);
      entries.push({
        kind: 'calendarEvent',
        entity: { ...(old ?? {}), ...entity, deletedAt: null },
        ...(old ? { expectedRevision: old.revision } : {}),
      });
    }
    for (const old of snapshot.calendarEvents.filter(
      (e) => e.sourceId === sourceId && !e.deletedAt && !ids.has(e.id),
    ))
      entries.push({
        kind: 'calendarEvent',
        entity: { ...old, deletedAt: now().toISOString() },
        expectedRevision: old.revision,
      });
    if (entries.length > 10000)
      throw new ToDooInteropError('Calendar source exceeds atomic refresh budget');
    service.command({
      requestId: randomUUID(),
      action: 'import_entities',
      payload: { entities: entries },
    });
  }
  async function refreshCalendar(sourceId: string, guard?: () => void) {
    guard?.();
    const row = db
      .prepare('SELECT * FROM to_doo_calendar_connections WHERE source_id=?')
      .get(sourceId) as
      | { url: string; headers: string; etag: string | null; status: string }
      | undefined;
    if (!row) throw new ToDooInteropError('Calendar connection needs configuration', 409);
    try {
      const headers = JSON.parse(row.headers);
      if (row.etag) headers['if-none-match'] = row.etag;
      const response = await network.request({ url: row.url, headers });
      guard?.();
      if (response.status === 304) {
        db.prepare(
          'UPDATE to_doo_calendar_connections SET last_fetched_at=?,status=?,error=NULL WHERE source_id=?',
        ).run(now().toISOString(), 'ready', sourceId);
        return { sourceId, unchanged: true };
      }
      if (response.status !== 200)
        throw new ToDooInteropError('Calendar source did not return a complete response', 502);
      const parsed = parseCalendar(response.body.toString('utf8'), {
        timeZone: all().settings.timeZone,
      });
      applyCalendar(
        sourceId,
        all().calendarSources.find((s) => s.id === sourceId)?.name ?? 'Calendar',
        parsed.items,
      );
      db.prepare(
        'UPDATE to_doo_calendar_connections SET etag=?,last_fetched_at=?,status=?,error=NULL WHERE source_id=?',
      ).run(response.headers.etag ?? null, now().toISOString(), 'ready', sourceId);
      return { sourceId, count: parsed.items.length, warnings: parsed.warnings };
    } catch {
      db.prepare('UPDATE to_doo_calendar_connections SET status=?,error=? WHERE source_id=?').run(
        'error',
        'Refresh failed; previous events retained',
        sourceId,
      );
      throw new ToDooInteropError('Calendar refresh failed; previous events retained', 502);
    }
  }
  function disconnectCalendar(sourceId: string) {
    db.prepare('DELETE FROM to_doo_calendar_connections WHERE source_id=?').run(sourceId);
    return { disconnected: true, snapshotsRetained: true };
  }
  function pauseCalendar(sourceId: string, paused: boolean) {
    const result = db
      .prepare('UPDATE to_doo_calendar_connections SET status=? WHERE source_id=?')
      .run(paused ? 'paused' : 'ready', sourceId);
    if (!result.changes)
      throw new ToDooInteropError('Calendar connection needs configuration', 404);
    return { sourceId, paused };
  }
  function connections() {
    return db
      .prepare(
        'SELECT source_id AS sourceId,status,last_fetched_at AS lastFetchedAt,error FROM to_doo_calendar_connections',
      )
      .all();
  }
  let timer: ReturnType<typeof setInterval> | null = null,
    refreshing: Promise<void> | null = null,
    closed = false;
  function refreshConnectedCalendars() {
    if (!refreshing)
      refreshing = (async () => {
        for (const row of db
          .prepare("SELECT source_id FROM to_doo_calendar_connections WHERE status<>'paused'")
          .all() as { source_id: string }[]) {
          if (closed) break;
          try {
            await refreshCalendar(row.source_id);
          } catch {
            /* The persisted connection status exposes failures while old events remain intact. */
          }
        }
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  function start() {
    if (timer || closed) return;
    timer = setInterval(() => {
      void refreshConnectedCalendars();
    }, 15 * 60000);
    timer.unref();
    void processImportJobs();
  }
  function close() {
    importGuards.clear();
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    return Promise.all([refreshing?.catch(() => {}), importing?.catch(() => {})]).then(() => {});
  }
  return {
    previewImport,
    protectImport,
    applyImport,
    importStatus,
    cancelImport,
    resumeImport,
    processImportJobs,
    exportJson: () => JSON.stringify(service.exportCheckpoint(), null, 2),
    exportIcs,
    createFeed,
    revokeFeed,
    readFeed,
    connectCalendar,
    refreshCalendar,
    disconnectCalendar,
    pauseCalendar,
    refreshConnectedCalendars,
    start,
    close,
    connections,
    feeds: () => all().calendarFeeds,
  };
}
function importDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): { field: string; before: unknown; after: unknown }[] {
  const metadata = new Set(['id', 'revision', 'createdAt', 'updatedAt']);
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
    .filter(
      (field) =>
        !metadata.has(field) &&
        canonical(before?.[field] ?? null) !== canonical(after[field] ?? null),
    )
    .map((field) => ({ field, before: before?.[field] ?? null, after: after[field] ?? null }));
}
function copyPortableEntities(entries: PortableEntity[], jobId: string): PortableEntity[] {
  const source = entries.filter((entry) => entry.kind !== 'settings' && entry.kind !== 'operation');
  const identities = new Map(
    source.map((entry) => [
      entry.kind + ':' + entry.entity.id,
      'copy_' + hash([jobId, entry.kind, entry.entity.id]).slice(0, 40),
    ]),
  );
  const candidates = new Map<string, Set<string>>();
  for (const entry of source) {
    const id = String(entry.entity.id),
      set = candidates.get(id) ?? new Set<string>();
    set.add(identities.get(entry.kind + ':' + id)!);
    candidates.set(id, set);
  }
  const series = new Map<string, string>();
  for (const entry of source.filter((entry) => entry.kind === 'task'))
    for (const rule of [
      entry.entity.recurrence,
      ...(Array.isArray(entry.entity.recurrenceHistory) ? entry.entity.recurrenceHistory : []),
    ])
      if (
        rule &&
        typeof rule === 'object' &&
        typeof (rule as Record<string, unknown>).id === 'string'
      ) {
        const id = String((rule as Record<string, unknown>).id);
        series.set(id, 'series_' + hash([jobId, id]).slice(0, 32));
      }
  const occurrences = new Map(
    source
      .filter((entry) => entry.kind === 'occurrence')
      .map((entry) => [String(entry.entity.id), entry.entity]),
  );
  const resolved = new Set<string>();
  function resolveOccurrence(id: string, path = new Set<string>()): string {
    const key = 'occurrence:' + id;
    if (resolved.has(id)) return identities.get(key)!;
    const occurrence = occurrences.get(id);
    if (!occurrence) return identities.get(key) ?? id;
    if (path.has(id)) throw new ToDooInteropError('Copied occurrence predecessors contain a cycle');
    path.add(id);
    const taskId = identities.get('task:' + occurrence.taskId);
    if (!taskId) throw new ToDooInteropError('Copy requires the occurrence task definition');
    let cycle = String(occurrence.cycleKey);
    for (const [old, next] of series)
      if (cycle.startsWith(old + ':')) cycle = next + cycle.slice(old.length);
    const predecessor =
      typeof occurrence.predecessorId === 'string' ? occurrence.predecessorId : null;
    if (predecessor)
      cycle = cycle.replace(
        ':after:' + predecessor,
        ':after:' + resolveOccurrence(predecessor, path),
      );
    const nextId = stableToDooId(taskId, cycle);
    identities.set(key, nextId);
    resolved.add(id);
    path.delete(id);
    return nextId;
  }
  for (const id of occurrences.keys()) resolveOccurrence(id);
  candidates.clear();
  for (const entry of source) {
    const id = String(entry.entity.id),
      set = candidates.get(id) ?? new Set<string>();
    set.add(identities.get(entry.kind + ':' + id)!);
    candidates.set(id, set);
  }
  const ref = (kind: ToDooEntityKind, value: unknown) =>
    typeof value === 'string' ? (identities.get(kind + ':' + value) ?? value) : value;
  const anyRef = (value: unknown) =>
    typeof value === 'string' && candidates.get(value)?.size === 1
      ? [...candidates.get(value)!][0]
      : value;
  const kindByField: Record<string, ToDooEntityKind> = {
    listId: 'list',
    sectionId: 'section',
    taskId: 'task',
    parentTaskId: 'task',
    occurrenceId: 'occurrence',
    parentOccurrenceId: 'occurrence',
    predecessorId: 'occurrence',
    habitId: 'habit',
    sourceSessionId: 'focusSession',
    expandedFromId: 'calendarEvent',
  };
  function rewrite(value: unknown, key: string, owner: ToDooEntityKind): unknown {
    if (Array.isArray(value)) {
      const arrayKind: Record<string, ToDooEntityKind> = {
        listIds: 'list',
        tagIds: 'tag',
        followupTaskIds: 'task',
      };
      return value.map((item) =>
        arrayKind[key]
          ? ref(arrayKind[key], item)
          : key === 'importedIds'
            ? anyRef(item)
            : rewrite(item, key, owner),
      );
    }
    if (!value || typeof value !== 'object') {
      if (kindByField[key]) return ref(kindByField[key], value);
      if (key === 'sourceId')
        return ref(owner === 'reminderEvent' ? 'task' : 'calendarSource', value);
      if (key === 'entityId') return anyRef(value);
      if ((key === 'seriesSegmentId' || key === 'previousSegmentId') && typeof value === 'string')
        return series.get(value) ?? value;
      if (key === 'cycleKey' && typeof value === 'string') {
        let changed = value;
        for (const [old, id] of series)
          if (changed.startsWith(old + ':')) changed = id + changed.slice(old.length);
        for (const [old, set] of candidates)
          if (set.size === 1) changed = changed.replace(':after:' + old, ':after:' + [...set][0]);
        return changed;
      }
      if (key === 'requestId' && typeof value === 'string')
        return 'copy_' + hash([jobId, value]).slice(0, 40);
      return value;
    }
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(object)) result[field] = rewrite(item, field, owner);
    if (
      Object.hasOwn(object, 'frequency') &&
      Object.hasOwn(object, 'anchorDate') &&
      typeof object.id === 'string'
    )
      result.id = series.get(object.id) ?? object.id;
    if (
      owner === 'reminderEvent' &&
      typeof object.sourceType === 'string' &&
      ['task', 'habit', 'anniversary'].includes(object.sourceType)
    )
      result.sourceId = ref(object.sourceType as ToDooEntityKind, object.sourceId);
    return result;
  }
  return source.map((entry) => {
    const entity = rewrite(entry.entity, '', entry.kind) as Record<string, unknown>;
    entity.id = identities.get(entry.kind + ':' + entry.entity.id)!;
    if (entry.kind === 'focusSession' && entity.status === 'running') entity.status = 'interrupted';
    return { kind: entry.kind, entity, sha256: hash(entity) };
  });
}
function orderImportEntries(entries: ImportEntry[]): ImportEntry[] {
  const ranks: Partial<Record<ToDooEntityKind, number>> = {
    settings: 0,
    list: 1,
    section: 2,
    tag: 3,
    calendarSource: 4,
    calendarFeed: 5,
    task: 6,
    occurrence: 7,
    exception: 8,
    timeBlock: 9,
    import: 100,
  };
  const sorted = [...entries].sort((a, b) => (ranks[a.kind] ?? 20) - (ranks[b.kind] ?? 20)),
    result: ImportEntry[] = [],
    visited = new Set<string>(),
    visiting = new Set<string>();
  const mapped = new Map(sorted.map((entry) => [entry.kind + ':' + entry.entity.id, entry]));
  if (mapped.size !== sorted.length)
    throw new ToDooInteropError(
      'Duplicate import identity; resolve matching source rows explicitly',
    );
  function visit(entry: ImportEntry) {
    const key = entry.kind + ':' + entry.entity.id;
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new ToDooInteropError('Import contains a relationship cycle');
    visiting.add(key);
    const parent =
      entry.kind === 'task'
        ? entry.entity.parentTaskId
        : entry.kind === 'occurrence'
          ? entry.entity.parentOccurrenceId
          : null;
    if (parent) {
      const item = mapped.get(entry.kind + ':' + parent);
      if (item) visit(item);
    }
    visiting.delete(key);
    visited.add(key);
    result.push(entry);
  }
  for (const entry of sorted) visit(entry);
  return result;
}
function validateImportEntries(entries: ImportEntry[], snapshot: ToDooSnapshot, at: string) {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const entry of entries) {
    const parsed = toDooEntitySchemas[entry.kind].safeParse({
      revision: 'preview',
      createdAt: at,
      updatedAt: at,
      ...entry.entity,
    });
    if (!parsed.success)
      throw new ToDooInteropError(
        'Import entity needs explicit field mapping: ' +
          parsed.error.issues
            .slice(0, 2)
            .map((issue) => issue.path.join('.'))
            .join(', '),
      );
    if (entry.kind === 'task')
      tasks.set(parsed.data.id, parsed.data as (typeof snapshot.tasks)[number]);
  }
  for (const task of tasks.values()) {
    if (task.deletedAt) continue;
    const seen = new Set([task.id]);
    let parent = task.parentTaskId;
    while (parent) {
      if (seen.has(parent)) throw new ToDooInteropError('Import contains a task tree cycle');
      seen.add(parent);
      const entity = tasks.get(parent);
      if (!entity || entity.deletedAt) break;
      if (entity.listId !== task.listId)
        throw new ToDooInteropError('Import child and parent lists do not match');
      if (seen.size > snapshot.settings.maxDepth)
        throw new ToDooInteropError('Import exceeds the selected task depth; adjust it explicitly');
      parent = entity.parentTaskId;
    }
  }
}
function calendarEntity(
  item: CalendarItem,
  sourceId: string,
  id: string,
  readOnly: boolean,
): Record<string, unknown> {
  return {
    id,
    sourceId,
    uid: item.uid,
    recurrenceId: item.recurrenceId,
    title: item.title,
    description: item.description,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    rawRecurrence: item.rrule,
    readOnly,
    component: item.component,
    recurrenceTimeZone: item.recurrenceTimeZone,
    excludedDates: item.excludedDates,
    additionalDates: item.additionalDates,
    sourceStatus: item.status,
    rawSource: Buffer.byteLength(item.raw) <= 65536 ? item.raw : null,
  };
}
function projectCalendar(
  items: CalendarItem[],
  sourceId: string,
  readOnly: boolean,
  at: Date,
  timeZone: string,
): Record<string, unknown>[] {
  const today = localDate(at, timeZone),
    masters = items.filter(
      (item) => !item.recurrenceId && (item.rrule || item.additionalDates.length),
    );
  const projected = expandCalendar(items, {
    from: addDays(today, -30),
    to: addDays(today, 90),
    limit: 9000,
  });
  const complete = [
    ...items.filter((item) => !item.rrule && !item.additionalDates.length && !item.recurrenceId),
    ...projected.filter((item) => !!item.recurrenceId),
  ];
  return [
    ...masters.map((item) => ({
      ...calendarEntity(item, sourceId, calendarItemId(sourceId, item.uid, null), readOnly),
      seriesMaster: true,
    })),
    ...complete.map((item) => ({
      ...calendarEntity(
        item,
        sourceId,
        calendarItemId(sourceId, item.uid, item.recurrenceId),
        readOnly,
      ),
      seriesMaster: false,
      expandedFromId: masters.some((master) => master.uid === item.uid)
        ? calendarItemId(sourceId, item.uid, null)
        : null,
    })),
  ];
}
function mapCalendarRule(item: CalendarItem, id: string): ToDooRecurrence | null {
  if (!item.rrule && !item.additionalDates.length) return null;
  const parts: Record<string, string> = Object.fromEntries(
    (item.rrule ?? 'FREQ=DAILY;COUNT=1').split(';').map((part) => part.split('=')),
  );
  if (
    Object.keys(parts).some(
      (key) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST'].includes(key),
    )
  )
    return null;
  const frequencies: Record<string, string> = {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
  };
  let frequency = frequencies[parts.FREQ];
  if (!frequency) return null;
  const weekdays: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const dayParts = (parts.BYDAY ?? '').split(',').filter(Boolean);
  const interval = Number(parts.INTERVAL ?? 1);
  if (
    dayParts.some((day) => !/^(-?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.test(day)) ||
    (frequency === 'weekly' && interval > 1 && dayParts.length > 1)
  )
    return null;
  if (frequency === 'daily' && dayParts.length) {
    if (interval !== 1) return null;
    frequency = 'weekly';
  }
  if (
    (frequency === 'yearly' && dayParts.length) ||
    (frequency === 'monthly' && dayParts.length && !dayParts[0].match(/^-?[1-5]/)) ||
    (parts.BYMONTHDAY && frequency !== 'monthly') ||
    (parts.BYMONTHDAY && dayParts.length)
  )
    return null;
  if (dayParts.some((day) => day.length > 2) && !(frequency === 'monthly' && dayParts.length === 1))
    return null;
  const ordinal = dayParts[0]?.length > 2 ? Number(dayParts[0].slice(0, -2)) : undefined;
  if (ordinal !== undefined && ordinal < 0 && ordinal !== -1) return null;
  let until: string | null = null;
  if (parts.UNTIL) {
    if (!/^\d{8}(T\d{6}Z?)?$/.test(parts.UNTIL)) return null;
    const raw = parts.UNTIL;
    until = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    if (raw.endsWith('Z') && raw.length > 8) {
      const instant = new Date(
        until + 'T' + raw.slice(9, 11) + ':' + raw.slice(11, 13) + ':' + raw.slice(13, 15) + 'Z',
      );
      until = localDate(instant, item.start.timeZone);
      if (dateTimeInstant({ ...item.start, date: until }).getTime() > instant.getTime())
        until = addDays(until, -1);
    }
  }
  const monthDay = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : undefined;
  if (
    monthDay !== undefined &&
    monthDay !== -1 &&
    (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)
  )
    return null;
  const result = toDooRecurrenceSchema.safeParse({
    id,
    frequency,
    interval,
    anchorDate: item.start.date,
    time: item.start.time,
    timeZone: item.start.timeZone,
    weekdays: dayParts.map((day) => weekdays[day.slice(-2)]),
    ...(ordinal !== undefined ? { weekOrdinal: ordinal } : {}),
    ...(monthDay !== undefined ? { monthDay: monthDay === -1 ? 31 : monthDay } : {}),
    until,
    count: parts.COUNT ? Number(parts.COUNT) : null,
    shortMonth: monthDay === -1 ? 'last_day' : 'skip',
    excludedDates: item.excludedDates.map((date) => date.slice(0, 10)),
    additionalDates: item.additionalDates.map((date) => date.slice(0, 10)),
  });
  return result.success ? result.data : null;
}
export function snapshotCalendarItems(
  snapshot: ToDooSnapshot,
  input: {
    listIds?: string[];
    from?: string;
    to?: string;
    mode?: 'events' | 'todos';
    includeCompleted?: boolean;
  },
): CalendarItem[] {
  const items: CalendarItem[] = [];
  const tasks = new Map(
    snapshot.tasks
      .filter(
        (t) =>
          !t.deletedAt && (!input.listIds?.length || input.listIds.includes(t.listId ?? 'inbox')),
      )
      .map((t) => [t.id, t]),
  );
  const occurrences = new Map(
    snapshot.occurrences
      .filter(
        (o) =>
          tasks.has(o.taskId) &&
          !o.deletedAt &&
          (input.includeCompleted !== false ||
            !['done', 'cancelled', 'skipped'].includes(o.status)),
      )
      .map((o) => [o.id, o]),
  );
  const within = (date: string) =>
    (!input.from || date >= input.from) && (!input.to || date <= input.to);
  const base = (id: string, title: string, start: ToDooDateTime): CalendarItem => ({
    component: input.mode === 'todos' ? 'VTODO' : 'VEVENT',
    uid: snapshot.datasetId + '-' + id + '@to-doo',
    recurrenceId: null,
    recurrenceTimeZone: null,
    title,
    description: '',
    start,
    end: null,
    allDay: start.time === null,
    status: null,
    rrule: null,
    excludedDates: [],
    additionalDates: [],
    raw: '',
  });
  for (const block of snapshot.timeBlocks) {
    const occurrence = block.occurrenceId ? occurrences.get(block.occurrenceId) : undefined;
    if (
      block.deletedAt ||
      !within(block.start.date) ||
      (block.occurrenceId && !occurrence) ||
      (!block.occurrenceId && input.listIds?.length)
    )
      continue;
    const task = occurrence ? tasks.get(occurrence.taskId) : undefined;
    const item = base(block.id, block.title || task?.title || 'Time block', block.start);
    item.description = task?.description ?? '';
    const parsed = ICALDateAdd(block.start, block.durationMinutes);
    item.end = block.allDay
      ? {
          ...block.start,
          date: block.dateEndExclusive ?? ICALDateAdd({ ...block.start, time: '00:00' }, 1440).date,
        }
      : parsed;
    items.push(item);
  }
  for (const occurrence of occurrences.values())
    if (occurrence.due && within(occurrence.due.date)) {
      const task = tasks.get(occurrence.taskId)!;
      const item = base(
        occurrence.id + '-due',
        task.title + (input.mode === 'todos' ? '' : ' · 截止'),
        occurrence.due,
      );
      item.description = task.description;
      item.status = occurrence.status === 'done' ? 'COMPLETED' : null;
      items.push(item);
    }
  if (!input.listIds?.length)
    for (const event of snapshot.calendarEvents) {
      if (event.deletedAt || event.seriesMaster || !within(event.start.date)) continue;
      const e = event as typeof event & Partial<CalendarItem> & { sourceStatus?: string | null };
      items.push({
        ...base(event.id, event.title, event.start),
        uid: event.expandedFromId ? snapshot.datasetId + '-' + event.id + '@to-doo' : event.uid,
        description: event.description,
        end: event.end,
        allDay: event.allDay,
        recurrenceId: event.expandedFromId ? null : event.recurrenceId,
        recurrenceTimeZone: e.recurrenceTimeZone ?? null,
        component: e.component ?? 'VEVENT',
        rrule: event.rawRecurrence,
        excludedDates: e.excludedDates ?? [],
        additionalDates: e.additionalDates ?? [],
        status: e.sourceStatus ?? null,
      });
    }
  return items;
}
function ICALDateAdd(value: ToDooDateTime, minutes: number): ToDooDateTime {
  const date = new Date(value.date + 'T' + (value.time ?? '00:00') + ':00Z');
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return {
    date: date.toISOString().slice(0, 10),
    time: value.time === null ? null : date.toISOString().slice(11, 16),
    timeZone: value.timeZone,
  };
}
export type ToDooInterop = ReturnType<typeof createToDooInterop>;
