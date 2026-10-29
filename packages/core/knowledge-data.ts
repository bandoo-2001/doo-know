import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AppDatabase } from './db.js';
import { HttpError } from './errors.js';

export type KnowledgeDataDomain = { refresh(): void; flush(): void };
type Options<T> = {
  tables: string[];
  workspace?: boolean;
  rows?: Record<string, { column: string; value: string }>;
  read(): T;
  validate(data: unknown): T;
  write(data: T): void;
};
type State = {
  root: string;
  path: string;
  digest: string | null;
  dirty: number;
  pending: string | null;
  pending_digest: string | null;
  pending_base: string | null;
  pending_version: number | null;
};
const domains = new WeakMap<AppDatabase, Map<string, KnowledgeDataDomain>>();
const workspaceDomains = new WeakSet<KnowledgeDataDomain>();
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function unavailable(message: string, code = 'KNOWLEDGE_DATA_UNAVAILABLE'): never {
  throw new HttpError(code === 'KNOWLEDGE_DATA_CONFLICT' ? 409 : 503, message, { code });
}
function parts(relative: string) {
  const result = relative.split('/');
  if (
    !relative ||
    result.some(
      (part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) || part === '..' || part === '.',
    )
  )
    throw new HttpError(400, '应用数据路径不允许');
  return result;
}
function checkedRoot(root: string) {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) unavailable('知识库数据目录不可用');
  return realpathSync(root);
}
function filePath(root: string, relative: string, create = false): string | undefined {
  const components = ['_data', ...parts(relative)],
    base = checkedRoot(root);
  let current = base;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    const directory = index !== components.length - 1;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create || !directory) return directory ? undefined : current;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      info = lstatSync(current);
    }
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)
    )
      unavailable('应用数据不允许软链接、共享硬链接或特殊文件');
  }
  return current;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function readKnowledgeDataFile(root: string, relative: string): Buffer | undefined {
  const path = filePath(root, relative);
  if (!path) return undefined;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink > 1) unavailable('应用数据不是独立的普通文件');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writeKnowledgeDataFile(
  root: string,
  relative: string,
  bytes: Buffer | string,
  expectedDigest?: string | null,
): void {
  const path = filePath(root, relative, true)!;
  const temporary = join(dirname(path), '.dooknow-' + randomUUID() + '.tmp');
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Recheck the destination after preparing the complete replacement.
    filePath(root, relative, true);
    if (expectedDigest !== undefined) {
      const previous = readKnowledgeDataFile(root, relative);
      if ((previous ? hash(previous) : null) !== expectedDigest)
        unavailable('应用数据存在同步冲突，请核对 _data 文件后重试', 'KNOWLEDGE_DATA_CONFLICT');
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function listKnowledgeDataDirectories(root: string, relative: string): string[] {
  const path = filePath(root, relative + '/placeholder');
  if (!path) return [];
  return readdirSync(dirname(path), { withFileTypes: true })
    .filter(
      (item) =>
        item.isDirectory() &&
        !item.isSymbolicLink() &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.name),
    )
    .map((item) => item.name)
    .sort();
}
function manifest(root: string, create = false) {
  const content = readKnowledgeDataFile(root, 'manifest.json');
  if (content) {
    try {
      const data = JSON.parse(content.toString('utf8'));
      if (data.format !== 1 || typeof data.id !== 'string' || !data.id) throw Error();
    } catch {
      unavailable('知识库应用数据版本不支持或清单损坏，请保留文件后检查');
    }
  } else if (create)
    writeKnowledgeDataFile(
      root,
      'manifest.json',
      JSON.stringify({ format: 1, id: randomUUID() }, null, 2) + '\n',
    );
}
export function createKnowledgeDataDomain<T>(
  config: { knowledgeRoot: string },
  db: AppDatabase,
  path: string,
  options: Options<T>,
): KnowledgeDataDomain {
  parts(path);
  const root = checkedRoot(config.knowledgeRoot);
  let registered = domains.get(db);
  if (!registered) {
    registered = new Map();
    domains.set(db, registered);
  }
  const key = root + '\0' + path;
  const existing = registered.get(key);
  if (existing) return existing;
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_data_state(
    root TEXT NOT NULL,path TEXT NOT NULL,digest TEXT,dirty INTEGER NOT NULL DEFAULT 1,
    pending TEXT,pending_digest TEXT,pending_base TEXT,pending_version INTEGER,
    PRIMARY KEY(root,path));
    CREATE TABLE IF NOT EXISTS knowledge_data_context(id INTEGER PRIMARY KEY CHECK(id=1),importing INTEGER NOT NULL);
    INSERT OR IGNORE INTO knowledge_data_context VALUES(1,0)`);
  db.prepare('INSERT OR IGNORE INTO knowledge_data_state(root,path) VALUES(?,?)').run(root, path);
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  for (const table of options.tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw Error('Invalid tracked table');
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = 'knowledge_data_' + hash(key + table + operation).slice(0, 24);
      const row = options.rows?.[table];
      if (row && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.column))
        throw Error('Invalid tracked column');
      const filter = (record: string) => `${record}."${row!.column}"=${literal(row!.value)}`;
      const condition = row
        ? ' AND (' +
          (operation === 'INSERT'
            ? filter('NEW')
            : operation === 'DELETE'
              ? filter('OLD')
              : filter('NEW') + ' OR ' + filter('OLD')) +
          ')'
        : '';
      db.exec(`DROP TRIGGER IF EXISTS ${trigger};
        CREATE TRIGGER ${trigger} AFTER ${operation} ON "${table}" WHEN (SELECT importing FROM knowledge_data_context WHERE id=1)=0${condition} BEGIN
        UPDATE knowledge_data_state SET dirty=dirty+1 WHERE root=${literal(root)} AND path=${literal(path)}; END;`);
    }
  }
  const state = () =>
    db
      .prepare('SELECT * FROM knowledge_data_state WHERE root=? AND path=?')
      .get(root, path) as State;
  const current = () => {
    manifest(root);
    const bytes = readKnowledgeDataFile(root, path);
    return { bytes, digest: bytes ? hash(bytes) : null };
  };
  const decode = (bytes: Buffer): T => {
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (
        envelope.format !== 1 ||
        typeof envelope.revision !== 'string' ||
        !envelope.revision ||
        !Object.hasOwn(envelope, 'data')
      )
        throw Error();
      return options.validate(envelope.data);
    } catch {
      return unavailable('应用数据格式不支持或文件损坏，请保留文件后检查');
    }
  };
  const conflict = (): never =>
    unavailable('应用数据存在同步冲突，请核对 _data 文件后重试', 'KNOWLEDGE_DATA_CONFLICT');
  const applyImport = (value: T, digest: string | null, expected: State) =>
    db
      .transaction(() => {
        const latest = state();
        if (
          latest.digest !== expected.digest ||
          latest.dirty !== expected.dirty ||
          latest.pending !== expected.pending ||
          current().digest !== digest
        )
          conflict();
        // Projection writes must not masquerade as local edits in another portable domain.
        db.prepare('UPDATE knowledge_data_context SET importing=1 WHERE id=1').run();
        options.write(value);
        db.prepare('UPDATE knowledge_data_context SET importing=0 WHERE id=1').run();
        db.prepare('UPDATE knowledge_data_state SET digest=?,dirty=0 WHERE root=? AND path=?').run(
          digest,
          root,
          path,
        );
      })
      .immediate();
  const acknowledge = (s: State) => {
    db.prepare(
      `UPDATE knowledge_data_state SET digest=?,dirty=CASE WHEN dirty=? THEN 0 ELSE dirty END,
      pending=NULL,pending_digest=NULL,pending_base=NULL,pending_version=NULL WHERE root=? AND path=?`,
    ).run(s.pending_digest, s.pending_version, root, path);
  };
  function recover() {
    db.transaction(() => {
      const s = state();
      if (!s.pending) return;
      const disk = current();
      if (disk.digest !== s.pending_digest) {
        if (disk.digest !== s.pending_base) conflict();
        manifest(root, true);
        writeKnowledgeDataFile(root, path, s.pending, s.pending_base);
      }
      acknowledge(s);
    }).immediate();
  }
  let busy = false;
  function flush() {
    if (busy || db.inTransaction) return;
    busy = true;
    try {
      recover();
      let s = state();
      const disk = current();
      if (s.digest !== disk.digest && s.digest !== null) {
        if (s.dirty || !disk.bytes) conflict();
        const value = decode(disk.bytes!);
        applyImport(value, disk.digest, s);
        return;
      }
      if (s.digest === null && disk.bytes) {
        // A synced file takes priority over a machine's previous database on first adoption.
        const value = decode(disk.bytes!);
        applyImport(value, disk.digest, s);
        return;
      }
      if (!s.dirty && disk.bytes) return;
      db.transaction(() => {
        s = state();
        if (s.pending) return;
        if (current().digest !== disk.digest) conflict();
        const value = options.validate(options.read());
        if (disk.bytes && JSON.stringify(decode(disk.bytes)) === JSON.stringify(value)) {
          db.prepare('UPDATE knowledge_data_state SET dirty=0 WHERE root=? AND path=?').run(
            root,
            path,
          );
          return;
        }
        const pending =
          JSON.stringify({ format: 1, revision: randomUUID(), data: value }, null, 2) + '\n';
        db.prepare(
          'UPDATE knowledge_data_state SET pending=?,pending_digest=?,pending_base=?,pending_version=? WHERE root=? AND path=?',
        ).run(pending, hash(pending), disk.digest, s.dirty, root, path);
      }).immediate();
      recover();
    } finally {
      busy = false;
    }
  }
  function refresh() {
    if (busy || db.inTransaction) return;
    busy = true;
    try {
      recover();
      const s = state(),
        disk = current();
      if (s.digest === disk.digest) {
        // A failed prior write can leave a dirty projection with an unchanged source.
      } else if (!disk.bytes) {
        if (s.digest !== null) conflict();
      } else {
        if (s.digest !== null && s.dirty) conflict();
        const value = decode(disk.bytes!);
        applyImport(value, disk.digest, s);
      }
    } finally {
      busy = false;
    }
    flush();
  }
  const domain = { refresh, flush };
  if (options.workspace !== false) workspaceDomains.add(domain);
  registered.set(key, domain);
  try {
    refresh();
    flush();
  } catch (error) {
    registered.delete(key);
    throw error;
  }
  return domain;
}
export function refreshKnowledgeData(db: AppDatabase) {
  for (const domain of domains.get(db)?.values() || [])
    if (workspaceDomains.has(domain)) domain.refresh();
}
export function flushKnowledgeData(db: AppDatabase) {
  for (const domain of domains.get(db)?.values() || [])
    if (workspaceDomains.has(domain)) domain.flush();
}

/** Rebind only local bookkeeping when a consistent backup is restored to a new directory. */
export function rebindKnowledgeDataRoot(db: AppDatabase, knowledgeRoot: string): void {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  if (!tables.has('knowledge_data_state')) return;
  const saved = db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as
    | { value: string }
    | undefined;
  if (!saved) return;
  const previous = JSON.parse(saved.value).path;
  const root = checkedRoot(knowledgeRoot);
  if (typeof previous !== 'string' || previous === root) return;
  db.transaction(() => {
    const pending = db
      .prepare('SELECT * FROM knowledge_data_state WHERE root=? ORDER BY path')
      .all(previous) as State[];
    for (const item of pending) {
      if (
        db
          .prepare('SELECT 1 FROM knowledge_data_state WHERE root=? AND path=?')
          .get(root, item.path)
      )
        unavailable(
          '恢复目标存在另一份应用数据状态，请保留恢复副本后检查',
          'KNOWLEDGE_DATA_CONFLICT',
        );
      if (item.pending) {
        const bytes = readKnowledgeDataFile(root, item.path),
          digest = bytes ? hash(bytes) : null;
        if (digest !== item.pending_digest) {
          if (digest !== item.pending_base)
            unavailable(
              '恢复副本的应用数据与待写记录冲突，请保留副本后检查',
              'KNOWLEDGE_DATA_CONFLICT',
            );
          manifest(root, true);
          writeKnowledgeDataFile(root, item.path, item.pending, item.pending_base);
        }
        db.prepare(
          `UPDATE knowledge_data_state SET digest=pending_digest,
          dirty=CASE WHEN dirty=pending_version THEN 0 ELSE dirty END,
          pending=NULL,pending_digest=NULL,pending_base=NULL,pending_version=NULL
          WHERE root=? AND path=?`,
        ).run(previous, item.path);
      }
    }
    for (const table of ['knowledge_data_state', 'portable_plugin_state', 'portable_plugin_data']) {
      if (tables.has(table))
        db.prepare(`UPDATE "${table}" SET root=? WHERE root=?`).run(root, previous);
    }
  }).immediate();
}
