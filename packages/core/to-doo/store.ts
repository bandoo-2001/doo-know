import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../db.js';
import { HttpError } from '../errors.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../knowledge-data.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import {
  toDooEntitySchemas,
  TO_DOO_COLLECTIONS,
  type ToDooEntity,
  type ToDooEntityKind,
  type ToDooEntityMap,
  type ToDooPortableReceipt,
  type ToDooCheckpoint,
} from '../../../shared/to-doo-contracts.js';
const rootPath = 'apps/to-doo';
export const canonical = (v: unknown): string => JSON.stringify(sort(v));
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sort(x)]),
    );
  return v;
}
export const toDooHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
export function toDooError(message: string, status = 409, code = 'TO_DOO_CONFLICT'): never {
  throw new HttpError(status, message, { code });
}
export function parseEntity<K extends ToDooEntityKind>(kind: K, value: unknown): ToDooEntityMap[K] {
  if (!Object.hasOwn(toDooEntitySchemas, kind))
    toDooError('不支持的实体类型', 400, 'TO_DOO_INVALID');
  const parsed = toDooEntitySchemas[kind].safeParse(value);
  if (!parsed.success)
    toDooError(
      '应用数据格式不正确：' +
        parsed.error.issues
          .slice(0, 3)
          .map((x) => x.path.join('.') + ' ' + x.message)
          .join('; '),
      400,
      'TO_DOO_INVALID',
    );
  return parsed.data as ToDooEntityMap[K];
}
export const entityPath = (kind: ToDooEntityKind, id: string) =>
  rootPath +
  '/' +
  (kind === 'settings'
    ? 'settings.json'
    : (TO_DOO_COLLECTIONS[kind as keyof typeof TO_DOO_COLLECTIONS] as string).replace(
        /[A-Z]/g,
        (c) => '-' + c.toLowerCase(),
      ) +
      '/' +
      id +
      '.json');
type Envelope = { format: 1; revision: string; data: ToDooEntity; lastTransactionId: string };
type Member = {
  kind: ToDooEntityKind;
  id: string;
  fromRevision: string | null;
  after: Envelope;
  afterHash: string;
};
export type PortableTransaction = {
  format: 1;
  id: string;
  parentId: string | null;
  requestId: string;
  fingerprint: string;
  at: string;
  members: Member[];
  ids: string[];
  importedReceipts?: ToDooPortableReceipt[];
  importedTransactions?: unknown[];
  adoptDatasetId?: string;
  previousDatasetId?: string;
};
type Row = {
  kind: ToDooEntityKind;
  id: string;
  revision: string;
  data: string;
  envelope: string;
  digest: string;
};
export type ToDooState = { [K in ToDooEntityKind]: Map<string, ToDooEntityMap[K]> };
class OverlayMap<K, V> extends Map<K, V> {
  private writes = new Map<K, V>();
  private removed = new Set<K>();
  private erased = false;
  constructor(private readonly baseMap: Map<K, V>) {
    super();
  }
  override get(key: K): V | undefined {
    return this.writes.has(key)
      ? this.writes.get(key)
      : this.erased || this.removed.has(key)
        ? undefined
        : this.baseMap.get(key);
  }
  override has(key: K): boolean {
    return (
      this.writes.has(key) || (!this.erased && !this.removed.has(key) && this.baseMap.has(key))
    );
  }
  override set(key: K, value: V): this {
    this.removed.delete(key);
    this.writes.set(key, value);
    return this;
  }
  override delete(key: K): boolean {
    const exists = this.has(key);
    this.writes.delete(key);
    this.removed.add(key);
    return exists;
  }
  override clear(): void {
    this.erased = true;
    this.writes.clear();
    this.removed.clear();
  }
  override get size(): number {
    let n = 0;
    for (const _ of this.entries()) n++;
    return n;
  }
  override *entries(): MapIterator<[K, V]> {
    if (!this.erased)
      for (const [key, value] of this.baseMap)
        if (!this.removed.has(key))
          yield [key, this.writes.has(key) ? this.writes.get(key)! : value];
    for (const [key, value] of this.writes)
      if (this.erased || !this.baseMap.has(key) || this.removed.has(key)) yield [key, value];
  }
  override *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }
  override *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }
  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}
