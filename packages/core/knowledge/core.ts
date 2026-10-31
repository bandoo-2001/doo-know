import { migrationAliasState } from './migration-alias-state.js';
import { finishWhiteboardMigration, finishWhiteboardRollback, type MigrationRow } from './diagram-migration-journal.js';
import { recordRevisionContext } from './revision-context.js';
import {
  captureNoteArchiveContext, prepareNoteTrashRestore, noteTrashRestorePlan,
  commitNoteRestore, assertNoteRestoreCommitted, publishNoteTrashRestoreAssets, verifyNoteTrashRestore,
} from './note-trash-native-restore.js';
import {parseDiagramDocument} from '../../../shared/diagram-document.js';
import { assertDiagramPublication } from './diagram-publication-policy.js';
import { recordDiagramPublication,verifyPendingDiagramPublication } from './diagram-publications.js';
import { assertDiagramRestorePublication } from './diagram-file-publication.js';
import { diagramCreationService } from './diagram-creation.js';
import {isWhiteboard,isDocument,parseWhiteboard,MAX_WHITEBOARD_BYTES,documentTitle,documentType,whiteboardText,withWhiteboardId} from '../../../shared/whiteboard.js';
import {
  workspaceWrite,
  workspaceWriteSync,
  operationHasLiveWorkspaceWriter,
  workspaceBegin,
  workspaceArtifact,
} from '../workspace/gate.js';
import { assertWritable, acquireNoteWrite, releaseNoteWrite } from './write-lease.js';
export { assertWritable } from './write-lease.js';
import { randomUUID, createHash } from 'node:crypto';
import { lifecyclePrincipal } from './lifecycle-access.js';
import {
  readFileSync,
  copyFileSync,
  constants,
  chmodSync,
  readSync,
  fstatSync,
  writeFileSync,
  renameSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal, RecoveryReport } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath, validName, readDocument } from '../files.js';
