import { lstatSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { AppConfig } from '../../../shared/contracts.js';
import { assertRoot } from '../../../packages/core/indexing/reconcile.js';
import { processIsAlive } from '../../../packages/core/workspace/gate.js';
const tableExists = (db: AppDatabase, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function rootBusinessDigest(db: AppDatabase) {
  const hash = createHash('sha256');
  for (const table of [
    'notes',
    'revisions',
    'shares',
    'assets',
    'note_assets',
    'document_state',
    'operations',
    'write_intents',
    'file_operations',
  ]) {
    if (!tableExists(db, table)) continue;
    hash.update(table + '\n');
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as any[]).map(
      (c) => '"' + c.name.replaceAll('"', '""') + '"',
    );
    for (const row of db
      .prepare(`SELECT * FROM "${table}" ORDER BY ${columns.join(',')}`)
      .iterate())
      hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}
// Administrative, offline rename. The caller must stop legacy services and retain
// an encrypted consistent backup before entering this function. No raw file is replaced.
export function renameRootInPlace(
  db: AppDatabase,
  options: {
    oldRoot: string;
    newRoot: string;
    expectedIdentity: string;
    configuration?: { apply(): void; rollback(): void };
    verify?: (root: string, db: AppDatabase) => void;
  },
) {
  const oldRoot = resolve(options.oldRoot),
    newRoot = resolve(options.newRoot);
  if (
    oldRoot !== options.oldRoot ||
    newRoot !== options.newRoot ||
    /[\x00-\x1f]/.test(oldRoot + newRoot) ||
    oldRoot === newRoot ||
    newRoot.startsWith(oldRoot + '/') ||
    oldRoot.startsWith(newRoot + '/')
  )
    throw Error('原文迁移需要两个独立绝对路径');
  const previous = (
    db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
  )?.value;
  if (typeof previous !== 'string' || previous !== options.expectedIdentity)
    throw Error('根身份已变化，拒绝迁移');
  let targetExists = false;
  try {
    lstatSync(newRoot);
    targetExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const dataRoot = dirname(db.name);
  if (
    newRoot === dataRoot ||
    newRoot.startsWith(dataRoot + '/') ||
    dataRoot.startsWith(newRoot + '/')
  )
    throw Error('原文与数据库目录必须独立');
  const before = lstatSync(oldRoot, { bigint: true }),
    parent = lstatSync(dirname(newRoot), { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    realpathSync(oldRoot) !== oldRoot ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    realpathSync(dirname(newRoot)) !== dirname(newRoot) ||
    targetExists ||
    before.dev !== parent.dev
  )
    throw Error('只允许同文件系统的真实目录改名，目标必须不存在');
  const identity = JSON.parse(previous);
  if (
    identity.path !== oldRoot ||
    identity.dev !== String(before.dev) ||
    identity.ino !== String(before.ino)
  )
    throw Error('目录与原根身份不一致');
  if (
    tableExists(db, 'database_processes') &&
    (db.prepare('SELECT pid,process_start FROM database_processes').all() as any[]).some(
      (p) => p.pid !== process.pid && processIsAlive(p.pid, p.process_start),
    )
  )
    throw Error('仍有数据进程，请先正常停止');
  for (const [table, where] of [
    ['write_intents', "status IN ('prepared','conflicted')"],
    ['file_operations', "status IN ('queued','running','committing')"],
    ['sync_runs', "status IN ('running','needs_reconciliation')"],
    ['organization_jobs', "status IN ('queued','running','committing','needs_reconciliation')"],
  ])
    if (tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get())
      throw Error('仍有未完成写入或同步，请先排空并核对');
  const verify =
    options.verify ||
    ((root: string, connection: AppDatabase) =>
      assertRoot({ knowledgeRoot: root } as AppConfig, connection));
  verify(oldRoot, db);
  const library = tableExists(db, 'organization_library')
    ? (db.prepare('SELECT * FROM organization_library WHERE id=1').get() as any)
    : undefined;
  if (library && library.root_identity !== previous) throw Error('目录整理身份与原根身份不一致');
  const digest = rootBusinessDigest(db),
    next = JSON.stringify({ path: newRoot, dev: String(before.dev), ino: String(before.ino) });
  let moved = false,
    configurationAttempted = false;
  try {
    db.transaction(() => {
      if (
        (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any)
          ?.value !== previous
      )
        throw Error('根身份已变化');
      renameSync(oldRoot, newRoot);
      moved = true;
      const after = lstatSync(newRoot, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || existsSync(oldRoot))
        throw Error('改名后的目录身份不一致');
      const changed = db
        .prepare("UPDATE index_meta SET value=? WHERE key='root_identity' AND value=?")
        .run(next, previous);
      if (changed.changes !== 1) throw Error('根身份比较更新必须恰好一行');
      if (library) {
        const rebound = db
          .prepare(
            'UPDATE organization_library SET root_identity=?,binding_version=binding_version+1 WHERE id=1 AND root_identity=? AND binding_version=?',
          )
          .run(next, previous, library.binding_version);
        if (rebound.changes !== 1) throw Error('目录整理绑定比较更新失败');
        if (tableExists(db, 'organization_jobs'))
          db.prepare(
            "UPDATE organization_jobs SET manifest=json_set(manifest,'$.bindingVersion',?) WHERE status='succeeded' AND json_valid(manifest) AND json_extract(manifest,'$.libraryId')=? AND json_extract(manifest,'$.bindingVersion')=?",
          ).run(library.binding_version + 1, library.library_id, library.binding_version);
      }
      if (tableExists(db, 'platform_settings')) {
        const binding = db
          .prepare('SELECT knowledge_root,binding_version FROM platform_settings WHERE id=1')
          .get() as any;
        if (binding) {
          if (binding.knowledge_root !== oldRoot) throw Error('知识库绑定与原根身份不一致');
          if (
            db
              .prepare(
                'UPDATE platform_settings SET knowledge_root=?,binding_version=binding_version+1 WHERE id=1 AND knowledge_root=? AND binding_version=?',
              )
              .run(newRoot, oldRoot, binding.binding_version).changes !== 1
          )
            throw Error('绑定比较更新失败');
        }
      }
      verify(newRoot, db);
      if (rootBusinessDigest(db) !== digest) throw Error('业务元数据在改名期间变化');
      if (options.configuration) {
        configurationAttempted = true;
        options.configuration.apply();
      }
      if (
        db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (db.pragma('foreign_key_check') as any[]).length
      )
        throw Error('迁移数据库校验失败');
    }).immediate();
    return {
      identityUpdated: true,
      oldRoot,
      newRoot,
      dev: String(before.dev),
      ino: String(before.ino),
      businessDigest: digest,
    };
  } catch (error) {
    let configurationError: unknown;
    try {
      if (configurationAttempted) options.configuration!.rollback();
    } catch (failure) {
      configurationError = failure;
    }
    if (moved) {
      const stored = (
        db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
      )?.value;
      if (stored !== previous || existsSync(oldRoot) || !existsSync(newRoot))
        throw Error('迁移未完成且状态需要人工核对；目录已保留，不覆盖资料');
      const actual = lstatSync(newRoot, { bigint: true });
      if (actual.dev !== before.dev || actual.ino !== before.ino)
        throw Error('目录被外部替换，保留现场并停止自动回退');
      renameSync(newRoot, oldRoot);
      verify(oldRoot, db);
    }
    if (configurationError) throw Error('目录已回退，但配置恢复失败；请核对迁移日志后再启动服务');
    throw error;
  }
}
