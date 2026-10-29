import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { requireScope } from './agent/auth.js';
import { authorizeFolderPath } from './knowledge/lifecycle-access.js';
import { safePath, validName, validateRelative } from './files.js';
import { assertRoot } from './indexing/reconcile.js';
import { assertWritable, fsyncDirectory, webPrincipal } from './knowledge/core.js';
import { fail } from './knowledge/errors.js';
import { portableLibrary } from './portable-library.js';
import { beginOperation, completeOperation, existingResult } from './knowledge/operations.js';
import {
  operationHasLiveWorkspaceWriter,
  workspaceOperation,
  workspacePermit,
} from './workspace/gate.js';

type FolderNote = { id: string; path: string };
type FolderRow = {
  id: string;
  path: string;
  state: string;
  notes_json: string;
  identity: string;
  operation_id: string;
  restore_path: string | null;
  deleted_at: number;
};
const identity = (path: string) => {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail(400, 'INVALID_PATH', '文件夹无法安全访问');
  return `${info.dev}:${info.ino}`;
};
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
function allowed(path: string) {
  validateRelative(path, 'folder');
  if (path === '90-Archive' || path === '99-System' || path.startsWith('99-System/'))
    fail(400, 'PROTECTED_FOLDER', '归档和系统目录需要保留，不能移入回收站');
}
function trashPath(config: AppConfig, id: string, create = false) {
  if (!/^folder-[a-f0-9-]{36}$/.test(id)) fail(400, 'INVALID_PATH');
  const archive = join(config.knowledgeRoot, '90-Archive');
  if (create && !exists(archive)) mkdirSync(archive, { mode: 0o700 });
  safePath(config.knowledgeRoot, '90-Archive', 'folder');
  let current = archive;
  for (const part of ['.trash', id]) {
    current = join(current, part);
    if (create && !exists(current)) mkdirSync(current, { mode: 0o700 });
    identity(current);
  }
  return join(current, 'tree');
}
// Inspect ordinary entries without following links. The directory is moved intact,
// so empty directories, attachments and files omitted by the note tree survive.
function inspect(path: string) {
  let entries = 0,
    size = 0;
  function walk(current: string, depth: number) {
    if (++entries > 50000 || depth > 64)
      fail(413, 'FOLDER_TOO_LARGE', '文件夹项目过多，请分批整理');
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      fail(400, 'INVALID_PATH', '文件夹包含链接或特殊文件，请先处理这些项目');
    if (info.isDirectory())
      for (const name of readdirSync(current)) walk(join(current, name), depth + 1);
    else size += info.size;
  }
  walk(path, 0);
  return size;
}

// Only the verified backup restore boundary may adopt copied directory identities.
// Runtime recovery and restore must continue comparing the recorded identity.
export function rebindRestoredFolders(config: AppConfig, db: AppDatabase) {
  const rows = db
    .prepare("SELECT * FROM folder_trash WHERE state IN ('trashed','archiving','restoring')")
    .all() as FolderRow[];
  for (const row of rows) {
    if (!/^\d+:\d+$/.test(row.identity)) fail(409, 'RECOVERY_REQUIRED');
    allowed(row.path);
    const trash = trashPath(config, row.id);
    let candidate = trash;
    if (row.state !== 'trashed') {
      const path = row.state === 'restoring' ? row.restore_path : row.path;
      if (!path) fail(409, 'RECOVERY_REQUIRED');
      allowed(path);
      const live = safePath(config.knowledgeRoot, path, 'folder', true);
      // An interrupted rename can be resolved only if exactly one side survives.
      // With both sides present the old inode cannot identify the original copy.
      const present = [trash, live].filter(exists);
      if (present.length !== 1) fail(409, 'RECOVERY_REQUIRED');
      candidate = present[0];
    }
    const stamp = identity(candidate);
    inspect(candidate);
    if (identity(candidate) !== stamp) fail(409, 'TRASH_CHANGED');
    db.prepare('UPDATE folder_trash SET identity=? WHERE id=?').run(stamp, row.id);
  }
}

