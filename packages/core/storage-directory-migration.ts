import { storageAssetAliasState } from './storage-asset-alias-state.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../shared/diagram-portability.js';
import { serializeDiagramBinding } from '../../shared/diagram-binding.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import type { AppDatabase } from './db.js';
import type { AppConfig } from '../../shared/contracts.js';
import {
  DOO_ASSETS_DIRECTORY,
  DOO_DATA_DIRECTORY,
  LEGACY_DATA_DIRECTORY,
  isKnowledgeDataPath,
  isDooAssetPath,
} from '../../shared/storage-paths.js';
import { knowledgeDataDirectory } from './knowledge-data-path.js';
import {
  ASSET_ALIASES_FILE,
  readStorageAssetAliases,
  type StorageAssetAlias,
} from './storage-asset-aliases.js';
import { rewriteLibraryReferences } from './organization/references.js';
import { safePath, validName, validateRelative } from './files.js';
import { reconcileService, assertRoot } from './indexing/reconcile.js';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const table = (db: AppDatabase, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export type StorageDirectoryMigrationPlan = {
  version: 1;
  id: string;
  knowledgeRoot: string;
  dataDirectory: string;
  assets: (StorageAssetAlias & { id: string })[];
  edits: {
    path: string;
    noteId?: string;
    beforeHash: string;
    afterHash: string;
    before: string;
    after: string;
  }[];
  preserved: string[];
  dataManifestHash?: string;
};
function independentFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error('迁移只允许独立普通文件：' + path);
  return stat;
}
function durable(path: string, bytes: string | Buffer) {
  mkdirSync(posix.dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.doo-migration-' + randomUUID();
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(posix.dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function assertIdle(db: AppDatabase) {
  for (const [name, clause] of [
    ['write_intents', "status IN ('prepared','conflicted')"],
    ['organization_jobs', "status IN ('committing','needs_reconciliation')"],
    ['sync_runs', "status IN ('running','needs_reconciliation')"],
    [
      'diagram_pending_publications',
      "operation_id IN (SELECT id FROM operations WHERE status<>'succeeded')",
    ],
  ] as const)
    if (table(db, name) && db.prepare(`SELECT 1 FROM ${name} WHERE ${clause} LIMIT 1`).get())
      throw Error('迁移前请先完成待核对操作：' + name);
}
export function planStorageDirectoryMigration(
  config: Pick<AppConfig, 'knowledgeRoot' | 'dataRoot'>,
  db: AppDatabase,
): StorageDirectoryMigrationPlan {
  assertIdle(db);
  assertRoot(config, db);
  const root = config.knowledgeRoot,
    data = knowledgeDataDirectory(root),
    plan: StorageDirectoryMigrationPlan = {
      version: 1,
      id: randomUUID(),
      knowledgeRoot: root,
      dataDirectory: posix.basename(data),
      assets: [],
      edits: [],
      preserved: [],
    };
  if (posix.basename(data) === LEGACY_DATA_DIRECTORY) {
    const manifest = join(data, 'manifest.json');
    independentFile(manifest);
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    if (value.format !== 1 || typeof value.id !== 'string' || !value.id)
      throw Error('旧 _data 缺少有效的 DooKnow 身份清单，不能自动重命名');
  }
  const manifestFile = join(data, 'manifest.json');
  if (existsSync(manifestFile)) {
    independentFile(manifestFile);
    plan.dataManifestHash = hash(readFileSync(manifestFile));
  }
  const receipts = new Set<string>();
  if (table(db, 'operations'))
    for (const row of db
      .prepare(
        "SELECT result FROM operations WHERE status='succeeded' AND (kind='diagram-primary.prepare' OR kind LIKE 'diagram-artifacts:%') AND result IS NOT NULL",
      )
      .all() as { result: string }[]) {
      try {
        const visit = (value: any) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, v] of Object.entries(value)) {
            if ((key === 'relativePath' || key === 'path') && typeof v === 'string')
              receipts.add(v);
            else visit(v);
          }
        };
        visit(JSON.parse(row.result));
      } catch {}
    }
  const candidates = table(db, 'assets')
    ? (db.prepare('SELECT id,path FROM assets ORDER BY path').all() as {
        id: string;
        path: string;
      }[])
    : [];
  for (const asset of candidates) {
    if (!asset.path.split('/').includes('assets') || isDooAssetPath(asset.path)) continue;
    const path = join(root, asset.path);
    if (!existsSync(path)) continue;
    if (!receipts.has(asset.path)) {
      plan.preserved.push(asset.path);
      continue;
    }
    independentFile(safePath(root, asset.path, 'asset'));
    const parts = asset.path.split('/');
    parts[parts.lastIndexOf('assets')] = DOO_ASSETS_DIRECTORY;
    plan.assets.push({
      id: asset.id,
      from: asset.path,
      to: parts.join('/'),
      sha256: hash(readFileSync(path)),
    });
  }
  const moves = plan.assets.map(({ from, to }) => ({ from, to })),
    owned = new Set(plan.assets.map((asset) => asset.from));
  const identities = new Map<string, string>();
  if (table(db, 'notes'))
    for (const note of db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
      id: string;
      path: string;
    }[])
      identities.set(note.path, note.id);
  function walk(dir: string) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (
        !validName(entry.name) ||
        entry.isSymbolicLink() ||
        entry.name === DOO_ASSETS_DIRECTORY ||
        (!dir && isKnowledgeDataPath(entry.name))
      )
        continue;
      const path = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !path.toLowerCase().endsWith('.md') || owned.has(path)) continue;
      const absolute = join(root, path);
      independentFile(absolute);
      const before = readFileSync(absolute, 'utf8'),
        result = rewriteLibraryReferences(before, path, path, moves);
      if (result.changed) {
        const original = boundDiagramSources(before);
        for (const group of boundDiagramSources(result.content)) {
          const nextHash = hash(normalizeDiagramCode(group.code));
          if (
            nextHash === group.binding.codeHash ||
            !original.some(
              (previous) =>
                previous.binding.sourceHash === group.binding.sourceHash &&
                previous.binding.codeHash === group.binding.codeHash &&
                hash(normalizeDiagramCode(previous.code)) === previous.binding.codeHash,
            )
          )
            continue;
          const marker = serializeDiagramBinding(group.binding),
            at = result.content.indexOf(marker, group.prefixFrom);
          if (at < 0 || at + marker.length > group.prefixTo) throw Error('无法定位迁移图形绑定');
          result.content =
            result.content.slice(0, at) +
            serializeDiagramBinding({ ...group.binding, codeHash: nextHash }) +
            result.content.slice(at + marker.length);
        }
      }
      if (result.changed)
        plan.edits.push({
          path,
          noteId: identities.get(path),
          beforeHash: hash(before),
          afterHash: hash(result.content),
          before,
          after: result.content,
        });
    }
  }
  if (moves.length) walk('');
  return plan;
}
/** Apply a fixed, private journal while the caller has quiesced the service and taken a consistent backup. */
export async function applyStorageDirectoryMigration(
  config: AppConfig,
  db: AppDatabase,
  plan: StorageDirectoryMigrationPlan,
) {
  if (
    plan.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(plan.id) ||
    plan.knowledgeRoot !== config.knowledgeRoot
  )
    throw Error('迁移计划不属于当前知识库');
  assertIdle(db);
  assertRoot(config, db);
  const root = config.knowledgeRoot,
    journal = join(config.dataRoot, 'directory-migrations', plan.id, 'plan.json');
  const record = (status: string) =>
    durable(journal, JSON.stringify({ status, plan }, null, 2) + '\n');
  // Validate the whole frozen plan before the first mutation. Already-completed moves are recoverable.
  const dataDirectory = knowledgeDataDirectory(root);
  const rootManifest = join(dataDirectory, 'manifest.json');
  if (
    plan.dataManifestHash &&
    (!existsSync(rootManifest) || hash(readFileSync(rootManifest)) !== plan.dataManifestHash)
  )
    throw Error('知识库身份清单在迁移计划后发生变化');
  for (const asset of plan.assets) {
    validateRelative(asset.from, 'asset');
    validateRelative(asset.to, 'asset');
    if (
      !asset.from.split('/').includes('assets') ||
      !asset.to.split('/').includes(DOO_ASSETS_DIRECTORY)
    )
      throw Error('迁移资源命名空间不正确');
    for (const [index] of posix.dirname(asset.to).split('/').entries()) {
      const relative = posix
        .dirname(asset.to)
        .split('/')
        .slice(0, index + 1)
        .join('/');
      const parent = safePath(root, relative, 'asset', true);
      if (!existsSync(parent)) break;
      if (!lstatSync(parent).isDirectory()) throw Error('迁移目标父路径不是目录');
    }
    const source = join(root, asset.from),
      target = join(root, asset.to);
    const identity = db.prepare('SELECT id,path FROM assets WHERE id=?').get(asset.id) as
      | { id: string; path: string }
      | undefined;
    const destination = db.prepare('SELECT id FROM assets WHERE path=?').get(asset.to) as
      | { id: string }
      | undefined;
    if (
      !identity ||
      ![asset.from, asset.to].includes(identity.path) ||
      (destination && destination.id !== asset.id)
    )
      throw Error('迁移目标资源身份冲突：' + asset.to);
    if (existsSync(source)) {
      independentFile(safePath(root, asset.from, 'asset'));
      if (hash(readFileSync(source)) !== asset.sha256) throw Error('迁移来源已变化：' + asset.from);
    } else if (!existsSync(target)) throw Error('迁移资源缺失：' + asset.from);
    if (existsSync(target)) {
      independentFile(safePath(root, asset.to, 'asset'));
      if (hash(readFileSync(target)) !== asset.sha256) throw Error('迁移目标冲突：' + asset.to);
    }
  }
  for (const edit of plan.edits) {
    if (hash(edit.before) !== edit.beforeHash || hash(edit.after) !== edit.afterHash)
      throw Error('迁移计划内容校验失败');
    independentFile(safePath(root, edit.path, 'note'));
    const current = hash(readFileSync(join(root, edit.path)));
    if (current !== edit.beforeHash && current !== edit.afterHash)
      throw Error('迁移期间文档变化：' + edit.path);
  }
  record('prepared');
  const legacy = join(root, LEGACY_DATA_DIRECTORY),
    current = join(root, DOO_DATA_DIRECTORY);
  if (existsSync(legacy)) {
    if (existsSync(current)) throw Error('两个应用数据目录同时存在');
    renameSync(legacy, current);
  }
  const aliases = new Map(readStorageAssetAliases(root).map((entry) => [entry.from, entry]));
  for (const asset of plan.assets) {
    const previous = aliases.get(asset.from);
    if (previous && (previous.to !== asset.to || previous.sha256 !== asset.sha256))
      throw Error('资源迁移映射冲突');
    aliases.set(asset.from, {
      from: asset.from,
      to: asset.to,
      sha256: asset.sha256,
      assetId: asset.id,
    });
  }
  // Resource bytes remain immutable; the registered alias domain is published after the SQL identities agree.
  for (const asset of plan.assets) {
    validateRelative(asset.from, 'asset');
    validateRelative(asset.to, 'asset');
    if (
      !asset.from.split('/').includes('assets') ||
      !asset.to.split('/').includes(DOO_ASSETS_DIRECTORY)
    )
      throw Error('迁移资源命名空间不正确');
    const source = join(root, asset.from),
      target = join(root, asset.to);
    const components = posix.dirname(asset.to).split('/');
    for (let i = 1; i <= components.length; i++) {
      const parent = safePath(root, components.slice(0, i).join('/'), 'asset', true);
      if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    }

    // Revalidate every component after creating the target parent; never follow a project symlink.
    safePath(root, asset.to, 'asset', true);
    if (existsSync(source)) {
      if (existsSync(target)) {
        // A second physical copy is retained, never deleted implicitly. The registry can safely point at the verified target.
      } else renameSync(source, target);
    }
  }
  record('resources-moved');
  for (const edit of plan.edits) {
    const file = safePath(root, edit.path, 'note');
    independentFile(file);
    if (hash(readFileSync(file)) === edit.beforeHash) durable(file, edit.after);
  }
  db.transaction(() => {
    for (const asset of plan.assets)
      db.prepare('UPDATE assets SET path=? WHERE id=? AND path IN (?,?)').run(
        asset.to,
        asset.id,
        asset.from,
        asset.to,
      );
    if (table(db, 'diagram_document_versions'))
      for (const edit of plan.edits) {
        if (!edit.noteId) continue;
        const versions = db
          .prepare('SELECT * FROM diagram_document_versions WHERE note_id=? AND document_hash=?')
          .all(edit.noteId, edit.beforeHash) as any[];
        for (const version of versions) {
          const manifest = JSON.parse(version.manifest);
          for (const resource of manifest.resources || []) {
            const asset = plan.assets.find((asset) => asset.from === resource.path);
            if (asset) resource.path = asset.to;
          }
          db.prepare(
            'INSERT OR IGNORE INTO diagram_document_versions(note_id,document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(
            version.note_id,
            edit.afterHash,
            version.path,
            version.document_type,
            version.source_hash,
            version.render_hash,
            version.preview_hash,
            JSON.stringify(manifest),
            Date.now(),
          );
        }
      }
  }).immediate();
  const aliasDomain = storageAssetAliasState(config, db);
  db.transaction(() => {
    const upsert = db.prepare(
      'INSERT INTO storage_asset_aliases(root,from_path,asset_id,target_path,hash) VALUES(?,?,?,?,?) ON CONFLICT(root,from_path) DO UPDATE SET asset_id=excluded.asset_id,target_path=excluded.target_path,hash=excluded.hash',
    );
    for (const alias of aliases.values())
      upsert.run(root, alias.from, alias.assetId || null, alias.to, alias.sha256);
  }).immediate();
  aliasDomain.flush();
  record('references-updated');
  // Remove only empty directories from which verified application resources were moved.
  for (const directory of new Set(plan.assets.map((asset) => posix.dirname(asset.from)))) {
    const path = join(root, directory);
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
  const indexing = reconcileService(config, db);
  await indexing.reconcile(undefined, true);
  for (const asset of plan.assets)
    if (hash(readFileSync(join(root, asset.to))) !== asset.sha256)
      throw Error('迁移后资源校验失败：' + asset.to);
  for (const edit of plan.edits)
    if (hash(readFileSync(join(root, edit.path))) !== edit.afterHash)
      throw Error('迁移后文档校验失败：' + edit.path);
  record('complete');
  return {
    id: plan.id,
    assets: plan.assets.length,
    documents: plan.edits.length,
    preserved: plan.preserved.length,
    journal,
  };
}
