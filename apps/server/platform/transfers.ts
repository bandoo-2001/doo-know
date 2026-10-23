import {isWhiteboard,whiteboardId} from '../../../shared/whiteboard.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createReadStream,
  constants,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  fstatSync,
  realpathSync,
} from 'node:fs';
import { mkdir, rm, readFile, lstat, open, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, posix } from 'node:path';
import { randomUUID, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import { verifyPassword } from 'better-auth/crypto';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type {
  TransferTask,
  TransferItem,
  TransferKind,
  ManagedBackup,
  ImportRequest,
  RestoreVerification,
} from '../../../shared/transfer-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { openDatabase } from '../../../packages/core/db.js';
import { HttpError } from '../../../packages/core/errors.js';
import { safePath, scanFiles, validateRelative } from '../../../packages/core/files.js';
import { references, localReference,renderMarkdownReferences,rewriteWhiteboardReferences } from '../../../packages/core/render.js';
import { workspaceWriteSync, workspaceExclusive } from '../../../packages/core/workspace/gate.js';
import { webPrincipal, mutationCore } from '../../../packages/core/knowledge/core.js';
import type { platformRuntime } from './runtime.js';
import { createPlatformBackup, restorePlatformBackup } from './backups.js';
import { independent } from '../backup.js';
import { validateArchive } from './archive.js';
import {
  IMPORT_BODY_LIMIT,
  digest,
  relativeInput,
  targetPath,
  parseImport,
  importPreview,
  entryBytes,
  rewriteImportReferences,
  isImportDocument,
} from './transfer-import.js';

type Job = {
  id: string;
  owner: string;
  kind: TransferKind;
  request_id: string;
  fingerprint: string;
  state: TransferTask['state'];
  created_at: string;
  updated_at: string;
  cancellable: number;
  cancel_requested: number;
  progress: string;
  items: string;
  result: string | null;
  error: string | null;
  payload: string;
  artifact: string | null;
};
type ImportItem = TransferItem & { attempt?: number };
const noteRequestId = (jobId: string, index: number, item: ImportItem) =>
  `transfer-${jobId}-${index}-${item.attempt || 0}`;
type BackupRow = {
  id: string;
  owner: string;
  task_id: string;
  created_at: string;
  bytes: number;
  knowledge_included: number;
  fingerprint: string;
  external: number;
};
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const uploadLimit = 128 * 1024 ** 2;
function requestId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new HttpError(400, 'requestId 格式不正确');
  return value;
}
function idInput(value: string) {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new HttpError(404, '任务或备份不存在');
  return value;
}
function safeDirectory(path: string) {
  const absolute = resolve(path);
  let cursor = absolute;
  for (;;) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new HttpError(503, '托管存储目录不安全');
    } catch (e) {
      if ((e as any).code !== 'ENOENT') throw e;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (info.mode & 0o077) throw new HttpError(503, '托管存储目录权限需为 700');
  return absolute;
}
function safeError(error: unknown) {
  const code = (error as any)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(code)) return code;
  if (error instanceof HttpError) return error.message;
  return '操作失败；请核对文件、恢复密钥、可用空间及工作区状态后重试';
}
function publicTask(j: Job): TransferTask {
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    cancellable: !!j.cancellable && !j.cancel_requested,
    progress: JSON.parse(j.progress),
    ...(j.kind === 'import'
      ? { items: (JSON.parse(j.items) as ImportItem[]).map(({ attempt, ...item }) => item) }
      : {}),
    ...(j.error ? { error: j.error } : {}),
    downloadAvailable: j.state === 'succeeded' && !!j.artifact,
    ...(j.result ? { result: JSON.parse(j.result) } : {}),
  };
}
function publicBackup(b: BackupRow): ManagedBackup {
  return {
    id: b.id,
    taskId: b.task_id,
    createdAt: b.created_at,
    bytes: b.bytes,
    encrypted: true,
    ...(b.external ? {} : { knowledgeIncluded: !!b.knowledge_included }),
    keyFingerprint: b.fingerprint,
    external: !!b.external,
  };
}