export function emptyToDooState(): ToDooState {
  return Object.fromEntries(
    Object.keys(toDooEntitySchemas).map((k) => [k, new Map()]),
  ) as ToDooState;
}
export type PendingEntity = {
  kind: ToDooEntityKind;
  entity: ToDooEntity;
  expectedRevision: string | null;
};
export function createToDooStore(config: { knowledgeRoot: string }, db: AppDatabase) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS todo_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS todo_instance_state(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT NOT NULL);CREATE TABLE IF NOT EXISTS todo_entities(kind TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,data TEXT NOT NULL,envelope TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE IF NOT EXISTS todo_transactions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,sequence INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS todo_pending_files(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE IF NOT EXISTS todo_imported_receipts(request_id TEXT PRIMARY KEY,data TEXT NOT NULL);`,
  );
  for (const field of [
    'taskId',
    'occurrenceId',
    'listId',
    'parentTaskId',
    'status',
    'scheduledDate',
  ])
    db.exec(
      'CREATE INDEX IF NOT EXISTS todo_entity_' +
        field +
        "_lookup ON todo_entities(kind,json_extract(data,'$." +
        field +
        "'))",
    );
  const instance = db.prepare('SELECT root FROM todo_instance_state WHERE id=1').get() as
    | { root: string }
    | undefined;
  const newInstance = !instance || instance.root !== config.knowledgeRoot;
  db.prepare(
    'INSERT INTO todo_instance_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root',
  ).run(config.knowledgeRoot);
  let closed = false,
    lastScan = 0,
    diskDirty = true;
  const fileCache = new Map<string, { stamp: string; digest: string }>();
  function stamp(path: string): string | undefined {
    try {
      const s = lstatSync(join(config.knowledgeRoot, '_data', path), { bigint: true });
      if (s.isSymbolicLink() || !s.isFile()) toDooError('应用数据文件不安全');
      return String(s.mtimeNs) + ':' + String(s.size);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  function cached(path: string): string | undefined {
    const c = fileCache.get(path);
    return c && stamp(path) === c.stamp ? c.digest : undefined;
  }
  function remember(path: string, digest: string) {
    const s = stamp(path);
    if (s) fileCache.set(path, { stamp: s, digest });
  }
  const manifestPath = rootPath + '/manifest.json';
  let manifestBytes = readKnowledgeDataFile(config.knowledgeRoot, manifestPath);
  if (!manifestBytes) {
    manifestBytes = Buffer.from(
      encode({ format: 1, appId: 'to-doo', datasetId: randomUUID(), schemaVersion: 1 }),
    );
    writeKnowledgeDataFile(config.knowledgeRoot, manifestPath, manifestBytes, null);
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    toDooError('To Doo 清单损坏');
  }
  if (
    manifest.format !== 1 ||
    manifest.appId !== 'to-doo' ||
    typeof manifest.datasetId !== 'string'
  )
    toDooError('To Doo 数据版本不支持');
  let datasetId = manifest.datasetId as string;
  function files(relative: string): string[] {
    const full = join(config.knowledgeRoot, '_data', relative);
    let stat;
    try {
      stat = lstatSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) toDooError('应用数据目录不安全');
    return readdirSync(full, { withFileTypes: true })
      .filter((e) => !/^\.dooknow-[0-9a-f-]+\.tmp$/.test(e.name))
      .map((e) => {
        if (e.isSymbolicLink() || !e.isFile() || !/^[-A-Za-z0-9_]+\.json$/.test(e.name))
          toDooError('应用数据包含不支持的文件');
        return e.name;
      });
  }
  function readEnvelope(kind: ToDooEntityKind, id: string, bytes: Buffer): Envelope {
    let v: any;
    try {
      v = JSON.parse(bytes.toString('utf8'));
    } catch {
      toDooError('应用数据文件损坏');
    }
    if (v.format !== 1 || typeof v.lastTransactionId !== 'string')
      toDooError('应用实体缺少便携事务身份');
    v.data = parseEntity(kind, v.data);
    if (v.data.id !== id || v.data.revision !== v.revision) toDooError('应用实体身份或版本不一致');
    return v;
  }
  function parseTransaction(bytes: Buffer): PortableTransaction {
    let tx: any;
    try {
      tx = JSON.parse(bytes.toString('utf8'));
    } catch {
      toDooError('应用事务记录损坏');
    }
    if (
      tx.format !== 1 ||
      typeof tx.id !== 'string' ||
      typeof tx.requestId !== 'string' ||
      typeof tx.fingerprint !== 'string' ||
      !Array.isArray(tx.members) ||
      !Array.isArray(tx.ids)
    )
      toDooError('应用事务格式无效');
    const seen = new Set<string>();
    for (const m of tx.members) {
      if (
        !Object.hasOwn(toDooEntitySchemas, m.kind) ||
        m.after?.data?.id !== m.id ||
        m.after.lastTransactionId !== tx.id
      )
        toDooError('事务成员身份无效');
      if (m.after.revision !== m.after.data.revision || toDooHash(encode(m.after)) !== m.afterHash)
        toDooError('事务成员校验失败');
      parseEntity(m.kind, m.after.data);
      const key = m.kind + '\0' + m.id;
      if (seen.has(key)) toDooError('事务存在重复成员');
      seen.add(key);
    }
    return tx;
  }
  const getRow = (kind: ToDooEntityKind, id: string) =>
    db.prepare('SELECT * FROM todo_entities WHERE kind=? AND id=?').get(kind, id) as
      | Row
      | undefined;
  function refresh(force = false) {
    if (closed) toDooError('To Doo 已关闭', 503);
    if (!force && !diskDirty && Date.now() - lastScan < 60000) return;
    diskDirty = false;
    lastScan = Date.now();
    const fresh = !db.prepare('SELECT 1 FROM todo_transactions LIMIT 1').get();
    const pending: PortableTransaction[] = [];
    const names = files(rootPath + '/transactions');
    const present = new Set<string>();
    for (const name of names) {
      const path = rootPath + '/transactions/' + name,
        id = name.slice(0, -5);
      present.add(id);
      const known = db.prepare('SELECT digest FROM todo_transactions WHERE id=?').get(id) as
        | { digest: string }
        | undefined;
      if (known && cached(path) === known.digest) continue;
      const bytes = readKnowledgeDataFile(config.knowledgeRoot, path)!;
      const digest = toDooHash(bytes);
      remember(path, digest);
      if (known) {
        if (known.digest !== digest) toDooError('已提交事务被外部修改，请核对同步冲突');
      } else {
        const tx = parseTransaction(bytes);
        if (tx.id !== id) toDooError('事务文件名不匹配');
        pending.push(tx);
      }
    }
    for (const tx of db.prepare('SELECT id FROM todo_transactions').all() as { id: string }[])
      if (!present.has(tx.id)) toDooError('已知事务文件缺失，请恢复完整同步');
    const changed = new Set(
      (
        db.prepare('SELECT kind,id FROM todo_pending_files').all() as { kind: string; id: string }[]
      ).map((r) => r.kind + '\0' + r.id),
    );
    db.transaction(() => {
      let rest = pending;
      while (rest.length) {
        let progress = false;
        const next: PortableTransaction[] = [];
        for (const tx of rest) {
          if (
            tx.parentId &&
            !db.prepare('SELECT 1 FROM todo_transactions WHERE id=?').get(tx.parentId)
          ) {
            next.push(tx);
            continue;
          }
          // A merged branch can depend on an entity version outside the single
          // global parent chain. Wait for every member predecessor before writing
          // any member, so enumeration order cannot create a false fork.
          if (tx.members.some((m) => (getRow(m.kind, m.id)?.revision ?? null) !== m.fromRevision)) {
            next.push(tx);
            continue;
          }
          for (const m of tx.members) {
            const row = getRow(m.kind, m.id);
            if ((row?.revision ?? null) !== m.fromRevision)
              toDooError('事务版本分叉或成员顺序冲突，请核对同步');
            db.prepare(
              'INSERT INTO todo_entities VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,envelope=excluded.envelope,digest=excluded.digest',
            ).run(
              m.kind,
              m.id,
              m.after.revision,
              JSON.stringify(parseEntity(m.kind, m.after.data)),
              encode(m.after),
              m.afterHash,
            );
            changed.add(m.kind + '\0' + m.id);
            db.prepare('INSERT OR IGNORE INTO todo_pending_files VALUES(?,?)').run(m.kind, m.id);
          }
          db.prepare('INSERT INTO todo_transactions VALUES(?,?,?,?,?,?)').run(
            tx.id,
            tx.requestId,
            tx.fingerprint,
            encode(tx),
            toDooHash(encode(tx)),
            ((
              db.prepare('SELECT MAX(sequence) n FROM todo_transactions').get() as {
                n: number | null;
              }
            ).n ?? 0) + 1,
          );
          for (const r of tx.importedReceipts ?? []) {
            const old = db
              .prepare('SELECT data FROM todo_imported_receipts WHERE request_id=?')
              .get(r.requestId) as { data: string } | undefined;
            if (old && JSON.parse(old.data).fingerprint !== r.fingerprint)
              toDooError('导入请求身份冲突');
            db.prepare('INSERT OR IGNORE INTO todo_imported_receipts VALUES(?,?)').run(
              r.requestId,
              JSON.stringify(r),
            );
          }
          if (tx.adoptDatasetId)
            db.prepare(
              "INSERT INTO todo_meta VALUES('dataset-adoption',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ).run(JSON.stringify({ from: tx.previousDatasetId, to: tx.adoptDatasetId }));
          progress = true;
        }
        if (!progress) toDooError('事务前驱缺失或成员版本分叉，请核对完整同步');
        rest = next;
      }
    }).immediate();
    const adoption = db
      .prepare("SELECT value FROM todo_meta WHERE key='dataset-adoption'")
      .get() as { value: string } | undefined;
    if (adoption) {
      const target = JSON.parse(adoption.value) as { from: string; to: string };
      const bytes = readKnowledgeDataFile(config.knowledgeRoot, manifestPath)!;
      const current = JSON.parse(bytes.toString('utf8'));
      if (current.datasetId !== target.to) {
        if (current.datasetId !== target.from) toDooError('数据集身份出现外部冲突');
        current.datasetId = target.to;
        writeKnowledgeDataFile(
          config.knowledgeRoot,
          manifestPath,
          encode(current),
          toDooHash(bytes),
        );
      }
      datasetId = target.to;
    }
    const rows = db.prepare('SELECT * FROM todo_entities').all() as Row[];
    for (const row of rows) {
      const path = entityPath(row.kind, row.id);
      if (cached(path) === row.digest) continue;
      const bytes = readKnowledgeDataFile(config.knowledgeRoot, path);
      if (bytes && toDooHash(bytes) === row.digest) {
        remember(path, row.digest);
        continue;
      }
      if (!fresh && !changed.has(row.kind + '\0' + row.id))
        toDooError('应用数据被外部修改或缺失，请核对文件冲突');
      if (bytes) {
        const disk = readEnvelope(row.kind, row.id, bytes);
        const known = db.prepare('SELECT data FROM todo_transactions').all() as { data: string }[];
        const valid = known.some((r) => {
          const tx = JSON.parse(r.data) as PortableTransaction;
          return tx.members.some(
            (m) =>
              m.kind === row.kind &&
              m.id === row.id &&
              m.after.revision === disk.revision &&
              m.afterHash === toDooHash(bytes),
          );
        });
        if (!valid) toDooError('应用文件存在未确认的外部变化，已保留双方');
      }
      writeKnowledgeDataFile(
        config.knowledgeRoot,
        path,
        row.envelope,
        bytes ? toDooHash(bytes) : null,
      );
      remember(path, row.digest);
    }
    db.prepare('DELETE FROM todo_pending_files').run();
    for (const kind of Object.keys(TO_DOO_COLLECTIONS) as (keyof typeof TO_DOO_COLLECTIONS)[]) {
      const folder = entityPath(kind, 'placeholder').split('/').slice(0, -1).join('/');
      for (const file of files(folder)) {
        const id = file.slice(0, -5);
        if (!getRow(kind, id)) toDooError('发现没有提交记录的应用实体，请核对完整同步');
      }
    }
  }
  refresh(true);
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(
      join(config.knowledgeRoot, '_data', rootPath),
      { recursive: true, persistent: false },
      () => {
        diskDirty = true;
      },
    );
    watcher.on('error', () => {
      diskDirty = true;
    });
  } catch {
    /* Periodic validation still works on filesystems without watch support. */
  }
  let cachedState: ToDooState | undefined,
    cachedSequence = 0;
  function state(): ToDooState {
    const currentSequence = Number(
      (
        db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM todo_transactions').get() as {
          n: number;
        }
      ).n,
    );
    if (!cachedState || currentSequence < cachedSequence) {
      cachedState = emptyToDooState();
      for (const row of db.prepare('SELECT kind,data FROM todo_entities ORDER BY rowid').all() as {
        kind: ToDooEntityKind;
        data: string;
      }[]) {
        const entity = parseEntity(row.kind, JSON.parse(row.data));
        (cachedState[row.kind] as Map<string, ToDooEntity>).set(entity.id, entity);
      }
    } else if (currentSequence > cachedSequence) {
      for (const row of db
        .prepare('SELECT data FROM todo_transactions WHERE sequence>? ORDER BY sequence')
        .all(cachedSequence) as { data: string }[]) {
        const tx = JSON.parse(row.data) as PortableTransaction;
        for (const member of tx.members)
          (cachedState[member.kind] as Map<string, ToDooEntity>).set(
            member.id,
            parseEntity(member.kind, member.after.data),
          );
      }
    }
    cachedSequence = currentSequence;
    return Object.fromEntries(
      Object.keys(toDooEntitySchemas).map((kind) => [
        kind,
        new OverlayMap(cachedState![kind as ToDooEntityKind] as Map<string, ToDooEntity>),
      ]),
    ) as unknown as ToDooState;
  }

  function receipt(requestId: string): ToDooPortableReceipt | undefined {
    const row = db
      .prepare('SELECT data FROM todo_transactions WHERE request_id=?')
      .get(requestId) as { data: string } | undefined;
    if (row) {
      const tx = JSON.parse(row.data) as PortableTransaction;
      return {
        transactionId: tx.id,
        requestId: tx.requestId,
        fingerprint: tx.fingerprint,
        ids: tx.ids,
        changed: tx.members.map((m) => ({ kind: m.kind, id: m.id, revision: m.after.revision })),
      };
    }
    const imported = db
      .prepare('SELECT data FROM todo_imported_receipts WHERE request_id=?')
      .get(requestId) as { data: string } | undefined;
    return imported ? JSON.parse(imported.data) : undefined;
  }
  function execute(
    requestId: string,
    input: unknown,
    work: (s: ToDooState) => {
      changes: PendingEntity[];
      ids: string[];
      importedReceipts?: ToDooPortableReceipt[];
      importedTransactions?: unknown[];
      adoptDatasetId?: string;
      previousDatasetId?: string;
    },
  ): { receipt: ToDooPortableReceipt; replayed: boolean } {
    let preparedMembers: Member[] = [];
    return workspaceWriteSync(db, { kind: 'to-doo.command' }, () => {
      try {
        return db
          .transaction(() => {
            refresh();
            const fingerprint = toDooHash(canonical(input));
            const previous = receipt(requestId);
            if (previous) {
              if (previous.fingerprint !== fingerprint) toDooError('相同请求标识携带不同内容', 409);
              return { receipt: previous, replayed: true };
            }
            const result = work(state()),
              id = randomUUID(),
              at = new Date().toISOString();
            const members: Member[] = [];
            const unique = new Set<string>();
            for (const change of result.changes) {
              const { kind, entity, expectedRevision } = change,
                key = kind + '\0' + entity.id;
              if (unique.has(key)) toDooError('事务重复修改同一实体');
              unique.add(key);
              const row = getRow(kind, entity.id);
              if ((row?.revision ?? null) !== expectedRevision)
                toDooError('实体版本已变化，请重新核对');
              const path = entityPath(kind, entity.id),
                bytes = readKnowledgeDataFile(config.knowledgeRoot, path);
              if ((bytes ? toDooHash(bytes) : null) !== (row?.digest ?? null))
                toDooError('应用数据存在文件同步冲突，未覆盖外部版本');
              const after: Envelope = {
                format: 1,
                revision: entity.revision,
                data: parseEntity(kind, entity),
                lastTransactionId: id,
              };
              members.push({
                kind,
                id: entity.id,
                fromRevision: expectedRevision,
                after,
                afterHash: toDooHash(encode(after)),
              });
            }
            preparedMembers = members;
            const parent = db
              .prepare('SELECT id FROM todo_transactions ORDER BY sequence DESC LIMIT 1')
              .get() as { id: string } | undefined;
            const tx: PortableTransaction = {
              format: 1,
              id,
              parentId: parent?.id ?? null,
              requestId,
              fingerprint,
              at,
              members,
              ids: result.ids,
              ...(result.importedReceipts ? { importedReceipts: result.importedReceipts } : {}),
              ...(result.adoptDatasetId
                ? { adoptDatasetId: result.adoptDatasetId, previousDatasetId: datasetId }
                : {}),
              ...(result.importedTransactions
                ? { importedTransactions: result.importedTransactions }
                : {}),
            };
            writeKnowledgeDataFile(
              config.knowledgeRoot,
              rootPath + '/transactions/' + id + '.json',
              encode(tx),
              null,
            );
            // The immutable portable record is the commit point. Refresh replays it into
            // one SQLite transaction, then materializes individual files before exposing it.
            lastScan = 0;
            refresh(true);
            return { receipt: receipt(requestId)!, replayed: false };
          })
          .immediate();
      } catch (error) {
        diskDirty = true;
        if (preparedMembers.length)
          db.transaction(() => {
            for (const m of preparedMembers)
              db.prepare('INSERT OR IGNORE INTO todo_pending_files VALUES(?,?)').run(m.kind, m.id);
          }).immediate();
        throw error;
      }
    });
  }
  function readAssets(): { hash: string; data: string }[] {
    const directory = join(config.knowledgeRoot, '_data', rootPath, 'assets');
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) toDooError('附件目录不安全');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return readdirSync(directory).map((hash) => {
      if (!/^[a-f0-9]{64}$/.test(hash)) toDooError('附件身份无效');
      const bytes = readKnowledgeDataFile(config.knowledgeRoot, rootPath + '/assets/' + hash);
      if (!bytes || toDooHash(bytes) !== hash) toDooError('附件缺失或校验失败');
      return { hash, data: bytes.toString('base64') };
    });
  }
  function checkpoint(): ToDooCheckpoint {
    return workspaceWriteSync(db, { kind: 'to-doo.export' }, () => {
      refresh(true);
      const transactions = (
        db.prepare('SELECT data FROM todo_transactions ORDER BY sequence').all() as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data));
      const receipts = [
        ...transactions.map((t: PortableTransaction) => receipt(t.requestId)!),
        ...(db.prepare('SELECT data FROM todo_imported_receipts').all() as { data: string }[]).map(
          (r) => JSON.parse(r.data),
        ),
      ];
      const payload = {
        format: 1 as const,
        appId: 'to-doo' as const,
        datasetId,
        createdAt: new Date().toISOString(),
        entities: (
          db.prepare('SELECT kind,data FROM todo_entities ORDER BY kind,id').all() as {
            kind: ToDooEntityKind;
            data: string;
          }[]
        ).map((r) => ({ kind: r.kind, entity: JSON.parse(r.data) })),
        transactions,
        receipts,
        assets: readAssets(),
      };
      return { ...payload, digest: toDooHash(canonical(payload)) };
    });
  }
  return {
    get datasetId() {
      const adopted = db
        .prepare("SELECT value FROM todo_meta WHERE key='dataset-adoption'")
        .get() as { value: string } | undefined;
      return adopted ? JSON.parse(adopted.value).to : datasetId;
    },
    newInstance,
    db,
    refresh,
    state,
    execute,
    receipt,
    checkpoint,
    entities<K extends ToDooEntityKind>(kind: K, limit?: number, offset = 0): ToDooEntityMap[K][] {
      const sql =
        'SELECT data FROM todo_entities WHERE kind=? ORDER BY rowid' +
        (limit === undefined ? '' : ' LIMIT ? OFFSET ?');
      return (
        db.prepare(sql).all(...(limit === undefined ? [kind] : [kind, limit, offset])) as {
          data: string;
        }[]
      ).map((r) => parseEntity(kind, JSON.parse(r.data)));
    },
    close() {
      closed = true;
      watcher?.close();
    },
  };
}