function finish(config: AppConfig, db: AppDatabase, row: FolderRow) {
  const library = portableLibrary(config, db);
  const restoring = row.state === 'restoring';
  const destination = restoring
    ? safePath(config.knowledgeRoot, row.restore_path!, 'folder')
    : trashPath(config, row.id);
  if (identity(destination) !== row.identity)
    fail(409, 'RECOVERY_REQUIRED', '文件夹发生变化，请核对后重试');
  db.transaction(() => {
    for (const note of JSON.parse(row.notes_json) as FolderNote[]) {
      library.remember(note.id);
      if (restoring) {
        const path = row.restore_path! + note.path.slice(row.path.length);
        db.prepare('UPDATE notes SET path=?,active=1,trash_path=NULL WHERE id=?').run(
          path,
          note.id,
        );
        // Mark the restored source for the existing reconciliation/indexing pipeline.
        db.prepare('UPDATE document_state SET content_hash=NULL WHERE note_id=?').run(note.id);
      } else {
        db.prepare('UPDATE notes SET active=0,trash_path=NULL WHERE id=?').run(note.id);
        db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(note.id);
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(note.id);
        db.prepare(
          "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND status<>'done'",
        ).run(note.id);
      }
      db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(note.id);
    }
    db.prepare('UPDATE folder_trash SET state=? WHERE id=?').run(
      restoring ? 'restored' : 'trashed',
      row.id,
    );
    completeOperation(db, row.operation_id, {
      id: row.id,
      relativePath: restoring ? row.restore_path : row.path,
      deleted: !restoring,
    });
  }).immediate();
}

// A journal survives a process stopping between the directory rename and its
// metadata update. Reconcile it before a note scan can assign new note IDs.
export function recoverFolders(config: AppConfig, db: AppDatabase) {
  for (const op of db
    .prepare(
      "SELECT id FROM operations WHERE kind IN ('folder.archive','folder.restore') AND status='prepared' AND NOT EXISTS(SELECT 1 FROM folder_trash WHERE operation_id=operations.id AND state IN ('archiving','restoring'))",
    )
    .all() as { id: string }[]) {
    if (!operationHasLiveWorkspaceWriter(db, op.id))
      db.prepare("UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=?").run(
        JSON.stringify({
          code: 'OPERATION_UNAPPLIED',
          status: 409,
          message: '上次操作尚未执行，请重新确认后再试',
        }),
        Date.now(),
        op.id,
      );
  }
  const pending = db
    .prepare("SELECT * FROM folder_trash WHERE state IN ('archiving','restoring')")
    .all() as FolderRow[];
  for (const row of pending) {
    if (operationHasLiveWorkspaceWriter(db, row.operation_id))
      fail(503, 'WORKSPACE_BUSY', '文件夹正在处理中，请稍后重试', true);
    const trash = trashPath(config, row.id);
    const restoring = row.state === 'restoring';
    const destination = restoring ? join(config.knowledgeRoot, row.restore_path!) : trash;
    const source = restoring ? trash : join(config.knowledgeRoot, row.path);
    if (exists(destination) && identity(destination) === row.identity) finish(config, db, row);
    else if (exists(source) && identity(source) === row.identity && !exists(destination)) {
      db.transaction(() => {
        if (restoring) db.prepare("UPDATE folder_trash SET state='trashed' WHERE id=?").run(row.id);
        else db.prepare('DELETE FROM folder_trash WHERE id=?').run(row.id);
        db.prepare(
          "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED',updated_at=? WHERE id=?",
        ).run(Date.now(), row.operation_id);
      }).immediate();
    } else fail(409, 'RECOVERY_REQUIRED', '文件夹操作需要核对，原文件已保留');
  }
}

export function archiveFolder(
  config: AppConfig,
  db: AppDatabase,
  path: string,
  requestId: string,
  scan: () => unknown,
  principal: Principal = webPrincipal,
  revalidate?: () => Principal,
) {
  workspacePermit(db);
  assertRoot(config, db);
  assertWritable(db);
  allowed(path);
  const authorize = () => { const p=revalidate?.()||principal; authorizeFolderPath(p,path,'knowledge:write'); if(p.id!=='web-owner') { requireScope(p,'knowledge:archive');requireScope(p,'knowledge:organize'); } return p; };
  authorize();
  recoverFolders(config, db);
  const started = beginOperation(db, principal, 'folder.archive', requestId, { path });
  if (!started.fresh) return existingResult(started.operation);
  workspaceOperation(db, started.operation.id);
  let journaled = false;
  try {
    scan();
    const source = safePath(config.knowledgeRoot, path, 'folder');
    const stamp = identity(source);
    inspect(source);
    const notes = (
      db.prepare('SELECT id,path FROM notes WHERE active=1').all() as FolderNote[]
    ).filter((n) => n.path.startsWith(path + '/'));
    for (const note of notes) assertWritable(db, note.id);
    const id = 'folder-' + randomUUID(),
      destination = trashPath(config, id, true);
    const row: FolderRow = {
      id,
      path,
      state: 'archiving',
      notes_json: JSON.stringify(notes),
      identity: stamp,
      operation_id: started.operation.id,
      restore_path: null,
      deleted_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO folder_trash(id,path,state,notes_json,identity,operation_id,restore_path,deleted_at) VALUES(@id,@path,@state,@notes_json,@identity,@operation_id,@restore_path,@deleted_at)',
    ).run(row);
    journaled = true;
    if (identity(source) !== stamp) fail(409, 'TRASH_CHANGED');
    authorize();
    renameSync(source, destination);
    fsyncDirectory(dirname(source));
    fsyncDirectory(dirname(destination));
    finish(config, db, row);
    return { id, relativePath: path, deleted: true };
  } catch (e) {
    if (journaled)
      fail(503, 'OPERATION_OUTCOME_UNKNOWN', '文件夹操作结果待核对，请按原请求重试', true);
    if (!journaled)
      db.prepare("UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=?").run(
        JSON.stringify({
          code: (e as { code?: string }).code || 'INVALID_PATH',
          status: (e as { statusCode?: number }).statusCode || 400,
          message: (e as Error).message,
        }),
        Date.now(),
        started.operation.id,
      );
    throw e;
  }
}