/** All authorization, Origin and CSRF hooks in createApp run before these handlers. */
export function registerTransferRoutes(
  app: FastifyInstance,
  config: HostConfig,
  db: AppDatabase,
  platform: ReturnType<typeof platformRuntime>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_transfer_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,cancellable INTEGER NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,progress TEXT NOT NULL,items TEXT NOT NULL,result TEXT,error TEXT,payload TEXT NOT NULL,artifact TEXT,UNIQUE(owner,kind,request_id));
 CREATE TABLE IF NOT EXISTS managed_transfer_backups(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,created_at TEXT NOT NULL,bytes INTEGER NOT NULL,knowledge_included INTEGER NOT NULL,fingerprint TEXT NOT NULL,external INTEGER NOT NULL DEFAULT 0);`);
  db.prepare(
    "UPDATE managed_transfer_jobs SET state='interrupted',cancellable=0,updated_at=?,error='服务重启中断了任务；可重试未完成项目' WHERE state IN ('queued','running')",
  ).run(new Date().toISOString());
  let closing = false,
    scheduled = false,
    current: Promise<void> | undefined;
  const storageRoot = join(
    dirname(resolve(config.dataRoot)),
    '.doo-know-transfers-' + digest(resolve(config.dataRoot)).slice(0, 16),
  );
  const keysRoot = join(storageRoot, 'keys');
  const keyFile = join(keysRoot, 'backup-key.pem');
  function storage() {
    independent(storageRoot, config.dataRoot);
    independent(storageRoot, realpathSync(config.dataRoot));
    const root = platform.settings.configured()?.knowledgeRoot;
    if (root) {
      independent(storageRoot, root);
      try {
        independent(storageRoot, realpathSync(root));
      } catch (error) {
        if ((error as any).code !== 'ENOENT') throw error;
      }
    }
    return safeDirectory(storageRoot);
  }
  function directory(id: string) {
    storage();
    return safeDirectory(join(storageRoot, 'jobs', idInput(id)));
  }
  function clearUploadedKey(j: Job) {
    if (j.kind !== 'restore' || !JSON.parse(j.payload).externalKey) return;
    const file = join(directory(j.id), 'uploaded-key.pem');
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as any).code !== 'ENOENT') throw error;
    }
  }
  // Uploaded recovery keys are never retained across a restart.
  for (const j of db
    .prepare("SELECT * FROM managed_transfer_jobs WHERE kind='restore'")
    .all() as Job[])
    clearUploadedKey(j);
  function owned(req: FastifyRequest) {
    const owner = (req as any).ownerId;
    if (typeof owner !== 'string' || !db.prepare('SELECT 1 FROM user WHERE id=?').get(owner))
      throw new HttpError(401, '请登录后访问');
    return owner;
  }
  function job(owner: string, id: string) {
    const row = db
      .prepare('SELECT * FROM managed_transfer_jobs WHERE id=? AND owner=?')
      .get(idInput(id), owner) as Job | undefined;
    if (!row) throw new HttpError(404, '任务不存在');
    return row;
  }
  function backup(owner: string, id: string) {
    const row = db
      .prepare('SELECT * FROM managed_transfer_backups WHERE id=? AND owner=?')
      .get(idInput(id), owner) as BackupRow | undefined;
    if (!row) throw new HttpError(404, '备份不存在');
    return row;
  }
  function patch(
    id: string,
    fields: Partial<{
      state: Job['state'];
      cancellable: number;
      cancel_requested: number;
      progress: unknown;
      items: unknown;
      result: unknown;
      error: string | null;
      artifact: string | null;
    }>,
  ) {
    const pairs = Object.entries(fields);
    db.prepare(
      `UPDATE managed_transfer_jobs SET ${pairs.map(([k]) => k + '=?').join(',')},updated_at=? WHERE id=?`,
    ).run(
      ...pairs.map(([k, v]) =>
        ['progress', 'items', 'result'].includes(k) ? JSON.stringify(v) : v,
      ),
      new Date().toISOString(),
      id,
    );
  }
  function existing(owner: string, kind: TransferKind, rid: string, fingerprint: string) {
    const row = db
      .prepare('SELECT * FROM managed_transfer_jobs WHERE owner=? AND kind=? AND request_id=?')
      .get(owner, kind, rid) as Job | undefined;
    if (row && row.fingerprint !== fingerprint)
      throw new HttpError(409, '同一 requestId 已用于不同请求');
    return row;
  }
  function enqueue(
    owner: string,
    kind: TransferKind,
    payload: any,
    rid: string,
    items: TransferItem[] = [],
    fingerprint = digest(JSON.stringify(payload)),
    autoStart = true,
    allocatedId?: string,
  ) {
    requestId(rid);
    const old = existing(owner, kind, rid, fingerprint);
    if (old) return publicTask(old);
    if (closing) throw new HttpError(503, '服务正在停止');
    if (
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM managed_transfer_jobs WHERE state IN ('queued','running')",
          )
          .get() as any
      ).n >= 8
    )
      throw new HttpError(429, '后台任务已满，请稍后重试');
    const id = allocatedId || randomUUID(),
      now = new Date().toISOString();
    db.prepare(
      'INSERT INTO managed_transfer_jobs(id,owner,kind,request_id,fingerprint,state,created_at,updated_at,cancellable,progress,items,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      owner,
      kind,
      rid,
      fingerprint,
      'queued',
      now,
      now,
      1,
      JSON.stringify({ completed: 0, total: items.length || 1, phase: 'queued' }),
      JSON.stringify(items),
      JSON.stringify(payload),
    );
    if (autoStart) schedule();
    return publicTask(job(owner, id));
  }
  function schedule() {
    if (closing || scheduled || current) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closing) return;
      current = drain().finally(() => {
        current = undefined;
        if (
          !closing &&
          db.open &&
          db.prepare("SELECT 1 FROM managed_transfer_jobs WHERE state='queued'").get()
        )
          schedule();
      });
    });
  }
  function interrupted(j: Job) {
    return (
      closing ||
      (db.prepare('SELECT cancel_requested FROM managed_transfer_jobs WHERE id=?').get(j.id) as any)
        .cancel_requested
    );
  }
  async function drain() {
    while (!closing) {
      const j = db
        .prepare(
          "SELECT * FROM managed_transfer_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1",
        )
        .get() as Job | undefined;
      if (!j) return;
      if (interrupted(j)) {
        clearUploadedKey(j);
        patch(j.id, { state: 'cancelled', cancellable: 0 });
        continue;
      }
      patch(j.id, {
        state: 'running',
        progress: { completed: 0, total: JSON.parse(j.items).length || 1, phase: 'preparing' },
      });
      try {
        if (j.kind === 'import') await runImport(j);
        else if (j.kind === 'export') await runExport(j);
        else if (j.kind === 'backup') await runBackup(j);
        else await runRestore(j);
      } catch (error) {
        // Failure is not observable until ephemeral recovery material has been removed.
        clearUploadedKey(j);
        if (db.open) patch(j.id, { state: 'failed', cancellable: 0, error: safeError(error) });
      } finally {
        clearUploadedKey(j);
      }
    }
  }
  async function runImport(j: Job) {
    const b = JSON.parse(j.payload) as ImportRequest,
      runtime = platform.get(),
      items = JSON.parse(j.items) as ImportItem[];
    const mapping = new Map(items.map((i) => [i.path, i.targetPath]));
    const sceneIds=new Map<string,string[]>();
    for(const entry of b.entries.filter(entry=>isWhiteboard(entry.path)&&isImportDocument(entry.path))){
      const id=JSON.parse(entryBytes(entry).toString('utf8')).dooknow?.id;
      if(typeof id==='string'&&whiteboardId(id))sceneIds.set(id,[...(sceneIds.get(id)||[]),entry.path]);
    }
    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item.kind === 'asset' ? 0 : isWhiteboard(a.item.path)?1:2) - (b.item.kind === 'asset' ? 0 : isWhiteboard(b.item.path)?1:2));
    for (const { item, index } of ordered) {
      if (item.state === 'succeeded' || item.state === 'skipped') continue;
      if (interrupted(j)) {
        patch(j.id, { state: 'cancelled', cancellable: 0, items });
        return;
      }
      try {
        workspaceWriteSync(db, { kind: 'transfer.import' }, () => {
          // New ancestor directories are created through the existing note folder mutation.
          const parent = posix.dirname(item.targetPath);
          let cursor = '';
          for (const part of parent === '.' ? [] : parent.split('/')) {
            const next = cursor ? cursor + '/' + part : part;
            if (!existsSync(join(runtime.config.knowledgeRoot, next))) {
              if (part === 'assets')
                mkdirSync(targetPath(runtime.config.knowledgeRoot, next, 'asset'), { mode: 0o700 });
              else runtime.notes.createFolder(cursor, part);
            }
            targetPath(runtime.config.knowledgeRoot, next, part === 'assets' ? 'asset' : 'folder');
            cursor = next;
          }
          const entry = b.entries[index],
            bytes = entryBytes(entry);
          if (item.kind === 'asset') {
            const absolute = targetPath(runtime.config.knowledgeRoot, item.targetPath, 'asset');
            // Persisted target plus content digest makes interrupted retries converge without a second copy.
            let created = false;
            try {
              writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
              created = true;
            } catch (e) {
              if ((e as any).code !== 'EEXIST') throw e;
              const asset = runtime.assets.file(item.targetPath), existing = asset.sourceBytes ?? asset.bytes;
              if (digest(existing) !== digest(bytes))
                throw new HttpError(409, '附件目标已被其他内容占用');
            }
            try {
              runtime.assets.register(item.targetPath);
            } catch (e) {
              if (created) unlinkSync(absolute);
              throw e;
            }
          } else {
            const dependencies = references(bytes.toString('utf8'))
              .map((url) => localReference(item.path, url))
              .filter(
                (p) =>
                  p &&
                  items.some((i) => i.path === p && i.kind === 'asset' && i.state === 'failed'),
              );
            if (dependencies.length) throw new HttpError(409, '引用附件导入失败，请修复后重试');
            let content = isWhiteboard(item.path) ? bytes.toString('utf8') : rewriteImportReferences(
              bytes.toString('utf8'),
              item.path,
              item.targetPath,
              mapping,
            );
            if(!isWhiteboard(item.path))content=rewriteWhiteboardReferences(content,ref=>{
              if(whiteboardId(ref)){
                const sources=sceneIds.get(ref);if(!sources)return;
                if(sources.length!==1)throw new HttpError(409,'引用白板标识重复，请分开导入并核对引用');
                const sourceItem=items.find(other=>other.path===sources[0]);
                if(sourceItem?.state==='failed')throw new HttpError(409,'引用白板导入失败，请修复后重试');
                return sourceItem?.noteId||(db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(sourceItem?.targetPath) as {id:string}|undefined)?.id;
              }
              const source=localReference(item.path,ref),target=(source&&mapping.get(source))||localReference(item.targetPath,ref);
              if(!target)return;
              if(items.some(other=>other.targetPath===target&&other.state==='failed'))throw new HttpError(409,'引用白板导入失败，请修复后重试');
              return (db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(target) as {id:string}|undefined)?.id;
            });
            const result = mutationCore(runtime.config, db).create(
              webPrincipal,
              parent === '.' ? '' : parent,
              posix.basename(item.targetPath),
              content,
              noteRequestId(j.id, index, item),
            );
            item.noteId = result.id;
          }
        });
        item.state = 'succeeded';
        delete item.error;
      } catch (error) {
        item.state = 'failed';
        item.error = safeError(error);
      }
      patch(j.id, {
        items,
        progress: {
          completed: items.filter((i) => i.state !== 'pending').length,
          total: items.length,
          phase: 'importing',
        },
      });
      await new Promise<void>((r) => setImmediate(r));
    }
    const failed = items.some((i) => i.state === 'failed');
    patch(j.id, {
      state: failed ? 'failed' : 'succeeded',
      cancellable: 0,
      error: failed ? '部分文件未导入，可重试失败项目' : null,
      items,
      result: {
        notes: items.filter((i) => i.kind === 'note' && i.state === 'succeeded').length,
        assets: items.filter((i) => i.kind === 'asset' && i.state === 'succeeded').length,
      },
      progress: { completed: items.length, total: items.length, phase: 'complete' },
    });
  }
  async function runExport(j: Job) {
    const runtime = platform.get(),
      folder = (JSON.parse(j.payload) as any).folderPath || '',
      destination = join(directory(j.id), 'library.tar.gz'),
      stage = join(directory(j.id), 'export-stage');
    await mkdir(stage, { mode: 0o700 });
    let noteCount = 0,
      assetCount = 0,
      totalBytes = 0;
    try {
      await workspaceExclusive(db, { kind: 'transfer.export' }, async () => {
        const all = scanFiles(runtime.config.knowledgeRoot).notes,
          selected = all.filter((p) => !folder || p.startsWith(folder + '/'));
        if (selected.length > 5000)
          throw new HttpError(413, '导出最多 5000 篇笔记，请缩小目录范围');
        const assets = new Set<string>(),
          warnings: string[] = [],
          files: string[] = [];
        async function copy(path: string, bytes: Buffer) {
          totalBytes += bytes.length;
          if (totalBytes > 256 * 1024 ** 2 || files.length >= 10000)
            throw new HttpError(413, '导出超过 256 MiB 或 10000 个文件');
          const target = join(stage, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
          files.push(path);
        }
        for (const path of selected) {
          if (interrupted(j)) {
            patch(j.id, { state: 'cancelled', cancellable: 0 });
            return;
          }
          const absolute = safePath(runtime.config.knowledgeRoot, path, 'note'),
            fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.nlink > 1 || info.size > 20 * 1024 ** 2)
              throw new HttpError(413, '笔记无法安全导出');
            bytes = readFileSync(fd);
          } finally {
            closeSync(fd);
          }
          let content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if(!isWhiteboard(path)){
            content=rewriteWhiteboardReferences(content,ref=>{
              const boardPath=whiteboardId(ref)
                ? (db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(ref) as {path:string}|undefined)?.path
                : localReference(path,ref);
              if(!boardPath||!isWhiteboard(boardPath)||!all.includes(boardPath)){
                warnings.push(`${path}: 引用白板不可用 ${ref}`);return;
              }
              if(!selected.includes(boardPath)){
                if(selected.length>=5000)throw new HttpError(413,'导出最多 5000 个文档');
                selected.push(boardPath);
              }
              return posix.relative(posix.dirname(path),boardPath);
            });
            bytes=Buffer.from(content,'utf8');
          }
          for (const url of isWhiteboard(path) ? [] : references(content)) {
            const p = localReference(path, url);
            if (!p) continue;
            if (isImportDocument(p)) {
              if (!selected.includes(p)) warnings.push(`${path}: 引用笔记不在导出范围 ${p}`);
            } else assets.add(p);
          }
          await copy(path, bytes);
          noteCount++;
          patch(j.id, {
            progress: { completed: noteCount, total: selected.length, phase: 'copying-notes' },
          });
          await new Promise<void>((r) => setImmediate(r));
        }
        for (const path of assets) {
          if (interrupted(j)) {
            patch(j.id, { state: 'cancelled', cancellable: 0 });
            return;
          }
          try {
            const asset = runtime.assets.file(path);
            await copy(path, asset.sourceBytes ?? asset.bytes);
            assetCount++;
          } catch (error) {
            if (error instanceof HttpError && error.statusCode === 413) throw error;
            warnings.push(`引用附件不可用或类型不受支持 ${path}`);
          }
        }
        if (interrupted(j)) {
          patch(j.id, { state: 'cancelled', cancellable: 0 });
          return;
        }
        patch(j.id, {
          cancellable: 0,
          progress: { completed: noteCount, total: noteCount, phase: 'packing' },
        });
        const manifest = {
          version: 1,
          scope: folder || 'all-library',
          notes: noteCount,
          assets: assetCount,
          files: [...files],
          warnings: [...new Set(warnings)].slice(0, 200),
          includes: '选定目录内 Markdown、Excalidraw 白板和可用的受支持引用附件；不含数据库、凭据、插件或历史版本',
        };
        await writeFile(join(stage, 'dooknow-export.json'), JSON.stringify(manifest, null, 2), {
          mode: 0o600,
        });
        await createTar(
          { cwd: stage, file: destination, gzip: true, portable: true, noMtime: true },
          [...files, 'dooknow-export.json'],
        );
        await validateArchive(destination, { maxBytes: 257 * 1024 ** 2, maxEntries: 20000 });
        patch(j.id, {
          state: 'succeeded',
          artifact: 'library.tar.gz',
          result: {
            notes: noteCount,
            assets: assetCount,
            bytes: (await lstat(destination)).size,
            scope: manifest.scope,
            warnings: manifest.warnings,
          },
          progress: { completed: noteCount, total: noteCount, phase: 'complete' },
        });
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  async function runBackup(j: Job) {
    if (interrupted(j)) {
      patch(j.id, { state: 'cancelled', cancellable: 0 });
      return;
    }
    patch(j.id, {
      cancellable: 0,
      progress: { completed: 0, total: 1, phase: 'encrypted-snapshot' },
    });
    safeDirectory(keysRoot);
    const destination = join(directory(j.id), 'snapshot.dkb');
    const result = await createPlatformBackup(config, { destination, keyFile });
    const bytes = (await lstat(destination)).size;
    const backupId = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO managed_transfer_backups VALUES(?,?,?,?,?,?,?,?)').run(
        backupId,
        j.owner,
        j.id,
        new Date().toISOString(),
        bytes,
        result.knowledgeIncluded ? 1 : 0,
        result.keyFingerprint,
        0,
      );
      patch(j.id, {
        state: 'succeeded',
        artifact: 'snapshot.dkb',
        result: { backupId, bytes },
        progress: { completed: 1, total: 1, phase: 'complete' },
      });
    })();
  }
  async function runRestore(j: Job) {
    try {
      await runRestoreCopy(j);
    } finally {
      clearUploadedKey(j);
    }
  }
  async function runRestoreCopy(j: Job) {
    const payload = JSON.parse(j.payload),
      record = backup(j.owner, payload.backupId),
      source = join(directory(record.task_id), 'snapshot.dkb');
    if (interrupted(j)) {
      clearUploadedKey(j);
      patch(j.id, { state: 'cancelled', cancellable: 0 });
      return;
    }
    patch(j.id, {
      cancellable: 0,
      progress: { completed: 0, total: 1, phase: 'decrypting-and-verifying' },
    });
    const key = payload.externalKey ? join(directory(j.id), 'uploaded-key.pem') : keyFile;
    const base = join(directory(j.id), 'restored');
    // Every attempt receives fresh paths; a failed attempt is retained for inspection.
    const attempt = join(base, randomUUID());
    try {
      await mkdir(attempt, { recursive: true, mode: 0o700 });
      const result = await restorePlatformBackup({
        source,
        keyFile: key,
        target: {
          dataRoot: join(attempt, 'data'),
          knowledgeRoot: join(attempt, 'knowledge'),
          profileFile: join(attempt, 'config/profile.json'),
          pluginRoot: join(attempt, 'plugins'),
        },
        maxBytes: 2 * 1024 ** 3,
        maxEntries: 100000,
      });
      const restored = openDatabase(result.dataRoot);
      let notes = 0,
        assets = 0;
      try {
        if (
          restored.pragma('integrity_check', { simple: true }) !== 'ok' ||
          (restored.pragma('foreign_key_check') as any[]).length
        )
          throw new HttpError(409, '恢复副本数据库校验失败');
        notes = (restored.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get() as any).n;
        assets = (restored.prepare('SELECT count(*) AS n FROM assets').get() as any).n;
        if ((restored.prepare('SELECT count(*) AS n FROM session').get() as any).n)
          throw new HttpError(409, '恢复副本会话撤销校验失败');
      } finally {
        restored.close();
      }
      const verification: RestoreVerification = {
        ...result,
        pluginsDisabled: true,
        sessionsRevoked: true,
        sharesRevoked: true,
        searchNeedsPreparation: true,
        verified: true,
        notes,
        assets,
        activationRequired: true,
        guidance:
          '恢复副本已完成完整性校验。当前服务未切换；请按 CLI 恢复文档审查新 profile，准备搜索运行时，并由部署管理员将独立服务绑定到新配置后验证。',
      };
      // Completion is visible only after the uploaded private key is gone.
      if (payload.externalKey) await rm(key, { force: true });
      patch(j.id, {
        state: 'succeeded',
        result: { verification },
        progress: { completed: 1, total: 1, phase: 'verified-isolated-copy' },
      });
    } finally {
      if (payload.externalKey) await rm(key, { force: true });
    }
  }
  async function download(j: Job, reply: FastifyReply, backupOnly = false) {
    if (j.state !== 'succeeded' || !j.artifact) throw new HttpError(409, '文件尚未准备好');
    const expected =
      j.kind === 'backup' ? 'snapshot.dkb' : j.kind === 'export' ? 'library.tar.gz' : undefined;
    if (j.artifact !== expected || (backupOnly && j.kind !== 'backup'))
      throw new HttpError(404, '文件不存在');
    const file = join(directory(j.id), expected!),
      fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.nlink > 1) throw new HttpError(404, '文件不存在');
      reply
        .header(
          'Content-Disposition',
          `attachment; filename="dooknow-${j.id}.${j.kind === 'backup' ? 'dkb' : 'tar.gz'}"`,
        )
        .header('Content-Length', info.size)
        .header('Cache-Control', 'no-store')
        .type(j.kind === 'backup' ? 'application/octet-stream' : 'application/gzip');
      return reply.send(fd.createReadStream());
    } catch (e) {
      await fd.close();
      throw e;
    }
  }
  function pagination(req: FastifyRequest) {
    const query = req.query as any;
    const limit = query?.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, '分页数量不正确');
    const cursor = query?.cursor;
    if (cursor !== undefined) idInput(cursor);
    return { limit, cursor };
  }
  app.get('/api/manage/tasks', async (req) => {
    const owner = owned(req),
      { limit, cursor } = pagination(req);
    if (cursor) job(owner, cursor);
    const rows = db
      .prepare(
        `SELECT * FROM managed_transfer_jobs WHERE owner=? ${cursor ? 'AND rowid<(SELECT rowid FROM managed_transfer_jobs WHERE id=?)' : ''} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(cursor ? [owner, cursor, limit + 1] : [owner, limit + 1])) as Job[];
    return {
      items: rows.slice(0, limit).map(publicTask),
      ...(rows.length > limit ? { nextCursor: rows[limit - 1].id } : {}),
    };
  });
  app.get<{ Params: { id: string } }>('/api/manage/tasks/:id', async (req) =>
    publicTask(job(owned(req), req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/manage/tasks/:id/cancel', async (req) => {
    const j = job(owned(req), req.params.id);
    if (terminal.has(j.state)) return publicTask(j);
    if (!j.cancellable) throw new HttpError(409, '此阶段正在执行一致性操作，不能取消');
    patch(j.id, {
      cancel_requested: 1,
      ...(j.state === 'queued' ? { state: 'cancelled' as const, cancellable: 0 } : {}),
    });
    if (j.state === 'queued') clearUploadedKey(j);
    return publicTask(job(j.owner, j.id));
  });
  app.post<{ Params: { id: string } }>('/api/manage/tasks/:id/retry', async (req, reply) => {
    const j = job(owned(req), req.params.id);
    if (!['failed', 'interrupted', 'cancelled'].includes(j.state))
      throw new HttpError(409, '仅可重试失败或中断的任务');
    if (j.kind === 'restore' && JSON.parse(j.payload).externalKey)
      throw new HttpError(409, '外部恢复密钥已清除，请重新上传备份和密钥');
    if (j.kind !== 'import' && j.kind !== 'restore') {
      // A new artifact path avoids any partial file left by interrupted packing or encryption.
      const payload = JSON.parse(j.payload);
      return reply
        .code(202)
        .send(
          enqueue(
            j.owner,
            j.kind,
            payload,
            requestId((req.body as any)?.requestId || randomUUID()),
          ),
        );
    }
    const items = JSON.parse(j.items) as ImportItem[];
    for (const [index, item] of items.entries())
      if (item.state === 'failed') {
        const op = db
          .prepare(
            "SELECT status FROM operations WHERE principal=? AND client_id=? AND kind='create' AND request_id=?",
          )
          .get(webPrincipal.id, webPrincipal.clientId, noteRequestId(j.id, index, item)) as
          | { status: string }
          | undefined;
        // Failed operations cannot be replayed by core. Keep unknown/succeeded IDs stable,
        // and allocate a new attempt only after a known deterministic failure.
        if (op && ['failed', 'cancelled'].includes(op.status))
          item.attempt = (item.attempt || 0) + 1;
        item.state = 'pending';
        delete item.error;
      }
    patch(j.id, { state: 'queued', cancel_requested: 0, cancellable: 1, error: null, items });
    schedule();
    return reply.code(202).send(publicTask(job(j.owner, j.id)));
  });
  app.get<{ Params: { id: string } }>('/api/manage/tasks/:id/download', async (req, reply) =>
    download(job(owned(req), req.params.id), reply),
  );
  app.post('/api/manage/import/preview', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    owned(req);
    const runtime = platform.get();
    return importPreview(runtime.config.knowledgeRoot, parseImport(req.body));
  });
  app.post('/api/manage/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const owner = owned(req),
      runtime = platform.get(),
      b = parseImport(req.body),
      rid = requestId(b.requestId),
      fingerprint = digest(JSON.stringify(b));
    const old = existing(owner, 'import', rid, fingerprint);
    if (old) return reply.code(202).send(publicTask(old));
    const preview = importPreview(runtime.config.knowledgeRoot, b),
      items: TransferItem[] = preview.items.map((i) => ({
        path: i.path,
        targetPath: i.targetPath,
        kind: i.kind,
        state: i.decision === 'skip' ? 'skipped' : 'pending',
      }));
    return reply.code(202).send(enqueue(owner, 'import', b, rid, items, fingerprint));
  });
  app.post('/api/manage/export', async (req, reply) => {
    const owner = owned(req),
      runtime = platform.get(),
      b = req.body as any;
    let folderPath = b?.folderPath;
    if (folderPath !== undefined && folderPath !== '') {
      relativeInput(folderPath);
      safePath(runtime.config.knowledgeRoot, folderPath, 'folder');
    }
    folderPath ||= undefined;
    return reply.code(202).send(enqueue(owner, 'export', { folderPath }, requestId(b?.requestId)));
  });
  app.get('/api/manage/backups', async (req) => {
    const owner = owned(req),
      { limit, cursor } = pagination(req);
    if (cursor) backup(owner, cursor);
    const rows = db
      .prepare(
        `SELECT * FROM managed_transfer_backups WHERE owner=? ${cursor ? 'AND rowid<(SELECT rowid FROM managed_transfer_backups WHERE id=?)' : ''} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(cursor ? [owner, cursor, limit + 1] : [owner, limit + 1])) as BackupRow[];
    return {
      items: rows.slice(0, limit).map(publicBackup),
      ...(rows.length > limit ? { nextCursor: rows[limit - 1].id } : {}),
    };
  });
  app.post('/api/manage/backups', async (req, reply) =>
    reply
      .code(202)
      .send(enqueue(owned(req), 'backup', {}, requestId((req.body as any)?.requestId))),
  );
  app.get<{ Params: { id: string } }>('/api/manage/backups/:id/download', async (req, reply) => {
    const owner = owned(req),
      b = backup(owner, req.params.id);
    return download(job(owner, b.task_id), reply, true);
  });
  app.post('/api/manage/backups/key', async (req, reply) => {
    const owner = owned(req),
      password = (req.body as any)?.currentPassword;
    const account = db
      .prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'")
      .get(owner) as { password: string } | undefined;
    // Persisted per-owner throttle also survives service restarts.
    db.exec(
      'CREATE TABLE IF NOT EXISTS managed_key_attempts(owner TEXT PRIMARY KEY,window_at INTEGER NOT NULL,attempts INTEGER NOT NULL)',
    );
    const now = Date.now(),
      attempt = db.prepare('SELECT * FROM managed_key_attempts WHERE owner=?').get(owner) as any;
    if (attempt && now - attempt.window_at < 60000 && attempt.attempts >= 5)
      throw new HttpError(429, '请稍后再验证密码');
    db.prepare(
      'INSERT INTO managed_key_attempts VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET window_at=?,attempts=?',
    ).run(
      owner,
      now,
      attempt && now - attempt.window_at < 60000 ? attempt.window_at : now,
      attempt && now - attempt.window_at < 60000 ? attempt.attempts + 1 : 1,
    );
    if (
      typeof password !== 'string' ||
      password.length > 1024 ||
      !account?.password ||
      !(await verifyPassword({ hash: account.password, password }))
    )
      throw new HttpError(403, '当前密码不正确');
    storage();
    safeDirectory(keysRoot);
    if (!existsSync(keyFile)) throw new HttpError(409, '请先创建加密备份以生成恢复密钥');
    const fd = await open(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      if (!st.isFile() || st.nlink > 1 || st.mode & 0o077 || st.size > 16384)
        throw new HttpError(409, '恢复密钥不可用');
      const bytes = await fd.readFile();
      return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', 'attachment; filename="dooknow-recovery-key.pem"')
        .type('application/octet-stream')
        .send(bytes);
    } finally {
      await fd.close();
    }
  });
  app.post('/api/manage/restores', async (req, reply) => {
    const owner = owned(req),
      b = req.body as any,
      record = backup(owner, b?.backupId);
    if (record.external) throw new HttpError(409, '外部备份需要重新上传对应恢复密钥');
    return reply
      .code(202)
      .send(enqueue(owner, 'restore', { backupId: record.id }, requestId(b?.requestId)));
  });
  app.post(
    '/api/manage/restores/upload',
    { bodyLimit: uploadLimit + 1024 ** 2 },
    async (req, reply) => {
      const owner = owned(req);
      storage();
      const uploadId = randomUUID(),
        stage = directory(uploadId),
        allocatedTaskId = randomUUID();
      let rid: string | undefined,
        hasBackup = false,
        hasKey = false;
      try {
        for await (const part of req.parts({
          limits: { fileSize: uploadLimit, files: 2, fields: 1, parts: 3, fieldSize: 256 },
        })) {
          if (part.type === 'field') {
            if (part.fieldname !== 'requestId' || rid) throw new HttpError(400, '上传字段不正确');
            rid = requestId(part.value);
            continue;
          }
          if (part.fieldname === 'backup' && !hasBackup) {
            hasBackup = true;
            const out = await open(join(stage, 'snapshot.dkb'), 'wx', 0o600);
            try {
              await pipeline(part.file, out.createWriteStream());
              if (part.file.truncated) throw new HttpError(413, '备份文件超过 128 MiB');
            } finally {
              await out.close().catch(() => {});
            }
          } else if (part.fieldname === 'key' && !hasKey) {
            hasKey = true;
            let bytes = Buffer.alloc(0);
            for await (const block of part.file) {
              bytes = Buffer.concat([bytes, block]);
              if (bytes.length > 16384) throw new HttpError(413, '密钥文件过大');
            }
            const key = createPrivateKey(bytes);
            if (key.asymmetricKeyType !== 'x25519') throw new HttpError(400, '密钥类型不正确');
            await writeFile(join(stage, 'uploaded-key.pem'), bytes, { flag: 'wx', mode: 0o600 });
          } else throw new HttpError(400, '仅允许备份和恢复密钥两个文件');
        }
        if (!rid || !hasBackup || !hasKey)
          throw new HttpError(400, '需要 requestId、加密备份和恢复密钥');
        const source = join(stage, 'snapshot.dkb'),
          fd = await open(source, 'r');
        let bytes: number;
        try {
          const header = Buffer.alloc(10);
          await fd.read(header, 0, 10, 0);
          if (header.toString() !== 'DOOKNOWBK1')
            throw new HttpError(400, '仅支持 DooKnow 加密备份');
          bytes = (await fd.stat()).size;
        } finally {
          await fd.close();
        }
        const hash = createHash('sha256');
        for await (const block of createReadStream(source)) hash.update(block);
        const recoveryBytes = await readFile(join(stage, 'uploaded-key.pem'));
        const keyFingerprint = digest(
          createPublicKey(createPrivateKey(recoveryBytes)).export({
            format: 'der',
            type: 'spki',
          }) as Buffer,
        );
        hash.update(keyFingerprint);
        const fingerprint = hash.digest('hex'),
          old = existing(owner, 'restore', rid, fingerprint);
        if (old) {
          await rm(stage, { recursive: true, force: true });
          return reply.code(202).send(publicTask(old));
        }
        const taskDir = directory(allocatedTaskId);
        await writeFile(join(taskDir, 'uploaded-key.pem'), recoveryBytes, {
          flag: 'wx',
          mode: 0o600,
        });
        await rm(join(stage, 'uploaded-key.pem'), { force: true });
        // Commit all queued dependencies together before the worker can observe this job.
        const task = db.transaction(() => {
          const created = enqueue(
            owner,
            'restore',
            { backupId: uploadId, externalKey: true },
            requestId(rid),
            [],
            fingerprint,
            false,
            allocatedTaskId,
          );
          if (created.id !== allocatedTaskId) return created;
          // Keep imported encrypted backup as an owner-managed record; the key is ephemeral.
          db.prepare('INSERT INTO managed_transfer_backups VALUES(?,?,?,?,?,?,?,?)').run(
            uploadId,
            owner,
            uploadId,
            new Date().toISOString(),
            bytes,
            0,
            keyFingerprint,
            1,
          );
          // External artifact task supplies a controlled download record without exposing its key.
          db.prepare(
            'INSERT INTO managed_transfer_jobs(id,owner,kind,request_id,fingerprint,state,created_at,updated_at,cancellable,progress,items,payload,artifact) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            uploadId,
            owner,
            'backup',
            'external-' + uploadId,
            fingerprint,
            'succeeded',
            new Date().toISOString(),
            new Date().toISOString(),
            0,
            JSON.stringify({ completed: 1, total: 1, phase: 'uploaded' }),
            '[]',
            '{}',
            'snapshot.dkb',
          );
          return created;
        })();
        if (task.id !== allocatedTaskId) {
          await rm(stage, { recursive: true, force: true });
          await rm(taskDir, { recursive: true, force: true });
        }
        schedule();
        return reply.code(202).send(task);
      } catch (e) {
        await rm(stage, { recursive: true, force: true });
        await rm(join(storageRoot, 'jobs', allocatedTaskId), { recursive: true, force: true });
        throw e;
      }
    },
  );
  app.addHook('preClose', async () => {
    closing = true;
    if (current) await current;
    if (db.open) {
      db.prepare(
        "UPDATE managed_transfer_jobs SET state='interrupted',cancellable=0,error='服务停止中断了任务',updated_at=? WHERE state IN ('queued','running')",
      ).run(new Date().toISOString());
      for (const j of db
        .prepare("SELECT * FROM managed_transfer_jobs WHERE kind='restore'")
        .all() as Job[])
        clearUploadedKey(j);
    }
  });
}