import { assertSharePrincipal, isSharePrincipal } from '../share-policy.js';
import { assertShareResources } from '../share-resources.js';
import { authorizePath, requireScope } from '../agent/auth.js';
import { fail, KnowledgeError } from './errors.js';
import type { OperationRow } from './operations.js';
import {
  beginOperation,
  existingResult,
  completeOperation,
  sha256,
  releaseSnapshotRef,
} from './operations.js';
import { observeSource } from '../indexing/state.js';
import { hashFile, fileVersionStamp } from './file-reader.js';
import { limits } from './limits.js';
import { assertRoot } from '../indexing/reconcile.js';
import { moveService } from './move.js';
import { observeCollectionSource } from '../collections/source.js';
import { portableLibrary } from '../portable-library.js';
const documentTypeMismatch = (a:string,b:string) => isWhiteboard(a)!==isWhiteboard(b);
export const webPrincipal: Principal = {
  id: 'web-owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
  knowledgeAll: true,
  allowedPrefixes: [
    'README.md',
    '00-Inbox',
    '10-Projects',
    '20-Areas',
    '30-Knowledge',
    '40-Resources',
    '50-Journal',
    '90-Archive',
    '99-System',
  ],
};
type Intent = {
  id: string;
  note_id: string;
  path: string;
  kind: string;
  original_hash: string | null;
  original_mtime: string | null;
  target_hash: string | null;
  temp_path: string | null;
  revision_id: string | null;
  history_file: string | null;
  status: string;
};
function durableFile(file: string, content: string, mode = 0o600) {
  const fd = openSync(file, 'wx', mode);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function restoreHash(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail(409, 'RESTORE_CONFLICT');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(limits.io);
    let offset = 0n;
    while (offset < before.size) {
      const size = Number(
        before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset,
      );
      const read = readSync(fd, buffer, 0, size, null);
      if (!read) fail(409, 'RESTORE_CONFLICT');
      hash.update(buffer.subarray(0, read));
      offset += BigInt(read);
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(file, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink()
    )
      fail(409, 'RESTORE_CONFLICT', '恢复文件读取期间发生变化');
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function fsyncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function enqueueSource(
  db: AppDatabase,
  config: AppConfig,
  noteId: string,
  hash: string,
  mtime: string,
  size: number,
) {
  const v = observeSource(db, noteId, hash, mtime, size);
  for (const target of ['text', ...(config.embeddingSpaceId ? ['vector'] : [])]) {
    db.prepare(
      "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND target=? AND source_revision<>? AND status NOT IN ('done','superseded')",
    ).run(noteId, target, v.sourceRevision);
    db.prepare(
      'INSERT OR IGNORE INTO index_jobs(id,note_id,source_revision,source_hash,target,space_id) VALUES(?,?,?,?,?,?)',
    ).run(
      randomUUID(),
      noteId,
      v.sourceRevision,
      hash,
      target,
      target === 'vector' ? config.embeddingSpaceId : '',
    );
  }
  return v;
}
export function mutationCore(config: AppConfig, db: AppDatabase) {
  const library = portableLibrary(config, db);
  function runOperation<T>(
    op: OperationRow,
    work: (commit: () => void, stage: (file: string) => void) => T,
    noteId?: string,
  ): T {
    let committing = false;
    const staged: string[] = [];
    let owned = false;
    try {
      if (noteId) {
        acquireNoteWrite(db, noteId, op.id);
        owned = true;
      }
      return work(
        () => {
          committing = true;
        },
        (file) => {
          staged.push(file);
          if (/^\.doo-.*\.tmp$/.test(basename(file))) workspaceArtifact(db, file);
        },
      );
    } catch (error) {
      if (!committing) {
        if (op.kind === 'restore' && error instanceof KnowledgeError && error.code === 'DIAGRAM_PREVIEW_REQUIRED') {
          db.prepare(
            "UPDATE operations SET error='DIAGRAM_PREVIEW_REQUIRED',updated_at=? WHERE id=? AND status='prepared'",
          ).run(Date.now(), op.id);
          throw error;
        }
        const e = error as { statusCode?: number };
        db.transaction(() => {
          db.prepare(
            "UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=? AND status='prepared'",
          ).run(
            JSON.stringify({
              status: e.statusCode || 500,
              code: error instanceof KnowledgeError ? error.code : 'OPERATION_FAILED',
              message: error instanceof KnowledgeError ? error.message : '操作未完成',
              retryable: error instanceof KnowledgeError ? error.retryable : false,
              details: error instanceof KnowledgeError ? error.details : {},
            }),
            Date.now(),
            op.id,
          );
          db.prepare(
            "UPDATE write_intents SET status='failed' WHERE id=? AND status='prepared'",
          ).run(op.id);
          db.prepare("UPDATE diagram_creation_intents SET commit_operation_id=NULL WHERE commit_operation_id=? AND status IN ('reserved','prepared')").run(op.id);
        })();
        for (const file of staged)
          try {
            unlinkSync(file);
          } catch {}
      }
      throw error;
    } finally {
      if (owned) releaseNoteWrite(db, noteId!, op.id);
    }
  }
  function row(id: string, deleted = false) {
    assertRoot(config, db);
    library.refresh();
    const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as any;
    if (!n || (!deleted && !n.active)) fail(404, 'NOT_FOUND');
    return n as { id: string; path: string; active: number; trash_path: string | null };
  }
  function record(intent: Intent, content?: string) {
    const recordReceipt = db.transaction(() => {
      const current = db.prepare('SELECT status FROM write_intents WHERE id=?').get(intent.id) as
        | { status: string }
        | undefined;
      if (current?.status === 'recorded')
        return existingResult(
          db.prepare('SELECT * FROM operations WHERE id=?').get(intent.id) as OperationRow,
        );
      if (current?.status !== 'prepared') fail(409, 'OPERATION_ALREADY_RESOLVED');
      library.remember(intent.note_id);
      if (intent.kind === 'archive') {
        captureNoteArchiveContext(config, db, intent);
        db.prepare('UPDATE notes SET active=0,trash_path=? WHERE id=?').run(
          basename(intent.path),
          intent.note_id,
        );
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(intent.note_id);
        db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(intent.note_id);
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(intent.note_id);
        db.prepare(
          "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND status<>'done'",
        ).run(intent.note_id);
        const result = {
          id: intent.note_id,
          relativePath: intent.path,
          archived: true,
          indexState: 'removed',
        };
        completeOperation(db, intent.id, result);
        db.prepare("UPDATE write_intents SET status='recorded' WHERE id=?").run(intent.id);
        return result;
      }
      const file = safePath(config.knowledgeRoot, intent.path, 'note'),
        s = statSync(file, { bigint: true });
      if (['restore', 'move', 'whiteboard-migrate', 'whiteboard-rollback'].includes(intent.kind) && restoreHash(file) !== intent.target_hash)
        fail(409, 'RESTORE_CONFLICT', '恢复目标发生外部变化');
      recordRevisionContext(config, db, intent);
      const previousRelativePath =
        intent.kind === 'move'
          ? (db.prepare('SELECT path FROM notes WHERE id=?').get(intent.note_id) as any).path
          : undefined;
      if (intent.kind === 'restore' || intent.kind === 'move' || intent.kind === 'whiteboard-migrate' || intent.kind === 'whiteboard-rollback') {
        db.prepare('UPDATE notes SET path=?,active=1,trash_path=NULL WHERE id=?').run(
          intent.path,
          intent.note_id,
        );
        if (intent.kind === 'restore')
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(intent.note_id);
      } else db.prepare('UPDATE notes SET active=1 WHERE id=?').run(intent.note_id);
      if (intent.kind === 'whiteboard-rollback') {
        db.prepare('DELETE FROM note_path_aliases WHERE note_id=?').run(intent.note_id);
      }
      if (intent.kind === 'whiteboard-migrate') {
        const migration = db.prepare('SELECT id,old_path FROM whiteboard_migrations WHERE commit_operation_id=?').get(intent.id) as { id:string;old_path:string } | undefined;
        if (!migration) fail(409, 'MIGRATION_INTENT_MISSING');
        db.prepare('INSERT INTO note_path_aliases(path,note_id,migration_id) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET note_id=excluded.note_id,migration_id=excluded.migration_id').run(migration.old_path,intent.note_id,migration.id);
      }
      if (intent.kind === 'move')
        db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(intent.note_id);
      enqueueSource(
        db,
        config,
        intent.note_id,
        intent.target_hash!,
        s.mtimeNs.toString(),
        Number(s.size),
      );
      observeCollectionSource(db, intent.note_id, s.mtimeNs.toString(), Number(s.size), isWhiteboard(intent.path) && content !== undefined ? whiteboardText(content) : content,
        `${s.dev}:${s.ino}:${s.ctimeNs}`, intent.target_hash!);
      db.prepare("UPDATE document_state SET longest_line_bytes=NULL,document_type='markdown' WHERE note_id=?").run(
        intent.note_id,
      );
      if (content !== undefined) {
        let longest = 0;
        for (const line of content.split('\n'))
          longest = Math.max(longest, Buffer.byteLength(line));
        const title = [...documentTitle(intent.path,content)]
          .slice(0, 256)
          .join('');
        db.prepare('UPDATE document_state SET longest_line_bytes=?,title=?,document_type=? WHERE note_id=?').run(
          longest,
          title,
          documentType(intent.path,content),
          intent.note_id,
        );
      }
      recordDiagramPublication(config,db,intent.id);
      if (intent.kind === 'restore' && noteTrashRestorePlan(db, intent.id)) {
        const identity = JSON.parse(intent.original_hash || 'null');
        const published = lstatSync(file, { bigint: true });
        if (!identity || published.ino !== BigInt(identity.ino) || published.dev !== BigInt(identity.dev) ||
          Number(published.mode) !== identity.mode || published.mtimeNs.toString() !== identity.mtime ||
          restoreHash(file) !== intent.target_hash)
          fail(409, 'RESTORE_CONFLICT', '恢复目标发生外部变化');
      }
      const result = {
        id: intent.note_id,
        relativePath: intent.path,
        modifiedAt: s.mtimeNs.toString(),
        contentHash: intent.target_hash,
        sizeBytes: Number(s.size),
        indexState: 'pending',
        ...(intent.kind === 'restore' ? { restored: true } : {}),
        ...(intent.kind === 'move' ? { moved: true, previousRelativePath } : {}),
      };
      completeOperation(db, intent.id, result);
      db.prepare("UPDATE write_intents SET status='recorded' WHERE id=?").run(intent.id);
      return result;
    });
    return recordReceipt.immediate();
  }
  function create(
    p: Principal,
    directory: string,
    fileName: string,
    content: string,
    requestId: string,
    creationIntentId?: string,
    ordinaryByteLimit = limits.ordinary,
  ) {
    if (typeof directory !== 'string') fail(400, 'INVALID_DIRECTORY');
    if (typeof content !== 'string' || Buffer.byteLength(content) > (isWhiteboard(fileName) ? MAX_WHITEBOARD_BYTES : parseDiagramDocument(content).status==='diagram'?limits.file:ordinaryByteLimit))
      fail(413, 'REQUEST_TOO_LARGE');
    if (isWhiteboard(fileName)) { try { parseWhiteboard(content); } catch(e) { fail(400, 'INVALID_WHITEBOARD', (e as Error).message); } }
    if (!validName(fileName) || !isDocument(fileName)) fail(400, 'INVALID_INPUT');
    const path = directory === '' ? fileName : `${directory}/${fileName}`;
    authorizePath(p, path, 'knowledge:write');
    assertRoot(config, db);
    library.refresh();
    assertWritable(db);
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'create', requestId, { directory, fileName, content, ...(creationIntentId?{creationIntentId}:{}) }),
    );
    if (!op.fresh) return existingResult(op.operation);
    return runOperation(op.operation, (commit, stage) => {
      if (directory !== '') safePath(config.knowledgeRoot, directory, 'folder');
      const file = safePath(config.knowledgeRoot, path, 'note', true);
      if (existsSync(file) || db.prepare("SELECT 1 FROM whiteboard_migrations WHERE new_path=? AND status NOT IN ('rolled_back','committed','references_pending')").get(path) || db.prepare('SELECT 1 FROM note_path_aliases WHERE path=?').get(path)) fail(409, 'NAME_CONFLICT');
      const creation=creationIntentId?diagramCreationService(config,db,p).get(creationIntentId):undefined;
      if(!creation && db.prepare("SELECT 1 FROM diagram_creation_intents WHERE path=? AND status IN ('reserved','prepared') AND (expires_at>? OR commit_operation_id IS NOT NULL)").get(path,Date.now())) fail(409,'NAME_CONFLICT');
      const noteId = creation?.noteId || randomUUID(),
        temp = join(dirname(file), `.doo-${op.operation.id}.tmp`);
      assertDiagramPublication(config,db,p,{operationId:op.operation.id,noteId,path,markdown:content,creationIntentId});
      stage(temp);
      if(isWhiteboard(path)){content=withWhiteboardId(content,noteId);if(Buffer.byteLength(content)>MAX_WHITEBOARD_BYTES)fail(413,'REQUEST_TOO_LARGE','白板不能超过 8 MiB');}
      durableFile(temp, content);
      db.transaction(() => {
        if(creationIntentId) {
          const claimed=db.prepare("UPDATE diagram_creation_intents SET commit_operation_id=? WHERE id=? AND note_id=? AND status IN ('reserved','prepared') AND (commit_operation_id IS NULL OR commit_operation_id=?)")
            .run(op.operation.id,creationIntentId,noteId,op.operation.id);
          if(!claimed.changes) fail(409,'CREATION_COMMIT_IN_PROGRESS');
          const inserted=db.prepare('INSERT INTO notes(id,path,active) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET path=excluded.path,active=0 WHERE notes.active=0 AND notes.trash_path IS NULL AND notes.path=excluded.path').run(noteId,path);
          if(!inserted.changes) fail(409,'CREATION_INTENT_UNAVAILABLE');
        } else db.prepare('INSERT INTO notes(id,path,active) VALUES(?,?,0)').run(noteId, path);
        db.prepare(
          'INSERT INTO write_intents(id,note_id,path,kind,target_hash,temp_path) VALUES(?,?,?,?,?,?)',
        ).run(op.operation.id, noteId, path, 'create', sha256(content), temp);
      })();
      try {
        assertDiagramPublication(config,db,p,{operationId:op.operation.id,noteId,path,markdown:content,creationIntentId});
        commit();
        linkSync(temp, file);
        unlinkSync(temp);
        fsyncDirectory(dirname(file));
        return record(
          db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
          content,
        );
      } catch (e) {
        throw e;
      }
    });
  }
  function update(p: Principal, id: string, content: string, expected: string, requestId: string) {
    const n = row(id);
    assertSharePrincipal(db, p, id, n.path, 'edit');
    authorizePath(p, n.path, 'knowledge:write');
    assertWritable(db, id);
    if (typeof content !== 'string' || Buffer.byteLength(content) > (isWhiteboard(n.path) ? MAX_WHITEBOARD_BYTES : parseDiagramDocument(content).status==='diagram'?limits.file:1024*1024))
      fail(413, 'REQUEST_TOO_LARGE');
    if (isSharePrincipal(p)) {
      if (isWhiteboard(n.path)) fail(403, 'SHARE_EDIT_UNSUPPORTED', '白板分享暂不支持公开编辑');
      if (content.split('\n').some(line => Buffer.byteLength(line) > 32768))
        fail(413, 'SHARE_EDIT_UNSUPPORTED', '公开编辑不支持超过 32 KiB 的长行');
    }
    if (!isWhiteboard(n.path) && db.prepare('SELECT 1 FROM note_path_aliases WHERE note_id=?').get(id)) {
      try { const native = JSON.parse(content); if (native?.type === 'excalidraw') fail(409, 'VERSION_CONFLICT', '白板已迁移，请重新载入文档'); } catch (error) { if (error instanceof KnowledgeError) throw error; }
    }
    if (isWhiteboard(n.path)) { try { parseWhiteboard(content); } catch(e) { fail(400, 'INVALID_WHITEBOARD', (e as Error).message); } }
    if(isWhiteboard(n.path)){content=withWhiteboardId(content,id);if(Buffer.byteLength(content)>MAX_WHITEBOARD_BYTES)fail(413,'REQUEST_TOO_LARGE','白板不能超过 8 MiB');}
    if (typeof expected !== 'string' || !/^\d+$/.test(expected)) fail(400, 'INVALID_VERSION');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'update', requestId, {
        id,
        content,
        expectedModifiedAt: expected,
      }),
    );
    if (!op.fresh) return existingResult(op.operation);
    return runOperation(op.operation, (commit, stage) => {
      const file = safePath(config.knowledgeRoot, n.path, 'note'),
        s = statSync(file, { bigint: true });
      const current = readDocument(config.knowledgeRoot, n.path,{allowDiagramLarge:true});
      if (current.modifiedAt !== expected)
        fail(409, 'VERSION_CONFLICT', '原文件已更新', false, {
          currentModifiedAt: current.modifiedAt,
        });
      if (!isWhiteboard(n.path) && parseDiagramDocument(current.content).status!=='diagram' && current.content.split('\n').some((line) => Buffer.byteLength(line) > 32768))
        fail(409, 'LARGE_FILE_MODE_REQUIRED');
      if (isSharePrincipal(p)) assertShareResources(n.path, current.content, content);
      assertDiagramPublication(config,db,p,{operationId:op.operation.id,noteId:id,path:n.path,markdown:content,currentMarkdown:current.content});
      const temp = join(dirname(file), `.doo-${op.operation.id}.tmp`),
        historyFile = `${op.operation.id}.md`;
      mkdirSync(join(config.dataRoot, 'history'), { recursive: true, mode: 0o700 });
      const historyPath = join(config.dataRoot, 'history', historyFile);
      stage(historyPath);
      durableFile(historyPath, current.content);
      fsyncDirectory(dirname(historyPath));
      fsyncDirectory(config.dataRoot);
      stage(temp);
      durableFile(temp, content, Number(s.mode) & 0o777);
      db.prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,temp_path,revision_id,history_file) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        op.operation.id,
        id,
        n.path,
        'update',
        sha256(current.content),
        expected,
        sha256(content),
        temp,
        op.operation.id,
        historyFile,
      );
      const latest = readDocument(config.knowledgeRoot, n.path,{allowDiagramLarge:true});
      if (latest.modifiedAt !== expected || sha256(latest.content) !== sha256(current.content))
        fail(409, 'VERSION_CONFLICT', '原文件再次更新', false, {
          currentModifiedAt: latest.modifiedAt,
        });
      assertSharePrincipal(db, p, id, n.path, 'edit');
      assertDiagramPublication(config,db,p,{operationId:op.operation.id,noteId:id,path:n.path,markdown:content,currentMarkdown:current.content});
      commit();
      renameSync(temp, file);
      fsyncDirectory(dirname(file));
      return record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
        content,
      );
    }, id);
  }
  function archive(p: Principal, id: string, expected: string, requestId: string) {
    if (p.policyVersion === 2 || p.permissionCeiling) requireScope(p, 'knowledge:archive');
    const n = row(id, true);
    authorizePath(p, n.path, 'knowledge:write');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'archive', requestId, { id, expectedModifiedAt: expected }),
    );
    if (!op.fresh) return existingResult(op.operation);
    return runOperation(op.operation, (commit) => {
      if (!n.active) fail(404, 'NOT_FOUND');
      const file = safePath(config.knowledgeRoot, n.path, 'note'),
        s = statSync(file, { bigint: true });
      if (s.mtimeNs.toString() !== expected) fail(409, 'VERSION_CONFLICT');
      const archiveHash = restoreHash(file);
      const archive = join(config.knowledgeRoot, '90-Archive');
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      safePath(config.knowledgeRoot, '90-Archive', 'folder');
      let destination = archive;
      for (const part of ['.trash', id]) {
        destination = join(destination, part);
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        const st = lstatSync(destination);
        if (!st.isDirectory() || st.isSymbolicLink()) fail(400, 'INVALID_PATH');
      }
      destination = join(destination, basename(n.path));
      if (existsSync(destination)) fail(409, 'TRASH_CONFLICT');
      db.prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,temp_path) VALUES(?,?,?,?,?,?,?)',
      ).run(op.operation.id, id, n.path, 'archive', archiveHash, expected, destination);
      if (fileVersionStamp(statSync(file, { bigint: true })) !== fileVersionStamp(s))
        fail(409, 'VERSION_CONFLICT');
      commit();
      renameSync(file, destination);
      fsyncDirectory(dirname(file));
      fsyncDirectory(dirname(destination));
      return record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
      );
    }, id);
  }
  function restoreStage(intent: Intent) {
    return join(dirname(join(config.knowledgeRoot, intent.path)), `.doo-restore-${intent.id}.tmp`);
  }
  function trashSource(intent: Intent) {
    const base = join(config.knowledgeRoot, '90-Archive');
    safePath(config.knowledgeRoot, '90-Archive', 'folder');
    for (const path of [join(base, '.trash'), join(base, '.trash', intent.note_id)]) {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink()) fail(400, 'INVALID_PATH');
    }
    const source = intent.temp_path!;
    if (dirname(source) !== join(base, '.trash', intent.note_id)) fail(400, 'INVALID_PATH');
    if (existsSync(source)) {
      const st = lstatSync(source);
      if (!st.isFile() || st.isSymbolicLink()) fail(400, 'INVALID_PATH');
    }
    return source;
  }
  function assertRestoreDestination(intent: Intent) {
    if (
      db
        .prepare('SELECT 1 FROM notes WHERE path=? AND active=1 AND id<>?')
        .get(intent.path, intent.note_id)
    )
      fail(409, 'NAME_CONFLICT', '原位置已有其他笔记，请选择新文件名');
    if (
      db
        .prepare(
          "SELECT 1 FROM write_intents WHERE path=? AND id<>? AND status IN ('prepared','conflicted')",
        )
        .get(intent.path, intent.id)
    )
      fail(409, 'OPERATION_IN_PROGRESS');
  }
  function finishRestore(intent: Intent) {
    assertRoot(config, db);
    assertNoteRestoreCommitted(config, db, intent);
    const nativePlan = noteTrashRestorePlan(db, intent.id);
    if (nativePlan) publishNoteTrashRestoreAssets(config, db, nativePlan);
    verifyPendingDiagramPublication(config,db,intent.id);
    assertRestoreDestination(intent);
    const source = trashSource(intent),
      parent =
        dirname(intent.path) === '.'
          ? config.knowledgeRoot
          : safePath(config.knowledgeRoot, dirname(intent.path), 'folder'),
      dest = join(parent, basename(intent.path)),
      stage = restoreStage(intent),
      publication = `${stage}.publish`;
    const matches = (file: string) => {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail(409, 'RESTORE_CONFLICT');
      if (nativePlan && (st.mode & 0o777) !== 0o600) fail(409, 'RESTORE_CONFLICT');
      return restoreHash(file) === intent.target_hash;
    };
    if (existsSync(source) && !nativePlan && !matches(source)) fail(409, 'RESTORE_CONFLICT', '回收站原件发生变化');
    // Keep a separate, durable inode until the database commit. A competing edit
    // or unlink of the public target must not destroy the last original copy.
    if (!existsSync(stage) || !matches(stage)) {
      if (!existsSync(source)) fail(409, 'RESTORE_CONFLICT', '恢复文件证据缺失');
      if (existsSync(stage)) unlinkSync(stage);
      copyFileSync(nativePlan?.afterFile ?? source, stage, constants.COPYFILE_EXCL);
      chmodSync(stage, 0o600);
      const fd = openSync(stage, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!matches(stage)) fail(409, 'RESTORE_CONFLICT');
      fsyncDirectory(parent);
    }
    const backupFd = openSync(stage, 'r');
    try {
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    fsyncDirectory(parent);
    if (!existsSync(dest)) {
      if (existsSync(publication)) {
        const st = lstatSync(publication);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail(409, 'RESTORE_CONFLICT');
        unlinkSync(publication);
      }
      copyFileSync(stage, publication, constants.COPYFILE_EXCL);
      const fd = openSync(publication, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!matches(publication)) fail(409, 'RESTORE_CONFLICT');
      fsyncDirectory(parent);
      const staged = lstatSync(publication);
      intent.original_hash = JSON.stringify({
        ino: staged.ino, dev: staged.dev,
        ...(nativePlan ? { mode: staged.mode, mtime: statSync(publication, { bigint: true }).mtimeNs.toString() } : {}),
      });
      db.prepare('UPDATE write_intents SET original_hash=? WHERE id=?').run(
        intent.original_hash,
        intent.id,
      );
      try {
        linkSync(publication, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'NAME_CONFLICT');
        throw e;
      }
      fsyncDirectory(parent);
    }
    const identity = intent.original_hash ? JSON.parse(intent.original_hash) : null;
    const st = lstatSync(dest);
    if (
      !identity ||
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.ino !== identity.ino ||
      st.dev !== identity.dev ||
      (nativePlan && (st.mode !== identity.mode || statSync(dest, { bigint: true }).mtimeNs.toString() !== identity.mtime)) ||
      restoreHash(dest) !== intent.target_hash
    )
      fail(409, 'RESTORE_CONFLICT', '恢复目标发生外部变化');
    if (existsSync(publication)) {
      const pub = lstatSync(publication);
      if (!pub.isFile() || pub.isSymbolicLink() || pub.ino !== st.ino || pub.dev !== st.dev)
        fail(409, 'RESTORE_CONFLICT');
      unlinkSync(publication);
      fsyncDirectory(parent);
    }
    const result = db
      .transaction(() => {
        // The immediate transaction serializes database ownership through unlink
        // and record. The private stage survives any process exit or read failure.
        assertRestoreDestination(intent);
        safePath(config.knowledgeRoot, intent.path, 'note');
        if (nativePlan) verifyNoteTrashRestore(config, db, nativePlan);
        if (existsSync(source)) {
          if (!nativePlan) {
            if (!matches(source)) fail(409, 'RESTORE_CONFLICT');
            unlinkSync(source);
            fsyncDirectory(dirname(source));
          }
        }
        return record(intent, nativePlan ? readFileSync(nativePlan.afterFile, 'utf8') : undefined);
      })
      .immediate();
    try {
      if (nativePlan && existsSync(source)) {
        if (fileVersionStamp(lstatSync(source, { bigint: true })) === nativePlan.original.stamp &&
          restoreHash(source) === nativePlan.original.hash) {
          unlinkSync(source);
          fsyncDirectory(dirname(source));
        }
      }
      if (matches(dest)) {
        unlinkSync(stage);
        fsyncDirectory(parent);
      }
    } catch {
      /* Cleanup cannot replace the durable success receipt. */
    }
    return result;
  }
  function preserveRestoreSource(intent: Intent) {
    if (noteTrashRestorePlan(db, intent.id)) return;
    const n = row(intent.note_id, true);
    if (n.active || !n.trash_path) return;
    const source = trashSource(intent),
      stage = restoreStage(intent);
    if (basename(source) !== n.trash_path || existsSync(source) || !existsSync(stage)) return;
    const st = lstatSync(stage);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      restoreHash(stage) !== intent.target_hash
    )
      return;
    copyFileSync(stage, source, constants.COPYFILE_EXCL);
    chmodSync(source, 0o600);
    const fd = openSync(source, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(source));
  }
  function restore(p: Principal, id: string, fileName: string | undefined, requestId: string) {
    if (p.policyVersion === 2 || p.permissionCeiling) requireScope(p, 'knowledge:archive');
    const n = row(id, true);
    p = lifecyclePrincipal(db, p, 'note', id, n.path);
    authorizePath(p, n.path, 'knowledge:write');
    const name = fileName || basename(n.path);
    if (!validName(name) || !isDocument(name) || documentTypeMismatch(name,n.path)) fail(400, 'INVALID_INPUT');
    const path = dirname(n.path) === '.' ? name : `${dirname(n.path)}/${name}`;
    p = lifecyclePrincipal(db, p, 'note', id, path);
    authorizePath(p, path, 'knowledge:write');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'restore', requestId, { id, fileName: fileName ?? null }),
    );
    if (!op.fresh) {
      const intent = db
        .prepare("SELECT * FROM write_intents WHERE id=? AND kind='restore' AND status='prepared'")
        .get(op.operation.id) as Intent | undefined;
      if (intent && ['prepared', 'committing', 'needs_reconciliation'].includes(op.operation.status)) {
        acquireNoteWrite(db, id, intent.id, intent.id);
        try {
          return finishRestore(intent);
        } finally {
          releaseNoteWrite(db, id, intent.id);
        }
      }
      if (intent || op.operation.status !== 'prepared' || op.operation.error !== 'DIAGRAM_PREVIEW_REQUIRED')
        return existingResult(op.operation);
    }
    return runOperation(op.operation, (commit) => {
      if (n.active || !n.trash_path) fail(404, 'NOT_FOUND');
      const dest = safePath(config.knowledgeRoot, path, 'note', true);
      if (db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1 AND id<>?').get(path, id))
        fail(409, 'NAME_CONFLICT', '原位置已有其他笔记，请选择新文件名');
      if (existsSync(dest)) fail(409, 'NAME_CONFLICT', '原位置已被占用，请选择新文件名');
      const intent: Intent = {
        id: op.operation.id,
        note_id: id,
        path,
        kind: 'restore',
        temp_path: join(config.knowledgeRoot, '90-Archive', '.trash', id, n.trash_path),
        original_hash: null,
        original_mtime: null,
        target_hash: null,
        revision_id: null,
        history_file: null,
        status: 'prepared',
      };
      const source = trashSource(intent);
      if (!existsSync(source)) fail(404, 'NOT_FOUND');
      const st = lstatSync(source, { bigint: true });
      intent.target_hash = restoreHash(source);
      const sourceHash = intent.target_hash;
      intent.original_mtime = st.mtimeNs.toString();
      const { plan: nativePlan, targets } = prepareNoteTrashRestore(config, db, p, {
        operationId: intent.id, noteId: id, from: n.path, to: path, source, trashFile: n.trash_path,
      });
      if (nativePlan) intent.target_hash = nativePlan.afterHash;
      else assertDiagramRestorePublication(config, db, p, {
        operationId: intent.id, noteId: id, path, sourceFile: source, sourceHash: intent.target_hash,
      });
      db.prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,original_mtime,target_hash,temp_path) VALUES(?,?,?,?,?,?,?)',
      ).run(intent.id, id, path, 'restore', intent.original_mtime, intent.target_hash, source);
      commitNoteRestore(config, db, p, {
        operationId: intent.id, noteId: id, from: n.path, path, source, sourceHash,
        sourceStamp: fileVersionStamp(st), targetHash: intent.target_hash, targets,
      }, nativePlan);
      commit();
      return finishRestore(intent);
    }, id);
  }
  async function recover(): Promise<RecoveryReport> {
    const report = { recovered: 0, unapplied: 0, conflicted: 0 };
    for (const migration of db.prepare("SELECT * FROM whiteboard_migrations WHERE status IN ('committing','rolling_back')").all() as MigrationRow[]) {
      const migrationOperationId = migration.status === 'rolling_back' ? migration.rollback_operation_id : migration.commit_operation_id;
      if (!migrationOperationId || operationHasLiveWorkspaceWriter(db, migrationOperationId)) continue;
      let owned = false;
      try {
        acquireNoteWrite(db, migration.note_id, migrationOperationId, migrationOperationId); owned = true;
        if (migration.status === 'rolling_back') finishWhiteboardRollback(config, db, migration, record);
        else finishWhiteboardMigration(config, db, migration, record);
        library.flush(); migrationAliasState(config,db).flush(); report.recovered++;
      } catch {
        if (owned) report.conflicted++;
      } finally { if (owned) releaseNoteWrite(db, migration.note_id, migrationOperationId); }
    }
    for (const orphan of db
      .prepare(
        "SELECT id FROM operations WHERE kind IN ('create','update','archive','restore','move') AND status='prepared' AND (error IS NULL OR error<>'DIAGRAM_PREVIEW_REQUIRED') AND NOT EXISTS(SELECT 1 FROM write_intents WHERE write_intents.id=operations.id)",
      )
      .all() as any[]) {
      if (!operationHasLiveWorkspaceWriter(db, orphan.id))
        report.unapplied += db
          .prepare(
            "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED',updated_at=? WHERE id=? AND status='prepared'",
          )
          .run(Date.now(), orphan.id).changes;
    }
    for (let intent of db
      .prepare("SELECT * FROM write_intents WHERE status='prepared'")
      .all() as Intent[]) {
      if (intent.kind === 'whiteboard-migrate' || intent.kind === 'whiteboard-rollback') continue;
      if (operationHasLiveWorkspaceWriter(db, intent.id)) continue;
      if (
        db
          .prepare(
            "SELECT 1 FROM file_operations WHERE id=? AND status IN ('running','committing') AND lease_until>?",
          )
          .get(intent.id, Date.now())
      )
        continue;
      let owned = false;
      try {
        // Recovery publishes files too. Bind its live workspace gate while
        // acquiring the same atomic ownership used by normal writes/retries.
        acquireNoteWrite(db, intent.note_id, intent.id, intent.id);
        owned = true;
        const current = db
          .prepare(
            "SELECT w.* FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.id=? AND w.status='prepared' AND o.status IN ('prepared','committing','needs_reconciliation')",
          )
          .get(intent.id) as Intent | undefined;
        if (!current) continue;
        intent = current;
        assertRoot(config, db);
        if (intent.kind === 'move') {
          moves.finish(intent);
          report.recovered++;
          continue;
        }
        if (intent.kind === 'restore') {
          finishRestore(intent);
          report.recovered++;
          continue;
        }
        if (intent.kind === 'archive') {
          if (
            intent.temp_path &&
            existsSync(intent.temp_path) &&
            !existsSync(join(config.knowledgeRoot, intent.path))
          ) {
            record(intent);
            report.recovered++;
            continue;
          }
        } else {
          const file = join(config.knowledgeRoot, intent.path),
            hash = existsSync(file)
              ? await hashFile(safePath(config.knowledgeRoot, intent.path, 'note'))
              : null;
          // Hashing yields to owner reconciliation. Never replay a stale
          // snapshot of an intent that the owner has already disposed of.
          if (
            (db.prepare('SELECT status FROM write_intents WHERE id=?').get(intent.id) as any)
              ?.status !== 'prepared'
          )
            continue;
          if (hash === intent.target_hash) {
            const result = record(intent) as any;
            const job = db
              .prepare('SELECT payload,snapshot_id FROM file_operations WHERE id=?')
              .get(intent.id) as any;
            if (job) {
              result.editCount = JSON.parse(job.payload)?.input?.edits?.length || 0;
              db.prepare('UPDATE operations SET result=? WHERE id=?').run(
                JSON.stringify(result),
                intent.id,
              );
              db.prepare("UPDATE file_operations SET status='succeeded' WHERE id=?").run(intent.id);
              releaseSnapshotRef(db, intent.id);
            }
            report.recovered++;
            continue;
          }
          if (hash !== intent.original_hash) {
            db.prepare(
              "UPDATE operations SET status='needs_reconciliation',error='EXTERNAL_CHANGE' WHERE id=? AND status IN ('prepared','committing','needs_reconciliation')",
            ).run(intent.id);
            db.prepare(
              "UPDATE write_intents SET status='conflicted' WHERE id=? AND status='prepared'",
            ).run(intent.id);
            report.conflicted++;
            continue;
          }
        }
        db.prepare(
          "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED' WHERE id=? AND status IN ('prepared','committing','needs_reconciliation')",
        ).run(intent.id);
        db.prepare("UPDATE write_intents SET status='failed' WHERE id=? AND status='prepared'").run(
          intent.id,
        );
        db.prepare(
          "UPDATE file_operations SET status='failed',error='OPERATION_UNAPPLIED' WHERE id=?",
        ).run(intent.id);
        db.prepare("UPDATE diagram_creation_intents SET commit_operation_id=NULL WHERE commit_operation_id=? AND status IN ('reserved','prepared')").run(intent.id);
        releaseSnapshotRef(db, intent.id);
        report.unapplied++;
      } catch (e) {
        if (!owned) {
          if (
            e instanceof KnowledgeError &&
            ['OPERATION_IN_PROGRESS', 'OPERATION_OUTCOME_UNKNOWN', 'SYNC_IN_PROGRESS'].includes(e.code)
          )
            continue;
          throw e;
        }
        // An already recorded/terminal receipt is authoritative, even if a
        // stale recovery snapshot or filesystem cleanup raised an error.
        if (
          !db
            .prepare(
              "SELECT 1 FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.id=? AND w.status='prepared' AND o.status IN ('prepared','committing','needs_reconciliation')",
            )
            .get(intent.id)
        )
          continue;
        if(db.prepare('SELECT 1 FROM diagram_pending_publications WHERE operation_id=?').get(intent.id)) {
          const error=e instanceof KnowledgeError?{status:e.statusCode,code:e.code,message:e.message,retryable:true,details:e.details}:{status:409,code:'DIAGRAM_RECONCILIATION_REQUIRED',retryable:true};
          db.prepare("UPDATE operations SET status='needs_reconciliation',error=?,updated_at=? WHERE id=? AND status IN ('prepared','committing','needs_reconciliation')").run(JSON.stringify(error),Date.now(),intent.id);
        }
        if (intent.kind === 'move') {
          const changed = db
            .transaction(() => {
              const operation = db
                .prepare(
                  "UPDATE operations SET status='needs_reconciliation',error='MOVE_CONFLICT' WHERE id=? AND status IN ('prepared','committing','needs_reconciliation') AND EXISTS(SELECT 1 FROM write_intents WHERE id=? AND status='prepared')",
                )
                .run(intent.id, intent.id);
              const writeIntent = db
                .prepare(
                  "UPDATE write_intents SET status='conflicted' WHERE id=? AND status='prepared' AND EXISTS(SELECT 1 FROM operations WHERE id=? AND status='needs_reconciliation')",
                )
                .run(intent.id, intent.id);
              return operation.changes + writeIntent.changes;
            })
            .immediate();
          if (!changed) continue;
        }
        if (intent.kind === 'restore') {
          try {
            preserveRestoreSource(intent);
          } catch {
            /* Keep the private backup for reconciliation. */
          }
          const changed = db
            .transaction(() => {
              const operation = db
                .prepare(
                  "UPDATE operations SET status='needs_reconciliation',error='RESTORE_CONFLICT' WHERE id=? AND status IN ('prepared','committing','needs_reconciliation') AND EXISTS(SELECT 1 FROM write_intents WHERE id=? AND status='prepared')",
                )
                .run(intent.id, intent.id);
              if (
                operation.changes &&
                e instanceof KnowledgeError &&
                ['RESTORE_CONFLICT', 'NAME_CONFLICT', 'INVALID_PATH'].includes(e.code)
              )
                db.prepare(
                  "UPDATE write_intents SET status='conflicted' WHERE id=? AND status='prepared'",
                ).run(intent.id);
              return operation.changes;
            })
            .immediate();
          if (!changed) continue;
        }
        report.conflicted++;
      } finally {
        if (owned) releaseNoteWrite(db, intent.note_id, intent.id);
      }
    }
    // Cleanup is retryable after a committed restore; it cannot change its receipt.
    for (const intent of db
      .prepare("SELECT * FROM write_intents WHERE kind='restore' AND status='recorded'")
      .all() as Intent[]) {
      const stage = restoreStage(intent);
      if (existsSync(stage)) {
        let owned = false;
        try {
          acquireNoteWrite(db, intent.note_id, intent.id, intent.id);
          owned = true;
          const dest = safePath(config.knowledgeRoot, intent.path, 'note');
          if (restoreHash(dest) === intent.target_hash) {
            unlinkSync(stage);
            fsyncDirectory(dirname(stage));
          }
        } catch {
          // Cleanup is best effort; a current writer or recovery keeps priority.
        } finally {
          if (owned) releaseNoteWrite(db, intent.note_id, intent.id);
        }
      }
    }
    return report;
  }
  const moves = moveService(config, db, record);
  return {
    move: moves.move,
    create: (p:Principal,directory:string,fileName:string,content:string,requestId:string) =>
      workspaceWriteSync(db, { kind: 'core.create' }, () => create(p,directory,fileName,content,requestId)),
    /** Internal manifest-import capability; ordinary public create retains its 1 MiB limit. */
    createPortableMarkdown: (p:Principal,directory:string,fileName:string,content:string,requestId:string) =>
      workspaceWriteSync(db, { kind: 'core.create-portable-markdown' }, () => {
        if (typeof content !== 'string' || isWhiteboard(fileName) || parseDiagramDocument(content).status !== 'ordinary')
          fail(400, 'INVALID_PORTABLE_DOCUMENT');
        return create(p,directory,fileName,content,requestId,undefined,limits.file);
      }),
    createDiagram: (p:Principal,creationIntentId:string,content:string,requestId:string) =>
      workspaceWriteSync(db,{kind:'core.create-diagram'},()=>{
        const intent=diagramCreationService(config,db,p).get(creationIntentId),folder=dirname(intent.relativePath);
        return create(p,folder==='.'?'':folder,basename(intent.relativePath),content,requestId,creationIntentId);
      }),
    update: (...args: Parameters<typeof update>) =>
      workspaceWriteSync(db, { kind: 'core.update' }, () => update(...args)),
    archive: (...args: Parameters<typeof archive>) =>
      workspaceWriteSync(db, { kind: 'core.archive' }, () => archive(...args)),
    restore: (...args: Parameters<typeof restore>) =>
      workspaceWriteSync(db, { kind: 'core.restore' }, () => restore(...args)),
    recover: () => workspaceWrite(db, { kind: 'core.recover' }, recover),
    record,
  };
}
