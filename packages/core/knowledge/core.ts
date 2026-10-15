import {
  workspaceWrite,
  workspaceWriteSync,
  operationHasLiveWorkspaceWriter,
  workspaceBegin,
  workspaceArtifact,
} from '../workspace/gate.js';
import { randomUUID, createHash } from 'node:crypto';
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
import { authorizePath } from '../agent/auth.js';
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
import { hashFile } from './file-reader.js';
import { limits } from './limits.js';
import { assertRoot } from '../indexing/reconcile.js';
export const webPrincipal: Principal = {
  id: 'web-owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
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
export function assertWritable(db: AppDatabase, noteId?: string, ownIntent?: string) {
  if (
    (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
    db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
  )
    fail(503, 'SYNC_IN_PROGRESS', '工作区维护中', true);
  if (
    noteId &&
    db
      .prepare(
        "SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted') AND id<>?",
      )
      .get(noteId, ownIntent || '')
  )
    fail(409, 'OPERATION_OUTCOME_UNKNOWN', '请先核对未完成的写入', true);
  if (noteId && db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'").get()) {
    const lease = db
      .prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?')
      .get(noteId) as any;
    if (
      lease &&
      (lease.lease_until > Date.now() ||
        operationHasLiveWorkspaceWriter(db, String(lease.owner).split(':')[0]))
    )
      fail(409, 'OPERATION_IN_PROGRESS');
  }
}
function durableFile(file: string, content: string, mode = 0o600) {
  const fd = openSync(file, 'wx', mode);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function restoreHash(file: string) {
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
  function runOperation<T>(
    op: OperationRow,
    work: (commit: () => void, stage: (file: string) => void) => T,
  ): T {
    let committing = false;
    const staged: string[] = [];
    try {
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
        })();
        for (const file of staged)
          try {
            unlinkSync(file);
          } catch {}
      }
      throw error;
    }
  }
  function row(id: string, deleted = false) {
    assertRoot(config, db);
    const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as any;
    if (!n || (!deleted && !n.active)) fail(404, 'NOT_FOUND');
    return n as { id: string; path: string; active: number; trash_path: string | null };
  }
  function record(intent: Intent, content?: string) {
    return db.transaction(() => {
      if (intent.kind === 'archive') {
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
      if (intent.kind === 'restore' && restoreHash(file) !== intent.target_hash)
        fail(409, 'RESTORE_CONFLICT', '恢复目标发生外部变化');
      if (intent.revision_id)
        db.prepare(
          'INSERT OR IGNORE INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)',
        ).run(
          intent.revision_id,
          intent.note_id,
          intent.history_file,
          new Date().toISOString(),
          intent.original_mtime,
        );
      if (intent.kind === 'restore') {
        db.prepare('UPDATE notes SET path=?,active=1,trash_path=NULL WHERE id=?').run(
          intent.path,
          intent.note_id,
        );
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(intent.note_id);
      } else db.prepare('UPDATE notes SET active=1 WHERE id=?').run(intent.note_id);
      enqueueSource(
        db,
        config,
        intent.note_id,
        intent.target_hash!,
        s.mtimeNs.toString(),
        Number(s.size),
      );
      db.prepare('UPDATE document_state SET longest_line_bytes=NULL WHERE note_id=?').run(
        intent.note_id,
      );
      if (content !== undefined) {
        let longest = 0;
        for (const line of content.split('\n'))
          longest = Math.max(longest, Buffer.byteLength(line));
        const title = [...(content.match(/^#\s+(.+)$/m)?.[1] || basename(intent.path, '.md'))]
          .slice(0, 256)
          .join('');
        db.prepare('UPDATE document_state SET longest_line_bytes=?,title=? WHERE note_id=?').run(
          longest,
          title,
          intent.note_id,
        );
      }
      const result = {
        id: intent.note_id,
        relativePath: intent.path,
        modifiedAt: s.mtimeNs.toString(),
        contentHash: intent.target_hash,
        sizeBytes: Number(s.size),
        indexState: 'pending',
        ...(intent.kind === 'restore' ? { restored: true } : {}),
      };
      completeOperation(db, intent.id, result);
      db.prepare("UPDATE write_intents SET status='recorded' WHERE id=?").run(intent.id);
      return result;
    })();
  }
  function create(
    p: Principal,
    directory: string,
    fileName: string,
    content: string,
    requestId: string,
  ) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024)
      fail(413, 'REQUEST_TOO_LARGE');
    if (!validName(fileName) || !fileName.toLowerCase().endsWith('.md')) fail(400, 'INVALID_INPUT');
    const path = `${directory}/${fileName}`;
    authorizePath(p, path, 'knowledge:write');
    assertRoot(config, db);
    assertWritable(db);
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'create', requestId, { directory, fileName, content }),
    );
    if (!op.fresh) return existingResult(op.operation);
    return runOperation(op.operation, (commit, stage) => {
      safePath(config.knowledgeRoot, directory, 'folder');
      const file = safePath(config.knowledgeRoot, path, 'note', true);
      if (existsSync(file)) fail(409, 'NAME_CONFLICT');
      const noteId = randomUUID(),
        temp = join(dirname(file), `.doo-${op.operation.id}.tmp`);
      stage(temp);
      durableFile(temp, content);
      db.transaction(() => {
        db.prepare('INSERT INTO notes(id,path,active) VALUES(?,?,0)').run(noteId, path);
        db.prepare(
          'INSERT INTO write_intents(id,note_id,path,kind,target_hash,temp_path) VALUES(?,?,?,?,?,?)',
        ).run(op.operation.id, noteId, path, 'create', sha256(content), temp);
      })();
      try {
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
    authorizePath(p, n.path, 'knowledge:write');
    assertWritable(db, id);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024)
      fail(413, 'REQUEST_TOO_LARGE');
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
      if (s.size > 1024n * 1024n) fail(409, 'LARGE_FILE_MODE_REQUIRED');
      const current = readDocument(config.knowledgeRoot, n.path);
      if (current.modifiedAt !== expected)
        fail(409, 'VERSION_CONFLICT', '原文件已更新', false, {
          currentModifiedAt: current.modifiedAt,
        });
      if (current.content.split('\n').some((line) => Buffer.byteLength(line) > 32768))
        fail(409, 'LARGE_FILE_MODE_REQUIRED');
      const temp = join(dirname(file), `.doo-${op.operation.id}.tmp`),
        historyFile = `${op.operation.id}.md`;
      mkdirSync(join(config.dataRoot, 'history'), { recursive: true, mode: 0o700 });
      const historyPath = join(config.dataRoot, 'history', historyFile);
      stage(historyPath);
      durableFile(historyPath, current.content);
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
      const latest = readDocument(config.knowledgeRoot, n.path);
      if (latest.modifiedAt !== expected || sha256(latest.content) !== sha256(current.content))
        fail(409, 'VERSION_CONFLICT', '原文件再次更新', false, {
          currentModifiedAt: latest.modifiedAt,
        });
      commit();
      renameSync(temp, file);
      fsyncDirectory(dirname(file));
      return record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
        content,
      );
    });
  }
  function archive(p: Principal, id: string, expected: string, requestId: string) {
    const n = row(id, true);
    authorizePath(p, n.path, 'knowledge:write');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'archive', requestId, { id, expectedModifiedAt: expected }),
    );
    if (!op.fresh) return existingResult(op.operation);
    return runOperation(op.operation, (commit) => {
      assertWritable(db, id);
      if (!n.active) fail(404, 'NOT_FOUND');
      const file = safePath(config.knowledgeRoot, n.path, 'note'),
        s = statSync(file, { bigint: true });
      if (s.mtimeNs.toString() !== expected) fail(409, 'VERSION_CONFLICT');
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
        'INSERT INTO write_intents(id,note_id,path,kind,original_mtime,temp_path) VALUES(?,?,?,?,?,?)',
      ).run(op.operation.id, id, n.path, 'archive', expected, destination);
      if (statSync(file, { bigint: true }).mtimeNs.toString() !== expected)
        fail(409, 'VERSION_CONFLICT');
      commit();
      renameSync(file, destination);
      fsyncDirectory(dirname(file));
      fsyncDirectory(dirname(destination));
      return record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
      );
    });
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
      return restoreHash(file) === intent.target_hash;
    };
    if (existsSync(source) && !matches(source)) fail(409, 'RESTORE_CONFLICT', '回收站原件发生变化');
    // Keep a separate, durable inode until the database commit. A competing edit
    // or unlink of the public target must not destroy the last original copy.
    if (!existsSync(stage) || !matches(stage)) {
      if (!existsSync(source)) fail(409, 'RESTORE_CONFLICT', '恢复文件证据缺失');
      if (existsSync(stage)) unlinkSync(stage);
      copyFileSync(source, stage, constants.COPYFILE_EXCL);
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
      intent.original_hash = JSON.stringify({ ino: staged.ino, dev: staged.dev });
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
        if (existsSync(source)) {
          if (!matches(source)) fail(409, 'RESTORE_CONFLICT');
          unlinkSync(source);
          fsyncDirectory(dirname(source));
        }
        return record(intent);
      })
      .immediate();
    try {
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
    const n = row(id, true);
    authorizePath(p, n.path, 'knowledge:write');
    const name = fileName || basename(n.path);
    if (!validName(name) || !name.toLowerCase().endsWith('.md')) fail(400, 'INVALID_INPUT');
    const path = dirname(n.path) === '.' ? name : `${dirname(n.path)}/${name}`;
    authorizePath(p, path, 'knowledge:write');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'restore', requestId, { id, fileName: fileName ?? null }),
    );
    if (!op.fresh) {
      const intent = db
        .prepare("SELECT * FROM write_intents WHERE id=? AND kind='restore' AND status='prepared'")
        .get(op.operation.id) as Intent | undefined;
      if (intent && ['prepared', 'needs_reconciliation'].includes(op.operation.status)) {
        assertWritable(db, id, intent.id);
        return finishRestore(intent);
      }
      return existingResult(op.operation);
    }
    return runOperation(op.operation, (commit) => {
      assertWritable(db, id);
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
      intent.original_mtime = st.mtimeNs.toString();
      db.prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,original_mtime,target_hash,temp_path) VALUES(?,?,?,?,?,?,?)',
      ).run(intent.id, id, path, 'restore', intent.original_mtime, intent.target_hash, source);
      commit();
      return finishRestore(intent);
    });
  }
  async function recover(): Promise<RecoveryReport> {
    const report = { recovered: 0, unapplied: 0, conflicted: 0 };
    for (const orphan of db
      .prepare(
        "SELECT id FROM operations WHERE kind IN ('create','update','archive','restore') AND status='prepared' AND NOT EXISTS(SELECT 1 FROM write_intents WHERE write_intents.id=operations.id)",
      )
      .all() as any[]) {
      if (!operationHasLiveWorkspaceWriter(db, orphan.id))
        report.unapplied += db
          .prepare(
            "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED',updated_at=? WHERE id=? AND status='prepared'",
          )
          .run(Date.now(), orphan.id).changes;
    }
    for (const intent of db
      .prepare("SELECT * FROM write_intents WHERE status='prepared'")
      .all() as Intent[]) {
      if (operationHasLiveWorkspaceWriter(db, intent.id)) continue;
      if (
        db
          .prepare(
            "SELECT 1 FROM file_operations WHERE id=? AND status IN ('running','committing') AND lease_until>?",
          )
          .get(intent.id, Date.now())
      )
        continue;
      try {
        assertRoot(config, db);
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
              "UPDATE operations SET status='needs_reconciliation',error='EXTERNAL_CHANGE' WHERE id=?",
            ).run(intent.id);
            db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(intent.id);
            report.conflicted++;
            continue;
          }
        }
        db.prepare(
          "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED' WHERE id=?",
        ).run(intent.id);
        db.prepare("UPDATE write_intents SET status='failed' WHERE id=?").run(intent.id);
        db.prepare(
          "UPDATE file_operations SET status='failed',error='OPERATION_UNAPPLIED' WHERE id=?",
        ).run(intent.id);
        releaseSnapshotRef(db, intent.id);
        report.unapplied++;
      } catch (e) {
        if (intent.kind === 'restore') {
          try {
            preserveRestoreSource(intent);
          } catch {
            /* Keep the private backup for reconciliation. */
          }
          db.prepare(
            "UPDATE operations SET status='needs_reconciliation',error='RESTORE_CONFLICT' WHERE id=?",
          ).run(intent.id);
          if (
            e instanceof KnowledgeError &&
            ['RESTORE_CONFLICT', 'NAME_CONFLICT', 'INVALID_PATH'].includes(e.code)
          )
            db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(intent.id);
        }
        report.conflicted++;
      }
    }
    // Cleanup is retryable after a committed restore; it cannot change its receipt.
    for (const intent of db
      .prepare("SELECT * FROM write_intents WHERE kind='restore' AND status='recorded'")
      .all() as Intent[]) {
      const stage = restoreStage(intent);
      if (existsSync(stage)) {
        try {
          const dest = safePath(config.knowledgeRoot, intent.path, 'note');
          if (restoreHash(dest) === intent.target_hash) {
            unlinkSync(stage);
            fsyncDirectory(dirname(stage));
          }
        } catch {}
      }
    }
    return report;
  }
  return {
    create: (...args: Parameters<typeof create>) =>
      workspaceWriteSync(db, { kind: 'core.create' }, () => create(...args)),
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