export function restoreFolder(
  config: AppConfig,
  db: AppDatabase,
  id: string,
  name: string | undefined,
  requestId: string,
  principal: Principal = webPrincipal,
  revalidate?: () => Principal,
) {
  workspacePermit(db);
  assertRoot(config, db);
  assertWritable(db);
  recoverFolders(config, db);
  const started = beginOperation(db, principal, 'folder.restore', requestId, {
    id,
    name: name ?? null,
  });
  if (!started.fresh) return existingResult(started.operation);
  workspaceOperation(db, started.operation.id);
  let journaled = false;
  try {
    const row = db.prepare("SELECT * FROM folder_trash WHERE id=? AND state='trashed'").get(id) as
      | FolderRow
      | undefined;
    if (!row) fail(404, 'NOT_FOUND');
    const leaf = name ?? basename(row.path);
    if (!validName(leaf) || leaf === 'assets') fail(400, 'INVALID_INPUT', '文件夹名称无效');
    const path = dirname(row.path) === '.' ? leaf : dirname(row.path) + '/' + leaf;
    allowed(path);
    const authorize=()=> { const p=revalidate?.()||principal;authorizeFolderPath(p,row.path,'knowledge:write');authorizeFolderPath(p,path,'knowledge:write');if(p.id!=='web-owner'){requireScope(p,'knowledge:archive');requireScope(p,'knowledge:organize');} };
    authorize();
    // Recreate missing ancestors, validating each segment before creating it.
    let parent = '';
    for (const part of path.split('/').slice(0, -1)) {
      parent = parent ? parent + '/' + part : part;
      const dir = safePath(config.knowledgeRoot, parent, 'folder', true);
      if (!exists(dir)) mkdirSync(dir, { mode: 0o700 });
      identity(dir);
    }
    const destination = safePath(config.knowledgeRoot, path, 'folder', true);
    if (exists(destination)) fail(409, 'NAME_CONFLICT', '原位置已有同名项目，请更换文件夹名');
    const source = trashPath(config, id);
    if (identity(source) !== row.identity) fail(409, 'TRASH_CHANGED');
    inspect(source);
    for (const note of JSON.parse(row.notes_json) as FolderNote[]) {
      const notePath = path + note.path.slice(row.path.length);
      if (
        db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1 AND id<>?').get(notePath, note.id)
      )
        fail(409, 'NAME_CONFLICT', '目标位置已有其他笔记，请更换文件夹名');
    }
    row.state = 'restoring';
    row.restore_path = path;
    row.operation_id = started.operation.id;
    db.prepare(
      "UPDATE folder_trash SET state='restoring',restore_path=?,operation_id=? WHERE id=?",
    ).run(path, started.operation.id, id);
    journaled = true;
    authorize();
    renameSync(source, destination);
    fsyncDirectory(dirname(source));
    fsyncDirectory(dirname(destination));
    finish(config, db, row);
    return { id, relativePath: path, deleted: false };
  } catch (e) {
    if (journaled)
      fail(503, 'OPERATION_OUTCOME_UNKNOWN', '文件夹操作结果待核对，请按原请求重试', true);
    if (!journaled)
      db.prepare("UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=?").run(
        JSON.stringify({
          code: (e as { code?: string }).code || 'TRASH_UNAVAILABLE',
          status: (e as { statusCode?: number }).statusCode || 400,
          message: (e as Error).message,
        }),
        Date.now(),
        started.operation.id,
      );
    throw e;
  }
}

export function folderTrashSize(config: AppConfig, row: { id: string; identity: string }) {
  const source = trashPath(config, row.id);
  if (identity(source) !== row.identity) fail(409, 'TRASH_CHANGED');
  return inspect(source);
}
